import { NextResponse } from "next/server";
import { sessionCookieName } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { assertSameOrigin } from "@/lib/security";

export async function POST(req: Request) {
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const requestOrigin = req.headers.get("origin") || new URL(req.headers.get("referer")!).origin;
  await audit({ request: req, actor: "admin", action: "auth.logout" });
  const res = NextResponse.redirect(new URL("/login", requestOrigin), 303);
  res.cookies.set(sessionCookieName, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure: requestOrigin.startsWith("https:") || process.env.NODE_ENV === "production" });
  return res;
}
