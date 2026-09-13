import { describe, expect, it, vi } from "vitest";
import { createNativeAppArtworkResource } from "../native-app-artwork";

const PNG = "data:image/png;base64,aGVsbG8=";
describe("native application artwork cache", () => {
  it("batches distinct apps and deduplicates repeated rows", async () => {
    const read = vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, PNG])),
    );
    const resource = createNativeAppArtworkResource(read);
    await Promise.all([
      resource.load("com.google.Chrome"),
      resource.load("com.apple.Calculator"),
      resource.load("com.google.Chrome"),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toEqual([
      "com.google.Chrome",
      "com.apple.Calculator",
    ]);
    const before = resource.cache.getSnapshot("com.google.Chrome");
    await resource.load("com.google.Chrome");
    expect(resource.cache.getSnapshot("com.google.Chrome")).toBe(before);
  });
  it("isolates native hosts and preserves a confirmed icon while refreshing", async () => {
    let settle!: (value: Record<string, string | null>) => void;
    const old = createNativeAppArtworkResource(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const current = createNativeAppArtworkResource(async () => ({}));
    const pending = old.load("com.google.Chrome");
    await vi.waitFor(() => expect(settle).toBeTypeOf("function"));
    await current.load("com.google.Chrome");
    settle({ "com.google.Chrome": PNG });
    await pending;
    expect(current.cache.getSnapshot("com.google.Chrome").data).toBeNull();
    expect(old.cache.getSnapshot("com.google.Chrome").data).toBe(PNG);
    old.cache.invalidate("com.google.Chrome");
    const next = old.load("com.google.Chrome");
    await new Promise((resolve) => queueMicrotask(resolve as () => void));
    expect(old.cache.getSnapshot("com.google.Chrome").data).toBe(PNG);
    settle({ "com.google.Chrome": PNG });
    await next;
  });
  it("bounds each batch and rejects unsafe artwork returned by a bridge", async () => {
    const read = vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, "file:///private/icon.png"])),
    );
    const resource = createNativeAppArtworkResource(read);
    const ids = Array.from({ length: 40 }, (_, index) => `com.app${index}`);
    await Promise.all(ids.map(resource.load));
    expect(read.mock.calls.map(([batch]) => batch.length)).toEqual([16, 16, 8]);
    expect(
      ids.every((id) => resource.cache.getSnapshot(id).data === null),
    ).toBe(true);
  });
});
