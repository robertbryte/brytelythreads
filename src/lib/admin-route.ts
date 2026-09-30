import "server-only";
import { AUTH_CHALLENGE, checkBasicAuth } from "./auth";
import { getEnv } from "./cf";
import type { Env } from "./env";
import { log } from "./util";

/** Wraps an admin form POST: auth check, run, then 303 back to /admin with a message. */
export function adminAction(fn: (env: Env, form: FormData) => Promise<string>) {
  return async (req: Request) => {
    const env = getEnv();
    if (!checkBasicAuth(req.headers.get("authorization"), env.ADMIN_USERNAME, env.ADMIN_PASSWORD)) {
      return new Response("Authentication required", AUTH_CHALLENGE);
    }
    let msg: string;
    try {
      msg = await fn(env, await req.formData());
    } catch (e) {
      log("error", "admin action failed", { url: req.url, error: String(e) });
      msg = `Error: ${String(e).slice(0, 300)}`;
    }
    const back = new URL("/admin", req.url);
    back.searchParams.set("msg", msg);
    return Response.redirect(back.toString(), 303);
  };
}
