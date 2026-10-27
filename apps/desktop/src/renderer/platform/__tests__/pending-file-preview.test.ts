import { afterEach, expect, it, vi } from "vitest";
import { offerPendingFilePreview, acquirePendingFilePreview, hasPendingFilePreview } from "../pending-file-preview";
import { setActiveBridge } from "../bridge/active-bridge";
import { RuntimeClient } from "../bridge/ws-client";

afterEach(() => { vi.restoreAllMocks(); setActiveBridge(null); });
it("opens selected media before upload using a borrowed Blob and retires after the last display", () => {
  const blob = new Blob(["original"], { type: "video/mp4" }), create = vi.spyOn(URL, "createObjectURL"), revoke = vi.spyOn(URL, "revokeObjectURL");
  const read = vi.spyOn(blob, "arrayBuffer");
  const finish = offerPendingFilePreview("cloud://org/a", "clip.mp4", blob);
  const view = acquirePendingFilePreview("cloud://org/a", "clip.mp4")!;
  expect(view.blob).toBe(blob); expect(view.url).toMatch(/^blob:/);
  expect(create).toHaveBeenCalledExactlyOnceWith(blob);
  expect(read).not.toHaveBeenCalled();
  expect(acquirePendingFilePreview("cloud://org/b", "clip.mp4")).toBeNull();
  finish(); expect(hasPendingFilePreview("cloud://org/a", "clip.mp4")).toBe(true);
  expect(revoke).not.toHaveBeenCalled();
  view.release(); view.release();
  expect(hasPendingFilePreview("cloud://org/a", "clip.mp4")).toBe(false);
  expect(revoke).toHaveBeenCalledExactlyOnceWith(view.url);
});
it("uses workspace filename MIME for an SVG without copying or changing its selected source", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
  const blob = new Blob([svg], { type: "text/plain" });
  const read = vi.spyOn(blob, "arrayBuffer");
  const finish = offerPendingFilePreview("/mime", "image.SVG", blob);
  const view = acquirePendingFilePreview("/mime", "image.SVG")!;
  try {
    expect(view.blob).toBe(blob);
    expect(blob.type).toBe("text/plain");
    expect(read).not.toHaveBeenCalled();
    const response = await fetch(view.url!);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(await response.text()).toBe(svg);
  } finally { finish(); view.release(); }
});
it("drops completed sources immediately when unopened and rejects another runtime's cache", () => {
  const bridgeA = new RuntimeClient(), bridgeB = new RuntimeClient();
  setActiveBridge(bridgeA);
  const finish = offerPendingFilePreview("/repo", "image.png", new Blob(["image"]));
  setActiveBridge(bridgeB); expect(hasPendingFilePreview("/repo", "image.png")).toBe(false);
  finish(); setActiveBridge(bridgeA); expect(hasPendingFilePreview("/repo", "image.png")).toBe(false);
});
it("bounds optional unvisited sources without retiring an open preview", () => {
  const done = [offerPendingFilePreview("/many", "first.png", new Blob(["first"]))];
  const view = acquirePendingFilePreview("/many", "first.png")!;
  for (let i = 0; i < 30; i++) done.push(offerPendingFilePreview("/many", `${i}.png`, new Blob([String(i)])));
  expect(hasPendingFilePreview("/many", "first.png")).toBe(true);
  expect(hasPendingFilePreview("/many", "0.png")).toBe(false);
  done.forEach(finish => finish()); view.release();
});
it("keeps only the size of attachments above the preview cap, without retaining their Blob", () => {
  const blob = new Blob(["oversized"]);
  Object.defineProperty(blob, "size", { value: 500_000_000 });
  const create = vi.spyOn(URL, "createObjectURL");
  const finish = offerPendingFilePreview("/large", "clip.mp4", blob);
  const view = acquirePendingFilePreview("/large", "clip.mp4")!;
  expect(view.blob).toBeUndefined();
  expect(view.bytes).toBe(500_000_000);
  expect(view.url).toBeUndefined();
  expect(create).not.toHaveBeenCalled();
  finish(); view.release();
});
