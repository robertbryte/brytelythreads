/**
 * Order pipeline — the part that must never silently drop a paid order.
 *
 *   cart ─► createCheckout() ─► Stripe Checkout (hosted) ─► webhook
 *        ─► markPaid() ─► submitToPrintify() ─► Printify webhooks ─► applyPrintifyOrder()
 *
 * Safety nets for Printify submission:
 *   1. fetchWithRetry backoff inside a single attempt (network / 429 / 5xx)
 *   2. duplicate check by external_id before any retry (lost-response safe)
 *   3. atomic "claim" in D1 so concurrent webhook deliveries can't double-submit
 *   4. Stripe webhook returns 500 on failure → Stripe redelivers for up to 3 days
 *   5. hourly cron sweeps submit_failed / stuck orders
 *   6. admin alert email + "Retry" button in /admin
 */
import type { Env } from "./env";
import { flag } from "./env";
import { imageUrl, type ProductImage } from "./catalog";
import { alertAdmin, orderConfirmationEmail, sendEmail, shippedEmail, type EmailOrder } from "./notify";
import { Printify, type PfAddress, type PfOrder } from "./printify";
import { allowedCountries, getShippingRates, shippingAmount } from "./shipping";
import { Stripe, type StripeCheckoutSession, type StripeEvent } from "./stripe";
import { HttpError, log, nowIso, orderNumber, uuid } from "./util";

export type OrderStatus =
  | "pending_payment" | "paid" | "submitting" | "submit_failed" | "submitted"
  | "in_production" | "shipped" | "delivered" | "expired" | "canceled" | "refunded";

/** Forward-only progression for fulfillment statuses (webhooks can arrive out of order). */
const RANK: Record<string, number> = { submitted: 1, in_production: 2, shipped: 3, delivered: 4 };

export interface CartLine { productId: string; variantId: number; quantity: number }
export interface Tracking { carrier: string; number: string; url: string; deliveredAt?: string | null }

export interface OrderRow {
  id: string; number: string; status: OrderStatus; email: string | null; customer_name: string | null; phone: string | null;
  shipping_json: string | null; subtotal: number; shipping_amount: number; tax_amount: number; total: number; currency: string;
  stripe_session_id: string | null; stripe_payment_intent: string | null; printify_order_id: string | null; printify_status: string | null;
  submit_attempts: number; submit_started_at: string | null; last_error: string | null; tracking_json: string;
  shipped_email_sent_at: string | null; created_at: string; updated_at: string; paid_at: string | null; submitted_at: string | null;
}
export interface OrderItemRow {
  order_id: string; product_id: string; variant_id: number; title: string; variant_title: string; image: string | null; unit_price: number; quantity: number;
}
export interface ShippingAddress {
  name: string; line1: string; line2?: string; city: string; state: string; postalCode: string; country: string;
}

export class CheckoutError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

async function event(env: Env, orderId: string, kind: string, detail?: unknown) {
  await env.DB.prepare(`INSERT INTO order_events (order_id, kind, detail, created_at) VALUES (?, ?, ?, ?)`)
    .bind(orderId, kind, detail === undefined ? null : typeof detail === "string" ? detail : JSON.stringify(detail), nowIso())
    .run()
    .catch((e) => log("error", "failed to write order event", { orderId, kind, error: String(e) }));
}

export async function getOrder(env: Env, id: string) {
  return env.DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(id).first<OrderRow>();
}
export async function getOrderItems(env: Env, id: string) {
  return (await env.DB.prepare(`SELECT * FROM order_items WHERE order_id = ?`).bind(id).all<OrderItemRow>()).results;
}

// ── 1. Checkout ─────────────────────────────────────────────────────────────

