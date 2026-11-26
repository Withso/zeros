import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import type { DesignCanvasFrameWire } from "../../platform/git";
import {
  designSelectionBox,
  designSelectionBoxCorners,
  designSelectionLabelPlacement,
  designSelectionOverlayFrame,
} from "./design-canvas-math";
import { DESIGN_CANVAS_INVERSE_ZOOM, designCanvasScreenPixels } from "./design-canvas-camera";
import { DESIGN_CANVAS_CHIP_CLS } from "./design-canvas-chip";
import { designSizeBadgeText } from "./design-layout-tools";
import { designRuntimeFrameState } from "./state/design-runtime-store";
import { designWorkspaceView } from "./state/design-workspace-ui";

/** Device pixels in one capture; a whole large frame at 4× would otherwise
 * decode hundreds of megabytes for a temporary picture. */
const MAX_CAPTURE_PIXELS = 4096 * 4096;

/** What a frame shows while it is handled (design-workspace-ui.css): a moved
 * or nudged frame keeps only its name, in the selection color; a resized one
 * keeps its box and live size but drops Play; an Option-drag copy's source
 * stays behind as an unselected frame. */
export type DesignFrameGestureChrome = "move" | "resize" | "copy-source";

export function paintDesignFrameGestureChrome(
  article: Element | null | undefined,
  gesture: DesignFrameGestureChrome | null,
): void {
  if (!article) return;
  if (gesture) article.setAttribute("data-design-frame-gesture", gesture);
  else article.removeAttribute("data-design-frame-gesture");
}

/** A keyboard nudge has no release to wait for, so its frames rest this long
 * after the last step before their selection chrome returns. */
export const DESIGN_FRAME_NUDGE_REST_MS = 1_000;

export function createDesignFrameNudgeChrome(restMs = DESIGN_FRAME_NUDGE_REST_MS) {
  const held = new Set<Element>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const element of held) paintDesignFrameGestureChrome(element, null);
    held.clear();
  };
  return {
    hold(elements: Iterable<Element | null | undefined>) {
      for (const element of elements) {
        if (!element || held.has(element)) continue;
        held.add(element);
        paintDesignFrameGestureChrome(element, "move");
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(release, restMs);
    },
    release,
  };
}

type DragNode = Pick<DesignRuntimeNodeDetails, "oid" | "rect"> &
  Partial<Pick<DesignRuntimeNodeDetails, "box" | "borderCoordinateSpace" | "styles">>;

/** Reuse already captured pixels across opaque iframe boundaries. There is no
 * document clone, rasterization, store write, or layout read per pointer sample. */
