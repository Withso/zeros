// C4B: a workspace's fetched submodules as the checkpoint scripts take them, and what a restore printed about them. One
// definition for the lifecycle's stops, backups and restores and for live recovery (recovery.ts).
import { parseSubmoduleRestore, type CheckpointSubmodule, type RestoreSubmodule } from "./checkpoint.js";
import type { CloudV2UnrestoredReason, CloudV2UnrestoredSubmodule } from "./store.js";
import { CLOUD_V2_HOME_PATH } from "./workspace-layout.js";
import type { WorkspaceSubmoduleCheckout } from "./workspace-repositories.js";

/** Where a planned submodule is, as its unrestored record names it. */
export function unrestoredPlace(entry: WorkspaceSubmoduleCheckout): { position: number; path: string; folder: string } {
  return { position: entry.position, path: entry.checkoutFolder.slice(entry.repositoryFolder.length + 1), folder: `${CLOUD_V2_HOME_PATH}/${entry.checkoutFolder}` };
}

/** The restore's closed failure codes, as the record and the document name them. */
function unrestoredReason(code: string): CloudV2UnrestoredReason {
  return code === "checkpoint_repository_missing" ? "repository_unavailable" : code === "checkpoint_prerequisites_missing" ? "commits_unavailable"
    : code === "checkpoint_corrupt" ? "archive_corrupt" : "restore_failed";
}

/** A workspace's planned submodule checkouts as the checkpoint scripts take them: absolute paths on the VM. */
export function checkpointSubmodules(submodules: readonly WorkspaceSubmoduleCheckout[]): CheckpointSubmodule[] {
  return submodules.map(entry => ({ position: entry.position, checkoutPath: `${CLOUD_V2_HOME_PATH}/${entry.checkoutFolder}`,
    repositoryPath: `${CLOUD_V2_HOME_PATH}/${entry.repositoryFolder}`, gitDir: entry.gitDir, baseCommit: entry.baseCommit }));
}

/** Each planned submodule as a restore takes it: a private one with its own read-only token (none when it cannot be
 * had: it then fails on its own if it needs one), a public one with none. */
export function restoreSubmodules(planned: readonly WorkspaceSubmoduleCheckout[],
  token: (repository: string) => Promise<{ token: string } | null | undefined>): Promise<RestoreSubmodule[]> {
  return Promise.all(planned.map(async entry => {
    const minted = entry.public ? null : await token(entry.repository).catch(() => null) ?? null;
    return { ...checkpointSubmodules([entry])[0]!, repository: entry.repository, ...(entry.public ? { public: true } : {}), ...(minted ? { githubToken: minted.token } : {}) };
  }));
}

/** What a restore or a held apply printed about submodules, by their places in `planned`: those it could not put back
 * (each held on the machine) and those whose held part went back. */
export function submoduleOutcome(planned: readonly WorkspaceSubmoduleCheckout[], stdout: string): {
  failed: Omit<CloudV2UnrestoredSubmodule, "since">[]; restored: { position: number; path: string }[] } {
  const outcome = parseSubmoduleRestore(stdout);
  const place = (index: number) => planned[index - 1];
  const failed = outcome.unrestored.flatMap(({ place: index, reason }) => {
    const entry = place(index);
    return entry ? [{ ...unrestoredPlace(entry), reason: unrestoredReason(reason) }] : [];
  });
  const restored = outcome.held.flatMap(index => place(index) ? [unrestoredPlace(place(index)!)] : []);
  return { failed, restored };
}
