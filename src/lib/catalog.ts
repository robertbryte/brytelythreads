/**
 * Catalog: Printify → D1 sync, and cached reads for the storefront.
 * The storefront never calls Printify on page load — it reads D1, with the
 * listing index cached in KV.
 */
import type { Env } from "./env";
import { flag } from "./env";
import { Printify, type PfProduct } from "./printify";
import { sanitizeHtml } from "./sanitize";
import { log, nowIso, sha256Hex, slugify } from "./util";

// ── Storefront types ────────────────────────────────────────────────────────
import { imageUrl, type ProductImage } from "./images";
export { imageUrl, type ProductImage };
export interface ProductOption { name: string; type: string; values: { id: number; title: string; colors?: string[] }[] }
export interface ProductVariant { id: number; title: string; price: number; optionIds: number[]; available: boolean; isDefault: boolean }
export interface Tag { slug: string; name: string; count?: number }

export interface ProductSummary {
  id: string;
  handle: string;
  title: string;
  image: string | null;
  hoverImage: string | null;
  minPrice: number;
  maxPrice: number;
  colors: string[];      // swatch hexes
  tags: string[];        // slugs
  featured: boolean;
  createdAt: string | null;
}
export interface ProductDetail extends Omit<ProductSummary, "tags"> {
  description: string;
  images: ProductImage[];
  options: ProductOption[];
  variants: ProductVariant[];
  tags: Tag[];
}
export interface CatalogIndex { products: ProductSummary[]; tags: Tag[]; generatedAt: string }

const INDEX_KEY = "catalog:index:v1";

/**
 * Printify auto-adds generic tags (garment type, print method, holidays).
 * They're still stored, just not shown in the shop filter bar by default.
 * Toggle any tag on/off in /admin — no code change needed.
 */
const GENERIC_TAGS = new Set(
  [
    "t-shirts", "t-shirt", "tshirts", "tees", "dtg", "crew-neck", "mens-clothing", "womens-clothing", "unisex",
    "cotton", "regular-fit", "sustainable", "eco-friendly", "valentines-day-picks", "holiday-picks",
    "fathers-day-picks", "mothers-day-picks", "back-to-school", "streetwear", "sleeves", "made-in-usa",
    "neck-labels", "printify", "hoodies", "sweatshirts", "long-sleeves", "kids-clothing", "vegan",
  ],
);

function visibilitySql(env: Env) {
  const publishedOnly = env.CATALOG_MODE === "published_only";
  return `p.deleted = 0 AND p.hidden = 0 AND p.printify_visible = 1 ${publishedOnly ? "AND p.published = 1" : ""}
          AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.is_enabled = 1)`;
}

// ── Reads ───────────────────────────────────────────────────────────────────
interface ProductRow {
  id: string; handle: string; title: string; description: string; images_json: string; options_json: string;
  min_price: number; max_price: number; featured: number; printify_created_at: string | null; tag_slugs: string | null;
}

function colorSwatches(options: ProductOption[]): string[] {
  const color = options.find((o) => o.type === "color");
  if (!color) return [];
  return color.values.map((v) => v.colors?.[0]).filter((c): c is string => !!c).slice(0, 8);
}

function toSummary(r: ProductRow): ProductSummary {
  const images = JSON.parse(r.images_json) as ProductImage[];
  const options = JSON.parse(r.options_json) as ProductOption[];
  const def = images.find((i) => i.isDefault) ?? images[0];
  const hover = images.find((i) => i !== def && i.position !== def?.position && i.variantIds.some((v) => def?.variantIds.includes(v)))
    ?? images.find((i) => i !== def);
  return {
    id: r.id,
    handle: r.handle,
    title: r.title,
    image: def ? imageUrl(def) : null,
    hoverImage: hover ? imageUrl(hover) : null,
    minPrice: r.min_price,
    maxPrice: r.max_price,
    colors: colorSwatches(options),
    tags: r.tag_slugs ? r.tag_slugs.split(",") : [],
    featured: !!r.featured,
    createdAt: r.printify_created_at,
  };
}

