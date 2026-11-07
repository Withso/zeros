// ──────────────────────────────────────────────────────────
// Historical macOS ACL cleanup — the workspace-level compatibility wrapper
// ──────────────────────────────────────────────────────────
//
// A persistent same-user ACL is the wrong scope: it also blocks the user's
// other editors, Git clients, and coding platforms. The shared Code/Design
// session uses mode instructions plus Zeros-owned path authorization. Local
// Design mode permits native file authoring; cloud execution policy is separate.
// New builds never install a checkout ACL for either mode.
//
// Startup maintenance owns the cold, durable ACL migration so engine readiness,
// admission and canvas writes do not walk the tree.
// ──────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import path from "node:path";

import {
  designLockSupported,
  unfenceDesignDirFiles,
  unlockCodebase,
  type DesignLockTurn,
} from "../files/design-lock";
import {
  getWorkspaceByPath,
  getWorkspaceMeta,
  setWorkspaceMeta,
} from "../git/state";
import { runGit } from "../git/git-exec";
import { discoverDesignDirectories } from "./directory";
import { designDirectoryNameFor } from "./directory-registry";

export const LEGACY_DESIGN_ACL_CLEANUP_META_KEY =
  "design.legacy-acl-cleanup.v1";

function failedPathsMessage(action: string, failed: readonly string[]): string {
  const sample = failed.slice(0, 3).join(", ");
  return `Design directory ${action} failed for ${failed.length} ${
    failed.length === 1 ? "path" : "paths"
  }${sample ? ` (${sample})` : ""}.`;
}

/** A startup sweep that could not remove every historical ACE waits this long
 * before the next one: it walks every tracked file while holding the
 * workspace's mutation lane. Design mode and archive still sweep on use. */
export const LEGACY_DESIGN_ACL_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const DEFERRED = /^deferred:(\d+)$/;

/** Whether a launch should sweep this workspace for historical ACLs. */
export function legacyDesignAclCleanupDue(workspacePath: string, now = Date.now()): boolean {
  const workspace = getWorkspaceByPath(path.resolve(workspacePath));
  const state = workspace ? getWorkspaceMeta(workspace.id, LEGACY_DESIGN_ACL_CLEANUP_META_KEY) : null;
  if (state === "complete") return false;
  const deferred = state ? DEFERRED.exec(state) : null;
  return !deferred || now - Number(deferred[1]) >= LEGACY_DESIGN_ACL_RETRY_MS;
}

function legacyAclCleanupComplete(workspacePath: string): boolean {
  const workspace = getWorkspaceByPath(path.resolve(workspacePath));
  return (
    workspace != null &&
    getWorkspaceMeta(workspace.id, LEGACY_DESIGN_ACL_CLEANUP_META_KEY) ===
      "complete"
  );
}

/** Remove a Design-directory ACL written by an older Zeros build. An absent
 * first-use directory is success: initialization is about to create it and
 * there cannot be a legacy ACL there to remove. */
export async function unfenceDesignDirectory(
  workspacePath: string,
): Promise<void> {
  if (!designLockSupported() || legacyAclCleanupComplete(workspacePath)) return;
  const designName = designDirectoryNameFor(workspacePath);
  const designPath = path.join(workspacePath, ...designName.split("/"));
  if (!existsSync(designPath)) return;
  const result = await unfenceDesignDirFiles(workspacePath, designName);
  if (result.failed.length > 0) {
    throw new Error(failedPathsMessage("unfence", result.failed));
  }
}

/** Release a historical ACL before a Git rewrite. There is intentionally no
 * re-fence: the current actor contracts do not change permissions on the
 * shared checkout. */
export async function withDesignDirectoryWritable<T>(
  workspacePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  await cleanupLegacyDesignFilesystemGuards(workspacePath);
  return fn();
}

async function releaseKnownDesignDirectoryAcls(
  workspacePath: string,
  turn?: DesignLockTurn,
): Promise<string[]> {
  const names = new Set<string>([designDirectoryNameFor(workspacePath)]);
  for (const discovered of await discoverDesignDirectories(workspacePath)) {
    names.add(discovered);
  }
  const failed: string[] = [];
  for (const name of [...names].sort()) {
    const candidate = path.join(workspacePath, ...name.split("/"));
    if (!existsSync(candidate)) continue;
    const result = await unfenceDesignDirFiles(workspacePath, name, turn);
    failed.push(...result.failed);
  }
  return failed;
}

/** One-time, durable migration for ACLs installed by earlier builds. It is
 * deliberately outside agent admission and Design document writes: cleanup
 * can be retried after boot, but it is not part of the containment proof or a hot
 * interaction path. */
export async function cleanupLegacyDesignFilesystemGuards(
  workspacePath: string,
  /** Each step of the sweep runs in a turn; a caller already holding the
   * workspace's mutation lane passes none. */
  turn?: DesignLockTurn,
): Promise<void> {
  if (!designLockSupported()) return;
  const workspace = getWorkspaceByPath(path.resolve(workspacePath));
  if (legacyAclCleanupComplete(workspacePath)) return;
  const wholeTree = await unlockCodebase(workspacePath, turn);
  const failed = [
    ...wholeTree.failed,
    ...(await releaseKnownDesignDirectoryAcls(workspacePath, turn)),
  ];
  if (failed.length > 0) {
    if (workspace) setWorkspaceMeta(workspace.id, LEGACY_DESIGN_ACL_CLEANUP_META_KEY, `deferred:${Date.now()}`);
    throw new Error(failedPathsMessage("cleanup", failed));
  }
  if (workspace) {
    setWorkspaceMeta(
      workspace.id,
      LEGACY_DESIGN_ACL_CLEANUP_META_KEY,
      "complete",
    );
  }
}

/** LEGACY: sweep off the whole-codebase ACLs that pre-concurrency builds
 *  applied while a workspace was in design mode. Passes designDir "" so the
 *  sweep covers the entire tracked tree (including a design folder that moved
 *  since the lock was applied), then removes the later Design-directory ACL
 *  from tracked, ignored, and untracked entries. */
export async function unlockLegacyDesignWorkspaceLock(
  workspacePath: string,
): Promise<void> {
  await cleanupLegacyDesignFilesystemGuards(workspacePath);
  // Removing an ACL changes file metadata on macOS even when the bytes and
  // executable bit are untouched. Refresh Git's stat cache so subsequent
  // checkout/index operations do not misread those clean tracked files as
  // changed. A dirty or unmerged entry can make refresh exit non-zero, but Git
  // still refreshes the clean entries it can prove.
  await runGit(workspacePath, ["update-index", "-q", "--refresh"]).catch(
    () => undefined,
  );
}
