/** Small shared helpers: logging, time, ids, crypto, retrying fetch. */

export const nowIso = () => new Date().toISOString();

/** Structured JSON logs — visible in `wrangler tail` and Workers Logs. */
export function log(level: "info" | "warn" | "error", msg: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, msg, ...data, t: nowIso() });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Tests set scale to 0 so backoff doesn't slow them down. */
export const retryTiming = { scale: 1 };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * retryTiming.scale));

export function uuid(): string {
  return crypto.randomUUID();
}

/** Customer-facing order number: BT-XXXXXX (no ambiguous chars). */
export function orderNumber(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return "BT-" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

const enc = new TextEncoder();

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
    public retryable: boolean,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface RetryOptions {
  attempts?: number;       // total tries, default 4
  baseDelayMs?: number;    // default 500 → 0.5s, 1s, 2s (+ jitter)
  label: string;           // for logs
  /** Called before each retry (not before the first try). Return a value to short-circuit. */
  beforeRetry?: () => Promise<unknown | undefined>;
}

/**
 * fetch() with timeouts, exponential backoff and logging.
 * Retries: network errors, timeouts, 408, 429 (honours Retry-After), 5xx.
 * Never retries other 4xx — those are bugs/bad input and must surface.
 */
export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOptions): Promise<Response> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 500;
  let lastErr: unknown;

  for (let i = 1; i <= attempts; i++) {
    if (i > 1 && opts.beforeRetry) {
      const short = await opts.beforeRetry();
      if (short !== undefined) {
        return new Response(JSON.stringify(short), { status: 200, headers: { "content-type": "application/json", "x-short-circuit": "1" } });
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return res;

      const body = await res.text();
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      lastErr = new HttpError(`${opts.label}: HTTP ${res.status}`, res.status, body.slice(0, 2000), retryable);
      log(retryable ? "warn" : "error", `${opts.label} failed`, { attempt: i, status: res.status, body: body.slice(0, 500) });
      if (!retryable || i === attempts) throw lastErr;

      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : base * 2 ** (i - 1);
      await sleep(wait + Math.random() * 200);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HttpError) throw err;
      lastErr = err;
      log("warn", `${opts.label} network error`, { attempt: i, error: String(err) });
      if (i === attempts) break;
      await sleep(base * 2 ** (i - 1) + Math.random() * 200);
    }
  }
  if (lastErr instanceof HttpError) throw lastErr;
  throw new HttpError(`${opts.label}: network failure after ${attempts} attempts (${String(lastErr)})`, 0, "", true);
}

export function formatMoney(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}
