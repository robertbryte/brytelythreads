import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Env } from "./env";

/** Access Worker bindings + secrets from Next.js server components / route handlers. */
export function getEnv(): Env {
  return getCloudflareContext().env as unknown as Env;
}

export async function getEnvAsync(): Promise<Env> {
  return (await getCloudflareContext({ async: true })).env as unknown as Env;
}
