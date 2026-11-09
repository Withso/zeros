import { describe, expect, it } from "vitest";
import { designCaptureFramePolicy } from "../../src/engine/design/capture-sheet";
import { sharedDesignParseStatsForTests } from "../../src/engine/design/shared-parse";
import { insertDesignHeadMarkup, sanitizeDesignFrameMarkup } from "../../src/engine/design/source";
import { DESIGN_RECORDER_RASTER_SCALE, designRecorderDocument, designRecorderMetrics } from "../design-recorder-document";

// What the engine's compose sends: already sanitized, stylesheets linked.
const composed = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="zeros-sheet://css/abc"></head>` +
  `<body><main class="card"><h1>Pricing</h1><img src="data:image/png;base64,iVBORw0KGgo="></main></body></html>`;

function parsesDuring(work: () => Promise<unknown>): Promise<number> {
  const before = sharedDesignParseStatsForTests().parses;
  return work().then(() => sharedDesignParseStatsForTests().parses - before);
}

describe("recorder documents", () => {
  it("prepares an already-sanitized frame with one parse", async () => {
    // The recorder's main thread drives every window: a second full parse of
    // each frame was a large share of its time on a 1,000-frame open.
    const expected = insertDesignHeadMarkup(sanitizeDesignFrameMarkup(composed), designCaptureFramePolicy("dark"));
    let document = "";
    expect(await parsesDuring(async () => { document = await designRecorderDocument(composed, "dark"); })).toBe(1);
    expect(document).toBe(expected);
  });

  it("still sanitizes markup that arrives with active content", async () => {
    const active = composed.replace("<h1>", `<script>alert(1)</script><h1 onclick="steal()">`);
    let document = "";
    expect(await parsesDuring(async () => { document = await designRecorderDocument(active, "light"); })).toBe(2);
    expect(document).toBe(insertDesignHeadMarkup(sanitizeDesignFrameMarkup(active), designCaptureFramePolicy("light")));
    expect(document).not.toContain("<script>alert");
    expect(document).not.toContain("onclick");
  });

  it("lays a frame out at its own size and density, shown whole at the raster scale", () => {
    expect(designRecorderMetrics({ width: 1440, height: 900 }, 2)).toEqual({
      width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
      viewport: { x: 0, y: 0, width: 1440, height: 900, scale: DESIGN_RECORDER_RASTER_SCALE },
    });
    expect(DESIGN_RECORDER_RASTER_SCALE).toBeLessThan(1);
    // Not a power of two, the scale left rounding residue in recorded
    // matrices (0.05 changed 3 of 46 recordings).
    expect(Number.isInteger(Math.log2(DESIGN_RECORDER_RASTER_SCALE))).toBe(true);
  });
});
