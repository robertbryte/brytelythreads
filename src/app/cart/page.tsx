import type { Metadata } from "next";
import { CartView } from "@/components/CartView";

export const metadata: Metadata = { title: "Cart" };

export default async function CartPage({ searchParams }: { searchParams: Promise<{ canceled?: string }> }) {
  const { canceled } = await searchParams;
  return (
    <div className="wrap">
      <header className="page-head"><h1>Your cart</h1></header>
      <CartView canceled={canceled === "1"} />
    </div>
  );
}
