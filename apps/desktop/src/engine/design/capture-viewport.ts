import {
  designCaptureRasterSize,
  type DesignCaptureRequest,
} from "@zeros/protocol/design-capture";
import { assertDesignCapturePng } from "./capture-service";

function scaledViewport(input: DesignCaptureRequest) {
  const viewport = input.layoutViewport ?? input;
  const { scale } = designCaptureRasterSize(viewport);
  return {
    x: 0,
    y: 0,
    // Subpixel rasters can otherwise round to zero and stall Chromium.
    // Keep at least one output pixel on either axis without changing layout.
    width: Math.max(viewport.width, 1 / scale),
    height: Math.max(viewport.height, 1 / scale),
    scale,
  };
}

/** Both qualified hosts keep layout/media queries at the authored frame size.
 * The private debugger connection belongs to this disposable capture only. */
export async function prepareDesignCaptureViewport(
  input: DesignCaptureRequest,
  setMetrics: (params: {
    width: number;
    height: number;
    deviceScaleFactor: 1;
    mobile: false;
    viewport: ReturnType<typeof scaledViewport>;
  }) => Promise<unknown>,
): Promise<void> {
  if (!input.layoutViewport) return;
  await setMetrics({
    ...input.layoutViewport,
    deviceScaleFactor: 1,
    mobile: false,
    // Scale the surface before painting as well as the final screenshot.
    // A full-resolution surface can leave unrasterized tiles in large frames.
    // This override does not change CSS viewport dimensions or DPR.
    viewport: scaledViewport(input),
  });
}

export async function captureScaledDesignPng(
  input: DesignCaptureRequest,
  capture: (params: {
    format: "png";
    fromSurface: true;
    captureBeyondViewport: false;
    clip: ReturnType<typeof scaledViewport>;
  }) => Promise<{ data: string }>,
): Promise<Buffer> {
  const result = await capture({
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    clip: scaledViewport(input),
  });
  const bytes = Buffer.from(result.data, "base64");
  assertDesignCapturePng(bytes, input.width, input.height);
  return bytes;
}
