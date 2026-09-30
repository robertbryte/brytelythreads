/**
 * Printify Public API client (https://developers.printify.com).
 * Every call goes through fetchWithRetry (backoff + logging). Token and shop id
 * come from env — never hardcoded.
 */
import type { Env } from "./env";
import { fetchWithRetry, HttpError, log } from "./util";

const BASE = "https://api.printify.com/v1";

// ── Types (the subset of Printify's payloads we use) ─────────────────────────
export interface PfOptionValue { id: number; title: string; colors?: string[] }
export interface PfOption { name: string; type: string; values: PfOptionValue[] }
export interface PfVariant {
  id: number;
  sku?: string;
  cost?: number;
  price: number;           // cents
  title: string;
  options: number[];
  is_enabled: boolean;
  is_default: boolean;
  is_available?: boolean;
}
export interface PfImage { src: string; variant_ids: number[]; position: string; is_default: boolean }
export interface PfProduct {
  id: string;
  title: string;
  description: string;
  tags: string[];
  options: PfOption[];
  variants: PfVariant[];
  images: PfImage[];
  created_at?: string;
  updated_at?: string;
  visible: boolean;
  is_locked?: boolean;
  external?: { id?: string; handle?: string } | null;
}
export interface PfPage<T> { current_page: number; last_page: number; data: T[] }

export interface PfAddress {
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  country: string;   // ISO-2
  region: string;    // state / province code
  address1: string;
  address2?: string;
  city: string;
  zip: string;
}
export interface PfOrderRequest {
  external_id: string;
  label?: string;
  line_items: { product_id: string; variant_id: number; quantity: number }[];
  shipping_method: number;
  is_printify_express?: boolean;
  send_shipping_notification: boolean;
  address_to: PfAddress;
}
export interface PfShipment { carrier: string; number: string; url: string; delivered_at?: string | null }
export interface PfOrder {
  id: string;
  external_id?: string;
  status: string; // pending, on-hold, sending-to-production, in-production, canceled, fulfilled, partially-fulfilled, payment-not-received, has-issues
  shipments?: PfShipment[];
  created_at?: string;
  sent_to_production_at?: string | null;
  fulfilled_at?: string | null;
}
export interface PfWebhook { id: string; topic: string; url: string; shop_id?: string }

export class Printify {
  constructor(private token: string, private shopId: string) {}

