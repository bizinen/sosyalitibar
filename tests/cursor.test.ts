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
  it.each(["-010000-01-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z", "2026-02-30T00:00:00.000Z", "2026-09-28", "2026-09-28T16:00:00+03:00"])("rejects noncanonical or out-of-range date %s", (at) => {
    const cursor = Buffer.from(JSON.stringify({ at, id: "123e4567-e89b-12d3-a456-426614174000" })).toString("base64url");
    expect(decodeItemCursor(cursor)).toBeNull();
  });
  it("rejects non-string query parameters at runtime", () => {
    const cursor = encodeItemCursor({ at: new Date("2026-09-28T16:00:00.123Z"), id: "123e4567-e89b-12d3-a456-426614174000" });
    expect(decodeItemCursor([cursor] as unknown as string)).toBeNull();
    expect(decodeItemCursor(42 as unknown as string)).toBeNull();
  });
  it("preserves PostgreSQL microseconds through repeated cursor encoding", () => {
    const input = { at: new Date("2026-09-28T16:00:00.123Z"), preciseAt: "2026-09-28T16:00:00.123987Z", id: "123e4567-e89b-12d3-a456-426614174000" };
    const decoded = decodeItemCursor(encodeItemCursor(input));
    expect(decoded).toEqual(input);
    expect(decodeItemCursor(encodeItemCursor(decoded!))).toEqual(input);
  });
  it.each(["2026-02-30T00:00:00.123456Z", "2026-09-28T16:00:00.1234Z", "2026-09-28T16:00:00.1234567Z", "2026-09-28T24:00:00.000000Z"])("rejects invalid microsecond date %s", (at) => {
    const cursor = Buffer.from(JSON.stringify({ at, id: "123e4567-e89b-12d3-a456-426614174000" })).toString("base64url");
    expect(decodeItemCursor(cursor)).toBeNull();
  });
});