export function createDesignDragPresentation(
  workspaceId: string,
  frame: DesignCanvasFrameWire,
  details: DragNode,
  article: HTMLElement,
  options: {
    /** Draw the layer's own selection on the picture while it is outside its
     * frame. The frame's overlay sits beneath the picture there, so it would
     * otherwise be covered by the very pixels it describes. */
    selection?: boolean;
    /** The live camera zoom, when the caller holds a newer one than the store. */
    zoom?: number;
    /** A frame's name above the picture, as its own label draws it. */
    name?: { text: string; component?: boolean };
  } = {},
) {
  const world = article.closest<HTMLElement>("[data-design-canvas-world]");
  if (!world) return null;
  const cached = designRuntimeFrameState(workspaceId, frame.file);
  const nodeImage = cached?.screenshotsByNode[details.oid];
  const frameImage = cached?.screenshotsByNode[""];
  const drawnScale = (options.zoom ?? designWorkspaceView(workspaceId).zoom ?? 1) * (window.devicePixelRatio || 1);
  const wantedScale = Math.min(4, Math.max(1, drawnScale),
    Math.sqrt(MAX_CAPTURE_PIXELS / Math.max(1, details.rect.width * details.rect.height)));
  const exactNode =
    nodeImage?.sourceVersion === frame.sourceVersion ? nodeImage : null;
  const cachedShot =
    exactNode ??
    (frameImage?.sourceVersion === frame.sourceVersion ? frameImage : null);
  const sourceImage = article.querySelector<HTMLImageElement>(`img[data-design-source-ready][data-design-source-version="${CSS.escape(frame.sourceVersion)}"]`);
  const vectorReady = Boolean(sourceImage?.complete && sourceImage.naturalWidth > 0);
  // Background pictures are made for the zoom they were seen at (often a
  // quarter scale). The ready vector source stays sharp at any zoom.
  const screenshot = cachedShot && (cachedShot.scale >= wantedScale || !vectorReady) ? cachedShot : null;
  const element = document.createElement("div");
  element.className = "zd-design-drag-preview";
  element.dataset.designDragPreview = details.oid;
  element.hidden = true;
  Object.assign(element.style, {
    width: `${details.rect.width}px`,
    height: `${details.rect.height}px`,
  });
  let z = frame.z;
  for (const sibling of world.children)
    if (
      sibling instanceof HTMLElement &&
      sibling.hasAttribute("data-design-frame")
    )
      z = Math.max(z, Number(sibling.style.zIndex) || 0);
  element.style.zIndex = String(z + 1);
  const box = designSelectionBox(details);
  const pixels = document.createElement("div");
  pixels.dataset.designDragPixels = "";
  pixels.className = "zd-design-drag-pixels";
  // Cached and older-runtime pictures are crops of the frame, so they carry
  // whatever lies behind a turned or transparent layer's bounding box. Only
  // the layer's own border box belongs to the drag.
  const corners = designSelectionBoxCorners(box).map(
    (corner) =>
      `${corner.x - details.rect.x}px ${corner.y - details.rect.y}px`,
  );
  pixels.style.clipPath = `polygon(${corners.join(", ")})`;
  element.appendChild(pixels);
  // The frame's own selection chrome for this layer: its overlay would sit
  // beneath the picture, and its constraint runs describe a parent the layer
  // is no longer over.
  const frameChrome = options.selection
    ? [
        ...article.querySelectorAll<HTMLElement>(
          `[data-design-element-overlay="${CSS.escape(details.oid)}"], [data-design-parent-guides="${CSS.escape(details.oid)}"], [data-design-structure-parent="${CSS.escape(details.oid)}"]`,
        ),
      ]
    : [];
  if (options.selection) {
    const frameOverlay = designSelectionOverlayFrame(box);
    const outline = document.createElement("div");
    outline.dataset.designDragSelection = "";
    outline.className = "zd-design-selection-outline zd-design-stroke absolute";
    outline.style.setProperty("--design-stroke-width", "2");
    Object.assign(outline.style, {
      left: `${frameOverlay.left - details.rect.x}px`,
      top: `${frameOverlay.top - details.rect.y}px`,
      width: `${frameOverlay.width}px`,
      height: `${frameOverlay.height}px`,
      transform: frameOverlay.affine
        ? `matrix(${frameOverlay.affine.join(",")},0,0)`
        : frameOverlay.rotation
          ? `rotate(${frameOverlay.rotation}deg)`
          : "",
      transformOrigin: frameOverlay.affine
        ? "0 0"
        : `${frameOverlay.pivotX}px ${frameOverlay.pivotY}px`,
    });
    const label = document.createElement("span");
    label.className = `zd-design-selection-label pointer-events-none absolute ${DESIGN_CANVAS_CHIP_CLS}`;
    label.textContent = designSizeBadgeText(frameOverlay.width, frameOverlay.height);
    const placement = designSelectionLabelPlacement(frameOverlay);
    Object.assign(label.style, {
      left: `${placement.left}px`,
      top: `${placement.top}px`,
      transform: placement.transform,
      transformOrigin: "0 0",
    });
    outline.appendChild(label);
    element.appendChild(outline);
  }
  if (options.name) {
    const name = document.createElement("span");
    name.dataset.designDragName = "";
    name.className = `text-2xxs pointer-events-none absolute bottom-full left-0 block h-4 origin-bottom-left overflow-hidden leading-4 font-medium text-ellipsis whitespace-nowrap ${
      options.name.component ? "text-violet-text" : "text-[var(--design-selection-stroke)]"}`;
    name.textContent = options.name.text;
    Object.assign(name.style, {
      maxWidth: `calc(${details.rect.width}px * var(--design-canvas-zoom))`,
      transform: `translateY(${designCanvasScreenPixels(-4)}) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
    });
    element.appendChild(name);
  }
  const showPixels = (dataUrl: string, wholeFrame: boolean) => {
    const image = document.createElement("img");
    image.src = dataUrl;
    image.draggable = false;
    image.alt = "";
    Object.assign(
      image.style,
      wholeFrame
        ? {
            width: `${frame.width}px`,
            height: `${frame.height}px`,
            left: `${-details.rect.x}px`,
            top: `${-details.rect.y}px`,
          }
        : { width: "100%", height: "100%" },
    );
    pixels.replaceChildren(image);
  };
  let hasPixels = screenshot !== null;
  let isolated = false;
  let shownScale = 0;
  if (screenshot) {
    showPixels(screenshot.dataUrl, screenshot !== exactNode);
    shownScale = screenshot.scale;
  } else if (sourceImage && vectorReady) {
    showPixels(sourceImage.currentSrc || sourceImage.src, true);
    hasPixels = true;
    shownScale = Infinity;
  }
  world.appendChild(element);
  let disposeWatch: (() => void) | null = null;
  const showOverlay = () => {
    for (const chrome of frameChrome) chrome.removeAttribute("data-design-drag-detached");
  };
  /** `transferred`: the layer now lives in another frame, so its old chrome
   * stays hidden until it unmounts instead of flashing at the old place. */
  const remove = (options: { transferred?: boolean } = {}) => {
    disposeWatch?.();
    disposeWatch = null;
    if (!options.transferred) showOverlay();
    element.remove();
  };
  return {
    element,
    get hasPixels() {
      return hasPixels;
    },
    /** Whether the pictured layer was captured alone, at drag resolution. */
    get isolated() {
      return isolated;
    },
    /** Device pixels per CSS pixel the picture is drawn at: zoom × DPR, bounded. */
    wantedScale,
    /** Whether the shown pixels are at least as sharp as they are drawn. */
    get sharp() {
      return shownScale >= wantedScale;
    },
    /** Pixels captured for this drag. A capture of the layer alone replaces
     * any cached crop, as it carries nothing from behind the layer; a crop
     * replaces only a blurrier one. */
    adopt(captured: {
      sourceVersion: string;
      dataUrl: string;
      nodeId: string | null;
      scale?: number;
      isolated?: boolean;
    }) {
      const scale = captured.scale ?? 0;
      if (
        captured.sourceVersion !== frame.sourceVersion ||
        captured.nodeId !== details.oid ||
        isolated ||
        (hasPixels && !captured.isolated && scale <= shownScale)
      )
        return;
      hasPixels = true;
      isolated = captured.isolated === true;
      shownScale = scale;
      showPixels(captured.dataUrl, false);
    },
    paint(origin: { x: number; y: number }) {
      element.style.transform = `translate3d(${frame.x + origin.x}px, ${frame.y + origin.y}px, 0)`;
      element.hidden = false;
      for (const chrome of frameChrome) chrome.setAttribute("data-design-drag-detached", "");
    },
    hide() {
      element.hidden = true;
      showOverlay();
    },
    remove,
    /** A confirmed write is not a presented document. Keep the dropped pixels
     * until the exact destination buffer has completed its ready/swap cycle. */
    handoff(destination: DesignCanvasFrameWire): Promise<void> {
      return new Promise((resolve) => {
        const selector = `[data-design-frame="${CSS.escape(destination.file)}"] iframe[data-design-document-buffer="displayed"][data-design-document-source-version="${CSS.escape(destination.sourceVersion)}"][data-design-document-ready]`;
        const finish = () => {
          remove({ transferred: true });
          resolve();
        };
        const observer = new MutationObserver(() => {
          if (!world.isConnected || world.querySelector(selector)) finish();
        });
        // Bound retention if the document fails to load; the frame owns Retry.
        const timeout = window.setTimeout(finish, 10_000);
        disposeWatch = () => {
          observer.disconnect();
          window.clearTimeout(timeout);
          resolve();
        };
        observer.observe(world, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: [
            "data-design-document-buffer",
            "data-design-document-ready",
          ],
        });
        if (!world.isConnected || world.querySelector(selector)) finish();
      });
    },
  };
}
