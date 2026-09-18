import { useEffect, useRef } from "react";
import { toast } from "../../../shared/ui/primitives";
import { errorMessage } from "../design-workspace-error";

/** Snapshot failures retain a retry action. Hidden or replaced owners cannot
 * execute a stale action; ordinary autosave adds no status or polling. */
export function useDesignLifecycleFeedback(
  workspaceId: string | null,
  active: boolean,
  error: Error | null,
  refresh: () => void,
): void {
  const retry = useRef(refresh);
  retry.current = refresh;
  useEffect(() => {
    if (!workspaceId || !active || !error) return;
    let live = true;
    const id = `design-lifecycle:${workspaceId}`;
    toast.error("Design needs attention", {
      id,
      description: errorMessage(error),
      duration: Infinity,
      action: {
        label: "Retry",
        onClick: () => {
          if (live) retry.current();
        },
      },
    });
    return () => {
      live = false;
      toast.dismiss(id);
    };
  }, [workspaceId, active, error]);
}