export async function createCheckout(env: Env, lines: CartLine[]): Promise<{ url: string; orderNumber: string }> {
  if (!Array.isArray(lines) || lines.length === 0) throw new CheckoutError("Your cart is empty.");
  if (lines.length > 25) throw new CheckoutError("Too many different items in one order.");

  // Merge duplicate lines and validate quantities.
  const merged = new Map<string, CartLine>();
  for (const l of lines) {
    const q = Number(l.quantity);
    if (!l.productId || !Number.isInteger(Number(l.variantId)) || !Number.isInteger(q) || q < 1 || q > 20) {
      throw new CheckoutError("Invalid cart item.");
    }
    const key = `${l.productId}:${l.variantId}`;
    const prev = merged.get(key);
    merged.set(key, { productId: String(l.productId), variantId: Number(l.variantId), quantity: (prev?.quantity ?? 0) + q });
  }

  // Price & availability come from our DB — never from the client.
  const items: Omit<OrderItemRow, "order_id">[] = [];
  for (const l of merged.values()) {
    const row = await env.DB.prepare(
      `SELECT v.id, v.title AS variant_title, v.price, v.is_available, v.option_ids_json, p.title, p.images_json
         FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.product_id = ? AND v.id = ? AND v.is_enabled = 1 AND p.deleted = 0 AND p.hidden = 0 AND p.printify_visible = 1`,
    ).bind(l.productId, l.variantId).first<{ id: number; variant_title: string; price: number; is_available: number; title: string; images_json: string }>();
    if (!row) throw new CheckoutError("An item in your cart is no longer available. Please remove it and try again.", 409);
    if (!row.is_available) throw new CheckoutError(`${row.title} (${row.variant_title}) is temporarily out of stock.`, 409);
    const images = JSON.parse(row.images_json) as ProductImage[];
    const img = images.find((i) => i.variantIds.includes(row.id) && i.isDefault) ?? images.find((i) => i.variantIds.includes(row.id)) ?? images[0];
    items.push({
      product_id: l.productId, variant_id: row.id, title: row.title, variant_title: row.variant_title,
      image: img ? imageUrl(img) : null, unit_price: row.price, quantity: l.quantity,
    });
  }

  const subtotal = items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
  const count = items.reduce((s, i) => s + i.quantity, 0);
  const id = uuid();
  const number = orderNumber();
  const now = nowIso();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO orders (id, number, status, subtotal, total, currency, created_at, updated_at) VALUES (?, ?, 'pending_payment', ?, ?, 'usd', ?, ?)`,
    ).bind(id, number, subtotal, subtotal, now, now),
    ...items.map((i) =>
      env.DB.prepare(
        `INSERT INTO order_items (order_id, product_id, variant_id, title, variant_title, image, unit_price, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, i.product_id, i.variant_id, i.title, i.variant_title, i.image, i.unit_price, i.quantity),
    ),
  ]);

  const abs = (u: string | null) => (u ? (u.startsWith("http") ? u : `${env.SITE_URL}${u}`) : undefined);
  const params: Record<string, unknown> = {
    mode: "payment",
    client_reference_id: id,
    metadata: { order_id: id, order_number: number },
    payment_intent_data: { metadata: { order_id: id, order_number: number }, description: `Brytely Threads ${number}` },
    line_items: items.map((i) => ({
      quantity: i.quantity,
      price_data: {
        currency: "usd",
        unit_amount: i.unit_price,
        product_data: {
          name: i.title,
          description: i.variant_title,
          images: abs(i.image) ? [abs(i.image)] : undefined,
          metadata: { printify_product_id: i.product_id, printify_variant_id: String(i.variant_id) },
        },
      },
    })),
    shipping_address_collection: { allowed_countries: allowedCountries(env) },
    phone_number_collection: { enabled: true },
    shipping_options: getShippingRates(env).slice(0, 5).map((r) => ({
      shipping_rate_data: {
        type: "fixed_amount",
        display_name: r.label,
        fixed_amount: { amount: shippingAmount(r, subtotal, count), currency: "usd" },
        delivery_estimate: { minimum: { unit: "business_day", value: r.minDays }, maximum: { unit: "business_day", value: r.maxDays } },
      },
    })),
    automatic_tax: flag(env.STRIPE_AUTOMATIC_TAX) ? { enabled: true } : undefined,
    success_url: `${env.SITE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.SITE_URL}/cart?canceled=1`,
  };

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const session = await stripe.createCheckoutSession(params, `checkout-${id}`);
  await env.DB.prepare(`UPDATE orders SET stripe_session_id = ?, updated_at = ? WHERE id = ?`).bind(session.id, nowIso(), id).run();
  await event(env, id, "checkout.created", { session: session.id, subtotal });
  if (!session.url) throw new CheckoutError("Stripe did not return a checkout URL.", 502);
  return { url: session.url, orderNumber: number };
}

// ── 2. Stripe webhook ───────────────────────────────────────────────────────

