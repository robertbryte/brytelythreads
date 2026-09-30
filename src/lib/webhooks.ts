/**
 * Webhook processing shared by the Next.js route handlers.
 */
import type { Env } from "./env";
import { invalidateCatalog, markProductDeleted, upsertProduct } from "./catalog";
import { applyPrintifyOrder, handleStripeEvent, markPaid, orderBySession, submitToPrintify, type PublicOrder } from "./orders";
import { Printify, WEBHOOK_TOPICS } from "./printify";
import { Stripe, verifyStripeSignature, type StripeCheckoutSession, type StripeEvent } from "./stripe";
import { hmacSha256Hex, log, nowIso, safeEqual } from "./util";

async function alreadyProcessed(env: Env, source: string, id: string) {
  return !!(await env.DB.prepare(`SELECT 1 FROM webhook_events WHERE source = ? AND event_id = ?`).bind(source, id).first());
}
async function markProcessed(env: Env, source: string, id: string, type: string) {
  await env.DB.prepare(`INSERT OR IGNORE INTO webhook_events (source, event_id, type, processed_at) VALUES (?, ?, ?, ?)`)
    .bind(source, id, type, nowIso()).run();
}

// ── Stripe ──────────────────────────────────────────────────────────────────

export async function processStripeWebhook(env: Env, rawBody: string, signature: string | null): Promise<{ status: number; body: unknown }> {
  if (!(await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET))) {
    log("warn", "stripe webhook signature rejected");
    return { status: 400, body: { error: "invalid signature" } };
  }
  const evt = JSON.parse(rawBody) as StripeEvent;
  if (await alreadyProcessed(env, "stripe", evt.id)) return { status: 200, body: { received: true, duplicate: true } };

  try {
    const r = await handleStripeEvent(env, evt);
    await markProcessed(env, "stripe", evt.id, evt.type); // only after success, so failures get redelivered
    log("info", "stripe webhook processed", { id: evt.id, type: evt.type, ...r });
    return { status: 200, body: { received: true, ...r } };
  } catch (e) {
    log("error", "stripe webhook processing failed — Stripe will retry", { id: evt.id, type: evt.type, error: String(e) });
    return { status: 500, body: { error: "processing failed; will retry" } };
  }
}

/**
 * Success page fallback: if the customer beats the webhook here (or the
 * webhook is misconfigured), confirm the session directly with Stripe.
 */
export async function confirmCheckoutSession(env: Env, sessionId: string): Promise<PublicOrder | null> {
  let order = await orderBySession(env, sessionId);
  if (!order) return null;
  if (order.status === "pending_payment") {
    try {
      const s: StripeCheckoutSession = await new Stripe(env.STRIPE_SECRET_KEY).retrieveCheckoutSession(sessionId);
      if (s.payment_status === "paid") {
        const paid = await markPaid(env, s);
        await submitToPrintify(env, paid.id, "success-page");
        order = await orderBySession(env, sessionId);
      }
    } catch (e) {
      log("warn", "success-page session confirm failed (webhook will handle it)", { sessionId, error: String(e) });
    }
  }
  return order;
}

// ── Printify ────────────────────────────────────────────────────────────────

interface PrintifyWebhook {
  id: string;
  type: string;                  // e.g. "order:shipment:created"
  created_at?: string;
  resource: { id: string; type: "order" | "product" | string; data?: Record<string, unknown> | null };
}

/**
 * Printify signs deliveries with X-Pfy-Signature: sha256=<hex hmac of body>
 * using the secret supplied at webhook creation. We also require a secret
 * token in the URL we register, as a second, independent check.
 */
export async function verifyPrintify(env: Env, rawBody: string, url: URL, sigHeader: string | null): Promise<boolean> {
  const secret = env.PRINTIFY_WEBHOOK_SECRET;
  if (!secret) return false;
  const token = url.searchParams.get("token") || "";
  if (!safeEqual(token, secret)) return false;
  if (sigHeader) {
    const expected = await hmacSha256Hex(secret, rawBody);
    const got = sigHeader.replace(/^sha256=/, "");
    if (!safeEqual(got, expected)) return false;
  }
  return true;
}

export async function processPrintifyWebhook(env: Env, rawBody: string, url: URL, sigHeader: string | null): Promise<{ status: number; body: unknown }> {
  if (!(await verifyPrintify(env, rawBody, url, sigHeader))) {
    log("warn", "printify webhook rejected (bad token/signature)");
    return { status: 401, body: { error: "unauthorized" } };
  }
  let hook: PrintifyWebhook;
  try {
    hook = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "bad json" } };
  }
  if (hook.id && (await alreadyProcessed(env, "printify", hook.id))) return { status: 200, body: { duplicate: true } };

  const pf = Printify.fromEnv(env);
  try {
    if (hook.resource?.type === "order" || hook.type.startsWith("order:")) {
      // Re-fetch the order: the API response is authoritative and shape-stable.
      const pfOrder = await pf.getOrder(hook.resource.id);
      const updated = await applyPrintifyOrder(env, pfOrder);
      log("info", "printify order webhook", { type: hook.type, printify_order_id: hook.resource.id, local: updated?.number ?? null, status: updated?.status });
    } else if (hook.type === "product:publish:started") {
      const productId = hook.resource.id;
      try {
        const product = await pf.getProduct(productId);
        await upsertProduct(env, product, { published: true });
        await invalidateCatalog(env);
        const row = await env.DB.prepare(`SELECT handle FROM products WHERE id = ?`).bind(productId).first<{ handle: string }>();
        await pf.publishingSucceeded(productId, row?.handle ?? productId, `${env.SITE_URL}/products/${row?.handle ?? ""}`);
        log("info", "product published", { productId, handle: row?.handle });
      } catch (e) {
        await pf.publishingFailed(productId, `Storefront import failed: ${String(e).slice(0, 200)}`).catch(() => {});
        throw e;
      }
    } else if (hook.type === "product:deleted") {
      await markProductDeleted(env, hook.resource.id);
      await invalidateCatalog(env);
    } else {
      log("info", "printify webhook ignored", { type: hook.type });
    }
    if (hook.id) await markProcessed(env, "printify", hook.id, hook.type);
    return { status: 200, body: { ok: true } };
  } catch (e) {
    log("error", "printify webhook processing failed", { type: hook.type, resource: hook.resource?.id, error: String(e) });
    return { status: 500, body: { error: "processing failed" } };
  }
}

/** Idempotently registers our webhook subscriptions with Printify. */
export async function registerPrintifyWebhooks(env: Env) {
  const pf = Printify.fromEnv(env);
  const target = `${env.SITE_URL}/api/webhooks/printify?token=${encodeURIComponent(env.PRINTIFY_WEBHOOK_SECRET)}`;
  const existing = await pf.listWebhooks();
  const report: { topic: string; action: "exists" | "created" | "replaced" }[] = [];
  for (const topic of WEBHOOK_TOPICS) {
    const same = existing.find((w) => w.topic === topic && w.url === target);
    if (same) {
      report.push({ topic, action: "exists" });
      continue;
    }
    // Replace any stale subscription for this topic pointing at our host (e.g. after rotating the secret).
    const stale = existing.filter((w) => w.topic === topic && safeHost(w.url) === safeHost(target));
    for (const w of stale) await pf.deleteWebhook(w.id, w.url);
    await pf.createWebhook(topic, target, env.PRINTIFY_WEBHOOK_SECRET);
    report.push({ topic, action: stale.length ? "replaced" : "created" });
  }
  return report;
}

function safeHost(u: string) {
  try { return new URL(u).host; } catch { return ""; }
}
