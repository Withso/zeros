import { useEffect } from "react";
import { isNativeRuntime } from "../platform/runtime";
import { loadProjects } from "../state/projects-store";
import { refreshProjectCapabilities } from "../state/project-capabilities";
import { notifyProjectsChanged } from "../state/use-projects";
import {
  selectActiveFolder,
  useWorkspaceStore,
} from "../state/workspace-store";
import { triggerGitRefresh } from "./use-git-refresh-key";

/** One shell-level observer, independent of the visible pane. Coalesce focus
 * and visibility notifications; bound native reads rather than probing rows. */
export function useProjectCapabilitiesRefresh(): void {
  useEffect(() => {
    if (!isNativeRuntime()) return;
    let disposed = false;
    let running = false;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    let resumeAgain = false;
    const refresh = async () => {
      if (disposed || document.visibilityState !== "visible") return;
      if (running) {
        resumeAgain = true;
        return;
      }
      running = true;
      const folder = selectActiveFolder(useWorkspaceStore.getState());
      const projects = loadProjects().sort(
        (a, b) => Number(b.repoRoot === folder) - Number(a.repoRoot === folder),
      );
      let next = 0;
      const worker = async () => {
        while (
          !disposed &&
          document.visibilityState === "visible" &&
          next < projects.length
        ) {
          const changed = await refreshProjectCapabilities(projects[next++]);
          if (changed) notifyProjectsChanged();
        }
      };
      await Promise.all([worker(), worker()]);
      // Refresh the live Changes/file views too, including branch/index changes
      // that leave Git and remote capabilities unchanged. No navigation writes.
      if (!disposed && document.visibilityState === "visible" && folder)
        triggerGitRefresh(folder);
      running = false;
      if (resumeAgain) {
        resumeAgain = false;
        schedule();
      }
    };
    const schedule = () => {
      if (document.visibilityState !== "visible") return;
      if (scheduled !== undefined) clearTimeout(scheduled);
      scheduled = setTimeout(() => {
        scheduled = undefined;
        void refresh();
      }, 50);
    };
    schedule();
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      disposed = true;
      if (scheduled !== undefined) clearTimeout(scheduled);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, []);
}