function extractShipping(s: StripeCheckoutSession): ShippingAddress | null {
  const sd = s.collected_information?.shipping_details ?? s.shipping_details ?? null;
  const a = sd?.address ?? s.customer_details?.address ?? null;
  if (!a?.line1 || !a.city || !a.country) return null;
  return {
    name: sd?.name || s.customer_details?.name || "",
    line1: a.line1, line2: a.line2 || undefined, city: a.city, state: a.state || "", postalCode: a.postal_code || "", country: a.country,
  };
}

async function findOrderForSession(env: Env, s: StripeCheckoutSession) {
  const id = s.metadata?.order_id || s.client_reference_id;
  if (id) {
    const o = await getOrder(env, id);
    if (o) return o;
  }
  return env.DB.prepare(`SELECT * FROM orders WHERE stripe_session_id = ?`).bind(s.id).first<OrderRow>();
}

export async function markPaid(env: Env, s: StripeCheckoutSession): Promise<OrderRow> {
  const order = await findOrderForSession(env, s);
  if (!order) throw new Error(`No local order for Stripe session ${s.id}`);
  const ship = extractShipping(s);
  if (!ship) throw new Error(`Stripe session ${s.id} has no shipping address`);

  const res = await env.DB.prepare(
    `UPDATE orders SET status = 'paid', email = ?, customer_name = ?, phone = ?, shipping_json = ?,
            shipping_amount = ?, tax_amount = ?, total = ?, currency = ?, stripe_session_id = ?, stripe_payment_intent = ?,
            paid_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending_payment', 'expired')`,
  ).bind(
    s.customer_details?.email ?? null, ship.name || s.customer_details?.name || null, s.customer_details?.phone ?? null, JSON.stringify(ship),
    s.shipping_cost?.amount_total ?? s.total_details?.amount_shipping ?? 0, s.total_details?.amount_tax ?? 0, s.amount_total ?? order.subtotal,
    s.currency ?? "usd", s.id, s.payment_intent, nowIso(), nowIso(), order.id,
  ).run();

  if (res.meta.changes > 0) {
    await event(env, order.id, "stripe.paid", { session: s.id, amount_total: s.amount_total });
    if (s.amount_subtotal !== null && s.amount_subtotal !== order.subtotal) {
      await event(env, order.id, "warning.subtotal_mismatch", { local: order.subtotal, stripe: s.amount_subtotal });
    }
    const paid = (await getOrder(env, order.id))!;
    if (paid.email) {
      const items = await getOrderItems(env, order.id);
      await sendEmail(env, paid.email, `Order ${paid.number} confirmed`, orderConfirmationEmail(env, toEmailOrder(paid, items)));
    }
    return paid;
  }
  return (await getOrder(env, order.id))!;
}

function toEmailOrder(o: OrderRow, items: OrderItemRow[]): EmailOrder {
  return {
    number: o.number, email: o.email ?? "", customerName: o.customer_name, total: o.total, currency: o.currency,
    items: items.map((i) => ({ title: i.title, variantTitle: i.variant_title, quantity: i.quantity })),
  };
}

/**
 * Processes a verified Stripe event. Throws on anything that should make
 * Stripe redeliver (the route turns a throw into HTTP 500).
 */
export async function handleStripeEvent(env: Env, evt: StripeEvent): Promise<{ handled: boolean; detail?: string }> {
  const s = evt.data.object as StripeCheckoutSession;
  switch (evt.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (s.payment_status !== "paid" && s.payment_status !== "no_payment_required") {
        const o = await findOrderForSession(env, s);
        if (o) await event(env, o.id, "stripe.awaiting_async_payment", { session: s.id });
        return { handled: true, detail: "awaiting async payment" };
      }
      const order = await markPaid(env, s);
      const result = await submitToPrintify(env, order.id, "stripe-webhook");
      if (!result.ok && !result.inProgress) {
        throw new Error(`Printify submission failed for ${order.number}: ${result.error}`);
      }
      return { handled: true, detail: result.ok ? `submitted ${result.printifyOrderId}` : "submission in progress elsewhere" };
    }
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed": {
      const o = await findOrderForSession(env, s);
      if (o) {
        await env.DB.prepare(`UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending_payment'`).bind(nowIso(), o.id).run();
        await event(env, o.id, `stripe.${evt.type.split(".").pop()}`);
      }
      return { handled: true };
    }
    default:
      return { handled: false };
  }
}

