// ──────────────────────────────────────────────────────────
// Historical macOS ACL cleanup — the workspace-level compatibility wrapper
// ──────────────────────────────────────────────────────────
//
// The strong Code/Design boundary belongs to each Zeros-launched actor's
// immutable provider sandbox and to engine path authorization. A persistent
// same-user ACL is the wrong scope: it also blocks the user's other editors,
// Git clients, and coding platforms. New builds therefore never install one.
//
// Boot owns the cold, durable ACL migration so admission and canvas writes do
// not walk the tree.
// ──────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import path from "node:path";

import {
  designLockSupported,
  unfenceDesignDirFiles,
  unlockCodebase,
} from "../files/design-lock";
import {
  getWorkspaceByPath,
  getWorkspaceMeta,
  setWorkspaceMeta,
} from "../git/state";
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
 * re-fence: new runtime isolation is attached to Zeros actors, not the shared
 * checkout. */
export async function withDesignDirectoryWritable<T>(
  workspacePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  await cleanupLegacyDesignFilesystemGuards(workspacePath);
  return fn();
}

async function releaseKnownDesignDirectoryAcls(
  workspacePath: string,
): Promise<string[]> {
  const names = new Set<string>([designDirectoryNameFor(workspacePath)]);
  for (const discovered of await discoverDesignDirectories(workspacePath)) {
    names.add(discovered);
  }
  const failed: string[] = [];
  for (const name of [...names].sort()) {
    const candidate = path.join(workspacePath, ...name.split("/"));
    if (!existsSync(candidate)) continue;
    const result = await unfenceDesignDirFiles(workspacePath, name);
    failed.push(...result.failed);
  }
  return failed;
}

/** One-time, durable migration for ACLs installed by earlier builds. It is
 * deliberately outside agent admission and Design document writes: cleanup
 * can be retried at boot, but it is not part of the containment proof or a hot
 * interaction path. */
export async function cleanupLegacyDesignFilesystemGuards(
  workspacePath: string,
): Promise<void> {
  if (!designLockSupported()) return;
  const workspace = getWorkspaceByPath(path.resolve(workspacePath));
  if (legacyAclCleanupComplete(workspacePath)) return;
  const wholeTree = await unlockCodebase(workspacePath);
  const failed = [
    ...wholeTree.failed,
    ...(await releaseKnownDesignDirectoryAcls(workspacePath)),
  ];
  if (failed.length > 0) {
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
}
