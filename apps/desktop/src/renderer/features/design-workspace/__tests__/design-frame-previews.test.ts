import { expect, it, vi } from "vitest";
import { DesignImageResidency } from "../state/design-image-residency";
import { DesignPreviewDecodes } from "../state/design-preview-decodes";
import type { DesignPreviewReply } from "@zeros/protocol/design-capture";
import type {
  DesignPreviewIndexEntry,
  DesignPreviewRecord,
  DesignPreviewStore,
} from "../../../platform/design-preview-store";
import {
  DESIGN_PREVIEW_LIVE_SETTLE_MS,
  DesignFramePreviews,
  activeDesignPreviewDemand,
  createDesignFramePicturedReader,
  designFrameAutoCapture,
  designPreviewDemandItems,
  designPreviewFrameKey,
  designPreviewKey,
  type DesignPreviewDemand,
  type DesignPreviewLevel,
  type DesignPreviewOwner,
} from "../state/design-frame-previews";

const local: DesignPreviewOwner = { scope: "local", workspaceId: "workspace-1", directoryId: "design_main" };
const version = (n: number) => n.toString(16).padStart(24, "0");
const PNG = "iVBORw0KGgo=";

function memoryStore(options: { readDelay?: () => Promise<void> } = {}) {
  const pictures = new Map<string, DesignPreviewRecord>();
  const index = new Map<string, DesignPreviewIndexEntry>();
  const store: DesignPreviewStore & { pictures: typeof pictures; index: typeof index; reads: number } = {
    pictures, index, reads: 0,
    async readIndex() { return [...index.values()].map((row) => ({ ...row })); },
    async read(keys) {
      store.reads++;
      await options.readDelay?.();
      return keys.flatMap((key) => pictures.get(key) ?? []);
    },
    async commit(change) {
      for (const key of change.remove ?? []) { pictures.delete(key); index.delete(key); }
      for (const { record, entry } of change.put ?? []) { pictures.set(record.key, record); index.set(entry.key, { ...entry }); }
      for (const entry of change.touch ?? []) if (index.has(entry.key)) index.set(entry.key, { ...entry });
    },
  };
  return store;
}

function harness(options: {
  store?: DesignPreviewStore | null;
  canProduce?: (owner: DesignPreviewOwner) => boolean;
  render?: (owner: DesignPreviewOwner, input: { file: string; sourceVersion: string; theme: string | null; maxDimension: number }) => Promise<DesignPreviewReply>;
  encode?: (png: Blob, level: DesignPreviewLevel) => Promise<Blob>;
  visible?: () => boolean;
  memoryBytes?: number;
  decodedBytes?: number;
  displayBudget?: DesignImageResidency;
  diskBytes?: number;
  pictureBytes?: number;
  rendersFar?: (owner: DesignPreviewOwner) => boolean;
  renderGapMs?: (owner: DesignPreviewOwner) => number;
} = {}) {
  let now = 1_000;
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
  const renders: Array<{ owner: DesignPreviewOwner; file: string; sourceVersion: string; theme: string | null; maxDimension: number }> = [];
  const created: string[] = [];
  const revoked: string[] = [];
  let urls = 0;
  const previews = new DesignFramePreviews({
    store: options.store === undefined ? memoryStore() : options.store,
    render: async (owner, input) => {
      renders.push({ owner, ...input });
      if (options.render) return options.render(owner, input);
      const width = Math.min(input.maxDimension, 400);
      const data = options.pictureBytes ? Buffer.alloc(options.pictureBytes, 1).toString("base64") : PNG;
      return { sourceVersion: input.sourceVersion, theme: input.theme, mimeType: "image/png", width, height: Math.round(width * 0.75), data };
    },
    schedule: (work) => work(),
    encode: options.encode ?? (async (png) => png),
    canProduce: options.canProduce ?? (() => true),
    createUrl: () => { const url = `blob:test/${++urls}`; created.push(url); return url; },
    revokeUrl: (url) => { revoked.push(url); },
    now: () => now,
    setTimer: (callback, ms) => { const timer = { at: now + ms, callback, cancelled: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { (timer as { cancelled: boolean }).cancelled = true; },
    visible: options.visible ?? (() => true),
    memoryBytes: options.memoryBytes,
    decodedBytes: options.decodedBytes,
    displayBudget: options.displayBudget,
    diskBytes: options.diskBytes,
    ...(options.rendersFar ? { rendersFar: options.rendersFar } : {}),
    ...(options.renderGapMs ? { renderGapMs: options.renderGapMs } : {}),
  });
  const settle = async () => { for (let round = 0; round < 40; round++) await Promise.resolve(); };
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of [...timers]) {
      if (timer.cancelled || timer.at > now) continue;
      timer.cancelled = true;
      timer.callback();
    }
    await settle();
  };
  return { previews, renders, created, revoked, settle, advance, token: {} };
}

