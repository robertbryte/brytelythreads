import { getEnv } from "@/lib/cf";
import { lookupOrder } from "@/lib/orders";

export async function POST(req: Request) {
  const { number, email } = (await req.json().catch(() => ({}))) as { number?: string; email?: string };
  if (!number || !email) return Response.json({ error: "Enter your order number and email." }, { status: 400 });
  const order = await lookupOrder(getEnv(), number, email);
  if (!order) {
    return Response.json({ error: "No order matches that number and email. Check your confirmation email and try again." }, { status: 404 });
  }
  return Response.json({ order }, { headers: { "Cache-Control": "no-store" } });
}
