import type { CSSProperties } from "react";
import type { DesignViewport } from "./design-canvas-math";
export const DESIGN_CANVAS_INVERSE_ZOOM = "var(--design-canvas-inverse-zoom)";

type DesignCanvasWorldStyle = CSSProperties & {
  "--design-canvas-zoom": number;
  "--design-canvas-inverse-zoom": number;
};

/** Canvas chrome is authored in world coordinates but must keep a stable
 * physical size. A CSS custom property lets an imperative wheel/pan paint
 * update the camera and every descendant affordance in the same style pass,
 * without waiting for the debounced React store commit. */
export function designCanvasScreenPixels(pixels: number): string {
  return `calc(${pixels}px * ${DESIGN_CANVAS_INVERSE_ZOOM})`;
}

export function designCanvasCameraStyle(
  viewport: DesignViewport,
): DesignCanvasWorldStyle {
  return {
    transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})`,
    "--design-canvas-zoom": viewport.zoom,
    "--design-canvas-inverse-zoom": 1 / viewport.zoom,
  };
}

export function paintDesignCanvasCamera(
  world: HTMLDivElement | null,
  viewport: DesignViewport,
  gestureActive: boolean,
): void {
  if (!world) return;
  const style = designCanvasCameraStyle(viewport);
  world.style.transform = String(style.transform);
  world.style.setProperty("--design-canvas-zoom", String(viewport.zoom));
  world.style.setProperty(
    "--design-canvas-inverse-zoom",
    String(1 / viewport.zoom),
  );
  world.toggleAttribute("data-design-camera-gesture", gestureActive);
}
