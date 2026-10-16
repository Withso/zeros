import { useLayoutEffect, useState, useSyncExternalStore } from "react";

import type { Size } from "./simulator-geometry";

const documentVisible = () =>
  typeof document === "undefined" || document.visibilityState === "visible";

function subscribeDocumentVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/** False while the window is minimized or otherwise hidden. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeDocumentVisibility, documentVisible, () => true);
}

/** An element's content box, measured only while `active`. A hidden tab
 * keeps its last size instead of measuring. */
export function useElementSize(active: boolean): {
  ref: (element: HTMLElement | null) => void;
  size: Size | null;
} {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    if (!active || !element) return;
    const publish = (width: number, height: number) => {
      setSize((current) =>
        current && current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    const style = getComputedStyle(element);
    publish(
      element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    );
    const observer = new ResizeObserver(([entry]) => {
      if (entry) publish(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, active]);
  return { ref: setElement, size };
}
