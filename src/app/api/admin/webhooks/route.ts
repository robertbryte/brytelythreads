import { adminAction } from "@/lib/admin-route";
import { registerPrintifyWebhooks } from "@/lib/webhooks";

export const POST = adminAction(async (env) => {
  const report = await registerPrintifyWebhooks(env);
  return "Printify webhooks: " + report.map((r) => `${r.topic} (${r.action})`).join(", ");
});