function demand(owner: DesignPreviewOwner, files: Array<[string, number] | [string, number, "overview" | "detail", boolean?, boolean?]>, theme: string | null = "dark"): DesignPreviewDemand {
  return {
    owner, theme,
    items: files.map(([file, n, level = "overview", live = false, near = true]) =>
      ({ file, sourceVersion: version(n), level, live, ...(near ? {} : { near: false }) })),
  };
}

it("orders a canvas's pictures visible-first and sizes each by its painted size", () => {
  const frames = [
    { file: "far.html", sourceVersion: version(1), x: 5000, y: 5000, width: 400, height: 300 },
    { file: "near.html", sourceVersion: version(2), x: 2500, y: 0, width: 400, height: 300 },
    { file: "live.html", sourceVersion: version(3), x: 0, y: 0, width: 400, height: 300 },
    { file: "big.html", sourceVersion: version(4), x: 450, y: 0, width: 1600, height: 1000 },
    { file: "small.html", sourceVersion: version(5), x: 300, y: 350, width: 200, height: 150 },
    { file: "label.html", sourceVersion: version(6), kind: "text" as const, x: 10, y: 10, width: 100, height: 20 },
  ];
  const items = designPreviewDemandItems({
    frames, view: { zoom: 0.5, panX: 0, panY: 0 }, viewport: { width: 1200, height: 800 },
    devicePixelRatio: 2, live: new Set(["live.html"]),
  });
  // The world viewport is 2400 × 1600 around (1200, 800).
  expect(items.map((item) => [item.file, item.level])).toEqual([
    ["big.html", "detail"], // 1600 px × 0.5 × 2 = 1600 device px, nearest the centre
    ["small.html", "overview"], // 200 px × 0.5 × 2 = 200 device px
    ["label.html", "thumbnail"], // Transparent text needs the same visible-pixel path.
    ["live.html", "overview"],
    ["near.html", "overview"],
    ["big.html", "overview"],
    ["far.html", "overview"],
  ]);
  // Beyond one viewport of the screen: the zoomed-out overview and far.html.
  expect(items.map((item) => item.near !== false)).toEqual([true, true, true, true, true, false, false]);
});

