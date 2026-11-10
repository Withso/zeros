import { useEffect, useState } from "react";

export interface DesignLiveDocumentRetirement {
  live: boolean;
  /** Still mounted, no longer drawn; see `useDesignLiveDocumentRetirement`. */
  retiring: boolean;
}

export function designLiveDocumentRetirement(
  previous: DesignLiveDocumentRetirement,
  live: boolean,
  active: boolean,
): DesignLiveDocumentRetirement {
  if (live) return { live: true, retiring: false };
  // A hidden canvas presents nothing, so there is nothing to wait for.
  return { live: false, retiring: active && (previous.live || previous.retiring) };
}

/** A live frame document leaves in two steps. Chromium frees a hidden
 * frame's rendered tiles at once, while the canvas frame that still draws
 * that document stays on screen until the next one is presented: removing a
 * visible document showed its blank tiles for a frame. So the document first
 * stops being drawn, in the commit that paints the frame's passive pixels,
 * and is removed once that commit has been presented. */
export function useDesignLiveDocumentRetirement(live: boolean, active: boolean): boolean {
  const [state, setState] = useState<DesignLiveDocumentRetirement>({ live, retiring: false });
  let current = state;
  if (state.live !== live || (state.retiring && !active)) {
    current = designLiveDocumentRetirement(state, live, active);
    setState(current);
  }
  const retiring = current.retiring;
  useEffect(() => {
    if (!retiring) return;
    const finish = () => setState((latest) => latest.retiring ? { live: latest.live, retiring: false } : latest);
    let second = 0;
    // The second animation frame runs after the first frame without the
    // document was produced. A hidden window delivers none; the timer bounds it.
    const first = window.requestAnimationFrame(() => { second = window.requestAnimationFrame(finish); });
    const timer = window.setTimeout(finish, 250);
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
      window.clearTimeout(timer);
    };
  }, [retiring]);
  return retiring;
}
