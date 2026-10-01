import { NextResponse, type NextRequest } from "next/server";

// Basic auth in front of /admin and /api/admin/*. For stronger protection,
// put Cloudflare Access in front of these paths as well (see README).
export function middleware(req: NextRequest) {
  // Cloudflare Worker secrets are available through the runtime Env binding,
  // not reliably through process.env in Next middleware. The admin page and
  // every admin action perform the authoritative Basic Auth check server-side.
  return NextResponse.next();
}

export const config = { matcher: ["/admin/:path*", "/api/admin/:path*"] };
