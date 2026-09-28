import { describe, expect, it } from "vitest";
import { mapLimit } from "@/lib/concurrency";

describe("mapLimit", () => {
  it("never exceeds configured concurrency and preserves order", async () => {
    let active = 0;
    let peak = 0;
    const output = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 10;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(output).toEqual([10, 20, 30, 40, 50, 60]);
  });
});
