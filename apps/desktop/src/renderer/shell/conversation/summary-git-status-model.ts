import type { ConflictState, PR, PrState, Workspace } from "../../platform/git";
import {
  isCloudWorkspace,
  parseCloudScopedId,
} from "../../platform/bridge/cloud-workspace-key";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";

export interface SummaryGitFacts {
  uncommitted: number;
  all: number;
  conflicted: number;
  operation: ConflictState;
  ahead: number | null;
  behind: number | null;
  upstream: string | null;
  /** Undefined is an older engine; null is a confirmed detached HEAD. */
  branch?: string | null;
  base?: { ref: string; behind: number } | null;
}

export type SummaryGitAction =
  | "commit-and-push"
  | "push"
  | "pull"
  | "pull-base"
  | "resolve-conflicts"
  | "resolve-divergence"
  | "continue"
  | "attach-branch"
  | "ready-for-review"
  | "view-pr";

export interface SummaryGitRow {
  id: string;
  name: string;
  action: SummaryGitAction;
  label: string;
  disabledReason?: string;
  /** The exact base named by this row, for the explicit Pull action. */
  baseRef?: string;
}

export function supportsSummaryGitStatus(
  workspace: Workspace | null,
): workspace is Workspace {
  return (
    !!workspace &&
    workspace.placement !== "cloud" &&
    !isCloudWorkspace(workspace.path) &&
    !isCloudWorkspace(workspace.id) &&
    !parseCloudScopedId(workspace.id) &&
    !isLocalMainWorkspace(workspace)
  );
}

export function summaryGitBlocker(
  facts: SummaryGitFacts | undefined,
): string | undefined {
  if (!facts) return "Reading Git status…";
  if (facts.conflicted > 0) return "Resolve merge conflicts first";
  if (facts.operation) return `Finish the ${facts.operation} first`;
  if (facts.branch === null) return "Check out a branch first";
  return undefined;
}

const commits = (count: number) =>
  `${count} ${count === 1 ? "commit" : "commits"}`;
const operationNames: Record<NonNullable<ConflictState>, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
};

/** Independent Git facts, not the PR island's single CI/readiness verdict. */
export function summaryGitRows({
  facts,
  prNumber,
  prState,
  pr,
  baseBranch,
}: {
  facts?: SummaryGitFacts;
  prNumber: number | null;
  prState: PrState | null;
  pr: PR | null;
  baseBranch: string;
}): SummaryGitRow[] {
  const rows: SummaryGitRow[] = [];
  const livePr = pr?.number === prNumber ? pr : null;
  const state = livePr?.mergedAt ? "merged" : (livePr?.state ?? prState);
  const terminal = state === "merged" || state === "closed";
  if (prNumber != null) {
    rows.push(
      state === "draft"
        ? {
            id: "draft",
            name: "PR is in draft",
            action: "ready-for-review",
            label: "Ready for review",
          }
        : {
            id: "pr",
            name:
              state === "merged"
                ? "PR is merged"
                : state === "closed"
                  ? "PR is closed"
                  : "PR is open",
            action: "view-pr",
            label: "View PR",
          },
    );
  }
  if (!facts) return rows;

  const blocker = summaryGitBlocker(facts);
  const ahead = facts.ahead ?? 0;
  const behind = facts.behind ?? 0;
  const diverged = ahead > 0 && behind > 0;
  if (facts.uncommitted > 0)
    rows.push({
      id: "uncommitted",
      name: `${facts.uncommitted} uncommitted ${facts.uncommitted === 1 ? "change" : "changes"}`,
      action: "commit-and-push",
      label: "Commit and push",
      disabledReason:
        blocker ??
        (behind > 0
          ? "Pull remote changes before committing and pushing"
          : undefined),
    });
  if (behind > 0)
    rows.push({
      id: "behind-remote",
      name: `${commits(behind)} behind remote`,
      action: "pull",
      label: "Pull",
      disabledReason: blocker,
    });
  if (ahead > 0)
    rows.push({
      id: "ahead",
      name: `${commits(ahead)} ahead of remote`,
      action: "push",
      label: "Push",
      disabledReason:
        blocker ??
        (behind > 0 ? "Pull remote changes before pushing" : undefined),
    });
  // A local selected-base comparison works before PR creation and on drafts.
  // Older engines can still use GitHub's optional behind count. Terminal PR
  // heads need no base integration, but their new local edits remain visible.
  const base =
    facts.base ??
    (facts.base === undefined && !terminal && livePr?.behindBy
      ? { ref: livePr.baseBranch, behind: livePr.behindBy }
      : null);
  if (!terminal && base && base.behind > 0 && base.ref !== facts.upstream)
    rows.push({
      id: "behind-base",
      name: `${commits(base.behind)} behind ${facts.base ? baseBranch : (livePr?.baseBranch ?? baseBranch)}`,
      action: "pull-base",
      label: "Pull",
      baseRef: base.ref,
      disabledReason: blocker,
    });
  if (facts.conflicted > 0 || (!terminal && livePr?.mergeableState === "dirty"))
    rows.push({
      id: "conflicts",
      name: "Merge conflicts detected",
      action: "resolve-conflicts",
      label: "Resolve",
    });
  else if (facts.operation)
    rows.push({
      id: "operation",
      name: `${operationNames[facts.operation]} in progress`,
      action: "continue",
      label: "Continue",
    });
  if (diverged)
    rows.push({
      id: "diverged",
      name: "Incompatible with remote",
      action: "resolve-divergence",
      label: "Resolve",
      disabledReason: blocker,
    });
  if (facts.branch === null && !facts.operation)
    rows.push({
      id: "detached",
      name: "Detached HEAD",
      action: "attach-branch",
      label: "Resolve",
    });
  return rows;
}

/** Resolve/Continue must finish an existing operation before integrating
 * another branch. Divergence is never authority to discard or force-push. */
export function summaryGitPrompt(
  row: SummaryGitRow,
  facts: SummaryGitFacts,
  baseBranch: string,
  remote: string,
): string {
  switch (row.action) {
    case "commit-and-push":
      return "Commit and push all changes";
    case "pull-base":
      return `Fetch ${remote} and merge the selected base ${row.baseRef ?? baseBranch} into this branch. Preserve uncommitted changes, resolve any conflicts, then push. Do not force-push.`;
    case "resolve-divergence":
      return "Inspect this branch and its upstream: their histories have diverged. Reconcile the remote changes while preserving local commits and uncommitted work, resolve conflicts, then push normally. Do not reset, discard work, or force-push.";
    case "attach-branch":
      return "Inspect this workspace's detached HEAD and check out or create the appropriate branch, preserving all commits and uncommitted work. Do not reset or discard changes.";
    case "continue":
      return `Inspect the ${facts.operation ?? "Git operation"} already in progress. Finish it safely, resolving any remaining conflicts and preserving local work. Do not start another merge or rebase while it is in progress. Then push normally.`;
    default:
      return facts.operation
        ? `Resolve the conflicts in the ${facts.operation} already in progress, then continue that operation and push normally. Preserve all local work. Do not start another merge or rebase or force-push.`
        : `Inspect the Git conflicts in this workspace and its pull request against ${remote}/${baseBranch}. Resolve them while preserving local commits and uncommitted work, then commit and push normally. Do not force-push.`;
  }
}
