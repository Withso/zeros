import { expect, it, vi } from "vitest";
import { DesignThumbnailBatches, type DesignThumbnailBatchRender, type DesignThumbnailGroup } from "../state/design-thumbnail-batches";

const version = (n: number) => n.toString(16).padStart(24, "0");
const group: DesignThumbnailGroup = { workspaceId: "workspace-1", directoryId: "design_main", theme: "dark", colorScheme: "light", maxDimension: 128 };

function harness(render: DesignThumbnailBatchRender, maxItems = 64) {
  const timers: Array<() => void> = [];
  const batches = new DesignThumbnailBatches(render, { maxItems, setTimer: (callback) => { timers.push(callback); return callback; } });
  return { batches, tick: () => { for (const timer of timers.splice(0)) timer(); } };
}
const pictureOf = (file: string, sourceVersion: string) => ({ file, sourceVersion, width: 128, height: 80, data: `png:${file}` });

it("renders requests that arrive together as one batch and answers each caller with its own frame", async () => {
  const render = vi.fn<DesignThumbnailBatchRender>(async (_group, frames) => ({
    pictures: frames.filter(frame => frame.file === "a.html").map(frame => pictureOf(frame.file, frame.sourceVersion)),
    stale: frames.filter(frame => frame.file === "b.html").map(frame => ({ file: frame.file, sourceVersion: version(9) })),
    failed: frames.filter(frame => frame.file === "c.html").map(frame => ({ file: frame.file, error: "layout failed" })),
  }));
  const { batches, tick } = harness(render);
  const a = batches.request(group, { file: "a.html", sourceVersion: version(1) });
  const b = batches.request(group, { file: "b.html", sourceVersion: version(1) });
  const c = batches.request(group, { file: "c.html", sourceVersion: version(1) });
  const d = batches.request(group, { file: "d.html", sourceVersion: version(1) });
  expect(render).not.toHaveBeenCalled();
  tick();
  await expect(a).resolves.toEqual({ sourceVersion: version(1), theme: "dark", mimeType: "image/png", width: 128, height: 80, data: "png:a.html" });
  await expect(b).resolves.toEqual({ stale: true, sourceVersion: version(9) });
  await expect(c).rejects.toThrow("layout failed");
  await expect(d).rejects.toThrow("did not picture this frame");
  expect(render).toHaveBeenCalledTimes(1);
  expect(render.mock.calls[0]![1].map(frame => frame.file)).toEqual(["a.html", "b.html", "c.html", "d.html"]);
});

it("sends a full batch at once, keeps one batch per workspace at the engine, and never mixes sizes, themes or owners", async () => {
  const render = vi.fn<DesignThumbnailBatchRender>(async (_group, frames) => ({
    pictures: frames.map(frame => pictureOf(frame.file, frame.sourceVersion)), stale: [], failed: [] }));
  const { batches, tick } = harness(render, 3);
  const requests = ["a", "b", "c", "d"].map(name => batches.request(group, { file: `${name}.html`, sourceVersion: version(1) }));
  expect(render).toHaveBeenCalledTimes(1);
  const others = [
    batches.request({ ...group, maxDimension: 64 }, { file: "a.html", sourceVersion: version(1) }),
    batches.request({ ...group, theme: null }, { file: "a.html", sourceVersion: version(1) }),
    batches.request({ ...group, workspaceId: "workspace-2" }, { file: "a.html", sourceVersion: version(1) }),
  ];
  tick();
  await Promise.all([...requests, ...others]);
  // The full batch left at once; another workspace never waits behind it;
  // this workspace's other batches leave one at a time as each returns.
  expect(render.mock.calls.map(call => [call[0].workspaceId, call[0].theme, call[0].maxDimension, call[1].length])).toEqual([
    ["workspace-1", "dark", 128, 3], ["workspace-2", "dark", 128, 1], ["workspace-1", "dark", 128, 1],
    ["workspace-1", "dark", 64, 1], ["workspace-1", null, 128, 1],
  ]);
});

