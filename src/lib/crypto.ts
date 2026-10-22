import crypto from "node:crypto";
import { env } from "@/lib/config";

function decodeKey(raw: string): Buffer {
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY base64 çözülünce 32 byte olmalı");
  return decoded;
}

function keyId(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function keyring(): Array<{ id: string; key: Buffer }> {
  const cfg = env();
  const keys = [cfg.TOKEN_ENCRYPTION_KEY, cfg.TOKEN_ENCRYPTION_KEY_PREVIOUS].filter((v): v is string => Boolean(v)).map(decodeKey);
  return keys.map((key) => ({ id: keyId(key), key }));
}

export function encryptSecret(value: string): string {
  const current = keyring()[0];
  if (!current) throw new Error("Şifreleme anahtarı bulunamadı");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", current.key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", current.id, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptV1(parts: string[]): string {
  const [, id, ivB64, tagB64, dataB64] = parts;
  if (!id || !ivB64 || !tagB64 || !dataB64) throw new Error("Şifreli token formatı bozuk");
  const candidates = keyring().filter((x) => x.id === id);
  if (candidates.length === 0) throw new Error("Token bilinmeyen/eskimiş şifreleme anahtarıyla korunuyor");
  for (const candidate of candidates) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", candidate.key, Buffer.from(ivB64, "base64url"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      // try the next matching key (normally there is only one)
    }
  }
  throw new Error("Token çözülemedi");
}

function decryptLegacy(value: string): string {
  const [ivB64, tagB64, dataB64] = value.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Şifreli token formatı bozuk");
  for (const candidate of keyring()) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", candidate.key, Buffer.from(ivB64, "base64url"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      // legacy migration path: try current then previous
    }
  }
  throw new Error("Token çözülemedi");
}

export function decryptSecret(value: string): string {
  const parts = value.split(".");
  return parts[0] === "v1" ? decryptV1(parts) : decryptLegacy(value);
}

export function secretNeedsRotation(value: string): boolean {
  const current = keyring()[0];
  if (!current) return false;
  const parts = value.split(".");
  return parts[0] !== "v1" || parts[1] !== current.id;
}

export function currentSecretPrefix(): string {
  return `v1.${keyring()[0].id}.`;
}
