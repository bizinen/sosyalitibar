import crypto from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { oauthNonces } from "@/db/schema";
import { db } from "@/lib/db";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/security";

const TTL_MS = 10 * 60 * 1000;

function sign(payload: string): string {
  return crypto.createHmac("sha256", env().SESSION_SECRET).update(payload).digest("base64url");
}

function nonceHash(nonce: string): string {
  return crypto.createHash("sha256").update(nonce).digest("hex");
}

export async function createOAuthState(): Promise<string> {
  const nonce = crypto.randomBytes(24).toString("base64url");
  const ts = Date.now();
  const payload = Buffer.from(JSON.stringify({ ts, nonce, v: 1 })).toString("base64url");
  await db.insert(oauthNonces).values({ nonceHash: nonceHash(nonce), expiresAt: new Date(ts + TTL_MS) });
  return `${payload}.${sign(payload)}`;
}

export async function consumeOAuthState(state: string): Promise<boolean> {
  const [payload, sig] = state.split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { ts?: number; nonce?: string; v?: number };
    if (parsed.v !== 1 || typeof parsed.ts !== "number" || typeof parsed.nonce !== "string") return false;
    const now = Date.now();
    if (parsed.ts > now + 30_000 || now - parsed.ts > TTL_MS) return false;
    const [used] = await db.update(oauthNonces).set({ usedAt: new Date() }).where(and(
      eq(oauthNonces.nonceHash, nonceHash(parsed.nonce)),
      isNull(oauthNonces.usedAt),
      gt(oauthNonces.expiresAt, new Date()),
    )).returning({ id: oauthNonces.id });
    return Boolean(used);
  } catch {
    return false;
  }
}
