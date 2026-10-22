import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { insert, values, commit } = vi.hoisted(() => ({ insert: vi.fn(), values: vi.fn(), commit: vi.fn() }));
vi.mock("@/lib/meta-settings", async () => ({ getMetaSettings: async () => (await import("@/lib/config")).env() }));
vi.mock("@/lib/config", () => ({ env: () => ({ META_APP_SECRET: "webhook-secret" }) }));
vi.mock("@/lib/db", () => ({ db: { insert } }));
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn() } }));

import { POST } from "@/app/api/webhooks/meta/route";

function request(body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  const init: RequestInit & { duplex: string } = { method: "POST", body, headers, duplex: "half" };
  return new Request("http://localhost/api/webhooks/meta", init);
}
function signature(raw: string) {
  return `sha256=${crypto.createHmac("sha256", "webhook-secret").update(raw).digest("hex")}`;
}

beforeEach(() => {
  insert.mockReturnValue({ values });
  values.mockReturnValue({ onConflictDoNothing: commit });
  commit.mockResolvedValue(undefined);
});

describe("Meta webhook body handling", () => {
  it("cancels an oversized chunked body without content-length before writing", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(64 * 1024)); },
      cancel,
    }, { highWaterMark: 0 });
    const response = await POST(request(body));
    expect(response.status).toBe(413);
    expect(pulls).toBe(17);
    expect(cancel).toHaveBeenCalledOnce();
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized body without reading it", async () => {
    const read = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: read }, { highWaterMark: 0 });
    const response = await POST(request(body, { "content-length": String(1024 * 1024 + 1) }));
    expect(response.status).toBe(413);
    expect(read).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("verifies chunked UTF-8 payloads and waits for durable enqueue before ACK", async () => {
    const raw = JSON.stringify({ object: "page", entry: [{ text: "İtibar 😊" }] });
    const encoded = new TextEncoder().encode(raw);
    const body = new ReadableStream<Uint8Array>({
      start(controller) { for (const byte of encoded) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    });
    let finish!: () => void;
    commit.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    let acknowledged = false;
    const pending = POST(request(body, { "x-hub-signature-256": signature(raw) })).then((response) => { acknowledged = true; return response; });
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(acknowledged).toBe(false);
    expect(values).toHaveBeenCalledWith({ dedupeKey: crypto.createHash("sha256").update(raw).digest("hex"), objectType: "page", payload: JSON.parse(raw) });
    finish();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
  });

  it("rejects invalid signatures without writing", async () => {
    const response = await POST(request('{"object":"page"}', { "x-hub-signature-256": "sha256=wrong" }));
    expect(response.status).toBe(401);
    expect(insert).not.toHaveBeenCalled();
  });

  it("preserves invalid JSON rejection for a valid signature", async () => {
    const response = await POST(request("{", { "x-hub-signature-256": signature("{") }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_json" });
    expect(insert).not.toHaveBeenCalled();
  });
});
