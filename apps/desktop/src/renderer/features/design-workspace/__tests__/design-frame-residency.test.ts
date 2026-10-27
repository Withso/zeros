import { describe, expect, it } from "vitest";
import { createDesignFrameResidencyReader, DESIGN_MAX_NEARBY_FRAME_SURFACES, type DesignFrameResidencyInput } from "../design-frame-residency";
import { DesignFrameSpatialIndex, type DesignSpatialFrame } from "../design-frame-spatial-index";

const frame = (file: string, x: number, y = 0) => ({ file, x, y, width: 200, height: 100 });
const setup = (frames: DesignSpatialFrame[]): DesignFrameResidencyInput<DesignSpatialFrame> => ({
  owner: "personal-local/directory/page", frames, index: new DesignFrameSpatialIndex(frames),
  view: { zoom: 1, panX: 0, panY: 0 }, viewport: { width: 800, height: 600 },
  active: true, selectedFrame: null, requiredFiles: [], pictured: new Set(frames.map((f) => f.file)), devicePixelRatio: 1,
});

describe("Design frame surface residency", () => {
  it("keeps last-confirmed source presentation while revalidation fences editing authority", () => {
    const confirmed = { ...frame("home.html", 0), sourceVersion: "a".repeat(24),
      surfaceCost: { nodes: 10, sourceBytes: 2000, imageBytes: 0 } };
    const input = { ...setup([confirmed]), sourceSurfacesEnabled: true, pictured: new Set<string>(),
      sourceReady: new Map([[confirmed.file, confirmed.sourceVersion]]) };
    const read = createDesignFrameResidencyReader();
    expect(read(input).sources.has(confirmed.file)).toBe(true);
    const descriptions = [{ ...frame("home.html", 0), preparation: "unprepared" as const, previous: confirmed }];
    const pending = read({ ...input, frames: descriptions, index: new DesignFrameSpatialIndex(descriptions), selectedFrame: "home.html" });
    expect(pending.sources.has(confirmed.file)).toBe(true);
    expect(pending.live.size).toBe(0);
  });
  it("does not turn unprepared descriptors into protected editing documents during passive loading", () => {
    const descriptions = Array.from({ length: 32 }, (_, index) => ({ ...frame(String(index), index % 8 * 240, Math.floor(index / 8) * 120),
      preparation: "unprepared" as const }));
    const read = createDesignFrameResidencyReader();
    const input = { ...setup(descriptions), view: { zoom: 0.25, panX: 0, panY: 0 }, sourceSurfacesEnabled: true, pictured: new Set<string>() };
    expect(read(input).live.size).toBe(0);
    const frames = descriptions.map(({ preparation: _preparation, ...description }) => ({ ...description,
      sourceVersion: "a".repeat(24), surfaceCost: { sourceBytes: 2000, nodes: 80, imageBytes: 0 } }));
    const prepared = { ...input, frames, index: new DesignFrameSpatialIndex(frames) };
    expect(read(prepared).live.size).toBe(0);
    expect(read({ ...prepared, selectedFrame: "0", requiredFiles: ["1"] }).live).toEqual(new Set(["0", "1"]));
  });
  it("retains visited passive HTML within its budget across close zoom and back", () => {
    const frames = Array.from({ length: 256 }, (_, index) => ({ ...frame(String(index), index % 16 * 400, Math.floor(index / 16) * 200),
      sourceVersion: "a".repeat(24), surfaceCost: { sourceBytes: 2000, nodes: 80, imageBytes: 0 } }));
    const input = { ...setup(frames), sourceSurfacesEnabled: true,
      sourceReady: new Map(frames.map(frame => [frame.file, frame.sourceVersion])) };
    const read = createDesignFrameResidencyReader();
    const overview = read({ ...input, view: { zoom: 0.1, panX: 0, panY: 0 } });
    expect(overview.sources.size).toBe(256);
    const close = read({ ...input, view: { zoom: 4, panX: 0, panY: 0 } });
    expect(close.sources).toBe(overview.sources);
    expect(close.frames).toHaveLength(256);
    expect(close.visible.size).toBeLessThan(10);
    expect(read({ ...input, active: false }).sources.size).toBe(0);
  });
  it("keeps offscreen descriptors out of the mounted set without changing scene order", () => {
    const frames = [frame("front", 100), frame("back", 100), ...Array.from({ length: 254 }, (_, i) => frame(`far-${i}`, 10000 + i * 400))];
    const read = createDesignFrameResidencyReader();
    const result = read(setup(frames));
    expect(result.frames).toEqual(frames.slice(0, 2));
    expect(result.live.size).toBe(0);
  });

  it("uses the moving camera and keeps collection identities stable inside hysteresis", () => {
    const input = setup([frame("left", 0), frame("right", 4000)]);
    const read = createDesignFrameResidencyReader();
    const start = read(input);
    expect(read({ ...input, view: { ...input.view, panX: 1 } })).toBe(start);
    const moving = read({ ...input, view: { ...input.view, panX: -4000 } });
    expect(moving.frames.map((f) => f.file)).toEqual(["right"]);
    expect(read(input).frames.map((f) => f.file)).toEqual(["left"]);
  });

  it("bounds nearby wrappers, while all actually visible frames remain paintable", () => {
    const frames = Array.from({ length: 256 }, (_, i) => frame(String(i), 900));
    const input = setup(frames);
    const read = createDesignFrameResidencyReader();
    expect(read(input).frames.length).toBe(DESIGN_MAX_NEARBY_FRAME_SURFACES);
    expect(read({ ...input, view: { zoom: 0.1, panX: 0, panY: 0 } }).frames).toEqual(frames);
  });

  it("keeps visible live pixels until a decoded cover permits reprioritizing the slot", () => {
    const frames = Array.from({ length: 24 }, (_, i) => frame(String(i), i % 8 * 240, Math.floor(i / 8) * 200));
    const input = { ...setup(frames), view: { zoom: 0.5, panX: 0, panY: 0 }, pictured: new Set<string>(), covered: new Set<string>() };
    const read = createDesignFrameResidencyReader();
    const first = read(input);
    const visiblePrevious = [...first.live].filter(file => {
      const item = frames.find(frame => frame.file === file)!;
      return item.x + item.width >= 400 && item.x <= 2000;
    });
    expect(visiblePrevious.length).toBeGreaterThan(0);
    const moving = { ...input, view: { ...input.view, panX: -200 } };
    const held = read(moving);
    expect(held.live.size).toBeLessThanOrEqual(12);
    expect(visiblePrevious.filter(file => !held.live.has(file))).toEqual([]);
    const covered = read({ ...moving, covered: new Set(frames.map(frame => frame.file)) });
    expect(visiblePrevious.some(file => !covered.live.has(file))).toBe(true);
    expect(covered.live.size).toBeLessThanOrEqual(12);
  });

  it("protects the editor and bounded layer demand without mounting an entire selection", () => {
    const input = setup(Array.from({ length: 256 }, (_, i) => frame(String(i), 10000 + i * 400)));
    const read = createDesignFrameResidencyReader();
    const result = read({ ...input, selectedFrame: "255", requiredFiles: input.frames.map((f) => f.file) });
    expect(result.frames).toHaveLength(12);
    expect(result.live.has("255")).toBe(true);
    const editing = read({ ...input, selectedFrame: "255", protectedFiles: ["254"], requiredFiles: input.frames.map((f) => f.file) });
    expect(editing.live.has("254")).toBe(true);
    expect(editing.live.size).toBe(12);
    expect(read({ ...input, selectedFrame: "255", protectedFiles: ["254"] }).frames.map((f) => f.file)).toEqual(["254", "255"]);
  });

  it("queries moved geometry without rebuilding the index and prunes removed owners", () => {
    const input = setup([frame("a", 0), frame("b", 4000)]);
    const read = createDesignFrameResidencyReader();
    read(input);
    expect(read({ ...input, geometry: new Map([["a", { x: 4000, y: 0, width: 200, height: 100 }], ["b", { x: 0, y: 0, width: 200, height: 100 }]]) }).frames.map((f) => f.file)).toEqual(["b"]);
    const live = read({ ...input, selectedFrame: "b" });
    expect(live.live.has("b")).toBe(true);
    expect(read({ ...input, active: false }).frames.map((f) => f.file)).toEqual(["b"]);
    expect(read({ ...input, owner: "organization-local/other-directory/page", active: false }).frames).toEqual([]);
    expect(read(input).frames.map((f) => f.file)).toEqual(["a"]);
  });
});
