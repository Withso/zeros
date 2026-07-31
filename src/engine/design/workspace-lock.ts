import {
  designLockSupported,
  lockCodebase,
  unlockCodebase,
} from "../files/design-lock";
import { DESIGN_DIRECTORY_NAME } from "./document";

function failedPathsMessage(action: string, failed: readonly string[]): string {
  const sample = failed.slice(0, 3).join(", ");
  return `Design workspace ${action} failed for ${failed.length} tracked ${
    failed.length === 1 ? "file" : "files"
  }${sample ? ` (${sample})` : ""}.`;
}

/** Enforce the design workspace write boundary at the filesystem layer.
 * Non-macOS development/test hosts keep working, while production macOS treats
 * a partial ACL application as failure and removes the partial lock. */
export async function lockDesignWorkspaceRoot(
  workspacePath: string,
): Promise<void> {
  if (!designLockSupported()) return;
  const result = await lockCodebase(workspacePath, {
    designDir: DESIGN_DIRECTORY_NAME,
  });
  if (result.failed.length === 0) return;
  await unlockCodebase(workspacePath).catch(() => {});
  throw new Error(failedPathsMessage("lock", result.failed));
}

/** Remove every matching ACL before Git moves or deletes the checkout. */
export async function unlockDesignWorkspaceRoot(
  workspacePath: string,
): Promise<void> {
  if (!designLockSupported()) return;
  const result = await unlockCodebase(workspacePath);
  if (result.failed.length > 0) {
    throw new Error(failedPathsMessage("unlock", result.failed));
  }
}