async function buildIndex(env: Env): Promise<CatalogIndex> {
  const { results } = await env.DB.prepare(
    `SELECT p.*, (SELECT group_concat(t.slug) FROM product_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.product_id = p.id) AS tag_slugs
       FROM products p WHERE ${visibilitySql(env)}
      ORDER BY p.featured DESC, p.sort_order ASC, p.printify_created_at DESC`,
  ).all<ProductRow>();
  const products = results.map(toSummary);

  const { results: tagRows } = await env.DB.prepare(
    `SELECT slug, name FROM tags WHERE show_in_nav = 1 ORDER BY sort_order ASC, name ASC LIMIT 5`,
  ).all<{ slug: string; name: string }>();
  const counts = new Map<string, number>();
  for (const p of products) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const tags = tagRows.filter((t) => counts.has(t.slug)).map((t) => ({ ...t, count: counts.get(t.slug) }));

  return { products, tags, generatedAt: nowIso() };
}

export async function getCatalogIndex(env: Env): Promise<CatalogIndex> {
  if (env.CATALOG_CACHE) {
    try {
      const cached = (await env.CATALOG_CACHE.get(INDEX_KEY, "json")) as CatalogIndex | null;
      if (cached) return cached;
    } catch (e) {
      log("warn", "KV read failed; falling back to D1", { error: String(e) });
    }
  }
  const index = await buildIndex(env);
  if (env.CATALOG_CACHE) {
    await env.CATALOG_CACHE.put(INDEX_KEY, JSON.stringify(index), { expirationTtl: 60 * 60 * 6 }).catch(() => {});
  }
  return index;
}

export async function invalidateCatalog(env: Env) {
  if (env.CATALOG_CACHE) await env.CATALOG_CACHE.delete(INDEX_KEY).catch(() => {});
}

export async function getProductByHandle(env: Env, handle: string): Promise<ProductDetail | null> {
  const row = await env.DB.prepare(
    `SELECT p.*, NULL AS tag_slugs FROM products p WHERE p.handle = ? AND ${visibilitySql(env)}`,
  ).bind(handle).first<ProductRow>();
  if (!row) return null;
  const [{ results: variants }, { results: tags }] = await Promise.all([
    env.DB.prepare(
      `SELECT id, title, price, option_ids_json, is_available, is_default FROM variants
        WHERE product_id = ? AND is_enabled = 1 ORDER BY price ASC, id ASC`,
    ).bind(row.id).all<{ id: number; title: string; price: number; option_ids_json: string; is_available: number; is_default: number }>(),
    env.DB.prepare(
      `SELECT t.slug, t.name FROM product_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.product_id = ? AND t.show_in_nav = 1 ORDER BY t.name`,
    ).bind(row.id).all<Tag>(),
  ]);
  const summary = toSummary(row);
  return {
    ...summary,
    description: row.description,
    images: JSON.parse(row.images_json),
    options: JSON.parse(row.options_json),
    variants: variants.map((v) => ({
      id: v.id, title: v.title, price: v.price, optionIds: JSON.parse(v.option_ids_json),
      available: !!v.is_available, isDefault: !!v.is_default,
    })),
    tags,
  };
}

