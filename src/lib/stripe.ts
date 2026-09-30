/**
 * Minimal Stripe REST client + webhook signature verification using WebCrypto.
 * Uses fetch directly (no Node SDK) so it runs natively on Workers.
 * Card data never touches this app — customers pay on Stripe's hosted Checkout page.
 */
import { fetchWithRetry, hmacSha256Hex, safeEqual } from "./util";

const API = "https://api.stripe.com/v1";
const API_VERSION = "2025-03-31.basil";

/** Encodes nested objects/arrays in Stripe's form style: a[b][0][c]=d */
export function formEncode(obj: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  const walk = (val: unknown, key: string) => {
    if (val === undefined || val === null) return;
    if (Array.isArray(val)) val.forEach((v, i) => walk(v, `${key}[${i}]`));
    else if (typeof val === "object") for (const [k, v] of Object.entries(val as object)) walk(v, `${key}[${k}]`);
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
  };
  for (const [k, v] of Object.entries(obj)) walk(v, prefix ? `${prefix}[${k}]` : k);
  return parts.join("&");
}

export interface StripeAddress {
  line1?: string | null; line2?: string | null; city?: string | null;
  state?: string | null; postal_code?: string | null; country?: string | null;
}
export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  client_reference_id: string | null;
  metadata: Record<string, string>;
  amount_subtotal: number | null;
  amount_total: number | null;
  currency: string | null;
  payment_intent: string | null;
  customer_details?: { email?: string | null; name?: string | null; phone?: string | null; address?: StripeAddress | null } | null;
  // API ≥ 2025-03-31 moves shipping here; older versions use shipping_details.
  collected_information?: { shipping_details?: { name?: string | null; address?: StripeAddress | null } | null } | null;
  shipping_details?: { name?: string | null; address?: StripeAddress | null } | null;
  shipping_cost?: { amount_total: number } | null;
  total_details?: { amount_tax?: number; amount_shipping?: number } | null;
}
export interface StripeEvent<T = unknown> {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: T };
}

export class Stripe {
  constructor(private secretKey: string) {}

  private async call<T>(method: "GET" | "POST", path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      "Stripe-Version": API_VERSION,
    };
    let url = `${API}${path}`;
    let body: string | undefined;
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = params ? formEncode(params) : "";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    } else if (params) {
      url += "?" + formEncode(params);
    }
    const res = await fetchWithRetry(url, { method, headers, body }, { label: `stripe.${method} ${path}` });
    return (await res.json()) as T;
  }

  createCheckoutSession(params: Record<string, unknown>, idempotencyKey: string) {
    return this.call<StripeCheckoutSession>("POST", "/checkout/sessions", params, idempotencyKey);
  }

  retrieveCheckoutSession(id: string) {
    return this.call<StripeCheckoutSession>("GET", `/checkout/sessions/${encodeURIComponent(id)}`);
  }
}

/**
 * Verifies the `Stripe-Signature` header (t=…,v1=…) against the raw body.
 * Rejects events older than `toleranceSec` to block replays.
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;
  let t = "";
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t") t = v;
    else if (k === "v1") v1.push(v);
  }
  const ts = Number(t);
  if (!t || !Number.isFinite(ts) || v1.length === 0) return false;
  if (Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  return v1.some((sig) => safeEqual(sig, expected));
}

/** Test helper / docs: produce a valid signature header. */
export async function signStripePayload(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${rawBody}`)}`;
}
