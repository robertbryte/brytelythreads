import { safeEqual } from "./util";

/** HTTP Basic auth check for /admin. Fails closed if credentials aren't configured. */
export function checkBasicAuth(header: string | null, user?: string, pass?: string): boolean {
  if (!user || !pass || pass.length < 12) return false;
  if (!header?.startsWith("Basic ")) return false;
  let decoded = "";
  try { decoded = atob(header.slice(6)); } catch { return false; }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass);
}

export const AUTH_CHALLENGE = { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Brytely admin", charset="UTF-8"' } };
