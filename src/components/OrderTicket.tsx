import type { PublicOrder } from "@/lib/orders";
import { formatMoney } from "@/lib/util";

const STEPS = [
  { key: "paid", label: "Paid" },
  { key: "printing", label: "Printing" },
  { key: "shipped", label: "Shipped" },
  { key: "delivered", label: "Delivered" },
] as const;

function stepIndex(status: PublicOrder["status"]): number {
  switch (status) {
    case "paid": case "submitting": case "submit_failed": case "submitted": return 0;
    case "in_production": return 1;
    case "shipped": return 2;
    case "delivered": return 3;
    default: return -1;
  }
}

const HEADLINE: Record<string, string> = {
  paid: "Payment received. Sending it to the print shop.",
  submitting: "Payment received. Sending it to the print shop.",
  submit_failed: "Payment received. We're getting this to the print shop.",
  submitted: "Your order is queued at the print shop.",
  in_production: "Your shirts are being printed.",
  shipped: "It's on the way.",
  delivered: "Delivered. Enjoy!",
  canceled: "This order was canceled.",
  refunded: "This order was refunded.",
  expired: "This checkout wasn't completed.",
  pending_payment: "Waiting for payment confirmation…",
};

export function OrderTicket({ order, heading }: { order: PublicOrder; heading?: string }) {
  const idx = stepIndex(order.status);
  const date = new Date(order.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return (
    <article className="ticket">
      <div className="ticket__top">
        <div className="mono muted">Order</div>
        <div className="ticket__num">{order.number}</div>
        <h1>{heading ?? HEADLINE[order.status] ?? "Order status"}</h1>

        {idx >= 0 && (
          <div className="thread" style={{ ["--p" as string]: idx / (STEPS.length - 1) }} role="list" aria-label="Order progress">
            {STEPS.map((s, i) => (
              <div key={s.key} className="knot" role="listitem" data-done={i < idx} data-current={i === idx} aria-current={i === idx ? "step" : undefined}>
                <i />
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        )}

        {order.tracking.length > 0 && (
          <div className="tracking">
            {order.tracking.map((t) => (
              <a key={t.number} href={t.url} target="_blank" rel="noopener noreferrer">
                <span><span className="mono">{t.carrier}</span> · <span className="num">{t.number}</span></span>
                <span aria-hidden="true">Track →</span>
              </a>
            ))}
          </div>
        )}

        <div className="ticket__meta">
          <div><span className="mono muted">Placed</span><span>{date}</span></div>
          {order.shipTo && <div><span className="mono muted">Ship to</span><span>{order.shipTo.name}<br />{order.shipTo.city}, {order.shipTo.state} {order.shipTo.country}</span></div>}
          <div><span className="mono muted">Total</span><span className="num">{formatMoney(order.total, order.currency)}</span></div>
        </div>
      </div>
      <div className="ticket__perf" aria-hidden="true" />
      <div className="ticket__bottom">
        <div className="items-mini">
          {order.items.map((i) => (
            <div key={`${i.title}-${i.variantTitle}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {i.image ? <img src={i.image} alt="" /> : <span />}
              <div><div style={{ fontWeight: 650 }}>{i.title}</div><div className="muted" style={{ fontSize: 14 }}>{i.variantTitle} × {i.quantity}</div></div>
              <div className="num">{formatMoney(i.unitPrice * i.quantity, order.currency)}</div>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}