export async function getBestSellerIds(env: Env, limit = 8): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT oi.product_id, SUM(oi.quantity) AS qty FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status NOT IN ('pending_payment','expired','canceled','refunded')
        AND o.created_at > datetime('now', '-90 days')
      GROUP BY oi.product_id ORDER BY qty DESC LIMIT ?`,
  ).bind(limit).all<{ product_id: string }>();
  return results.map((r) => r.product_id);
}

// ── Sync (Printify → D1) ────────────────────────────────────────────────────

async function resolveHandle(env: Env, p: PfProduct): Promise<string> {
  const existing = await env.DB.prepare(`SELECT handle FROM products WHERE id = ?`).bind(p.id).first<{ handle: string }>();
  if (existing) return existing.handle; // keep URLs stable even if the title changes
  const base = slugify(p.title);
  const clash = await env.DB.prepare(`SELECT id FROM products WHERE handle = ?`).bind(base).first();
  return clash ? `${base}-${p.id.slice(-6).toLowerCase()}` : base;
}

async function mirrorImage(env: Env, productId: string, src: string): Promise<string | undefined> {
  if (!env.MEDIA) return undefined;
  const key = `mockups/${productId}/${(await sha256Hex(src)).slice(0, 20)}.jpg`;
  try {
    if (await env.MEDIA.head(key)) return key;
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await env.MEDIA.put(key, await res.arrayBuffer(), {
      httpMetadata: { contentType: res.headers.get("content-type") || "image/jpeg", cacheControl: "public, max-age=31536000, immutable" },
    });
    return key;
  } catch (e) {
    log("warn", "image mirror failed; using Printify URL", { productId, src, error: String(e) });
    return undefined;
  }
}

export async function upsertProduct(env: Env, p: PfProduct, opts: { published?: boolean } = {}): Promise<{ imagesMirrored: number }> {
  const enabled = p.variants.filter((v) => v.is_enabled);
  const enabledIds = new Set(enabled.map((v) => v.id));
  const prices = enabled.map((v) => v.price);

  // Only keep option values actually used by enabled variants (Printify includes the whole blueprint).
  const usedValueIds = new Set(enabled.flatMap((v) => v.options));
  const options: ProductOption[] = p.options
    .map((o) => ({ name: o.name, type: o.type, values: o.values.filter((v) => usedValueIds.has(v.id)).map((v) => ({ id: v.id, title: v.title, colors: v.colors })) }))
    .filter((o) => o.values.length > 0);

  // Keep images that belong to enabled variants, default first.
  const imgs = p.images
    .filter((i) => i.variant_ids.some((id) => enabledIds.has(id)))
    .sort((a, b) => Number(b.is_default) - Number(a.is_default));
  const seen = new Set<string>();
  const images: ProductImage[] = [];
  for (const i of imgs) {
    if (seen.has(i.src)) continue;
    seen.add(i.src);
    images.push({ src: i.src, variantIds: i.variant_ids.filter((id) => enabledIds.has(id)), position: i.position, isDefault: i.is_default });
  }

  let imagesMirrored = 0;
  if (flag(env.MIRROR_IMAGES) && env.MEDIA) {
    const limit = Number(env.MAX_IMAGES_PER_PRODUCT || 10);
    for (const img of images.slice(0, limit)) {
      img.r2Key = await mirrorImage(env, p.id, img.src);
      if (img.r2Key) imagesMirrored++;
    }
  }

  const handle = await resolveHandle(env, p);
  const now = nowIso();
  const published = opts.published || !!(p.external && (p.external.id || p.external.handle));

  const stmts = [
    env.DB.prepare(
      `INSERT INTO products (id, handle, title, description, images_json, options_json, min_price, max_price,
                             printify_visible, published, deleted, printify_created_at, printify_updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, description = excluded.description, images_json = excluded.images_json,
         options_json = excluded.options_json, min_price = excluded.min_price, max_price = excluded.max_price,
         printify_visible = excluded.printify_visible, published = MAX(products.published, excluded.published),
         deleted = 0, printify_updated_at = excluded.printify_updated_at, synced_at = excluded.synced_at`,
    ).bind(
      p.id, handle, p.title, sanitizeHtml(p.description), JSON.stringify(images), JSON.stringify(options),
      prices.length ? Math.min(...prices) : 0, prices.length ? Math.max(...prices) : 0,
      p.visible === false ? 0 : 1, published ? 1 : 0, p.created_at ?? null, p.updated_at ?? null, now,
    ),
    env.DB.prepare(`DELETE FROM variants WHERE product_id = ?`).bind(p.id),
    ...p.variants.map((v) =>
      env.DB.prepare(
        `INSERT INTO variants (id, product_id, title, sku, price, option_ids_json, is_enabled, is_available, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(v.id, p.id, v.title, v.sku ?? null, v.price, JSON.stringify(v.options), v.is_enabled ? 1 : 0,
        v.is_available === false ? 0 : 1, v.is_default ? 1 : 0),
    ),
    env.DB.prepare(`DELETE FROM product_tags WHERE product_id = ?`).bind(p.id),
  ];

  const tagNames = Array.from(new Set((p.tags ?? []).map((t) => t.trim()).filter(Boolean)));
  for (const name of tagNames) {
    const slug = slugify(name);
    stmts.push(
      env.DB.prepare(`INSERT INTO tags (slug, name, show_in_nav, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING`)
        .bind(slug, name, GENERIC_TAGS.has(slug) ? 0 : 1, now),
      env.DB.prepare(`INSERT OR IGNORE INTO product_tags (product_id, tag_id) SELECT ?, id FROM tags WHERE slug = ?`).bind(p.id, slug),
    );
  }
  await env.DB.batch(stmts);
  return { imagesMirrored };
}

