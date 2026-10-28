import { describe, expect, it } from "vitest";
import { DesignSourceSurfaceBudget, selectDesignSourceSurfaces } from "../design-source-surfaces";

const frames = Array.from({ length: 256 }, (_, index) => ({
  file: `frame-${index}.html`, sourceVersion: "a".repeat(24),
  surfaceCost: { nodes: 100, sourceBytes: 4000, imageBytes: 0 },
}));

describe("Design source surface admission", () => {
  it("admits a 256-frame overview without making each frame an editing runtime", () => {
    expect(selectDesignSourceSurfaces(frames).size).toBe(256);
  });
  it("bounds aggregate DOM, source and image costs, with deterministic fallback", () => {
    const large = frames.map(frame => ({ ...frame, surfaceCost: { nodes: 4000, sourceBytes: 1024 * 1024, imageBytes: 4 * 1024 * 1024 } }));
    const admitted = selectDesignSourceSurfaces(large);
    expect(admitted.size).toBeGreaterThan(0);
    expect(admitted.size).toBeLessThanOrEqual(8);
    expect([...selectDesignSourceSurfaces(large)]).toEqual([...admitted]);
  });
  it("does not invent costs for legacy, corrupt, or unprepared frames", () => {
    expect(selectDesignSourceSurfaces([
      { file: "legacy.html", sourceVersion: "a".repeat(24) },
      { ...frames[0]!, surfaceCost: { nodes: -1, sourceBytes: 1, imageBytes: 0 } },
      { ...frames[1]!, sourceVersion: undefined },
    ]).size).toBe(0);
  });
  it("shares the document budget across owners and returns it on retirement", () => {
    const budget = new DesignSourceSurfaceBudget();
    const leases = frames.map(frame => budget.acquire(frame.surfaceCost));
    expect(leases.every(Boolean)).toBe(true);
    expect(budget.acquire(frames[0]!.surfaceCost)).toBeNull();
    for (const release of leases) { release!(); release!(); }
    expect(budget.usage()).toEqual({ frames: 0, nodes: 0, sourceBytes: 0, imageBytes: 0 });
    expect(budget.acquire(frames[0]!.surfaceCost)).not.toBeNull();
  });
  it("counts both generations during the one allowed replacement and releases them independently", () => {
    const budget = new DesignSourceSurfaceBudget();
    const old = budget.acquire(frames[0]!.surfaceCost)!;
    const incomingCost = { nodes: 120, sourceBytes: 5000, imageBytes: 1024 };
    const incoming = budget.acquireOverlap(incomingCost)!;
    expect(incoming).not.toBeNull();
    expect(budget.usage()).toMatchObject({ frames: 2, nodes: 220, sourceBytes: 9000, imageBytes: 1024 });
    expect(budget.acquireOverlap(incomingCost)).toBeNull();
    old();
    expect(budget.usage()).toMatchObject({ frames: 1, ...incomingCost });
    incoming(); incoming();
    expect(budget.usage()).toEqual({ frames: 0, nodes: 0, sourceBytes: 0, imageBytes: 0 });
  });

  it("waits for the owner-switch commit to release old sources before declaring the new overview unavailable", async () => {
    const budget = new DesignSourceSurfaceBudget();
    const old = frames.slice(0, 3).map(frame => budget.acquire(frame.surfaceCost)!);
    const admitted: number[] = []; const refused: number[] = [];
    const next = frames.map((frame, index) => budget.request(frame.surfaceCost, () => admitted.push(index), () => refused.push(index)));
    expect(admitted).toHaveLength(253);
    for (const release of old) release();
    await Promise.resolve();
    expect(admitted).toHaveLength(256);
    expect(refused).toEqual([]);
    for (const release of next) release();
    expect(budget.usage()).toEqual({ frames: 0, nodes: 0, sourceBytes: 0, imageBytes: 0 });
  });

  it("cancels deferred source admission on hide and refuses real saturation after the commit", async () => {
    const budget = new DesignSourceSurfaceBudget();
    const held = frames.map(frame => budget.acquire(frame.surfaceCost)!);
    let admitted = 0, refused = 0;
    const cancelled = budget.request(frames[0]!.surfaceCost, () => admitted++, () => refused++);
    cancelled();
    const pending = budget.request(frames[0]!.surfaceCost, () => admitted++, () => refused++);
    await Promise.resolve();
    expect(admitted).toBe(0); expect(refused).toBe(1);
    pending(); for (const release of held) release();
    await Promise.resolve();
    expect(admitted).toBe(0);
  });
});
