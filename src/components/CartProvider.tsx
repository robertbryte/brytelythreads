"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Cart lives in the browser. Prices shown here are for display only — the
 * server re-prices every line from the database when creating Stripe Checkout.
 */
export interface CartItem {
  productId: string;
  variantId: number;
  quantity: number;
  handle: string;
  title: string;
  variantTitle: string;
  price: number;
  image: string | null;
}

interface CartCtx {
  items: CartItem[];
  count: number;
  subtotal: number;
  ready: boolean;
  add(item: CartItem): void;
  setQty(productId: string, variantId: number, qty: number): void;
  remove(productId: string, variantId: number): void;
  clear(): void;
}

const Ctx = createContext<CartCtx | null>(null);
const KEY = "brytely.cart.v1";

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setItems(JSON.parse(raw));
    } catch { /* storage unavailable — cart is session-only */ }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* ignore */ }
  }, [items, ready]);

  const add = useCallback((item: CartItem) => {
    setItems((prev) => {
      const i = prev.findIndex((p) => p.productId === item.productId && p.variantId === item.variantId);
      if (i === -1) return [...prev, item];
      const next = [...prev];
      next[i] = { ...next[i], quantity: Math.min(20, next[i].quantity + item.quantity), price: item.price };
      return next;
    });
  }, []);

  const setQty = useCallback((productId: string, variantId: number, qty: number) => {
    setItems((prev) =>
      prev
        .map((p) => (p.productId === productId && p.variantId === variantId ? { ...p, quantity: Math.max(0, Math.min(20, qty)) } : p))
        .filter((p) => p.quantity > 0),
    );
  }, []);

  const remove = useCallback((productId: string, variantId: number) => {
    setItems((prev) => prev.filter((p) => !(p.productId === productId && p.variantId === variantId)));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const value = useMemo<CartCtx>(() => ({
    items, ready, add, setQty, remove, clear,
    count: items.reduce((s, i) => s + i.quantity, 0),
    subtotal: items.reduce((s, i) => s + i.quantity * i.price, 0),
  }), [items, ready, add, setQty, remove, clear]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCart must be used inside <CartProvider>");
  return c;
}
