import { describe, expect, it } from "vitest";
import { decodeItemCursor, encodeItemCursor } from "@/lib/cursor";

describe("item cursor", () => {
  it("round-trips stable pagination cursor", () => {
    const input = { at: new Date("2026-09-28T16:00:00.123Z"), id: "123e4567-e89b-12d3-a456-426614174000" };
    const encoded = encodeItemCursor(input);
    const decoded = decodeItemCursor(encoded);
    expect(decoded?.at.toISOString()).toBe(input.at.toISOString());
    expect(decoded?.id).toBe(input.id);
  });

  it("rejects malformed cursors", () => {
    expect(decodeItemCursor("not-base64-json")).toBeNull();
    expect(decodeItemCursor(Buffer.from(JSON.stringify({ at: "bad", id: "nope" })).toString("base64url"))).toBeNull();
  });
});
