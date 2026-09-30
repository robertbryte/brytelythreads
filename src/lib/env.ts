/**
 * Runtime environment for the Worker.
 *
 * The Cloudflare binding interfaces below are deliberately minimal structural
 * types (the subset this app uses) so the core library has no hard dependency
 * on @cloudflare/workers-types and can be unit-tested against SQLite locally.
 * The real D1/KV/R2 bindings satisfy these shapes.
 */

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: { changes: number; last_row_id?: number };
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface KVNamespace {
  get(key: string, type: "json"): Promise<unknown>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface R2ObjectBody {
  body: ReadableStream;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
}
export interface R2Bucket {
  head(key: string): Promise<unknown | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ArrayBuffer | ReadableStream,
    opts?: { httpMetadata?: { contentType?: string; cacheControl?: string } },
  ): Promise<unknown>;
}

export interface Env {
  // Bindings
  DB: D1Database;
  CATALOG_CACHE?: KVNamespace;
  MEDIA?: R2Bucket;

  // Secrets (set with `wrangler secret put`, never committed)
  PRINTIFY_API_TOKEN: string;
  PRINTIFY_SHOP_ID: string;
  PRINTIFY_WEBHOOK_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  RESEND_API_KEY?: string;

  // Plain config vars (wrangler.jsonc "vars")
  SITE_URL: string;                     // e.g. https://brytelythreads.shop
  EMAIL_FROM?: string;                  // e.g. "Brytely Threads <orders@brytelythreads.shop>"
  ADMIN_ALERT_EMAIL?: string;           // where failed-order alerts go
  PRINTIFY_SEND_TO_PRODUCTION?: string; // "true" in live mode; "false" keeps test orders on hold
  PRINTIFY_SHIPPING_METHOD?: string;    // 1 = standard, 2 = priority, 3 = express, 4 = economy
  CATALOG_MODE?: string;                // "all_visible" (default) | "published_only"
  SHIPPING_RATES?: string;              // JSON, see lib/shipping.ts
  SHIPPING_COUNTRIES?: string;          // comma list, default "US"
  STRIPE_AUTOMATIC_TAX?: string;        // "true" to enable Stripe Tax
  MIRROR_IMAGES?: string;               // "true" to copy mockups into R2
  MAX_IMAGES_PER_PRODUCT?: string;      // default 10
}

export function flag(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
}

export function requireEnv(env: Env, keys: (keyof Env)[]): void {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
