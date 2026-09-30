import "server-only";
import { headers } from "next/headers";
import { checkBasicAuth } from "./auth";
import type { Env } from "./env";

/** Second check inside admin pages/routes, in case middleware is ever misconfigured. */
export async function isAdmin(env: Env): Promise<boolean> {
  const h = (await headers()).get("authorization");
  return checkBasicAuth(h, env.ADMIN_USERNAME, env.ADMIN_PASSWORD);
}
