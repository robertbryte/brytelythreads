import { adminAction } from "@/lib/admin-route";
import { setTagVisible } from "@/lib/admin";

export const POST = adminAction(async (env, form) => {
  const id = Number(form.get("tagId"));
  const visible = form.get("visible") === "1";
  await setTagVisible(env, id, visible);
  return `Collection ${visible ? "shown in" : "hidden from"} the shop filters.`;
});
