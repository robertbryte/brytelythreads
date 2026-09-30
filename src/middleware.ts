import { NextResponse, type NextRequest } from "next/server";
import { AUTH_CHALLENGE, checkBasicAuth } from "@/lib/auth";

// Basic auth in front of /admin and /api/admin/*. For stronger protection,
// put Cloudflare Access in front of these paths as well (see README).
export function middleware(req: NextRequest) {
  const ok = checkBasicAuth(req.headers.get("authorization"), process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
  if (!ok) return new NextResponse("Authentication required", AUTH_CHALLENGE);
  return NextResponse.next();
}

export const config = { matcher: ["/admin/:path*", "/api/admin/:path*"] };
