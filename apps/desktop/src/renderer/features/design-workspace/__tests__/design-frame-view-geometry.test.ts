import { describe, expect, it } from "vitest";
import type { DesignFrameGeometryWire } from "../../../platform/bridge/design-bridge";
import { designFramesAtPresentedGeometry, type DesignFrameView } from "../state/design-frame-view";

const frame = (file: string, x: number) => ({
  file, title: file, x, y: 0, width: 400, height: 300, z: 0, modifiedAt: 1, nodeCount: 1,
  sourceVersion: "a".repeat(24),
});

describe("history geometry presentation", () => {
  it("places frames where Undo shows them, including a revalidating frame's cover, with stable references", () => {
    const home = frame("home.html", 0);
    const pricing = frame("pricing.html", 600);
    const revalidating = { file: "about.html", title: "About", x: 1200, y: 0, width: 400, height: 300, z: 1, previous: frame("about.html", 1200) } as DesignFrameView;
    const frames: readonly DesignFrameView[] = [home, pricing, revalidating];
    const geometry: ReadonlyMap<string, DesignFrameGeometryWire> = new Map([
      ["pricing.html", { x: 640, y: 40, w: 400, h: 300, z: 2 }],
      ["about.html", { x: 1300, y: 10, w: 420, h: 320, z: 3 }],
    ]);
    const presented = designFramesAtPresentedGeometry(frames, geometry);
    expect(presented[0]).toBe(home);
    expect(presented[1]).toMatchObject({ file: "pricing.html", x: 640, y: 40, z: 2 });
    expect(presented[2]).toMatchObject({ x: 1300, y: 10, width: 420, height: 320, previous: { x: 1300, y: 10, width: 420, height: 320 } });
    // The confirmed views are untouched and repeated reads keep identity.
    expect(pricing.x).toBe(600);
    expect(designFramesAtPresentedGeometry(frames, geometry)).toBe(presented);
    expect(designFramesAtPresentedGeometry(frames, null)).toBe(frames);
    expect(designFramesAtPresentedGeometry(frames, new Map())).toBe(frames);
  });
});
