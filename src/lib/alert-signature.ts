import crypto from "node:crypto";

export function signAlertPayload(body: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}
