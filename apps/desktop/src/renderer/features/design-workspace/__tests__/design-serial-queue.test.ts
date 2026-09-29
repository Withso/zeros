import { describe, expect, it } from "vitest";

import { createDesignSerialQueue } from "../state/design-serial-queue";

describe("design serial queue", () => {
  it("runs one key's tasks in order across owners and keeps failures local", async () => {
    const queue = createDesignSerialQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    // Gesture A previews (slow reply) and is cancelled; gesture B previews.
    const first = queue.run("root", async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("A preview");
    });
    const clear = queue.run("root", async () => {
      order.push("A clear");
    });
    const failed = queue.run("root", async () => {
      throw new Error("preview failed");
    });
    const second = queue.run("root", async () => {
      order.push("B preview");
    });
    const other = queue.run("other", async () => {
      order.push("other");
    });
    await other;
    expect(order).toEqual(["other"]);
    releaseFirst();
    await Promise.all([first, clear, failed, second]);
    expect(order).toEqual(["other", "A preview", "A clear", "B preview"]);
    await expect(queue.idle("root")).resolves.toBeUndefined();
    expect(queue.size).toBe(0);
  });
});
