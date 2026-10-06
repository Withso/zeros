import { useWorkbenchStatusSource } from "../../../shell/workbench/tab-status";
import { refreshDesignWorkspaceSnapshot } from "./design-workspace-cache";

/** Snapshot availability belongs to the workbench's persistent status slot. */
export function useDesignLifecycleFeedback(
  workspaceId: string | null,
  active: boolean,
  error: Error | null,
  hasContent: boolean,
  pending: boolean,
): void {
  useWorkbenchStatusSource(
    {
      error,
      primary: true,
      hasContent,
      pending,
      retry: () =>
        workspaceId && active
          ? refreshDesignWorkspaceSnapshot(workspaceId)
          : undefined,
    },
    workspaceId ?? "",
  );
}
