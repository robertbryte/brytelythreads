import type { Metadata } from "next";
import { OrderLookup } from "@/components/OrderLookup";

export const metadata: Metadata = { title: "Order status" };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ number?: string }> }) {
  const { number } = await searchParams;
  return (
    <div className="wrap">
      <header className="page-head">
        <div className="mono muted" style={{ marginBottom: 12 }}>Where&apos;s my shirt?</div>
        <h1>Order status</h1>
        <p>Enter the order number from your confirmation email (it starts with BT-) and the email you checked out with.</p>
      </header>
      <OrderLookup initialNumber={number ?? ""} />
      <div style={{ height: 60 }} />
    </div>
  );
}
