import type { DesignCheckoutStatus } from "@zeros/protocol/design-context";
import { runGit } from "../git/git-exec";
import { getInProgressState } from "../git/repo";
import { GitError } from "../git/errors";

export async function readDesignCheckoutStatus(
  root: string,
): Promise<DesignCheckoutStatus> {
  const [entries, operation] = await Promise.all([
    runGit(root, ["diff", "--name-only", "--diff-filter=U", "-z"], {
      readOnly: true,
    }),
    getInProgressState(root),
  ]);
  return { conflicts: entries.stdout.split("\0").filter(Boolean), operation };
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
