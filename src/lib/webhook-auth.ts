import crypto from "node:crypto";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/security";

export function verifyMetaWebhookSignature(raw: string, header: string | null, secret = env().META_APP_SECRET): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
  return safeEqual(header, expected);
}
