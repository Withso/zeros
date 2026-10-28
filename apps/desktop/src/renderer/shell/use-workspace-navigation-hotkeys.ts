import { useEffect } from "react";
import type { Workspace } from "../platform/git";
import { hasShortcutPriorityClaim } from "../features/agent/shortcut-priority";
import { getActiveOrganizationIdSnapshot } from "../features/team/team-store";
import { adjacentNavigationIndex, navigationShortcutBlocked, resolveNavigationShortcut } from "../shared/lib/navigation-shortcuts";
import { selectActiveFolder, useWorkspaceStore } from "../state/store";
import { findWorkspaceForFolder } from "../state/workspace-resolution";

/** App-wide navigation uses the sidebar's owner-filtered, sorted projection,
 * even while the sidebar itself is collapsed. Capture precedes editor keys. */
export function useWorkspaceNavigationHotkeys({ workspaces, onSelect, onCreate }: {
  workspaces: readonly Workspace[];
  onSelect: (workspace: Workspace) => void;
  onCreate: () => void;
}): void {
  const organizationId = getActiveOrganizationIdSnapshot();
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // The owner can change before React installs the new list's listener.
      if (getActiveOrganizationIdSnapshot() !== organizationId) return;
      if (hasShortcutPriorityClaim() || navigationShortcutBlocked(event)) return;
      const shortcut = resolveNavigationShortcut(event);
      if (!shortcut) return;
      if (shortcut.kind === "create-workspace") {
        event.preventDefault();
        event.stopPropagation();
        onCreate();
        return;
      }
      if (shortcut.kind !== "workspace-number" && shortcut.kind !== "workspace") return;
      const state = useWorkspaceStore.getState();
      const current = state.activePage === "workspace"
        ? findWorkspaceForFolder(selectActiveFolder(state), workspaces)
        : null;
      const index = shortcut.kind === "workspace-number" ? shortcut.index : adjacentNavigationIndex(
        workspaces.length, current ? workspaces.indexOf(current) : -1, shortcut.direction,
      );
      const target = index === null ? null : workspaces[index];
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      if (target !== current) onSelect(target);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [organizationId, workspaces, onSelect, onCreate]);
}
