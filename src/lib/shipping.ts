/**
 * Shipping options shown on Stripe Checkout.
 *
 * The customer's address isn't known until they're on Stripe's page, so we
 * offer flat rates (configurable without a code change via SHIPPING_RATES).
 * Set these at or slightly above your typical Printify shipping cost.
 */
import type { Env } from "./env";

export interface ShippingRate {
  label: string;
  amount: number;          // cents for the first item
  additional?: number;     // cents per additional item
  minDays: number;
  maxDays: number;
  freeOver?: number;       // subtotal in cents that unlocks free shipping on this rate
}

export const DEFAULT_RATES: ShippingRate[] = [
  { label: "Standard", amount: 499, additional: 200, minDays: 5, maxDays: 10, freeOver: 7500 },
];

export function getShippingRates(env: Env): ShippingRate[] {
  if (!env.SHIPPING_RATES) return DEFAULT_RATES;
  try {
    const parsed = JSON.parse(env.SHIPPING_RATES) as ShippingRate[];
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    /* fall through */
  }
  return DEFAULT_RATES;
}

export function shippingAmount(rate: ShippingRate, subtotal: number, itemCount: number): number {
  if (rate.freeOver !== undefined && subtotal >= rate.freeOver) return 0;
  return rate.amount + Math.max(0, itemCount - 1) * (rate.additional ?? 0);
}

export function allowedCountries(env: Env): string[] {
  return (env.SHIPPING_COUNTRIES || "US").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
}
