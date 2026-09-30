import type { Metadata } from "next";
import { Fragment } from "react";
import { adminDashboard, orderEvents } from "@/lib/admin";
import { isAdmin } from "@/lib/admin-guard";
import { getEnv } from "@/lib/cf";
import { flag } from "@/lib/env";
import { formatMoney } from "@/lib/util";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

const STATUS_TONE: Record<string, string> = {
  submit_failed: "var(--bad)", submitting: "var(--warn)", paid: "var(--warn)",
  submitted: "var(--ink-2)", in_production: "var(--ink-2)", shipped: "var(--ok)", delivered: "var(--ok)",
  canceled: "var(--muted)", expired: "var(--muted)", refunded: "var(--muted)",
};

function Pill({ status }: { status: string }) {
  return (
    <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, whiteSpace: "nowrap" }}>
      <i style={{ width: 8, height: 8, borderRadius: 9, background: STATUS_TONE[status] ?? "var(--muted)", display: "block" }} />
      {status.replace(/_/g, " ")}
    </span>
  );
}

const panel: React.CSSProperties = { background: "var(--card)", borderRadius: 10, boxShadow: "0 0 0 1px var(--line)", padding: 20 };
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 14 };
const cell: React.CSSProperties = { padding: "10px 8px", borderBottom: "1px solid var(--line)", textAlign: "left", verticalAlign: "top" };