it.each(["frame", "text"] as const)("keeps all 256 tiny visible %s frames paintable within the decoded image budget", async kind => {
  const h = harness();
  const frames = Array.from({ length: 256 }, (_, i) => ({
    kind, file: `frame-${i}.html`, sourceVersion: version(1), x: (i % 16) * 1600,
    y: Math.floor(i / 16) * 1100, width: 1440, height: 900,
  }));
  const items = designPreviewDemandItems({ frames, view: { zoom: 0.04, panX: 0, panY: 0 },
    viewport: { width: 1440, height: 900 }, devicePixelRatio: 2, live: new Set() });
  expect(new Set(items.map(item => item.file)).size).toBe(256);
  h.previews.setDemand(h.token, { owner: local, theme: "dark", items });
  for (let index = 0; index < 256; index++) await h.settle();
  const leases = frames.map((frame) => h.previews.acquire({ owner: local, theme: "dark", ...frame,
    level: items.find((item) => item.file === frame.file)!.level }));
  expect(leases.filter(Boolean)).toHaveLength(256);
  expect(h.previews.usage().decodedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  for (const lease of leases) lease?.release();
  expect(h.previews.usage().decodedBytes).toBe(0);
});

it("discards opaque legacy previews on restart without discarding current-format pictures", async () => {
  const store = memoryStore();
  const legacy = { owner: local, file: "transparent.html", sourceVersion: version(1), theme: "dark", level: "overview" as const };
  const current = { ...legacy, file: "current.html" };
  const legacyKey = JSON.stringify([1, local.scope, local.workspaceId, local.directoryId,
    legacy.file, legacy.theme, legacy.level, legacy.sourceVersion]);
  for (const [target, key] of [[legacy, legacyKey], [current, designPreviewKey(current)]] as const) {
    const blob = new Blob([PNG], { type: "image/png" });
    await store.commit({ put: [{ record: { key, blob }, entry: {
      key, frameKey: designPreviewFrameKey(local, target.file, target.theme), workspaceId: local.workspaceId,
      sourceVersion: target.sourceVersion, level: target.level, width: 384, height: 288,
      bytes: blob.size, savedAt: 1, readAt: 1,
    } }] });
  }
  let canProduce = false;
  const h = harness({ store, canProduce: () => canProduce });
  h.previews.setDemand(h.token, demand(local, [[legacy.file, 1], [current.file, 1]]));
  await h.settle();
  expect(h.previews.picture(legacy)).toBeNull();
  expect(h.previews.picture(current)?.current).toBe(true);
  expect(store.index.has(legacyKey)).toBe(false);
  expect(store.index.has(designPreviewKey(current))).toBe(true);
  expect(h.renders).toHaveLength(0);
  canProduce = true;
  h.previews.resume();
  await h.settle();
  expect(h.renders.map(row => row.file)).toEqual([legacy.file]);
  expect(h.previews.picture(legacy)?.current).toBe(true);
});

it("retires a live document only after its exact-generation display lease confirms decoded pixels", async () => {
  const h = harness();
  h.previews.setDemand(h.token, demand(local, [["a.html", 1]]));
  await h.settle();
  const frames = [{ file: "a.html", sourceVersion: version(1), width: 400, height: 300 }];
  const displayed = () => h.previews.pictured(local, "dark", frames, 0.1, true);
  expect(displayed().size).toBe(0);
  const lease = h.previews.acquire({ owner: local, file: "a.html", sourceVersion: version(1), theme: "dark", level: "overview" })!;
  expect(displayed().size).toBe(0);
  lease.confirmDecoded();
  lease.confirmDecoded();
  expect(displayed().has("a.html")).toBe(true);
  expect(h.previews.pictured(local, "light", frames, 0.1, true).size).toBe(0);
  expect(h.previews.pictured(local, "dark", [{ ...frames[0]!, sourceVersion: version(2) }], 0.1, true).size).toBe(0);
  lease.release();
  lease.release();
  lease.confirmDecoded();
  expect(displayed().size).toBe(0);
  // The encoded cache survives display retirement and can be leased again.
  expect(h.previews.pictured(local, "dark", frames, 0.1).has("a.html")).toBe(true);
});

it("leases a warm exact-owner cover while the preferred encoded level decodes without promoting stale pixels", async () => {
  const h = harness();
  const target = { owner: local, file: "a.html", sourceVersion: version(1), theme: "dark", level: "thumbnail" as const };
  h.previews.setDemand(h.token, { owner: local, theme: "dark", items: [{ ...target, live: false }] });
  await h.settle();
  let finish: (() => void) | undefined;
  const decode = vi.fn(async (picture: { level: string }) => {
    if (picture.level === "overview") await new Promise<void>(resolve => { finish = resolve; });
    return { dispose: vi.fn() };
  });
  const decodes = new DesignPreviewDecodes({
    acquire: (input, accept) => h.previews.acquire(input, accept),
    hasPicture: input => !!h.previews.picture(input),
    retain: key => h.previews.pin(key), decode,
  });
  decodes.setOwner({}, target);
  const first = decodes.acquire(target)!;
  await first.whenReady; first.release();
  h.previews.setDemand(h.token, demand(local, [["a.html", 1]]));
  await h.settle();
  const sharper = { ...target, level: "overview" as const };
  const upgrade = decodes.acquire(sharper)!;
  await Promise.resolve();
  expect(upgrade.ready).toBe(false);
  const cover = decodes.acquireReady(sharper)!;
  expect(cover.ready).toBe(true);
  expect(cover.picture).toMatchObject({ key: first.picture.key, level: "thumbnail", current: true });
  for (const input of [{ ...sharper, theme: "light" },
    { ...sharper, file: "b.html" },
    { ...sharper, owner: { ...local, workspaceId: "organization-local" } },
    { ...sharper, owner: { ...local, directoryId: "other-design" } },
    { ...sharper, owner: { ...local, scope: "cloud:other-account" } }])
    expect(decodes.acquireReady(input)).toBeNull();
  const newerSource = { ...sharper, sourceVersion: version(2) };
  const stale = decodes.acquireReady(newerSource)!;
  expect(stale.picture.current).toBe(false);
  stale.confirmDecoded();
  expect(h.previews.pictured(local, "dark", [{ file: target.file, sourceVersion: newerSource.sourceVersion }], 0, true).size).toBe(0);
  stale.release();
  expect(decode).toHaveBeenCalledTimes(2);
  finish!(); await upgrade.whenReady;
  upgrade.release(); cover.release(); decodes.clearWarm();
  expect(h.previews.usage().decodedBytes).toBe(0);
});

it("falls back within display capacity while preserving the shown generation's lease", async () => {
  const h = harness({ decodedBytes: 128 * 96 * 8 * 2 });
  const frames = [{ file: "a.html", sourceVersion: version(1), x: 0, y: 0, width: 1440, height: 900 }];
  const items = designPreviewDemandItems({ frames, view: { zoom: 0.04, panX: 0, panY: 0 },
    viewport: { width: 1440, height: 900 }, devicePixelRatio: 2, live: new Set() });
  h.previews.setDemand(h.token, { owner: local, theme: "dark", items });
  await h.settle();
  const target = { owner: local, file: "a.html", sourceVersion: version(1), theme: "dark", level: "detail" as const };
  const shown = h.previews.acquire(target)!;
  expect(shown.picture.level).toBe("thumbnail");
  h.previews.setDemand(h.token, demand(local, [["a.html", 1, "detail"]]));
  await h.settle();
  const fallback = h.previews.acquire(target)!;
  expect(fallback.picture.key).toBe(shown.picture.key);
  expect(h.previews.usage().decodedBytes).toBe(128 * 96 * 8);
  expect(h.previews.pictured(local, "dark", frames, 0.04).has("a.html")).toBe(true);
  expect(h.previews.pictured(local, "light", frames, 0.04).has("a.html")).toBe(false);
  shown.release();
  expect(h.previews.usage().decodedBytes).toBe(128 * 96 * 8);
  fallback.release();
  expect(h.previews.usage().decodedBytes).toBe(0);
});

it("optional detail uses a cached small cover before evicting another frame's warm pixels", async () => {
  const budget = new DesignImageResidency(1_100_000);
  const h = harness({ displayBudget: budget });
  const targets = ["a.html", "b.html"].map(file => ({ owner: local, file, sourceVersion: version(1), theme: "dark", level: "thumbnail" as const }));
  h.previews.setDemand(h.token, { owner: local, theme: "dark", items: targets.map(target => ({ ...target, live: false })) });
  await h.settle();
  const shown = h.previews.acquire(targets[0]!)!;
  const warm = h.previews.acquire(targets[1]!)!;
  const pressure = vi.fn(() => warm.release());
  budget.subscribePressure(pressure);
  h.previews.setDemand(h.token, demand(local, [["a.html", 1, "detail"]]));
  await h.settle();
  const requested = h.previews.acquire({ ...targets[0]!, level: "detail" })!;
  expect(pressure).not.toHaveBeenCalled();
  expect(requested.picture.level).toBe("thumbnail");
  requested.release();
  // A foreground capture still reclaims warm pixels when it needs capacity.
  const capture = budget.acquire("explicit capture", 400, 300);
  expect(capture).not.toBeNull();
  expect(pressure).toHaveBeenCalledTimes(1);
  capture!.release(); shown.release();
  expect(budget.usage().decodedBytes).toBe(0);
});

it("renders only frames near the screen for an owner that does not render far ones, painting those from disk", async () => {
  const store = memoryStore();
  const earlier = harness({ store });
  earlier.previews.setDemand(earlier.token, demand(local, [["stored.html", 1]]));
  await earlier.settle();
  const { previews, renders, settle, token } = harness({ store, rendersFar: () => false });
  previews.setDemand(token, demand(local, [["near.html", 2], ["far.html", 3, "overview", false, false], ["stored.html", 1, "overview", false, false]]));
  await settle();
  expect(renders.map((render) => render.file)).toEqual(["near.html"]);
  expect(previews.picture({ owner: local, file: "stored.html", sourceVersion: version(1), theme: "dark", level: "overview" }))
    .toMatchObject({ current: true });
  // Panning brings the far frame near; then it renders.
  previews.setDemand(token, demand(local, [["far.html", 3], ["near.html", 2]]));
  await settle();
  expect(renders.map((render) => render.file)).toEqual(["near.html", "far.html"]);
});

it("leaves the owner's render gap between one picture and the next", async () => {
  const { previews, renders, settle, advance, token } = harness({ renderGapMs: () => 2_000 });
  previews.setDemand(token, demand(local, [["a.html", 1], ["b.html", 2]]));
  await settle();
  expect(renders.map((render) => render.file)).toEqual(["a.html"]);
  await advance(1_999);
  expect(renders).toHaveLength(1);
  await advance(1);
  expect(renders.map((render) => render.file)).toEqual(["a.html", "b.html"]);
});

it("renders each wanted picture once, one at a time, and paints it as current", async () => {
  const { previews, renders, settle, token } = harness();
  previews.setDemand(token, demand(local, [["a.html", 1], ["b.html", 2]]));
  await settle();
  expect(renders.map((render) => render.file)).toEqual(["a.html", "b.html"]);
  expect(renders[0]).toMatchObject({ owner: local, sourceVersion: version(1), theme: "dark", maxDimension: 384 });
  const picture = previews.picture({ owner: local, file: "a.html", sourceVersion: version(1), theme: "dark", level: "overview" });
  expect(picture).toMatchObject({ current: true, width: 384, height: 288, sourceVersion: version(1) });
  expect(previews.pictured(local, "dark", [{ file: "a.html", sourceVersion: version(1) }, { file: "c.html", sourceVersion: version(3) }]))
    .toEqual(new Set(["a.html"]));
  // The same demand again renders nothing.
  previews.setDemand(token, demand(local, [["a.html", 1], ["b.html", 2]]));
  await settle();
  expect(renders).toHaveLength(2);
});

it("repaints a reopened canvas from disk without rendering anything", async () => {
  const store = memoryStore();
  const first = harness({ store });
  first.previews.setDemand(first.token, demand(local, [["a.html", 1], ["b.html", 2, "detail"]]));
  await first.settle();
  expect(first.renders).toHaveLength(2);
  expect(store.index.size).toBe(2);

  const reopened = harness({ store });
  reopened.previews.setDemand(reopened.token, demand(local, [["a.html", 1], ["b.html", 2, "detail"]]));
  await reopened.settle();
  expect(reopened.renders).toHaveLength(0);
  expect(store.reads).toBe(1);
  expect(reopened.previews.picture({ owner: local, file: "b.html", sourceVersion: version(2), theme: "dark", level: "detail" }))
    .toMatchObject({ current: true, width: 400 });
});

it("re-renders only an edited frame, showing its last picture until the new one is ready", async () => {
  const store = memoryStore();
  let release: (() => void) | null = null;
  const { previews, renders, settle, token } = harness({
    store,
    render: async (_owner, input) => {
      if (input.sourceVersion === version(9)) await new Promise<void>((resolve) => { release = resolve; });
      return { sourceVersion: input.sourceVersion, theme: input.theme, mimeType: "image/png", width: 384, height: 288, data: PNG };
    },
  });
  previews.setDemand(token, demand(local, [["a.html", 1], ["b.html", 2]]));
  await settle();
  previews.setDemand(token, demand(local, [["a.html", 9], ["b.html", 2]]));
  await settle();
  expect(renders.map((render) => [render.file, render.sourceVersion])).toEqual([
    ["a.html", version(1)], ["b.html", version(2)], ["a.html", version(9)],
  ]);
  const target = { owner: local, file: "a.html", sourceVersion: version(9), theme: "dark", level: "overview" as const };
  expect(previews.picture(target)).toMatchObject({ current: false, sourceVersion: version(1) });
  release!();
  await settle();
  expect(previews.picture(target)).toMatchObject({ current: true, sourceVersion: version(9) });
  // Disk keeps one picture per frame, theme and level.
  expect([...store.index.values()].filter((row) => row.frameKey === designPreviewFrameKey(local, "a.html", "dark"))
    .map((row) => row.sourceVersion)).toEqual([version(9)]);
});

it("keys pictures by theme, so switching theme never shows the other theme's pixels", async () => {
  const { previews, renders, settle, token } = harness();
  previews.setDemand(token, demand(local, [["a.html", 1]], "dark"));
  await settle();
  previews.setDemand(token, demand(local, [["a.html", 1]], "light"));
  expect(previews.picture({ owner: local, file: "a.html", sourceVersion: version(1), theme: "light", level: "overview" })).toBeNull();
  await settle();
  expect(renders.map((render) => render.theme)).toEqual(["dark", "light"]);
  expect(previews.picture({ owner: local, file: "a.html", sourceVersion: version(1), theme: "light", level: "overview" }))
    .toMatchObject({ current: true });
});

it("bounds memory by encoded bytes, never evicting a shown picture or rendering an evicted one again", async () => {
  const { previews, renders, revoked, settle, token } = harness({ store: null, memoryBytes: 250, pictureBytes: 100 });
  previews.setDemand(token, demand(local, [["a.html", 1]]));
  await settle();
  const shown = previews.picture({ owner: local, file: "a.html", sourceVersion: version(1), theme: "dark", level: "overview" })!;
  const release = previews.pin(shown.key);
  previews.setDemand(token, demand(local, [["a.html", 1], ["b.html", 2], ["c.html", 3], ["d.html", 4]]));
  await settle();
  expect(previews.usage().memoryBytes).toBeLessThanOrEqual(250);
  expect(previews.picture({ owner: local, file: "a.html", sourceVersion: version(1), theme: "dark", level: "overview" })?.url).toBe(shown.url);
  expect(revoked).not.toContain(shown.url);
  expect(revoked.length).toBeGreaterThan(0);
  expect(renders.map((render) => render.file)).toEqual(["a.html", "b.html", "c.html", "d.html"]);
  previews.setDemand(token, demand(local, [["a.html", 1], ["b.html", 2], ["c.html", 3], ["d.html", 4], ["e.html", 5]]));
  await settle();
  expect(renders).toHaveLength(5);
  release();
});

it.each(["personal-local", "organization-local"])("prunes restart leftovers for an HTML-only %s canvas without reading or rendering pictures", async workspaceId => {
  const store = memoryStore();
  const owner = { ...local, workspaceId };
  for (let index = 0; index < 4; index++) {
    const target = { owner, file: `old-${index}.html`, sourceVersion: version(1), theme: null, level: "overview" as const };
    const key = designPreviewKey(target);
    const blob = new Blob([new Uint8Array(100)], { type: "image/png" });
    await store.commit({ put: [{ record: { key, blob }, entry: {
      key, frameKey: designPreviewFrameKey(owner, target.file, null), workspaceId,
      sourceVersion: target.sourceVersion, level: target.level, width: 20, height: 20,
      bytes: blob.size, savedAt: index, readAt: index,
    } }] });
  }
  const readIndex = vi.spyOn(store, "readIndex");
  const h = harness({ store, diskBytes: 250 });
  // A retained hidden canvas must not start even the metadata read.
  h.previews.setDemand(h.token, activeDesignPreviewDemand(false, owner, null, []));
  await h.settle();
  expect(readIndex).not.toHaveBeenCalled();
  // Live HTML needs no picture, but its active owner still maintains the
  // persisted disk bound after an older session or interrupted cleanup.
  h.previews.setDemand(h.token, activeDesignPreviewDemand(true, owner, null, []));
  await h.settle();
  expect([...store.index.values()].reduce((sum, row) => sum + row.bytes, 0)).toBe(200);
  expect([...store.index.values()].map(row => row.readAt)).toEqual([2, 3]);
  h.previews.setDemand(h.token, activeDesignPreviewDemand(false, owner, null, []));
  h.previews.setDemand(h.token, activeDesignPreviewDemand(true, owner, null, []));
  await h.settle();
  expect(readIndex).toHaveBeenCalledTimes(1);
  expect(store.reads).toBe(0);
  expect(h.renders).toHaveLength(0);
  expect(h.created).toHaveLength(0);
  expect(h.previews.usage()).toMatchObject({ pictures: 0, demanded: 0, diskBytes: 200 });
});

it("bounds the disk copy by bytes, evicting the least recently read pictures", async () => {
  const store = memoryStore();
  const { previews, renders, settle, token } = harness({ store, diskBytes: 250, pictureBytes: 100 });
  previews.setDemand(token, demand(local, [["a.html", 1], ["b.html", 2], ["c.html", 3]]));
  await settle();
  await settle();
  expect(renders).toHaveLength(3);
  expect([...store.index.values()].reduce((total, row) => total + row.bytes, 0)).toBeLessThanOrEqual(250);
  expect([...store.index.values()].map((row) => row.frameKey)).not.toContain(designPreviewFrameKey(local, "a.html", "dark"));
  expect(store.pictures.size).toBe(store.index.size);
});

it("never renders for a cloud workspace whose VM is not running, yet shows its stored pictures", async () => {
  const store = memoryStore();
  const cloudA: DesignPreviewOwner = { scope: "cloud:account-a", workspaceId: "cloud://org/ws", directoryId: "design_main" };
  const cloudB: DesignPreviewOwner = { ...cloudA, scope: "cloud:account-b" };
  const running = harness({ store });
  running.previews.setDemand(running.token, demand(cloudA, [["a.html", 1]]));
  await running.settle();
  expect(running.renders).toHaveLength(1);

  let vmRunning = false;
  const sleeping = harness({ store, canProduce: () => vmRunning });
  sleeping.previews.setDemand(sleeping.token, demand(cloudA, [["a.html", 1], ["b.html", 2]]));
  await sleeping.settle();
  expect(sleeping.renders).toHaveLength(0);
  expect(sleeping.previews.picture({ owner: cloudA, file: "a.html", sourceVersion: version(1), theme: "dark", level: "overview" }))
    .toMatchObject({ current: true });
  // Another account on this device never sees account A's pictures.
  sleeping.previews.setDemand(sleeping.token, demand(cloudB, [["a.html", 1]]));
  await sleeping.settle();
  expect(sleeping.previews.picture({ owner: cloudB, file: "a.html", sourceVersion: version(1), theme: "dark", level: "overview" })).toBeNull();
  sleeping.previews.retainCloudScope("cloud:account-a");
  sleeping.previews.setDemand(sleeping.token, demand(cloudA, [["a.html", 1], ["b.html", 2]]));
  vmRunning = true;
  sleeping.previews.resume();
  await sleeping.settle();
  expect(sleeping.renders.map((render) => [render.owner.scope, render.file])).toEqual([["cloud:account-a", "b.html"]]);
});

it("waits for a live frame's generation to settle before picturing it", async () => {
  const { previews, renders, settle, advance, token } = harness();
  previews.setDemand(token, demand(local, [["edited.html", 1, "overview", true]]));
  await settle();
  previews.setDemand(token, demand(local, [["edited.html", 2, "overview", true]]));
  await advance(DESIGN_PREVIEW_LIVE_SETTLE_MS - 1);
  expect(renders).toHaveLength(0);
  await advance(1);
  expect(renders.map((render) => render.sourceVersion)).toEqual([version(2)]);
});

it("backs off when the capture host is missing or busy and stops retrying a broken frame", async () => {
  const failures: Record<string, string> = {
    "host.html": "No qualified Design capture host is available.",
    "busy.html": "Design capture capacity reached. Try again when the active render finishes.",
    "broken.html": "Sanitized frame HTML exceeded the 15 MiB per-frame render limit.",
  };
  let hostDown = true;
  const { previews, renders, settle, advance, token } = harness({
    render: async (_owner, input) => {
      if (input.file === "host.html" && hostDown) throw new Error(failures[input.file]);
      if (input.file === "busy.html" && renders.filter((render) => render.file === "busy.html").length < 3) throw new Error(failures[input.file]);
      if (input.file === "broken.html") throw new Error(failures[input.file]);
      return { sourceVersion: input.sourceVersion, theme: input.theme, mimeType: "image/png", width: 384, height: 288, data: PNG };
    },
  });
  previews.setDemand(token, demand(local, [["host.html", 1]]));
  await settle();
  expect(renders).toHaveLength(1);
  await advance(60_000);
  expect(renders).toHaveLength(1);
  hostDown = false;
  await advance(5 * 60_000);
  expect(renders).toHaveLength(2);

  previews.setDemand(token, demand(local, [["busy.html", 2], ["broken.html", 3]]));
  await settle();
  for (let step = 0; step < 6; step++) await advance(30_000);
  expect(renders.filter((render) => render.file === "busy.html")).toHaveLength(3);
  expect(previews.picture({ owner: local, file: "busy.html", sourceVersion: version(2), theme: "dark", level: "overview" }))
    .toMatchObject({ current: true });
  expect(renders.filter((render) => render.file === "broken.html")).toHaveLength(2);
});

it("does not retry a stale answer until the canvas asks for the saved generation", async () => {
  const { previews, renders, settle, advance, token } = harness({
    render: async (_owner, input) => input.sourceVersion === version(1)
      ? { stale: true, sourceVersion: version(2) }
      : { sourceVersion: input.sourceVersion, theme: input.theme, mimeType: "image/png", width: 384, height: 288, data: PNG },
  });
  previews.setDemand(token, demand(local, [["a.html", 1]]));
  await settle();
  await advance(60_000);
  expect(renders).toHaveLength(1);
  previews.setDemand(token, demand(local, [["a.html", 2]]));
  await settle();
  expect(renders.map((render) => render.sourceVersion)).toEqual([version(1), version(2)]);
});

it("never lets a slow disk read of an older picture replace a newer render", async () => {
  let releaseRead: (() => void) | null = null;
  const store = memoryStore();
  const seed = harness({ store });
  seed.previews.setDemand(seed.token, demand(local, [["a.html", 1]]));
  await seed.settle();

  const slowStore = memoryStore({ readDelay: () => new Promise<void>((resolve) => { releaseRead = resolve; }) });
  for (const [key, record] of store.pictures) slowStore.pictures.set(key, record);
  for (const [key, row] of store.index) slowStore.index.set(key, row);
  const { previews, settle, token } = harness({ store: slowStore });
  // Asks for v2: disk only has v1, read as the stand-in while v2 renders.
  previews.setDemand(token, demand(local, [["a.html", 2]]));
  await settle();
  expect(releaseRead).not.toBeNull();
  const target = { owner: local, file: "a.html", sourceVersion: version(2), theme: "dark", level: "overview" as const };
  releaseRead!();
  await settle();
  await settle();
  expect(previews.picture(target)).toMatchObject({ current: true, sourceVersion: version(2) });
});

it.each(["render", "encode"] as const)("keeps the current disk generation when an obsolete %s finishes", async (stage) => {
  const store = memoryStore();
  const seed = harness({ store });
  seed.previews.setDemand(seed.token, demand(local, [["a.html", 2]]));
  await seed.settle();

  let release: (() => void) | null = null;
  const hold = () => new Promise<void>((resolve) => { release = resolve; });
  const h = harness({
    store,
    render: async (_owner, input) => {
      if (stage === "render") await hold();
      return { sourceVersion: input.sourceVersion, theme: input.theme, mimeType: "image/png", width: 384, height: 288, data: PNG };
    },
    encode: async (png) => { if (stage === "encode") await hold(); return png; },
  });
  h.previews.setDemand(h.token, demand(local, [["a.html", 1]]));
  await h.settle();
  expect(release).not.toBeNull();
  // The live frame adopts v2 from disk while v1 is still in flight. Its
  // settle delay also proves v2 survives without a repair capture.
  h.previews.setDemand(h.token, demand(local, [["a.html", 2, "overview", true]]));
  await h.settle();
  const target = { owner: local, file: "a.html", sourceVersion: version(2), theme: "dark", level: "overview" as const };
  expect(h.previews.picture(target)).toMatchObject({ current: true, sourceVersion: version(2) });
  release!();
  await h.settle();
  expect(h.previews.picture(target)).toMatchObject({ current: true, sourceVersion: version(2) });
  expect([...store.index.values()].map((row) => row.sourceVersion)).toEqual([version(2)]);
  expect(h.renders.map((render) => render.sourceVersion)).toEqual([version(1)]);
});

it("does not restore a removed workspace when its encoding finishes", async () => {
  const store = memoryStore();
  let release: (() => void) | null = null;
  const h = harness({ store, encode: async (png) => {
    await new Promise<void>((resolve) => { release = resolve; });
    return png;
  } });
  h.previews.setDemand(h.token, demand(local, [["a.html", 1]]));
  await h.settle();
  expect(release).not.toBeNull();
  h.previews.forgetWorkspaces([local.workspaceId]);
  release!();
  await h.settle();
  expect(h.previews.usage()).toMatchObject({ pictures: 0, diskPictures: 0, demanded: 0 });
  expect(store.index.size).toBe(0);
  expect(store.pictures.size).toBe(0);
});

it("discards hidden encoding without suppressing the next visible request", async () => {
  let visible = true;
  let release: (() => void) | null = null;
  const h = harness({ visible: () => visible, encode: async (png) => {
    if (!release) await new Promise<void>((resolve) => { release = resolve; });
    return png;
  } });
  h.previews.setDemand(h.token, demand(local, [["a.html", 1]]));
  await h.settle();
  expect(release).not.toBeNull();
  visible = false;
  release!();
  await h.settle();
  expect(h.previews.usage()).toMatchObject({ pictures: 0, diskPictures: 0 });
  visible = true;
  h.previews.resume();
  await h.settle();
  expect(h.renders).toHaveLength(2);
  expect(h.previews.picture({ owner: local, file: "a.html", sourceVersion: version(1), theme: "dark", level: "overview" }))
    .toMatchObject({ current: true });
});

it.each(["owner switch", "workspace removal", "canvas hide"] as const)("rejects work from before %s even after returning to the same generation", async (transition) => {
  const store = memoryStore();
  let release: (() => void) | null = null;
  const h = harness({ store, encode: async (png) => {
    if (!release) await new Promise<void>((resolve) => { release = resolve; });
    return png;
  } });
  const original = demand(local, [["a.html", 1]]);
  h.previews.setDemand(h.token, original);
  await h.settle();
  expect(release).not.toBeNull();
  if (transition === "owner switch")
    h.previews.setDemand(h.token, demand({ ...local, workspaceId: "workspace-2" }, [["a.html", 1]]));
  else if (transition === "workspace removal") h.previews.forgetWorkspaces([local.workspaceId]);
  else h.previews.setDemand(h.token, null);
  h.previews.setDemand(h.token, original);
  release!();
  await h.settle();
  expect(h.renders.map((render) => render.owner.workspaceId)).toEqual([local.workspaceId, local.workspaceId]);
  expect(store.index.size).toBe(1);
  expect(h.previews.picture({ owner: local, file: "a.html", sourceVersion: version(1), theme: "dark", level: "overview" }))
    .toMatchObject({ current: true });
});

it("keeps a useful same-generation resolution when zoom changes during encoding", async () => {
  const store = memoryStore();
  let release: (() => void) | null = null;
  const h = harness({ store, encode: async (png) => {
    if (!release) await new Promise<void>((resolve) => { release = resolve; });
    return png;
  } });
  h.previews.setDemand(h.token, demand(local, [["a.html", 1]]));
  await h.settle();
  expect(release).not.toBeNull();
  h.previews.setDemand(h.token, demand(local, [["a.html", 1, "detail"]]));
  release!();
  await h.settle();
  expect(h.renders.map((render) => render.maxDimension)).toEqual([384, 1280]);
  expect([...store.index.values()].map((row) => row.level).sort()).toEqual(["detail", "overview"]);
});

it("lets only the canvas that set the demand clear it", async () => {
  const { previews, renders, settle } = harness({ canProduce: () => true });
  const shown = {};
  const hidden = {};
  previews.setDemand(shown, demand(local, [["a.html", 1]]));
  previews.setDemand(hidden, null);
  await settle();
  expect(renders).toHaveLength(1);
});

it("reads a stored detail picture when the overview of the same generation is already shown", async () => {
  const store = memoryStore();
  const first = harness({ store });
  first.previews.setDemand(first.token, demand(local, [["a.html", 1]]));
  await first.settle();
  first.previews.setDemand(first.token, demand(local, [["a.html", 1, "detail"]]));
  await first.settle();
  expect(first.renders.map((render) => render.maxDimension)).toEqual([384, 1280]);

  const reopened = harness({ store });
  reopened.previews.setDemand(reopened.token, demand(local, [["a.html", 1]]));
  await reopened.settle();
  // Zoomed in, the frame stays a picture and wants its sharp level.
  reopened.previews.setDemand(reopened.token, demand(local, [["a.html", 1, "detail"]]));
  await reopened.settle();
  expect(reopened.previews.picture({ owner: local, file: "a.html", sourceVersion: version(1), theme: "dark", level: "detail" }))
    .toMatchObject({ current: true, level: "detail" });
  expect(reopened.renders).toHaveLength(0);
});

it("reads the pictured frames as one set per membership, recomputing only when pictures or inputs change", () => {
  let changes = 0;
  let members = ["a.html"];
  let reads = 0;
  const read = createDesignFramePicturedReader({
    changes: () => changes,
    pictured: () => { reads++; return new Set(members); },
  });
  const frames = [{ file: "a.html", sourceVersion: version(1) }, { file: "b.html", sourceVersion: version(1) }];
  const first = read(local, null, frames);
  expect([...first]).toEqual(["a.html"]);
  // A render with nothing new does no work and keeps the set.
  expect(read(local, null, frames)).toBe(first);
  expect(reads).toBe(1);
  // A batch that leaves the members alone (a detail after its overview, or
  // another workspace's picture) keeps the set, so the canvas does not render.
  changes++;
  expect(read(local, null, frames)).toBe(first);
  expect(reads).toBe(2);
  members = ["a.html", "b.html"];
  changes++;
  const second = read(local, null, frames);
  expect([...second]).toEqual(["a.html", "b.html"]);
  expect(read(local, "dark", frames)).toBe(second);
  expect(read(null, null, frames).size).toBe(0);
});

it("captures a live frame in its own document only while it is selected or has no picture", () => {
  const picture = { key: "k", url: "blob:test/1", sourceVersion: version(1), width: 384, height: 240, current: true, level: "overview" as const };
  expect(designFrameAutoCapture(true, picture)).toBe(true);
  expect(designFrameAutoCapture(false, null)).toBe(true);
  // The host renders each generation's picture; a stale one holds the
  // frame's last pixels meanwhile, so the in-frame copy would be redundant.
  expect(designFrameAutoCapture(false, picture)).toBe(false);
  expect(designFrameAutoCapture(false, { ...picture, current: false })).toBe(false);
});
