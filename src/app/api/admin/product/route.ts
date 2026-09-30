import { adminAction } from "@/lib/admin-route";
import { setProductFlag } from "@/lib/admin";

export const POST = adminAction(async (env, form) => {
  const id = String(form.get("productId") || "");
  const field = form.get("field") === "featured" ? "featured" : "hidden";
  const value = form.get("value") === "1";
  await setProductFlag(env, id, field, value);
  return `Product updated (${field} = ${value ? "on" : "off"}).`;
});