export default async function Admin({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const env = getEnv();
  if (!(await isAdmin(env))) return <div className="wrap empty">Unauthorized.</div>;
  const { msg } = await searchParams;
  const d = await adminDashboard(env);
  const attentionEvents = await Promise.all(d.needsAttention.slice(0, 10).map((o) => orderEvents(env, o.id)));
  const lastSync = d.syncRuns[0] as { started_at?: string; ok?: number; products_upserted?: number; error?: string } | undefined;
  const liveMode = env.STRIPE_SECRET_KEY?.startsWith("sk_live_");

  return (
    <div className="wrap" style={{ paddingBlock: 32, display: "grid", gap: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "end", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div className="mono muted">Brytely Threads · internal</div>
          <h1 style={{ fontSize: 44, fontWeight: 800, marginTop: 6 }}>Admin</h1>
        </div>
        <div className="mono" style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <span>Stripe: <b style={{ color: liveMode ? "var(--ok)" : "var(--warn)" }}>{liveMode ? "LIVE" : "TEST"}</b></span>
          <span>Auto-send to production: <b>{flag(env.PRINTIFY_SEND_TO_PRODUCTION) ? "ON" : "OFF (orders wait in Printify)"}</b></span>
        </div>
      </header>

      {msg && <div role="status" style={{ ...panel, background: "var(--bright)", color: "var(--on-bright)" }}>{msg}</div>}

      {/* Needs attention first — this is the page's main job */}
      <section style={{ ...panel, boxShadow: d.needsAttention.length ? "0 0 0 2px var(--bad)" : panel.boxShadow }}>
        <h2 style={{ fontSize: 22 }}>Needs attention ({d.needsAttention.length})</h2>
        {d.needsAttention.length === 0 ? (
          <p className="muted" style={{ marginTop: 8 }}>All paid orders have reached Printify.</p>
        ) : (
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={table}>
              <thead><tr>{["Order", "Status", "Attempts", "Last error", "Log", ""].map((h) => <th key={h} style={cell} className="mono">{h}</th>)}</tr></thead>
              <tbody>
                {d.needsAttention.map((o, i) => (
                  <tr key={o.id}>
                    <td style={cell}><b className="num">{o.number}</b><br /><span className="muted">{o.email}</span></td>
                    <td style={cell}><Pill status={o.status} />{o.printify_status && <div className="muted mono" style={{ fontSize: 10 }}>pfy: {o.printify_status}</div>}</td>
                    <td style={cell} className="num">{o.submit_attempts}</td>
                    <td style={{ ...cell, maxWidth: 360 }}><code style={{ fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{o.last_error?.slice(0, 400) ?? "—"}</code></td>
                    <td style={cell}>
                      <details><summary className="mono" style={{ cursor: "pointer" }}>events</summary>
                        <ul style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: 12 }}>
                          {(attentionEvents[i] ?? []).map((e, k) => <li key={k}><span className="muted">{e.created_at.slice(5, 16)}</span> {e.kind}</li>)}
                        </ul>
                      </details>
                    </td>
                    <td style={cell}>
                      <form action="/api/admin/retry" method="post">
                        <input type="hidden" name="orderId" value={o.id} />
                        <button className="btn btn--sm" type="submit">Retry</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <div style={panel}>
          <h2 style={{ fontSize: 20 }}>Catalog</h2>
          <p className="muted" style={{ marginTop: 6, fontSize: 14 }}>
            Last sync: {lastSync?.started_at ? `${lastSync.started_at.replace("T", " ").slice(0, 16)} UTC — ${lastSync.ok ? `OK, ${lastSync.products_upserted} products` : "FAILED"}` : "never"}
          </p>
          {lastSync?.error && <pre style={{ fontSize: 11, whiteSpace: "pre-wrap", color: "var(--bad)" }}>{lastSync.error.slice(0, 500)}</pre>}
          <form action="/api/admin/sync" method="post" style={{ marginTop: 14 }}><button className="btn btn--sm" type="submit">Sync from Printify now</button></form>
        </div>
        <div style={panel}>
          <h2 style={{ fontSize: 20 }}>Printify webhooks</h2>
          <p className="muted" style={{ marginTop: 6, fontSize: 14 }}>Run once after deploying, and again after changing the domain or webhook secret. Safe to repeat.</p>
          <form action="/api/admin/webhooks" method="post" style={{ marginTop: 14 }}><button className="btn btn--sm btn--ghost" type="submit">Register webhooks</button></form>
        </div>
        <div style={panel}>
          <h2 style={{ fontSize: 20 }}>Orders by status</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6, marginTop: 10, fontSize: 14 }}>
            {Object.entries(d.statusCounts).map(([s, n]) => (<Fragment key={s}><Pill status={s} /><span className="num">{n}</span></Fragment>))}
          </div>
        </div>
      </section>

      <section style={panel}>
        <h2 style={{ fontSize: 20 }}>Recent orders</h2>
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={table}>
            <thead><tr>{["Order", "Placed", "Customer", "Total", "Status", "Printify", "Tracking"].map((h) => <th key={h} style={cell} className="mono">{h}</th>)}</tr></thead>
            <tbody>
              {d.orders.map((o) => {
                const tracking = JSON.parse(o.tracking_json || "[]") as { number: string; url: string }[];
                return (
                  <tr key={o.id}>
                    <td style={cell} className="num"><b>{o.number}</b></td>
                    <td style={cell} className="muted">{o.created_at.slice(0, 16).replace("T", " ")}</td>
                    <td style={cell}>{o.customer_name}<br /><span className="muted">{o.email}</span></td>
                    <td style={cell} className="num">{formatMoney(o.total, o.currency)}</td>
                    <td style={cell}><Pill status={o.status} /></td>
                    <td style={cell} className="mono" >{o.printify_order_id ?? "—"}</td>
                    <td style={cell}>{tracking.map((t) => <a key={t.number} href={t.url} target="_blank" rel="noreferrer">{t.number}</a>)}</td>
                  </tr>
                );
              })}
              {d.orders.length === 0 && <tr><td style={cell} colSpan={7} className="muted">No orders yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section style={panel}>
        <h2 style={{ fontSize: 20 }}>Collections (tags)</h2>
        <p className="muted" style={{ marginTop: 6, fontSize: 14 }}>
          Tags come from Printify. Visible tags appear as collections in the shop. Add a tag in Printify, sync, and it shows up here.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
          {d.tags.map((t) => (
            <form key={t.id} action="/api/admin/tag" method="post">
              <input type="hidden" name="tagId" value={t.id} />
              <input type="hidden" name="visible" value={t.show_in_nav ? "0" : "1"} />
              <button type="submit" className="woven" aria-pressed={!!t.show_in_nav} title={t.show_in_nav ? "Click to hide" : "Click to show"}
                style={t.show_in_nav ? { background: "var(--ink)", color: "var(--paper)" } : { opacity: 0.6 }}>
                {t.name} <span className="woven__count">{t.products}</span>
              </button>
            </form>
          ))}
        </div>
      </section>

      <section style={panel}>
        <h2 style={{ fontSize: 20 }}>Products</h2>
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={table}>
            <thead><tr>{["Product", "From", "State", "Featured", "Visible"].map((h) => <th key={h} style={cell} className="mono">{h}</th>)}</tr></thead>
            <tbody>
              {d.products.map((p) => (
                <tr key={p.id} style={p.deleted ? { opacity: 0.45 } : undefined}>
                  <td style={cell}><a href={`/products/${p.handle}`}>{p.title}</a></td>
                  <td style={cell} className="num">{formatMoney(p.min_price)}</td>
                  <td style={cell} className="mono" >{p.deleted ? "deleted in printify" : !p.printify_visible ? "hidden in printify" : p.published ? "published" : "synced"}</td>
                  {(["featured", "hidden"] as const).map((field) => {
                    const on = field === "featured" ? !!p.featured : !p.hidden;
                    return (
                      <td style={cell} key={field}>
                        <form action="/api/admin/product" method="post">
                          <input type="hidden" name="productId" value={p.id} />
                          <input type="hidden" name="field" value={field} />
                          <input type="hidden" name="value" value={field === "featured" ? (p.featured ? "0" : "1") : (p.hidden ? "0" : "1")} />
                          <button type="submit" className="btn btn--sm btn--ghost" style={{ minHeight: 30 }}>{on ? "Yes" : "No"}</button>
                        </form>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
