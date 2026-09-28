import { NextRequest, NextResponse } from "next/server";

/**
 * Next.js 16 Proxy is intentionally not the authorization layer.
 * Route handlers/server pages validate the signed session themselves.
 * Here we only attach a correlation id for production diagnostics.
 */
export function proxy(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") || globalThis.crypto.randomUUID();
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-request-id", requestId);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("x-request-id", requestId);
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
