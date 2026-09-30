import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cf";
import { CheckoutError, createCheckout, type CartLine } from "@/lib/orders";
import { log } from "@/lib/util";

export async function POST(req: Request) {
  let items: CartLine[];
  try {
    ({ items } = (await req.json()) as { items: CartLine[] });
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const { url } = await createCheckout(getEnv(), items);
    return NextResponse.json({ url });
  } catch (e) {
    if (e instanceof CheckoutError) return NextResponse.json({ error: e.message }, { status: e.status });
    log("error", "checkout failed", { error: String(e) });
    return NextResponse.json({ error: "Checkout is temporarily unavailable. Please try again in a minute." }, { status: 502 });
  }
}
