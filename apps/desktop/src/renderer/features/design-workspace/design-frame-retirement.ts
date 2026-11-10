import { useEffect, useState } from "react";

export interface DesignLiveDocumentRetirement {
  live: boolean;
  /** Identity of the frame's current (or next) live document. */
  document: number;
  /** A document that left: still mounted, no longer drawn. Null when none. */
  retiring: number | null;
}

export function designLiveDocumentRetirement(
  previous: DesignLiveDocumentRetirement,
  live: boolean,
  active: boolean,
): DesignLiveDocumentRetirement {
  // A hidden canvas presents nothing, so there is nothing to wait for.
  const retiring = active ? previous.retiring : null;
  if (live === previous.live) return retiring === previous.retiring ? previous : { ...previous, retiring };
  // A document that left never comes back: it may hold previews of a gesture
  // that ended with it. A frame that is live again starts a new document.
  if (live) return { live: true, document: previous.document + 1, retiring };
  return { live: false, document: previous.document, retiring: active ? previous.document : null };
}

/** A live frame document leaves in two steps. Chromium frees a hidden
 * frame's rendered tiles at once, while the canvas frame that still draws
 * that document stays on screen until the next one is presented: removing a
 * visible document showed its blank tiles for a frame. So the document first
 * stops being drawn, in the commit that paints the frame's passive pixels,
 * and is removed once that commit has been presented. */
export function useDesignLiveDocumentRetirement(live: boolean, active: boolean): DesignLiveDocumentRetirement {
  const [state, setState] = useState<DesignLiveDocumentRetirement>({ live, document: 0, retiring: null });
  const current = designLiveDocumentRetirement(state, live, active);
  if (current !== state) setState(current);
  const retiring = current.retiring;
  useEffect(() => {
    if (retiring === null) return;
    const finish = () => setState((latest) => latest.retiring === retiring ? { ...latest, retiring: null } : latest);
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
  return current;
}

/** The other direction: a document that was just revealed. Its own report
 * that it painted can precede the canvas frame that shows it, because the
 * child runs ahead while the canvas main thread is busy. True once the canvas
 * has produced two frames with the document shown; until then the pixels
 * beneath it stay. */
export function useDesignRevealPresented(shown: boolean): boolean {
  const [presented, setPresented] = useState(false);
  if (!shown && presented) setPresented(false);
  useEffect(() => {
    if (!shown) return;
    let second = 0;
    const first = window.requestAnimationFrame(() => { second = window.requestAnimationFrame(() => setPresented(true)); });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [shown]);
  return shown && presented;
}
