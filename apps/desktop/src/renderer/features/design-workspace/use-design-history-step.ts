import { useEffect, useMemo, useRef, useState } from "react";
import { subscribeDesignHistorySteps } from "./state/design-history-commands";

export interface DesignHistoryStep {
  /** True from an undo or redo until `drop()`: the step handed this surface's
   * draft back to the source, so it shows confirmed values again. */
  handedBack(): boolean;
  /** The person edited, focused or opened this surface: it owns a draft again. */
  drop(): void;
}

function useHistoryStepLatch(onStep?: () => void): DesignHistoryStep {
  const handedBackRef = useRef(false);
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;
  useEffect(
    () => subscribeDesignHistorySteps(() => {
      handedBackRef.current = true;
      onStepRef.current?.();
    }),
    [],
  );
  return useMemo(
    () => ({
      handedBack: () => handedBackRef.current,
      drop: () => { handedBackRef.current = false; },
    }),
    [],
  );
}

/** A focused field and an open editor hold back values published from
 * elsewhere, so a late save cannot replace what the person is working on. An
 * undo or redo is their own request and must show. A step's result can arrive
 * as more than one value change (the source, then the re-read element), so
 * the hand-back lasts until the surface's own next edit, not one change. */
export function useDesignHistoryStep(): DesignHistoryStep {
  return useHistoryStepLatch();
}

/** For an open editor, whose draft can run ahead of the last value published
 * to it: an edit whose confirmation has not arrived yet, then an undo back to
 * that same published value, changes no prop at all. `revision` changes on
 * every step so the editor re-reads its confirmed props regardless. */
export function useDesignHistoryHandBack(): {
  step: DesignHistoryStep;
  revision: number;
} {
  const [revision, setRevision] = useState(0);
  const step = useHistoryStepLatch(() => setRevision((current) => current + 1));
  return { step, revision };
}
