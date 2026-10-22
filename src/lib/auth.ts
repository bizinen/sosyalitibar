import crypto from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/security";

const COOKIE = "sosyal_itibar_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;

function sign(payload: string): string {
  return crypto.createHmac("sha256", env().SESSION_SECRET).update(payload).digest("base64url");
}

export function makeSession(username: string): string {
  const payload = Buffer.from(JSON.stringify({ username, exp: Date.now() + SESSION_TTL_MS, v: 1 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifySession(value?: string): boolean {
  if (!value) return false;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return false;
  const expected = sign(payload);
  if (!safeEqual(signature, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number; username?: string; v?: number };
    return data.v === 1 && data.username === env().ADMIN_USERNAME && typeof data.exp === "number" && data.exp > Date.now();
  } catch {
    return false;
  }
}

export async function isAdmin(): Promise<boolean> {
  const jar = await cookies();
  return verifySession(jar.get(COOKIE)?.value);
}

export const sessionCookieName = COOKIE;
export const sessionMaxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);

function verifyScrypt(password: string, encoded: string): boolean {
  if (encoded.split("$").length !== 6) return false;
  const [kind, nRaw, rRaw, pRaw, saltB64, expectedB64] = encoded.split("$");
  if (kind !== "scrypt" || !nRaw || !rRaw || !pRaw || !saltB64 || !expectedB64) return false;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 1024 || r < 1 || p < 1) return false;
  try {
    const expected = Buffer.from(expectedB64, "base64url");
    const salt = Buffer.from(saltB64, "base64url");
    if (!/^[A-Za-z0-9_-]+$/.test(saltB64) || !/^[A-Za-z0-9_-]+$/.test(expectedB64)
      || salt.length < 16 || expected.length < 32 || expected.length > 64) return false;
    const actual = crypto.scryptSync(password, salt, expected.length, { N, r, p });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function verifyAdminCredentials(username: string, password: string): boolean {
  const cfg = env();
  if (!safeEqual(username, cfg.ADMIN_USERNAME)) return false;
  if (cfg.ADMIN_PASSWORD_HASH) return verifyScrypt(password, cfg.ADMIN_PASSWORD_HASH);
  return cfg.NODE_ENV !== "production" && Boolean(cfg.ADMIN_PASSWORD) && safeEqual(password, cfg.ADMIN_PASSWORD || "");
}
