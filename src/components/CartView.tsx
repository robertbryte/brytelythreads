"use client";

import Link from "next/link";
import { useState } from "react";
import { formatMoney } from "@/lib/util";
import { useCart } from "./CartProvider";
import { Img } from "./Img";

const FREE_SHIPPING_OVER = 7500;

export function CartView({ canceled }: { canceled?: boolean }) {
  const { items, subtotal, setQty, remove, ready } = useCart();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function checkout() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: items.map((i) => ({ productId: i.productId, variantId: i.variantId, quantity: i.quantity })) }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error || "Checkout couldn't start. Please try again.");
      window.location.href = data.url; // Stripe-hosted checkout
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (!ready) return <div className="empty">Loading your cart…</div>;

  if (items.length === 0) {
    return (
      <div className="empty">
        <p style={{ fontSize: 18, color: "var(--ink)" }}>Your cart is empty.</p>
        <p style={{ marginTop: 8 }}>Find a design you like and it&apos;ll wait for you here.</p>
        <p style={{ marginTop: 24 }}><Link href="/shop" className="btn">Browse the shop <span className="btn__arrow" aria-hidden="true">→</span></Link></p>
      </div>
    );
  }

  const toFree = FREE_SHIPPING_OVER - subtotal;

  return (
    <div className="cart">
      <div>
        {canceled && <div className="alert" style={{ background: "var(--paper-2)", color: "var(--ink)" }}>Checkout was canceled. Your cart is still here.</div>}
        {items.map((i) => (
          <div className="line" key={`${i.productId}:${i.variantId}`}>
            <Link href={`/products/${i.handle}`} className="line__img"><Img src={i.image} alt={i.title} maxWidth={320} /></Link>
            <div>
              <Link href={`/products/${i.handle}`} className="line__title">{i.title}</Link>
              <div className="line__meta">{i.variantTitle}</div>
              <div className="line__controls">
                <div className="qty" aria-label={`Quantity for ${i.title}`}>
                  <button type="button" aria-label="Decrease" onClick={() => setQty(i.productId, i.variantId, i.quantity - 1)}>−</button>
                  <span>{i.quantity}</span>
                  <button type="button" aria-label="Increase" onClick={() => setQty(i.productId, i.variantId, i.quantity + 1)}>+</button>
                </div>
                <button type="button" className="linkbtn" onClick={() => remove(i.productId, i.variantId)}>Remove</button>
              </div>
            </div>
            <div className="num">{formatMoney(i.price * i.quantity)}</div>
          </div>
        ))}
      </div>

      <aside className="summary" aria-label="Order summary">
        <h2>Summary</h2>
        <dl>
          <dt>Subtotal</dt><dd className="num">{formatMoney(subtotal)}</dd>
          <dt>Shipping</dt><dd className="muted">{toFree <= 0 ? "Free" : "At checkout"}</dd>
          <dt className="total">Estimated total</dt><dd className="total num">{formatMoney(subtotal)}</dd>
        </dl>
        {toFree > 0 && <p className="mono muted" style={{ marginBottom: 16 }}>{formatMoney(toFree)} away from free shipping</p>}
        {error && <div className="alert" role="alert">{error}</div>}
        <button type="button" className="btn btn--block" onClick={checkout} disabled={busy}>
          {busy ? "Opening secure checkout…" : <>Check out <span className="btn__arrow" aria-hidden="true">→</span></>}
        </button>
        <p className="note">Payment is handled by Stripe. We never see your card details.</p>
      </aside>
    </div>
  );
}
