import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { webhookEvents } from "@/db/schema";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/security";
import { verifyMetaWebhookSignature } from "@/lib/webhook-auth";
import { log } from "@/lib/log";

const MAX_WEBHOOK_BYTES = 1024 * 1024;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && challenge && safeEqual(token, env().META_WEBHOOK_VERIFY_TOKEN)) {
    return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  return NextResponse.json({ error: "verification_failed" }, { status: 403 });
}

export async function POST(req: Request) {
  const declaredLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_WEBHOOK_BYTES) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  if (!verifyMetaWebhookSignature(raw, req.headers.get("x-hub-signature-256"))) {
    log.warn("meta.webhook.bad_signature");
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const objectType = payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as { object?: unknown }).object === "string"
    ? String((payload as { object: string }).object)
    : null;
  const dedupeKey = crypto.createHash("sha256").update(raw).digest("hex");
  await db.insert(webhookEvents).values({ dedupeKey, objectType, payload: payload as never }).onConflictDoNothing();
  // Meta expects a fast acknowledgement; processing happens in the durable worker queue.
  return NextResponse.json({ received: true });
}
