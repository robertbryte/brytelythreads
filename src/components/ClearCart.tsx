"use client";

import { useEffect } from "react";
import { useCart } from "./CartProvider";

/** Empties the cart once the order is confirmed. */
export function ClearCart() {
  const { clear, ready } = useCart();
  useEffect(() => { if (ready) clear(); }, [ready, clear]);
  return null;
}
