import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { metaAuthorizeUrl } from "@/lib/meta";
import { createOAuthState } from "@/lib/oauth-state";
import { audit } from "@/lib/audit";

export async function GET(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const state = await createOAuthState();
  await audit({ request: req, actor: "admin", action: "meta.oauth.started" });
  return NextResponse.redirect(metaAuthorizeUrl(state));
}
