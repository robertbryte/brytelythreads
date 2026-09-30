import type { Metadata } from "next";
import Link from "next/link";
import { ClearCart } from "@/components/ClearCart";
import { OrderTicket } from "@/components/OrderTicket";
import { getEnv } from "@/lib/cf";
import { confirmCheckoutSession } from "@/lib/webhooks";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Order confirmed", robots: { index: false } };

export default async function Success({ searchParams }: { searchParams: Promise<{ session_id?: string }> }) {
  const { session_id } = await searchParams;
  const order = session_id?.startsWith("cs_") ? await confirmCheckoutSession(getEnv(), session_id) : null;

  return (
    <div className="wrap" style={{ paddingBlock: "clamp(28px, 6vw, 72px)" }}>
      {order ? (
        <>
          <ClearCart />
          <OrderTicket order={order} heading={order.status === "pending_payment" ? "Confirming your payment…" : "Thank you! Your order is in."} />
          <p className="muted" style={{ textAlign: "center", marginTop: 24, maxWidth: "52ch", marginInline: "auto" }}>
            A confirmation is on its way to your inbox. Save your order number <strong className="num">{order.number}</strong> to
            check its status any time on the <Link href={`/orders?number=${order.number}`}>order status page</Link>.
          </p>
        </>
      ) : (
        <div className="empty">
          <p>We couldn&apos;t find that checkout. If you were charged, your confirmation email has your order number.</p>
          <p style={{ marginTop: 20 }}><Link className="btn" href="/orders">Look up an order</Link></p>
        </div>
      )}
    </div>
  );
}