  static fromEnv(env: Env) {
    if (!env.PRINTIFY_API_TOKEN || !env.PRINTIFY_SHOP_ID) {
      throw new Error("PRINTIFY_API_TOKEN and PRINTIFY_SHOP_ID must be set");
    }
    return new Printify(env.PRINTIFY_API_TOKEN, env.PRINTIFY_SHOP_ID);
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json;charset=utf-8",
      "User-Agent": "BrytelyThreads-Storefront/1.0",
    };
  }

  private async get<T>(path: string, label: string): Promise<T> {
    const res = await fetchWithRetry(`${BASE}${path}`, { headers: this.headers() }, { label });
    return (await res.json()) as T;
  }

  private shop(path: string) {
    return `/shops/${this.shopId}${path}`;
  }

  // ── Shops ──
  listShops() {
    return this.get<{ id: number; title: string; sales_channel: string }[]>("/shops.json", "printify.shops");
  }

  // ── Products ──
  async listAllProducts(): Promise<PfProduct[]> {
    const out: PfProduct[] = [];
    for (let page = 1; page < 200; page++) {
      const res = await this.get<PfPage<PfProduct>>(this.shop(`/products.json?limit=50&page=${page}`), "printify.products.list");
      out.push(...res.data);
      if (res.current_page >= res.last_page || res.data.length === 0) break;
    }
    return out;
  }

  getProduct(productId: string) {
    return this.get<PfProduct>(this.shop(`/products/${productId}.json`), "printify.products.get");
  }

  /** Completes Printify's "Publish" flow for custom API shops. */
  async publishingSucceeded(productId: string, externalId: string, handleUrl: string) {
    await fetchWithRetry(
      `${BASE}${this.shop(`/products/${productId}/publishing_succeeded.json`)}`,
      { method: "POST", headers: this.headers(), body: JSON.stringify({ external: { id: externalId, handle: handleUrl } }) },
      { label: "printify.products.publishing_succeeded" },
    );
  }

  async publishingFailed(productId: string, reason: string) {
    await fetchWithRetry(
      `${BASE}${this.shop(`/products/${productId}/publishing_failed.json`)}`,
      { method: "POST", headers: this.headers(), body: JSON.stringify({ reason }) },
      { label: "printify.products.publishing_failed" },
    );
  }

  // ── Orders ──
  getOrder(orderId: string) {
    return this.get<PfOrder>(this.shop(`/orders/${orderId}.json`), "printify.orders.get");
  }

  /**
   * Looks through recent orders for one with our external_id. Used before any
   * retry of order creation so a POST that succeeded but whose response was
   * lost (timeout, dropped connection) is never submitted twice.
   */
  async findOrderByExternalId(externalId: string, pages = 3): Promise<PfOrder | null> {
    for (let page = 1; page <= pages; page++) {
      const res = await this.get<PfPage<PfOrder>>(this.shop(`/orders.json?limit=50&page=${page}`), "printify.orders.list");
      const hit = res.data.find((o) => o.external_id === externalId);
      if (hit) return hit;
      if (res.current_page >= res.last_page) break;
    }
    return null;
  }

  /**
   * Creates an order. Duplicate-safe: on any retry we first check whether
   * Printify already has an order with this external_id.
   */
  async createOrder(body: PfOrderRequest): Promise<{ id: string; recovered: boolean }> {
    let recovered = false;
    const res = await fetchWithRetry(
      `${BASE}${this.shop("/orders.json")}`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      {
        label: "printify.orders.create",
        attempts: 4,
        baseDelayMs: 1000,
        beforeRetry: async () => {
          try {
            const existing = await this.findOrderByExternalId(body.external_id);
            if (existing) {
              recovered = true;
              log("warn", "printify order already existed on retry — not resubmitting", { external_id: body.external_id, id: existing.id });
              return { id: existing.id };
            }
          } catch (e) {
            log("warn", "printify duplicate check failed; proceeding with retry", { error: String(e) });
          }
          return undefined;
        },
      },
    );
    const json = (await res.json()) as { id?: string };
    if (!json.id) throw new HttpError("printify.orders.create: response missing id", res.status, JSON.stringify(json), true);
    return { id: json.id, recovered };
  }

  async sendToProduction(orderId: string) {
    await fetchWithRetry(
      `${BASE}${this.shop(`/orders/${orderId}/send_to_production.json`)}`,
      { method: "POST", headers: this.headers() },
      { label: "printify.orders.send_to_production" },
    );
  }

  // ── Webhooks ──
  listWebhooks() {
    return this.get<PfWebhook[]>(this.shop("/webhooks.json"), "printify.webhooks.list");
  }

  async createWebhook(topic: string, url: string, secret: string) {
    const res = await fetchWithRetry(
      `${BASE}${this.shop("/webhooks.json")}`,
      { method: "POST", headers: this.headers(), body: JSON.stringify({ topic, url, secret }) },
      { label: "printify.webhooks.create" },
    );
    return (await res.json()) as PfWebhook;
  }

  async deleteWebhook(id: string, url: string) {
    await fetchWithRetry(
      `${BASE}${this.shop(`/webhooks/${id}.json?host=${encodeURIComponent(new URL(url).host)}`)}`,
      { method: "DELETE", headers: this.headers() },
      { label: "printify.webhooks.delete" },
    );
  }
}

/** Topics we subscribe to. */
export const WEBHOOK_TOPICS = [
  "order:created",
  "order:updated",
  "order:sent-to-production",
  "order:shipment:created",
  "order:shipment:delivered",
  "product:publish:started",
  "product:deleted",
] as const;
