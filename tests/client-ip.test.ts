import { beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ TRUST_PROXY: false }));
vi.mock("@/lib/config", () => ({ env: () => config }));
import { clientIp } from "@/lib/security";

beforeEach(() => { config.TRUST_PROXY = false; });

describe("trusted proxy client IP", () => {
  it("ignores spoofed IP headers without explicit trust", () => {
    expect(clientIp(new Request("http://localhost", { headers: { "x-forwarded-for": "203.0.113.1", "x-real-ip": "203.0.113.2" } }))).toBe("unknown");
  });
  it("uses the first proxy-overwritten address when trust is enabled", () => {
    config.TRUST_PROXY = true;
    expect(clientIp(new Request("http://localhost", { headers: { "x-forwarded-for": "203.0.113.1, 192.0.2.1" } }))).toBe("203.0.113.1");
    expect(clientIp(new Request("http://localhost", { headers: { "x-real-ip": "2001:db8::1" } }))).toBe("2001:db8::1");
  });
  it.each(["attacker", "203.0.113.1:443", "999.1.1.1", "", "fe80::1%attacker"])("rejects invalid literal %s without falling back to another header", (address) => {
    config.TRUST_PROXY = true;
    expect(clientIp(new Request("http://localhost", { headers: { "x-forwarded-for": address, "x-real-ip": "203.0.113.2" } }))).toBe("unknown");
  });
});
