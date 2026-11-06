import { toast } from "@/renderer/shared/ui/primitives/elements";
import {
  conflictReplacement,
  parseMergeConflicts,
  type ConflictChoice,
} from "@zeros/protocol/merge-conflicts";
import { actionableConflicts } from "@/renderer/features/code-review/merge-conflict-rows";
import { writeWorkspaceFile } from "@/renderer/platform/files";
import { triggerGitRefresh } from "@/renderer/shell/use-git-refresh-key";
import { recordWorkspaceActivity } from "@/renderer/state/workspace-store";
import { loadWorkspaceFileReadForWrite } from "../../workspace-file-data-cache";

/** Accepting from a card writes the file like a save. It writes only over
 * the text the card shows; a file that changed since is refreshed instead. */
export async function acceptCardConflict(
  cwd: string,
  path: string,
  shown: string,
  index: number,
  choice: ConflictChoice,
): Promise<void> {
  const conflict = actionableConflicts(parseMergeConflicts(shown))[index];
  if (!conflict) return;
  const fresh = await loadWorkspaceFileReadForWrite({ cwd, path }).catch(
    (error: unknown) => {
      toast.error(`Couldn't read ${path}`, {
        description: error instanceof Error ? error.message : String(error),
      });
      return null;
    },
  );
  if (!fresh) return;
  if (fresh.kind !== "text" || (fresh.content ?? "") !== shown) {
    toast.info(`${path} changed, so its conflicts were refreshed.`);
    triggerGitRefresh(cwd);
    return;
  }
  const content =
    shown.slice(0, conflict.start) +
    conflictReplacement(shown, conflict, choice) +
    shown.slice(conflict.end);
  recordWorkspaceActivity(cwd);
  // The write itself refuses a file that changed after that read.
  const result = await writeWorkspaceFile(cwd, path, content, {
    expectedContent: shown,
  }).catch((error: unknown) => ({
    kind: "error" as const,
    error: error instanceof Error ? error.message : String(error),
  }));
  if (result?.kind !== "success") {
    if (await changedSince(cwd, path, shown)) {
      toast.info(`${path} changed, so its conflicts were refreshed.`);
      triggerGitRefresh(cwd);
      return;
    }
    toast.error(`Couldn't save ${path}`, {
      description:
        result?.error ?? "Try again when the workspace is available.",
    });
    return;
  }
  triggerGitRefresh(cwd);
}

/** Whether a refused write met a file that no longer holds the shown text. */
async function changedSince(cwd: string, path: string, shown: string): Promise<boolean> {
  const fresh = await loadWorkspaceFileReadForWrite({ cwd, path }).catch(() => null);
  return !!fresh && (fresh.kind !== "text" || (fresh.content ?? "") !== shown);
}

