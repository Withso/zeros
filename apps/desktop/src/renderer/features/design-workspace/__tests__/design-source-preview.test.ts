import { expect, it, vi } from "vitest";
import { renderDesignSourcePreview } from "../design-source-preview";
import type { DesignSourceVectorTarget } from "../design-source-vector";

const target = (file: string): DesignSourceVectorTarget => ({ workspaceId: "ws_preview-local", folder: "/fixture",
  directoryId: "design_preview", capability: "a".repeat(64), file, sourceVersion: "b".repeat(24), theme: null,
  width: 1440, height: 900, imageBytes: 0 });
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900"><rect width="1440" height="900" fill="red"/></svg>';

it("pictures a frame from its source vector at the level size and reuses the published vector", async () => {
  const loadVector = vi.fn(async () => svg);
  const rasterize = vi.fn(async (_url: string, width: number, height: number) => new Blob([`png:${width}x${height}`], { type: "image/png" }));
  const first = await renderDesignSourcePreview(target("page/home.html"), 384, undefined, { loadVector, rasterize });
  expect(first).toMatchObject({ sourceVersion: "b".repeat(24), theme: null, mimeType: "image/png", width: 384, height: 240 });
  expect(atob((first as { data: string }).data)).toBe("png:384x240");
  expect(rasterize.mock.calls[0]![0]).toMatch(/^data:image\/svg\+xml;base64,/);
  // The vector landed in the warm cache: a sharper level needs no new document.
  const detail = await renderDesignSourcePreview(target("page/home.html"), 1280, undefined, { loadVector, rasterize });
  expect(detail).toMatchObject({ width: 1280, height: 800 });
  expect(loadVector).toHaveBeenCalledTimes(1);
});

it("never returns a picture after cancellation and never upscales past the capture bound", async () => {
  const controller = new AbortController();
  const loadVector = vi.fn(async () => { controller.abort(new Error("retired")); return svg; });
  const rasterize = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
  await expect(renderDesignSourcePreview(target("page/cancel.html"), 384, controller.signal, { loadVector, rasterize }))
    .rejects.toThrow("retired");
  expect(rasterize).not.toHaveBeenCalled();
  const huge = await renderDesignSourcePreview({ ...target("page/huge.html"), width: 16_000, height: 4_000 }, 4_096, undefined,
    { loadVector: async () => svg, rasterize });
  expect(huge).toMatchObject({ width: 2048, height: 512 });
});

it("pictures an unknown-cost frame without admitting its vector to the warm cache", async () => {
  const { designSourceVectorCache } = await import("../design-source-vector");
  const before = designSourceVectorCache.usage().entries;
  const loadVector = vi.fn(async () => svg);
  const rasterize = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
  for (let attempt = 0; attempt < 2; attempt++)
    await renderDesignSourcePreview(target("page/unknown.html"), 128, undefined, { loadVector, rasterize }, { cache: false });
  expect(loadVector).toHaveBeenCalledTimes(2);
  expect(designSourceVectorCache.usage().entries).toBe(before);
});

it("waits for a live camera gesture to rest before rasterizing a loaded vector", async () => {
  let rest: (() => void) | undefined;
  const quiet = vi.fn(() => new Promise<void>(resolve => { rest = resolve; }));
  const rasterize = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
  const picture = renderDesignSourcePreview(target("page/gesture.html"), 128, undefined,
    { loadVector: async () => svg, rasterize, quiet }, { cache: false });
  await vi.waitFor(() => expect(quiet).toHaveBeenCalledTimes(1));
  expect(rasterize).not.toHaveBeenCalled();
  rest!();
  await expect(picture).resolves.toMatchObject({ width: 128, height: 80 });
  expect(rasterize).toHaveBeenCalledTimes(1);
});