it("answers a cancelled caller at once and aborts a batch every caller has left", async () => {
  let batchSignal: AbortSignal | undefined;
  let finish: (() => void) | undefined;
  const render = vi.fn<DesignThumbnailBatchRender>((_group, frames, signal) => {
    batchSignal = signal;
    return new Promise(resolve => { finish = () => resolve({ pictures: frames.map(frame => pictureOf(frame.file, frame.sourceVersion)), stale: [], failed: [] }); });
  });
  const { batches, tick } = harness(render);
  const first = new AbortController(), second = new AbortController();
  const a = batches.request(group, { file: "a.html", sourceVersion: version(1) }, first.signal);
  const b = batches.request(group, { file: "b.html", sourceVersion: version(1) }, second.signal);
  tick();
  first.abort(new Error("retired"));
  await expect(a).rejects.toThrow("retired");
  expect(batchSignal!.aborted).toBe(false);
  second.abort(new Error("retired too"));
  await expect(b).rejects.toThrow("retired too");
  expect(batchSignal!.aborted).toBe(true);
  finish!();
  // A caller cancelled before its batch leaves never reaches the engine.
  const gone = new AbortController();
  const c = batches.request(group, { file: "c.html", sourceVersion: version(1) }, gone.signal);
  gone.abort(new Error("left"));
  await expect(c).rejects.toThrow("left");
  tick();
  expect(render).toHaveBeenCalledTimes(1);
});

it("rejects every caller when the batch fails and keeps one frame per batch", async () => {
  const render = vi.fn<DesignThumbnailBatchRender>(async () => { throw new Error("capture host unavailable"); });
  const { batches, tick } = harness(render);
  const a = batches.request(group, { file: "a.html", sourceVersion: version(1) });
  // The same frame again goes to the next batch, which follows the first.
  const again = batches.request(group, { file: "a.html", sourceVersion: version(2) });
  expect(render).not.toHaveBeenCalled();
  tick();
  await expect(a).rejects.toThrow("capture host unavailable");
  await expect(again).rejects.toThrow("capture host unavailable");
  expect(render).toHaveBeenCalledTimes(2);
});

it("asks again for frames a reply deferred, first in the next batch, and stops after repeated deferrals", async () => {
  const seen: string[][] = [];
  const render = vi.fn<DesignThumbnailBatchRender>(async (_group, frames) => {
    seen.push(frames.map(frame => frame.file));
    // The first reply pictures a.html and defers the rest; stuck.html is deferred every time.
    const first = seen.length === 1;
    const pictured = frames.filter(frame => frame.file !== "stuck.html" && (!first || frame.file === "a.html"));
    return { pictures: pictured.map(frame => pictureOf(frame.file, frame.sourceVersion)), stale: [], failed: [],
      deferred: frames.filter(frame => !pictured.includes(frame)) };
  });
  const { batches, tick } = harness(render);
  const a = batches.request(group, { file: "a.html", sourceVersion: version(1) });
  const b = batches.request(group, { file: "b.html", sourceVersion: version(1) });
  const stuck = batches.request(group, { file: "stuck.html", sourceVersion: version(1) });
  tick();
  await expect(a).resolves.toMatchObject({ data: "png:a.html" });
  const later = batches.request(group, { file: "c.html", sourceVersion: version(1) });
  await expect(b).resolves.toMatchObject({ data: "png:b.html" });
  await expect(stuck).rejects.toThrow("kept deferring");
  tick();
  await expect(later).resolves.toMatchObject({ data: "png:c.html" });
  // Deferred frames leave before newer requests and keep their order.
  expect(seen[0]).toEqual(["a.html", "b.html", "stuck.html"]);
  expect(seen[1]).toEqual(["b.html", "stuck.html"]);
  expect(seen.slice(2, 4)).toEqual([["stuck.html"], ["stuck.html"]]);
  expect(seen.at(-1)).toEqual(["c.html"]);
});
