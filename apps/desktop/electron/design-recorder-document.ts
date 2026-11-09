// What the Design recorder (design-recorder-host.ts) hands a window: the
// frame's document and the metrics it lays out at. Kept apart from the host
// so it can be tested without Electron.
import { designCaptureFramePolicy } from "../src/engine/design/capture-sheet";
import { withSharedDesignParses } from "../src/engine/design/shared-parse";
import { insertDesignHeadMarkup, sanitizeDesignFrameMarkup } from "../src/engine/design/source";

/** A frame's document, sanitized again here, since the recorder's pages run
 * unsandboxed. The engine composes frames already sanitized, so this usually
 * returns the markup unchanged, and the head insertion reuses its parse. */
export function designRecorderDocument(html: string, colorScheme: "light" | "dark"): Promise<string> {
  return withSharedDesignParses(async () =>
    insertDesignHeadMarkup(sanitizeDesignFrameMarkup(html), designCaptureFramePolicy(colorScheme)));
}

/** Page scale a recorder window shows its frame at. Nothing looks at these
 * windows and a frame's picture is recorded before raster, so raster is pure
 * cost: at full size it was the recorder GPU process's main work. A power of
 * two keeps Blink's pixel snapping exact: at 0.05, 3 of 46 recordings gained
 * subnormal skews in their matrices. At 1/16 every byte matches full scale. */
export const DESIGN_RECORDER_RASTER_SCALE = 1 / 16;

/** A frame lays out at its own size and density (the page sees exactly these
 * metrics); the window shows all of it at `DESIGN_RECORDER_RASTER_SCALE`. */
export function designRecorderMetrics(viewport: { width: number; height: number }, ratio: number) {
  return {
    width: viewport.width, height: viewport.height, deviceScaleFactor: ratio, mobile: false,
    viewport: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: DESIGN_RECORDER_RASTER_SCALE },
  };
}