// ── 3. Printify submission ──────────────────────────────────────────────────

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "Customer", last: "-" };
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

export function buildPrintifyAddress(o: Pick<OrderRow, "shipping_json" | "email" | "phone" | "customer_name">): PfAddress {
  const a = JSON.parse(o.shipping_json || "null") as ShippingAddress | null;
  if (!a) throw new Error("Order has no shipping address");
  const { first, last } = splitName(a.name || o.customer_name || "");
  return {
    first_name: first, last_name: last, email: o.email || "", phone: o.phone || undefined,
    country: a.country, region: a.state, address1: a.line1, address2: a.line2, city: a.city, zip: a.postalCode,
  };
}

export interface SubmitResult { ok: boolean; printifyOrderId?: string; already?: boolean; inProgress?: boolean; error?: string }

const STALE_SUBMIT_MS = 10 * 60 * 1000;

export async function submitToPrintify(env: Env, orderId: string, trigger: string): Promise<SubmitResult> {
  const now = nowIso();
  const staleBefore = new Date(Date.now() - STALE_SUBMIT_MS).toISOString();

  // Atomic claim: exactly one worker gets to submit.
  const claim = await env.DB.prepare(
    `UPDATE orders SET status = 'submitting', submit_attempts = submit_attempts + 1, submit_started_at = ?, updated_at = ?
      WHERE id = ? AND printify_order_id IS NULL
        AND (status IN ('paid', 'submit_failed') OR (status = 'submitting' AND submit_started_at < ?))`,
  ).bind(now, now, orderId, staleBefore).run();

  if (claim.meta.changes === 0) {
    const o = await getOrder(env, orderId);
    if (!o) return { ok: false, error: "order not found" };
    if (o.printify_order_id) return { ok: true, already: true, printifyOrderId: o.printify_order_id };
    if (o.status === "submitting") return { ok: false, inProgress: true, error: "submission already in progress" };
    return { ok: false, error: `order is ${o.status}, not submittable` };
  }

  const order = (await getOrder(env, orderId))!;
  const items = await getOrderItems(env, orderId);
  await event(env, orderId, "printify.submit.start", { trigger, attempt: order.submit_attempts });

  try {
    if (items.length === 0) throw new Error("Order has no items");
    const pf = Printify.fromEnv(env);
    const { id: pfId, recovered } = await pf.createOrder({
      external_id: order.id,
      label: order.number,
      line_items: items.map((i) => ({ product_id: i.product_id, variant_id: i.variant_id, quantity: i.quantity })),
      shipping_method: Number(env.PRINTIFY_SHIPPING_METHOD || 1),
      send_shipping_notification: false, // we send our own branded email
      address_to: buildPrintifyAddress(order),
    });

    await env.DB.prepare(
      `UPDATE orders SET status = 'submitted', printify_order_id = ?, printify_status = 'on-hold', submitted_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
    ).bind(pfId, nowIso(), nowIso(), orderId).run();
    await event(env, orderId, "printify.submit.ok", { printify_order_id: pfId, recovered });

    if (flag(env.PRINTIFY_SEND_TO_PRODUCTION)) await sendToProduction(env, orderId, pfId);
    return { ok: true, printifyOrderId: pfId };
  } catch (e) {
    const msg = e instanceof HttpError ? `${e.message} ${e.body}` : String(e);
    await env.DB.prepare(`UPDATE orders SET status = 'submit_failed', last_error = ?, updated_at = ? WHERE id = ? AND status = 'submitting'`)
      .bind(msg.slice(0, 2000), nowIso(), orderId).run();
    await event(env, orderId, "printify.submit.error", msg.slice(0, 2000));
    log("error", "PRINTIFY SUBMISSION FAILED", { orderId, number: order.number, attempt: order.submit_attempts, error: msg });
    if (order.submit_attempts === 1 || order.submit_attempts % 5 === 0) {
      await alertAdmin(env, `Order ${order.number} failed to reach Printify (attempt ${order.submit_attempts})`,
        `The customer has paid. It will be retried automatically, or use Retry in /admin.\n\n${msg}`);
    }
    return { ok: false, error: msg };
  }
}

export async function sendToProduction(env: Env, orderId: string, pfId: string) {
  try {
    await Printify.fromEnv(env).sendToProduction(pfId);
    await env.DB.prepare(`UPDATE orders SET printify_status = 'sending-to-production', last_error = NULL, updated_at = ? WHERE id = ?`)
      .bind(nowIso(), orderId).run();
    await event(env, orderId, "printify.send_to_production.ok");
  } catch (e) {
    const msg = `send_to_production failed: ${e instanceof HttpError ? `${e.message} ${e.body}` : String(e)}`;
    // The order exists in Printify (on hold) — flag it loudly; the cron sweep retries.
    await env.DB.prepare(`UPDATE orders SET last_error = ?, updated_at = ? WHERE id = ?`).bind(msg.slice(0, 2000), nowIso(), orderId).run();
    await event(env, orderId, "printify.send_to_production.error", msg.slice(0, 2000));
    await alertAdmin(env, `Order ${orderId} is on hold in Printify`, `${msg}\nIt will be retried automatically, or approve it in Printify.`);
  }
}

// ── 4. Printify status updates ──────────────────────────────────────────────

export function mapPrintifyStatus(pf: PfOrder): OrderStatus | null {
  const shipments = pf.shipments ?? [];
  if (pf.status === "canceled") return "canceled";
  if (shipments.length > 0 && shipments.every((s) => s.delivered_at)) return "delivered";
  if (shipments.length > 0 || pf.status === "fulfilled" || pf.status === "partially-fulfilled") return "shipped";
  if (pf.status === "in-production" || pf.status === "sending-to-production") return "in_production";
  return null; // pending / on-hold / has-issues → keep current
}

export async function applyPrintifyOrder(env: Env, pf: PfOrder): Promise<OrderRow | null> {
  const order = await env.DB.prepare(`SELECT * FROM orders WHERE printify_order_id = ?`).bind(pf.id).first<OrderRow>()
    ?? (pf.external_id ? await getOrder(env, pf.external_id) : null);
  if (!order) return null; // e.g. an order placed manually in Printify

  const mapped = mapPrintifyStatus(pf);
  let status: OrderStatus = order.status;
  if (mapped === "canceled") status = "canceled";
  else if (mapped && (RANK[mapped] ?? 0) > (RANK[order.status] ?? 0)) status = mapped;

  const tracking: Tracking[] = (pf.shipments ?? []).map((s) => ({ carrier: s.carrier, number: s.number, url: s.url, deliveredAt: s.delivered_at ?? null }));
  await env.DB.prepare(
    `UPDATE orders SET status = ?, printify_status = ?, tracking_json = ?, printify_order_id = COALESCE(printify_order_id, ?), updated_at = ? WHERE id = ?`,
  ).bind(status, pf.status, JSON.stringify(tracking), pf.id, nowIso(), order.id).run();
  if (status !== order.status || pf.status !== order.printify_status) {
    await event(env, order.id, "printify.status", { from: order.status, to: status, printify: pf.status });
  }
  if (pf.status === "has-issues") {
    await alertAdmin(env, `Printify flagged order ${order.number} with issues`, `Printify order ${pf.id} needs attention in the Printify dashboard.`);
  }

  // Shipped email — claim first so parallel webhooks don't double-send.
  if ((status === "shipped" || status === "delivered") && tracking.length && order.email && !order.shipped_email_sent_at) {
    const claim = await env.DB.prepare(`UPDATE orders SET shipped_email_sent_at = ? WHERE id = ? AND shipped_email_sent_at IS NULL`)
      .bind(nowIso(), order.id).run();
    if (claim.meta.changes > 0) {
      const items = await getOrderItems(env, order.id);
      const sent = await sendEmail(env, order.email, `Your Brytely Threads order ${order.number} has shipped`, shippedEmail(env, toEmailOrder(order, items), tracking));
      if (!sent) await env.DB.prepare(`UPDATE orders SET shipped_email_sent_at = NULL WHERE id = ?`).bind(order.id).run();
      else await event(env, order.id, "email.shipped");
    }
  }
  return getOrder(env, order.id);
}

// ── 5. Cron sweep (safety net) ──────────────────────────────────────────────

export async function sweepOrders(env: Env) {
  const summary = { retried: 0, retriedOk: 0, productionRetried: 0, polled: 0 };

  // a) paid-but-not-submitted, failed, or stuck mid-submission
  const staleBefore = new Date(Date.now() - STALE_SUBMIT_MS).toISOString();
  const { results: toSubmit } = await env.DB.prepare(
    `SELECT id FROM orders WHERE printify_order_id IS NULL AND submit_attempts < 12
       AND (status IN ('paid', 'submit_failed') OR (status = 'submitting' AND submit_started_at < ?))
     ORDER BY paid_at ASC LIMIT 10`,
  ).bind(staleBefore).all<{ id: string }>();
  for (const { id } of toSubmit) {
    summary.retried++;
    const r = await submitToPrintify(env, id, "cron-sweep");
    if (r.ok) summary.retriedOk++;
  }

  // b) submitted but send_to_production failed earlier
  if (flag(env.PRINTIFY_SEND_TO_PRODUCTION)) {
    const { results } = await env.DB.prepare(
      `SELECT id, printify_order_id FROM orders WHERE status = 'submitted' AND last_error LIKE 'send_to_production%' LIMIT 10`,
    ).all<{ id: string; printify_order_id: string }>();
    for (const r of results) {
      summary.productionRetried++;
      await sendToProduction(env, r.id, r.printify_order_id);
    }
  }

  // c) poll open orders whose webhooks we may have missed
  const pollBefore = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const { results: open } = await env.DB.prepare(
    `SELECT printify_order_id FROM orders WHERE printify_order_id IS NOT NULL
       AND status IN ('submitted', 'in_production', 'shipped') AND updated_at < ?
       AND created_at > datetime('now', '-60 days')
     ORDER BY updated_at ASC LIMIT 25`,
  ).bind(pollBefore).all<{ printify_order_id: string }>();
  if (open.length) {
    const pf = Printify.fromEnv(env);
    for (const o of open) {
      try {
        const pfo = await pf.getOrder(o.printify_order_id);
        await applyPrintifyOrder(env, pfo);
        await env.DB.prepare(`UPDATE orders SET updated_at = ? WHERE printify_order_id = ?`).bind(nowIso(), o.printify_order_id).run();
        summary.polled++;
      } catch (e) {
        log("warn", "order poll failed", { printify_order_id: o.printify_order_id, error: String(e) });
      }
    }
  }

  // d) abandoned checkouts older than 2 days
  await env.DB.prepare(`UPDATE orders SET status = 'expired', updated_at = ? WHERE status = 'pending_payment' AND created_at < datetime('now', '-2 days')`)
    .bind(nowIso()).run();

  log("info", "order sweep finished", summary);
  return summary;
}

// ── 6. Customer lookup ──────────────────────────────────────────────────────

export interface PublicOrder {
  number: string; status: OrderStatus; createdAt: string; total: number; subtotal: number; shipping: number; tax: number; currency: string;
  items: { title: string; variantTitle: string; image: string | null; quantity: number; unitPrice: number }[];
  tracking: Tracking[];
  shipTo: { name: string; city: string; state: string; country: string } | null;
}

export function toPublicOrder(o: OrderRow, items: OrderItemRow[]): PublicOrder {
  const ship = o.shipping_json ? (JSON.parse(o.shipping_json) as ShippingAddress) : null;
  return {
    number: o.number, status: o.status, createdAt: o.created_at, total: o.total, subtotal: o.subtotal,
    shipping: o.shipping_amount, tax: o.tax_amount, currency: o.currency,
    items: items.map((i) => ({ title: i.title, variantTitle: i.variant_title, image: i.image, quantity: i.quantity, unitPrice: i.unit_price })),
    tracking: JSON.parse(o.tracking_json || "[]"),
    shipTo: ship ? { name: ship.name, city: ship.city, state: ship.state, country: ship.country } : null,
  };
}

export async function lookupOrder(env: Env, number: string, email: string): Promise<PublicOrder | null> {
  const o = await env.DB.prepare(`SELECT * FROM orders WHERE number = ? AND lower(email) = lower(?) AND status != 'pending_payment'`)
    .bind(number.trim().toUpperCase(), email.trim()).first<OrderRow>();
  if (!o) return null;
  return toPublicOrder(o, await getOrderItems(env, o.id));
}

export async function orderBySession(env: Env, sessionId: string): Promise<PublicOrder | null> {
  const o = await env.DB.prepare(`SELECT * FROM orders WHERE stripe_session_id = ?`).bind(sessionId).first<OrderRow>();
  if (!o) return null;
  return toPublicOrder(o, await getOrderItems(env, o.id));
}
