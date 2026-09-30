/**
 * End-to-end test of the money path, against the real schema (SQLite) with
 * Printify, Stripe and Resend replaced by an in-process fake.
 *
 *   npm test
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createTestD1, createTestKV } from "./d1-sqlite";
import type { Env } from "../src/lib/env";
import { getCatalogIndex, getProductByHandle, syncCatalog } from "../src/lib/catalog";
import { CheckoutError, createCheckout, getOrder, lookupOrder, submitToPrintify, sweepOrders } from "../src/lib/orders";
import { processPrintifyWebhook, processStripeWebhook, registerPrintifyWebhooks } from "../src/lib/webhooks";
import { signStripePayload } from "../src/lib/stripe";
import { hmacSha256Hex, retryTiming } from "../src/lib/util";
import { sanitizeHtml } from "../src/lib/sanitize";

retryTiming.scale = 0;
// Keep test output readable.
console.log = () => {};
console.warn = () => {};
console.error = () => {};

// ── Fixtures ────────────────────────────────────────────────────────────────
const SHOP = "999";
const product = (id: string, title: string, tags: string[], price = 2800) => ({
  id, title, description: `<p>Soft tee.</p><script>alert(1)</script><p onclick="x()">Hi</p>`, tags, visible: true,
  options: [
    { name: "Colors", type: "color", values: [{ id: 1, title: "Black", colors: ["#000000"] }, { id: 2, title: "Sand", colors: ["#e2d6c2"] }, { id: 3, title: "Unused", colors: ["#f00"] }] },
    { name: "Sizes", type: "size", values: [{ id: 10, title: "M" }, { id: 11, title: "L" }] },
  ],
  variants: [
    { id: 101, title: "Black / M", price, options: [1, 10], is_enabled: true, is_default: true, is_available: true },
    { id: 102, title: "Black / L", price: price + 200, options: [1, 11], is_enabled: true, is_default: false, is_available: true },
    { id: 103, title: "Sand / M", price, options: [2, 10], is_enabled: true, is_default: false, is_available: false },
    { id: 104, title: "Red / M", price, options: [3, 10], is_enabled: false, is_default: false, is_available: true },
  ],
  images: [
    { src: `https://images.printify.com/${id}/front.jpg`, variant_ids: [101, 102], position: "front", is_default: true },
    { src: `https://images.printify.com/${id}/back.jpg`, variant_ids: [101, 102], position: "back", is_default: false },
    { src: `https://images.printify.com/${id}/sand.jpg`, variant_ids: [103], position: "front", is_default: false },
    { src: `https://images.printify.com/${id}/red.jpg`, variant_ids: [104], position: "front", is_default: false },
  ],
  created_at: "2026-09-01 10:00:00+00:00",
});

interface FakeState {
  products: ReturnType<typeof product>[];
  orders: { id: string; external_id: string; status: string; shipments: unknown[]; body: any }[];
  createCalls: number;
  createMode: "ok" | "lose-response-once" | "fail-500" | "fail-400";
  sentToProduction: string[];
  stripeSessions: { params: string; id: string }[];
  emails: { to: string[]; subject: string }[];
  webhooks: { id: string; topic: string; url: string }[];
  publishSucceeded: string[];
}
let S: FakeState;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method || "GET").toUpperCase();
  const p = url.pathname;

  if (url.host === "api.printify.com") {
    assert.match(String((init?.headers as Record<string, string>)?.Authorization), /^Bearer test-printify-token$/);
    if (p === `/v1/shops/${SHOP}/products.json`) {
      return json({ current_page: 1, last_page: 1, data: S.products });
    }
    const prod = p.match(new RegExp(`/v1/shops/${SHOP}/products/([^/]+)\\.json$`));
    if (prod) return json(S.products.find((x) => x.id === prod[1]));
    const pubOk = p.match(/products\/([^/]+)\/publishing_succeeded\.json$/);
    if (pubOk) { S.publishSucceeded.push(pubOk[1]); return json({}); }
    if (p === `/v1/shops/${SHOP}/orders.json` && method === "POST") {
      S.createCalls++;
      const body = JSON.parse(String(init!.body));
      if (S.createMode === "fail-500") return json({ error: "upstream" }, 502);
      if (S.createMode === "fail-400") return json({ errors: { reason: "address_to.zip invalid" } }, 400);
      const order = { id: `pf_${S.orders.length + 1}`, external_id: body.external_id, status: "on-hold", shipments: [], body };
      S.orders.push(order);
      if (S.createMode === "lose-response-once") {
        S.createMode = "ok";
        throw new TypeError("network connection lost"); // order WAS created, response never arrived
      }
      return json({ id: order.id });
    }
    if (p === `/v1/shops/${SHOP}/orders.json` && method === "GET") {
      return json({ current_page: 1, last_page: 1, data: S.orders });
    }
    const stp = p.match(/orders\/([^/]+)\/send_to_production\.json$/);
    if (stp) { S.sentToProduction.push(stp[1]); return json({}); }
    const og = p.match(new RegExp(`/v1/shops/${SHOP}/orders/([^/]+)\\.json$`));
    if (og) return json(S.orders.find((o) => o.id === og[1]));
    if (p === `/v1/shops/${SHOP}/webhooks.json` && method === "GET") return json(S.webhooks);
    if (p === `/v1/shops/${SHOP}/webhooks.json` && method === "POST") {
      const b = JSON.parse(String(init!.body));
      const w = { id: `wh_${S.webhooks.length + 1}`, topic: b.topic, url: b.url };
      S.webhooks.push(w);
      return json(w);
    }
  }
  if (url.host === "api.stripe.com" && p === "/v1/checkout/sessions" && method === "POST") {
    const id = `cs_test_${S.stripeSessions.length + 1}`;
    S.stripeSessions.push({ params: decodeURIComponent(String(init!.body)), id });
    return json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (url.host === "api.resend.com") {
    const b = JSON.parse(String(init!.body));
    S.emails.push({ to: b.to, subject: b.subject });
    return json({ id: "em_1" });
  }
  throw new Error(`Unmocked fetch: ${method} ${url}`);
}) as typeof fetch;

let env: Env;
const WHSEC = "whsec_test";
const PFSEC = "pf-secret-123";

function freshEnv(): Env {
  return {
    DB: createTestD1(path.join(__dirname, "../migrations/0001_init.sql")),
    CATALOG_CACHE: createTestKV(),
    PRINTIFY_API_TOKEN: "test-printify-token",
    PRINTIFY_SHOP_ID: SHOP,
    PRINTIFY_WEBHOOK_SECRET: PFSEC,
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: WHSEC,
    ADMIN_USERNAME: "a", ADMIN_PASSWORD: "b",
    RESEND_API_KEY: "re_test", EMAIL_FROM: "Brytely <o@example.com>", ADMIN_ALERT_EMAIL: "owner@example.com",
    SITE_URL: "https://brytely.test",
    PRINTIFY_SEND_TO_PRODUCTION: "true",
  };
}

function completedEvent(eventId: string, sessionId: string, orderId: string, amountSubtotal: number) {
  return JSON.stringify({
    id: eventId, type: "checkout.session.completed", created: 1, livemode: false,
    data: { object: {
      id: sessionId, status: "complete", payment_status: "paid", client_reference_id: orderId,
      metadata: { order_id: orderId }, amount_subtotal: amountSubtotal, amount_total: amountSubtotal + 499, currency: "usd",
      payment_intent: "pi_123",
      customer_details: { email: "Jamie@Example.com", name: "Jamie Q Rivera", phone: "+15555550100", address: null },
      collected_information: { shipping_details: { name: "Jamie Q Rivera", address: { line1: "1 Main St", line2: "Apt 2", city: "Portland", state: "OR", postal_code: "97201", country: "US" } } },
      shipping_cost: { amount_total: 499 }, total_details: { amount_tax: 0, amount_shipping: 499 },
    } },
  });
}

async function paidOrder(eventId = "evt_1") {
  const { orderNumber } = await createCheckout(env, [{ productId: "p_golf", variantId: 102, quantity: 2 }]);
  const o = await env.DB.prepare(`SELECT * FROM orders WHERE number = ?`).bind(orderNumber).first<any>();
  const body = completedEvent(eventId, o.stripe_session_id, o.id, o.subtotal);
  return { order: o, body, sig: await signStripePayload(body, WHSEC) };
}

beforeEach(async () => {
  S = {
    products: [product("p_golf", "Fairway Club", ["Golf", "T-shirts", "DTG"]), product("p_coffee", "Pour Over Club", ["Coffee", "T-shirts"], 3000)],
    orders: [], createCalls: 0, createMode: "ok", sentToProduction: [], stripeSessions: [], emails: [], webhooks: [], publishSucceeded: [],
  };
  env = freshEnv();
  const r = await syncCatalog(env, "admin");
  assert.equal(r.ok, true, r.error);
});

// ── Catalog ────────────────────────────────────────────────────────────────
test("catalog sync: products, flexible tags, generic tags hidden, sanitized HTML", async () => {
  const idx = await getCatalogIndex(env);
  assert.equal(idx.products.length, 2);
  assert.deepEqual(idx.tags.map((t) => t.slug).sort(), ["coffee", "golf"]); // "T-shirts"/"DTG" stored but not in nav
  const p = await getProductByHandle(env, "fairway-club");
  assert.ok(p);
  assert.equal(p.variants.length, 3, "disabled variant excluded");
  assert.equal(p.options[0].values.length, 2, "unused option value pruned");
  assert.equal(p.images.length, 3, "image for disabled variant dropped");
  assert.equal(p.minPrice, 2800);
  assert.ok(!p.description.includes("script") && !p.description.includes("onclick"));
  // cached in KV
  assert.ok((env.CATALOG_CACHE as any).store.size === 1);
});

test("new niche = new tag, no code/schema change", async () => {
  S.products.push(product("p_hike", "Switchback", ["Hiking"]));
  await syncCatalog(env, "admin");
  const idx = await getCatalogIndex(env);
  assert.ok(idx.tags.some((t) => t.slug === "hiking"));
});

test("product removed in Printify is soft-deleted; empty response never wipes catalog", async () => {
  S.products = S.products.slice(0, 1);
  await syncCatalog(env, "cron");
  assert.equal((await getCatalogIndex(env)).products.length, 1);
  S.products = [];
  await syncCatalog(env, "cron");
  assert.equal((await getCatalogIndex(env)).products.length, 1);
});

// ── Checkout ───────────────────────────────────────────────────────────────
test("checkout uses server-side prices and rejects unavailable/disabled variants", async () => {
  const { orderNumber } = await createCheckout(env, [{ productId: "p_golf", variantId: 102, quantity: 2 }]);
  assert.match(orderNumber, /^BT-[A-Z2-9]{6}$/);
  const params = S.stripeSessions[0].params;
  assert.ok(params.includes("line_items[0][price_data][unit_amount]=3000"));
  assert.ok(params.includes("line_items[0][quantity]=2"));
  assert.ok(params.includes("shipping_address_collection[allowed_countries][0]=US"));
  assert.ok(params.includes("success_url=https://brytely.test/checkout/success?session_id={CHECKOUT_SESSION_ID}"));
  await assert.rejects(createCheckout(env, [{ productId: "p_golf", variantId: 103, quantity: 1 }]), CheckoutError); // out of stock
  await assert.rejects(createCheckout(env, [{ productId: "p_golf", variantId: 104, quantity: 1 }]), CheckoutError); // disabled
  await assert.rejects(createCheckout(env, [{ productId: "p_golf", variantId: 101, quantity: 0 }]), CheckoutError);
  await assert.rejects(createCheckout(env, []), CheckoutError);
});

// ── Payment → Printify ─────────────────────────────────────────────────────
test("paid webhook submits exactly one Printify order with correct payload", async () => {
  const { order, body, sig } = await paidOrder();
  const res = await processStripeWebhook(env, body, sig);
  assert.equal(res.status, 200);

  const o = (await getOrder(env, order.id))!;
  assert.equal(o.status, "submitted");
  assert.equal(o.printify_order_id, "pf_1");
  assert.equal(o.total, 6000 + 499);
  assert.equal(S.orders.length, 1);
  const sent = S.orders[0].body;
  assert.equal(sent.external_id, order.id);
  assert.deepEqual(sent.line_items, [{ product_id: "p_golf", variant_id: 102, quantity: 2 }]);
  assert.deepEqual(
    { ...sent.address_to },
    { first_name: "Jamie Q", last_name: "Rivera", email: "Jamie@Example.com", phone: "+15555550100", country: "US", region: "OR",
      address1: "1 Main St", address2: "Apt 2", city: "Portland", zip: "97201" },
  );
  assert.deepEqual(S.sentToProduction, ["pf_1"]);
  assert.ok(S.emails.some((e) => e.subject.includes("confirmed")));

  // Redelivery of same event, and a second event for same session → still one order.
  assert.equal((await processStripeWebhook(env, body, sig)).status, 200);
  const body2 = body.replace('"evt_1"', '"evt_1b"');
  assert.equal((await processStripeWebhook(env, body2, await signStripePayload(body2, WHSEC))).status, 200);
  assert.equal(S.orders.length, 1);
  assert.equal(S.createCalls, 1);
});

test("bad or stale Stripe signature is rejected and nothing happens", async () => {
  const { order, body } = await paidOrder();
  assert.equal((await processStripeWebhook(env, body, "t=1,v1=deadbeef")).status, 400);
  const old = await signStripePayload(body, WHSEC, Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await processStripeWebhook(env, body, old)).status, 400);
  assert.equal((await getOrder(env, order.id))!.status, "pending_payment");
  assert.equal(S.createCalls, 0);
});

test("lost Printify response is recovered without a duplicate order", async () => {
  S.createMode = "lose-response-once";
  const { order, body, sig } = await paidOrder();
  assert.equal((await processStripeWebhook(env, body, sig)).status, 200);
  assert.equal(S.orders.length, 1, "no duplicate created");
  assert.equal(S.createCalls, 1);
  assert.equal((await getOrder(env, order.id))!.printify_order_id, "pf_1");
});

test("Printify outage: webhook 500s (Stripe retries), admin alerted, cron sweep recovers", async () => {
  S.createMode = "fail-500";
  const { order, body, sig } = await paidOrder();
  const res = await processStripeWebhook(env, body, sig);
  assert.equal(res.status, 500);
  let o = (await getOrder(env, order.id))!;
  assert.equal(o.status, "submit_failed");
  assert.ok(o.last_error?.includes("502"));
  assert.ok(S.emails.some((e) => e.to[0] === "owner@example.com" && e.subject.includes("failed to reach Printify")));

  S.createMode = "ok";
  const sweep = await sweepOrders(env);
  assert.equal(sweep.retriedOk, 1);
  o = (await getOrder(env, order.id))!;
  assert.equal(o.status, "submitted");
  assert.equal(S.orders.length, 1);

  // Stripe's redelivery afterwards is harmless.
  assert.equal((await processStripeWebhook(env, body, sig)).status, 200);
  assert.equal(S.orders.length, 1);
});

test("permanent Printify 400 is not hammered and is surfaced", async () => {
  S.createMode = "fail-400";
  const { order, body, sig } = await paidOrder();
  await processStripeWebhook(env, body, sig);
  assert.equal(S.createCalls, 1, "4xx not retried inside a single attempt");
  const o = (await getOrder(env, order.id))!;
  assert.equal(o.status, "submit_failed");
  assert.ok(o.last_error?.includes("zip invalid"));
});

test("concurrent submissions for one order produce one Printify order", async () => {
  const { order, body, sig } = await paidOrder();
  S.createMode = "fail-500";
  await processStripeWebhook(env, body, sig); // leaves it paid→submit_failed
  S.createMode = "ok";
  const results = await Promise.all([submitToPrintify(env, order.id, "a"), submitToPrintify(env, order.id, "b"), submitToPrintify(env, order.id, "c")]);
  assert.equal(S.orders.length, 1);
  assert.equal(results.filter((r) => r.ok && !r.already).length, 1);
});

// ── Printify webhooks → shipping ───────────────────────────────────────────
test("Printify shipment webhook → shipped + tracking + one email; forged webhook rejected", async () => {
  const { order, body, sig } = await paidOrder();
  await processStripeWebhook(env, body, sig);
  S.orders[0].status = "fulfilled";
  S.orders[0].shipments = [{ carrier: "usps", number: "9400100000000000000000", url: "https://tools.usps.com/x", delivered_at: null }];

  const hook = JSON.stringify({ id: "wh_evt_1", type: "order:shipment:created", resource: { id: "pf_1", type: "order", data: {} } });
  const url = new URL(`https://brytely.test/api/webhooks/printify?token=${PFSEC}`);
  const pfSig = "sha256=" + (await hmacSha256Hex(PFSEC, hook));

  assert.equal((await processPrintifyWebhook(env, hook, new URL("https://brytely.test/api/webhooks/printify?token=nope"), pfSig)).status, 401);
  assert.equal((await processPrintifyWebhook(env, hook, url, "sha256=bad")).status, 401);

  assert.equal((await processPrintifyWebhook(env, hook, url, pfSig)).status, 200);
  const o = (await getOrder(env, order.id))!;
  assert.equal(o.status, "shipped");
  assert.equal(JSON.parse(o.tracking_json)[0].number, "9400100000000000000000");
  const shippedEmails = () => S.emails.filter((e) => e.subject.includes("has shipped")).length;
  assert.equal(shippedEmails(), 1);

  // A different, later webhook for the same order must not re-send; an old status must not downgrade.
  S.orders[0].status = "in-production";
  const hook2 = hook.replace("wh_evt_1", "wh_evt_2").replace("shipment:created", "updated");
  await processPrintifyWebhook(env, hook2, url, "sha256=" + (await hmacSha256Hex(PFSEC, hook2)));
  assert.equal((await getOrder(env, order.id))!.status, "shipped");
  assert.equal(shippedEmails(), 1);

  // Customer lookup
  const pub = await lookupOrder(env, order.number.toLowerCase(), "jamie@example.com");
  assert.equal(pub?.status, "shipped");
  assert.equal(pub?.tracking.length, 1);
  assert.equal(await lookupOrder(env, order.number, "someone@else.com"), null);
});

test("Printify 'Publish' button → product imported and publishing_succeeded called", async () => {
  S.products.push(product("p_new", "Brand New Design", ["Books"]));
  const hook = JSON.stringify({ id: "wh_pub_1", type: "product:publish:started", resource: { id: "p_new", type: "product", data: {} } });
  const url = new URL(`https://brytely.test/api/webhooks/printify?token=${PFSEC}`);
  assert.equal((await processPrintifyWebhook(env, hook, url, null)).status, 200);
  assert.deepEqual(S.publishSucceeded, ["p_new"]);
  assert.ok(await getProductByHandle(env, "brand-new-design"));
});

test("webhook registration is idempotent", async () => {
  const first = await registerPrintifyWebhooks(env);
  assert.ok(first.every((r) => r.action === "created"));
  const second = await registerPrintifyWebhooks(env);
  assert.ok(second.every((r) => r.action === "exists"));
  assert.ok(S.webhooks[0].url.startsWith("https://brytely.test/api/webhooks/printify?token="));
});

test("sanitizer strips executable markup", () => {
  assert.equal(sanitizeHtml(`<p style="x">a<img src=x onerror=alert(1)></p><iframe src=y></iframe>`), "<p>a</p>");
});
