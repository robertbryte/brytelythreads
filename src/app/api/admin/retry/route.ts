import { adminAction } from "@/lib/admin-route";
import { getOrder, sendToProduction, submitToPrintify } from "@/lib/orders";

export const POST = adminAction(async (env, form) => {
  const id = String(form.get("orderId") || "");
  const order = await getOrder(env, id);
  if (!order) return "Order not found.";
  if (order.printify_order_id) {
    await sendToProduction(env, id, order.printify_order_id);
    return `${order.number}: already in Printify (${order.printify_order_id}); re-sent to production.`;
  }
  const r = await submitToPrintify(env, id, "admin");
  return r.ok ? `${order.number} submitted to Printify (${r.printifyOrderId}).` : `${order.number} still failing: ${r.error}`;
});