export async function markProductDeleted(env: Env, productId: string) {
  await env.DB.prepare(`UPDATE products SET deleted = 1, synced_at = ? WHERE id = ?`).bind(nowIso(), productId).run();
}

export interface SyncResult { ok: boolean; seen: number; upserted: number; removed: number; imagesMirrored: number; error?: string; runId: number }

/** Full catalog sync. Called by the cron trigger and the admin "Sync now" button. */
export async function syncCatalog(env: Env, trigger: "cron" | "admin" | "webhook"): Promise<SyncResult> {
  const run = await env.DB.prepare(`INSERT INTO sync_runs (trigger, started_at) VALUES (?, ?)`).bind(trigger, nowIso()).run();
  const runId = Number(run.meta.last_row_id ?? 0);
  const result: SyncResult = { ok: false, seen: 0, upserted: 0, removed: 0, imagesMirrored: 0, runId };
  try {
    const pf = Printify.fromEnv(env);
    const products = await pf.listAllProducts();
    result.seen = products.length;

    const failures: string[] = [];
    for (const p of products) {
      try {
        const r = await upsertProduct(env, p);
        result.upserted++;
        result.imagesMirrored += r.imagesMirrored;
      } catch (e) {
        failures.push(`${p.id}: ${String(e)}`);
        log("error", "product upsert failed", { productId: p.id, error: String(e) });
      }
    }

    // Anything we have locally that Printify no longer returns → soft delete.
    // Guard: never wipe the catalog because Printify returned an empty page by mistake.
    if (products.length > 0) {
      const ids = new Set(products.map((p) => p.id));
      const { results } = await env.DB.prepare(`SELECT id FROM products WHERE deleted = 0`).all<{ id: string }>();
      for (const r of results) {
        if (!ids.has(r.id)) {
          await markProductDeleted(env, r.id);
          result.removed++;
        }
      }
    }
    await invalidateCatalog(env);
    result.ok = failures.length === 0;
    if (failures.length) result.error = failures.slice(0, 10).join("\n");
  } catch (e) {
    result.error = String(e);
    log("error", "catalog sync failed", { error: result.error });
  }
  await env.DB.prepare(
    `UPDATE sync_runs SET finished_at = ?, ok = ?, products_seen = ?, products_upserted = ?, products_removed = ?, images_mirrored = ?, error = ? WHERE id = ?`,
  ).bind(nowIso(), result.ok ? 1 : 0, result.seen, result.upserted, result.removed, result.imagesMirrored, result.error ?? null, runId).run();
  log(result.ok ? "info" : "error", "catalog sync finished", { ...result });
  return result;
}
