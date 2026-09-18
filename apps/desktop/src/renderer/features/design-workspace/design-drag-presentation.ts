import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import type { DesignCanvasFrameWire } from "../../platform/git";
import { designRuntimeFrameState } from "./state/design-runtime-store";

/** Reuse already captured pixels across opaque iframe boundaries. There is no
 * document clone, rasterization, store write, or layout read per pointer sample. */
export function createDesignDragPresentation(
  workspaceId: string,
  frame: DesignCanvasFrameWire,
  details: DesignRuntimeNodeDetails,
  article: HTMLElement,
) {
  const world = article.closest<HTMLElement>("[data-design-canvas-world]");
  if (!world) return null;
  const cached = designRuntimeFrameState(workspaceId, frame.file);
  const nodeImage = cached?.screenshotsByNode[details.oid];
  const frameImage = cached?.screenshotsByNode[""];
  const exactNode =
    nodeImage?.sourceVersion === frame.sourceVersion ? nodeImage : null;
  const screenshot =
    exactNode ??
    (frameImage?.sourceVersion === frame.sourceVersion ? frameImage : null);
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
  if (screenshot) {
    const image = document.createElement("img");
    image.src = screenshot.dataUrl;
    image.draggable = false;
    image.alt = "";
    Object.assign(
      image.style,
      exactNode
        ? { width: "100%", height: "100%" }
        : {
            width: `${frame.width}px`,
            height: `${frame.height}px`,
            left: `${-details.rect.x}px`,
            top: `${-details.rect.y}px`,
          },
    );
    element.appendChild(image);
  }
  world.appendChild(element);
  let disposeWatch: (() => void) | null = null;
  const remove = () => {
    disposeWatch?.();
    disposeWatch = null;
    element.remove();
  };
  return {
    hasPixels: screenshot !== null,
    paint(origin: { x: number; y: number }) {
      element.style.transform = `translate3d(${frame.x + origin.x}px, ${frame.y + origin.y}px, 0)`;
      element.hidden = false;
    },
    hide() {
      element.hidden = true;
    },
    remove,
    /** A confirmed write is not a presented document. Keep the dropped pixels
     * until the exact destination buffer has completed its ready/swap cycle. */
    handoff(destination: DesignCanvasFrameWire): Promise<void> {
      return new Promise((resolve) => {
        const selector = `[data-design-frame="${CSS.escape(destination.file)}"] iframe[data-design-document-buffer="displayed"][data-design-document-source-version="${CSS.escape(destination.sourceVersion)}"][data-design-document-ready]`;
        const finish = () => {
          remove();
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
