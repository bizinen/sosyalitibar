import { describe, expect, it } from "vitest";
import { signAlertPayload } from "@/lib/alert-signature";

// The function is deterministic so downstream gateways can verify exactly the raw request body.
describe("alert webhook signature", () => {
  it("changes when payload changes", () => {
    const secret = "s".repeat(40);
    const a = signAlertPayload('{"id":1}', secret);
    const b = signAlertPayload('{"id":2}', secret);
    expect(a).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
