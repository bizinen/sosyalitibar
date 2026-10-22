import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { metaAuthorizeUrl } from "@/lib/meta";
import { createOAuthState } from "@/lib/oauth-state";
import { audit } from "@/lib/audit";
import { metaConfigured } from "@/lib/config";
import { getMetaSettings } from "@/lib/meta-settings";

export async function GET(req: Request) {
  const cfg = await getMetaSettings();
  if (!metaConfigured(cfg) || !cfg.metaPublicOrigin.startsWith("https://")) return NextResponse.json({ error: "meta_not_configured" }, { status: 503 });
  if (req.headers.get("host") !== new URL(cfg.metaPublicOrigin).host) return NextResponse.redirect(new URL("/api/meta/connect", cfg.metaPublicOrigin));
  if (!(await isAdmin())) return NextResponse.redirect(new URL("/login", cfg.metaPublicOrigin));
  const state = await createOAuthState();
  await audit({ request: req, actor: "admin", action: "meta.oauth.started" });
  return NextResponse.redirect(await metaAuthorizeUrl(state));
}
