import { NextResponse } from "next/server";
import { sessionCookieName } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { assertSameOrigin } from "@/lib/security";
import { appOrigin } from "@/lib/config";

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  await audit({ request: req, actor: "admin", action: "auth.logout" });
  const res = NextResponse.redirect(new URL("/login", appOrigin()), 303);
  res.cookies.set(sessionCookieName, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  return res;
}
