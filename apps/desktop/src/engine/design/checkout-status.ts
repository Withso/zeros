import type { DesignCheckoutStatus } from "@zeros/protocol/design-context";
import { runGit } from "../git/git-exec";
import { getInProgressState } from "../git/repo";
import { GitError } from "../git/errors";
import { localIndexFingerprint } from "../git/local-index-fingerprint";

const conflictReads = new Map<string, { fingerprint: string; promise: Promise<string[]> }>();

async function readConflicts(root: string): Promise<string[]> {
  const read = async () => (await runGit(root, ["diff", "--name-only", "--diff-filter=U", "-z"], { readOnly: true })).stdout.split("\0").filter(Boolean);
  const fingerprint = await localIndexFingerprint(root);
  if (!fingerprint) return read();
  const existing = conflictReads.get(root);
  if (existing?.fingerprint === fingerprint) {
    conflictReads.delete(root); conflictReads.set(root, existing);
    return [...await existing.promise];
  }
  const entry = { fingerprint, promise: read() };
  conflictReads.set(root, entry);
  while (conflictReads.size > 128) conflictReads.delete(conflictReads.keys().next().value!);
  try {
    const conflicts = await entry.promise;
    if (await localIndexFingerprint(root) !== fingerprint && conflictReads.get(root) === entry) conflictReads.delete(root);
    return [...conflicts];
  } catch (error) {
    if (conflictReads.get(root) === entry) conflictReads.delete(root);
    throw error;
  }
}

export async function readDesignCheckoutStatus(
  root: string,
): Promise<DesignCheckoutStatus> {
  const [conflicts, operation] = await Promise.all([
    readConflicts(root),
    getInProgressState(root),
  ]);
  return { conflicts, operation };
}

/** Pause authoring for an unresolved checkout. In particular, a conflicted
 * manifest must never reach metadata migration/healing or canvas rendering. */
export async function assertDesignCheckoutReadable(
  root: string,
): Promise<void> {
  const status = await readDesignCheckoutStatus(root);
  if (status.conflicts.length)
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        "Design is paused while this workspace has unresolved Git conflicts.",
      remediation:
        "Resolve the conflicts or cancel the Git operation, then retry Design.",
      context: {
        conflictedPaths: status.conflicts,
        operation: status.operation,
      },
    });
}
