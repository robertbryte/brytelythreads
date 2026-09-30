/**
 * Transactional email via Resend (https://resend.com). Optional: if
 * RESEND_API_KEY isn't set, emails are logged and skipped — never fatal.
 */
import type { Env } from "./env";
import { fetchWithRetry, formatMoney, log } from "./util";

export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    log("info", "email skipped (RESEND_API_KEY/EMAIL_FROM not configured)", { to, subject });
    return false;
  }
  try {
    await fetchWithRetry(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html }),
      },
      { label: "resend.send", attempts: 3 },
    );
    return true;
  } catch (e) {
    log("error", "email send failed", { to, subject, error: String(e) });
    return false;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function shell(title: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#f6f3ec;font-family:Helvetica,Arial,sans-serif;color:#15140f">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px">
    <div style="font-weight:800;font-size:22px;letter-spacing:-.02em">Brytely Threads<span style="color:#e6b800">.</span></div>
    <div style="font-size:12px;color:#6b675c;margin-bottom:28px">a little brighter, thread by thread</div>
    <h1 style="font-size:24px;margin:0 0 16px">${esc(title)}</h1>
    ${body}
  </div></body></html>`;
}

export interface EmailOrder {
  number: string;
  email: string;
  customerName?: string | null;
  total: number;
  currency: string;
  items: { title: string; variantTitle: string; quantity: number }[];
}

export function orderConfirmationEmail(env: Env, o: EmailOrder) {
  const lines = o.items.map((i) => `<li>${esc(i.title)} — ${esc(i.variantTitle)} × ${i.quantity}</li>`).join("");
  return shell(
    `Thanks${o.customerName ? `, ${esc(o.customerName.split(" ")[0])}` : ""}! Order ${o.number} is in.`,
    `<p>Your shirts are printed to order, usually within 2–5 business days, then shipped. We'll email tracking as soon as it leaves the print shop.</p>
     <ul>${lines}</ul><p><strong>Total: ${formatMoney(o.total, o.currency)}</strong></p>
     <p><a href="${env.SITE_URL}/orders?number=${encodeURIComponent(o.number)}" style="color:#15140f">Check order status →</a></p>`,
  );
}

export function shippedEmail(env: Env, o: EmailOrder, tracking: { carrier: string; number: string; url: string }[]) {
  const t = tracking
    .map((s) => `<li>${esc(s.carrier.toUpperCase())}: <a href="${esc(s.url)}" style="color:#15140f">${esc(s.number)}</a></li>`)
    .join("");
  return shell(
    `Order ${o.number} has shipped`,
    `<p>Good news — it's on the way.</p><ul>${t}</ul>
     <p><a href="${env.SITE_URL}/orders?number=${encodeURIComponent(o.number)}" style="color:#15140f">Order status →</a></p>`,
  );
}

export async function alertAdmin(env: Env, subject: string, detail: string) {
  log("error", `ADMIN ALERT: ${subject}`, { detail });
  if (env.ADMIN_ALERT_EMAIL) {
    await sendEmail(env, env.ADMIN_ALERT_EMAIL, `[Brytely] ${subject}`, shell(subject, `<pre style="white-space:pre-wrap;font-size:12px">${esc(detail)}</pre>
      <p><a href="${env.SITE_URL}/admin">Open admin →</a></p>`));
  }
}
