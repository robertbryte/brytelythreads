import { getEnv } from "@/lib/cf";
import { processStripeWebhook } from "@/lib/webhooks";

// Stripe → us. Configure in Stripe Dashboard → Developers → Webhooks:
//   URL:    https://<your-domain>/api/webhooks/stripe
//   Events: checkout.session.completed, checkout.session.async_payment_succeeded,
//           checkout.session.async_payment_failed, checkout.session.expired
export async function POST(req: Request) {
  const raw = await req.text(); // raw body is required for signature verification
  const { status, body } = await processStripeWebhook(getEnv(), raw, req.headers.get("stripe-signature"));
  return Response.json(body, { status });
}
