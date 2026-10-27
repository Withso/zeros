import { describe, expect, it } from "vitest";
import { DesignDocumentReplacements } from "../state/design-document-replacements";

describe("Design incoming document admission", () => {
  it("holds a cancelled slot until its mounted buffer actually detaches", async () => {
    const queue = new DesignDocumentReplacements();
    const starts: string[] = [];
    const a = queue.request(false, () => starts.push("a"))!;
    const detach = a.attach();
    const b = queue.request(true, () => starts.push("b"))!;
    a.cancel();
    await Promise.resolve();
    expect(starts).toEqual(["a"]);
    expect(queue.usage()).toEqual({ active: 1, waiting: 1 });
    detach();
    expect(starts).toEqual(["a"]);
    await Promise.resolve();
    expect(starts).toEqual(["a", "b"]);
    detach();
    a.cancel();
    await Promise.resolve();
    expect(queue.usage()).toEqual({ active: 1, waiting: 0 });
    b.cancel();
    await Promise.resolve();
    expect(queue.usage()).toEqual({ active: 0, waiting: 0 });
  });

  it("prioritizes the selected editor and never starts cancelled queued generations", async () => {
    const queue = new DesignDocumentReplacements();
    const starts: string[] = [];
    const a = queue.request(false, () => starts.push("a"))!;
    const stale = queue.request(true, () => starts.push("stale"))!;
    const ordinary = queue.request(false, () => starts.push("ordinary"))!;
    const edited = queue.request(true, () => starts.push("edited"))!;
    stale.cancel();
    a.cancel();
    await Promise.resolve();
    expect(starts).toEqual(["a", "edited"]);
    edited.cancel();
    await Promise.resolve();
    expect(starts).toEqual(["a", "edited", "ordinary"]);
    ordinary.cancel();
  });

  it("bounds queued demand and wakes refused consumers when capacity is released", async () => {
    const queue = new DesignDocumentReplacements(1);
    const a = queue.request(false, () => {})!;
    const b = queue.request(false, () => {})!;
    expect(queue.request(false, () => {})).toBeNull();
    let available = 0;
    const unsubscribe = queue.subscribeAvailable(() => available++);
    b.cancel();
    await Promise.resolve();
    expect(available).toBe(1);
    expect(queue.usage()).toEqual({ active: 1, waiting: 0 });
    unsubscribe();
    a.cancel();
  });
});
