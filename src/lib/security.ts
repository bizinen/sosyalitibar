import crypto from "node:crypto";
import { env, appOrigin } from "@/lib/config";

export function safeEqual(a: string, b: string): boolean {
  const ah = crypto.createHash("sha256").update(a).digest();
  const bh = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

export function hashIdentifier(value: string): string {
  return crypto.createHmac("sha256", env().AUDIT_HASH_SECRET).update(value).digest("hex");
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip") || "unknown";
}

/**
 * Cookie-authenticated state changes must originate from this application.
 * We intentionally fail closed when modern browser provenance headers are absent.
 * Server-to-server jobs use bearer auth on separate endpoints and do not call this.
 */
export function assertSameOrigin(req: Request): boolean {
  const expected = appOrigin();
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== expected) return false;
    } catch {
      return false;
    }
  } else {
    const referer = req.headers.get("referer");
    if (!referer) return false;
    try {
      if (new URL(referer).origin !== expected) return false;
    } catch {
      return false;
    }
  }

  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  return true;
}
