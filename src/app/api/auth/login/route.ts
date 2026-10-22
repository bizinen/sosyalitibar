import { NextResponse } from "next/server";
import { makeSession, sessionCookieName, sessionMaxAgeSeconds, verifyAdminCredentials } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { clearLoginFailures, loginRateLimitState, recordLoginFailure } from "@/lib/rate-limit";
import { assertSameOrigin, clientIp, hashIdentifier } from "@/lib/security";

export async function POST(req: Request) {
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const requestOrigin = req.headers.get("origin") || new URL(req.headers.get("referer")!).origin;
  const keyHash = hashIdentifier(`login:${clientIp(req)}`);
  const limit = await loginRateLimitState(keyHash);
  if (!limit.allowed) {
    return NextResponse.json({ error: "too_many_attempts" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
  }

  const body = await req.formData();
  const username = String(body.get("username") || "").slice(0, 200);
  const password = String(body.get("password") || "").slice(0, 1000);
  if (!verifyAdminCredentials(username, password)) {
    await recordLoginFailure(keyHash);
    await audit({ request: req, actor: "anonymous", action: "auth.login.failed" });
    return NextResponse.redirect(new URL("/login?error=1", requestOrigin), 303);
  }

  await clearLoginFailures(keyHash);
  await audit({ request: req, actor: username, action: "auth.login.succeeded" });
  const res = NextResponse.redirect(new URL("/", requestOrigin), 303);
  res.cookies.set(sessionCookieName, makeSession(username), {
    httpOnly: true,
    sameSite: "lax",
    secure: requestOrigin.startsWith("https:") || process.env.NODE_ENV === "production",
    path: "/",
    maxAge: sessionMaxAgeSeconds,
    priority: "high",
  });
  return res;
}
