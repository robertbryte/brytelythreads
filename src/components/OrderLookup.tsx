"use client";

import { useState } from "react";
import type { PublicOrder } from "@/lib/orders";
import { OrderTicket } from "./OrderTicket";

export function OrderLookup({ initialNumber = "" }: { initialNumber?: string }) {
  const [number, setNumber] = useState(initialNumber);
  const [email, setEmail] = useState("");
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/orders/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number, email }),
      });
      const data = (await res.json()) as { order?: PublicOrder; error?: string };
      if (!res.ok || !data.order) throw new Error(data.error || "We couldn't find that order.");
      setOrder(data.order);
    } catch (err) {
      setOrder(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (order) {
    return (
      <div>
        <OrderTicket order={order} />
        <p style={{ textAlign: "center", marginTop: 20 }}>
          <button type="button" className="linkbtn" onClick={() => setOrder(null)}>Look up another order</button>
        </p>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="order-number">Order number</label>
        <input id="order-number" className="input num" placeholder="BT-7K2Q9M" value={number} onChange={(e) => setNumber(e.target.value)} required autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor="order-email">Email used at checkout</label>
        <input id="order-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
      <button className="btn" type="submit" disabled={busy}>{busy ? "Looking…" : "Find my order"}</button>
    </form>
  );
}
