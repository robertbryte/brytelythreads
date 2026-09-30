import { getEnv } from "@/lib/cf";
import { processPrintifyWebhook } from "@/lib/webhooks";

// Printify → us. Registered automatically from /admin ("Register Printify webhooks").
export async function POST(req: Request) {
  const raw = await req.text();
  const { status, body } = await processPrintifyWebhook(getEnv(), raw, new URL(req.url), req.headers.get("x-pfy-signature"));
  return Response.json(body, { status });
}
