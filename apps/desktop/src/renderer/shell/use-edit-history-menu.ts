import { useEffect } from "react";
import { nativeEditHistory, onMenuEditHistory } from "../platform/app";
import { dispatchFocusedDesignHistory } from "../features/design-workspace/state/design-history-commands";
import { dispatchFocusedEditHistory, preventUnfocusedEditHistory } from "../shared/ui/edit-history";

/** One native subscriber for the app, including when Design is unmounted. */
export function useEditHistoryMenu(): void {
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    document.addEventListener("beforeinput", preventUnfocusedEditHistory, true);
    void onMenuEditHistory(({ direction }) => {
      if (disposed || (direction !== "undo" && direction !== "redo")) return;
      if (!dispatchFocusedDesignHistory(direction) && dispatchFocusedEditHistory(direction) === "native")
        void nativeEditHistory(direction).catch(() => {});
    }).then((stop) => { if (disposed) stop(); else unsubscribe = stop; });
    return () => {
      disposed = true;
      unsubscribe?.();
      document.removeEventListener("beforeinput", preventUnfocusedEditHistory, true);
    };
  }, []);
}
