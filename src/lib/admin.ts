import type { Env } from "./env";
import { invalidateCatalog } from "./catalog";
import type { OrderRow } from "./orders";

export async function adminDashboard(env: Env) {
  const [orders, needsAttention, runs, counts, tags, products] = await Promise.all([
    env.DB.prepare(`SELECT * FROM orders WHERE status != 'pending_payment' ORDER BY created_at DESC LIMIT 50`).all<OrderRow>(),
    env.DB.prepare(
      `SELECT * FROM orders WHERE status IN ('paid','submitting','submit_failed') OR (last_error IS NOT NULL AND status NOT IN ('canceled','refunded','expired'))
        OR printify_status = 'has-issues' ORDER BY created_at ASC LIMIT 50`,
    ).all<OrderRow>(),
    env.DB.prepare(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT 10`).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM orders GROUP BY status`).all<{ status: string; n: number }>(),
    env.DB.prepare(
      `SELECT t.id, t.slug, t.name, t.show_in_nav, t.sort_order, COUNT(pt.product_id) AS products
         FROM tags t LEFT JOIN product_tags pt ON pt.tag_id = t.id GROUP BY t.id ORDER BY t.show_in_nav DESC, products DESC`,
    ).all<{ id: number; slug: string; name: string; show_in_nav: number; sort_order: number; products: number }>(),
    env.DB.prepare(
      `SELECT id, handle, title, hidden, featured, deleted, printify_visible, published, min_price FROM products ORDER BY deleted ASC, featured DESC, title ASC`,
    ).all<{ id: string; handle: string; title: string; hidden: number; featured: number; deleted: number; printify_visible: number; published: number; min_price: number }>(),
  ]);
  return {
    orders: orders.results, needsAttention: needsAttention.results, syncRuns: runs.results,
    statusCounts: Object.fromEntries(counts.results.map((c) => [c.status, c.n])),
    tags: tags.results, products: products.results,
  };
}

export async function orderEvents(env: Env, orderId: string) {
  return (await env.DB.prepare(`SELECT kind, detail, created_at FROM order_events WHERE order_id = ? ORDER BY id DESC LIMIT 50`)
    .bind(orderId).all<{ kind: string; detail: string | null; created_at: string }>()).results;
}

export async function setTagVisible(env: Env, tagId: number, visible: boolean) {
  await env.DB.prepare(`UPDATE tags SET show_in_nav = ? WHERE id = ?`).bind(visible ? 1 : 0, tagId).run();
  await invalidateCatalog(env);
}

export async function setProductFlag(env: Env, productId: string, field: "hidden" | "featured", value: boolean) {
  const col = field === "hidden" ? "hidden" : "featured"; // whitelist — never interpolate user input
  await env.DB.prepare(`UPDATE products SET ${col} = ? WHERE id = ?`).bind(value ? 1 : 0, productId).run();
  await invalidateCatalog(env);
}
