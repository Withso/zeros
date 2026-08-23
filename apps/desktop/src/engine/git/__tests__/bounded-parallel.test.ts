import { describe, expect, it, vi } from "vitest";

import { mapBounded } from "../bounded-parallel";

describe("mapBounded", () => {
  it("preserves order while capping concurrent workspace probes", async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const tasks = Array.from({ length: 12 }, (_, index) => index);

    const mapped = mapBounded(tasks, 3, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
      return value * 2;
    });

    for (let completed = 0; completed < tasks.length; completed += 1) {
      await vi.waitFor(() => expect(release.length).toBeGreaterThan(completed));
      release[completed]!();
    }

    await expect(mapped).resolves.toEqual(tasks.map((value) => value * 2));
    expect(peak).toBe(3);
  });
});
