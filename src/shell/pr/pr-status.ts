// ──────────────────────────────────────────────────────────
// pr-status — derive the PR status island's single "current" state
// ──────────────────────────────────────────────────────────
//
// The island shows ONE state at a time with (0..2) action buttons. Which state
// wins is a priority decision over three data sources:
//   • gitStatus       → local truth (conflicts, uncommitted, ahead/behind)
//   • ghPrGet.pr      → GitHub truth (draft/ready/merged/closed + mergeableState)
//   • ghPrChecks      → CI truth (pending / failed counts)
//
// Priority (first match wins): terminal PR states (merged / closed) → local
// blockers you must fix before anything else (conflicts → uncommitted →
// diverged → ahead → behind) → the PR's own readiness (draft → checks →
// mergeable state). This
// mirrors the natural "fix your working tree, then look at the PR" workflow.
//
// Every branch is pure + data-in/data-out so the whole matrix is unit tested.
// ──────────────────────────────────────────────────────────

import type { PrState } from "../../native/git";

export type PrIslandTone =
  | "neutral"
  | "success"
  | "warning"
  | "merged"
  | "danger"
  | "closed";

/** What a button does when clicked. `prompt` sends a brief to the active chat
 *  (the agent does the git work — Resolve / Commit & Push / Update branch);
 *  `push` / `pull` / `ready` / `merge` / `continue` / `archive` act DIRECTLY in
 *  the engine (2026-07-19: no agent round-trip — the button shows an inline
 *  spinner and the status flips as soon as the op lands); `show-checks` opens
 *  the Review tab's Checks sub-tab. */
export type PrIslandActionBehavior =
  | "prompt"
  | "push"
  | "pull"
  | "ready"
  | "merge"
  | "continue"
  | "archive"
  | "show-checks";

export type PrIslandActionKind =
  | "resolve"
  | "commit-and-push"
  | "push"
  | "pull"
  | "update-from-base"
  | "ready-for-review"
  | "continue"
  | "merge"
  | "archive"
  | "show-checks";

/** A synchronous claim shared by prompt and direct island actions. React state
 * disables the rendered controls, but it is not visible to another handler in
 * the same event frame; this ref-shaped guard closes that double-fire window. */
export function claimPrIslandAction(
  claim: { current: PrIslandActionKind | null },
  kind: PrIslandActionKind,
): boolean {
  if (claim.current != null) return false;
  claim.current = kind;
  return true;
}

/** Release only the action that owns the claim, so an old async completion can
 * never unlock a newer operation. */
export function releasePrIslandAction(
  claim: { current: PrIslandActionKind | null },
  kind: PrIslandActionKind,
): void {
  if (claim.current === kind) claim.current = null;
}

export interface PrIslandAction {
  kind: PrIslandActionKind;
  label: string;
  behavior: PrIslandActionBehavior;
  /** Visual weight: `primary` = filled, `secondary` = outline, `dashed` = ghost. */
  variant: "primary" | "secondary" | "dashed";
}

export interface PrIslandState {
  /** Stable machine id (for tests / analytics), e.g. `ready-to-merge`. */
  kind: string;
  /** Human label shown left of the buttons, e.g. `Ready to merge`. */
  label: string;
  tone: PrIslandTone;
  actions: PrIslandAction[];
}

export interface PrStatusInputs {
  /** The workspace's persisted PR state (fast, always available). */
  prState: PrState | null;
  /** Local working-tree truth from gitStatus. `ahead`/`behind` are null when
   *  the branch has no upstream (or the engine build predates the field). */
  status: {
    uncommitted: number;
    conflicts: boolean;
    ahead: number | null;
    behind: number | null;
  };
  /** Live GitHub PR metadata (null until ghPrGet resolves). */
  pr: {
    state: PrState;
    /** GitHub `mergeable_state`: clean/dirty/behind/blocked/unstable/draft/unknown/has_hooks. */
    mergeableState: string;
    isMergeable: boolean | null;
    mergedAt: number | null;
    /** Commits the BASE has that this PR's head doesn't (GitHub compare) —
     *  fetched only when `mergeable_state` is `behind`, so the "Require branch
     *  to be up to date" label can show the real count. Null/undefined =
     *  unknown. */
    behindBy?: number | null;
  } | null;
  /** Live check rollup (null until ghPrChecks resolves). */
  checks: {
    pending: number;
    failed: number;
    total: number;
  } | null;
}

const commits = (n: number) => (n === 1 ? "commit" : "commits");

// Button factories — keep labels/variants in one place.
const resolveAction: PrIslandAction = {
  kind: "resolve",
  label: "Resolve",
  behavior: "prompt",
  variant: "secondary",
};
const commitPushAction: PrIslandAction = {
  kind: "commit-and-push",
  label: "Commit & Push",
  behavior: "prompt",
  variant: "secondary",
};
// Push / Pull / Ready-for-review are DIRECT engine actions (2026-07-19): the
// work is deterministic (nothing for an agent to decide), so the button acts
// immediately and the island's next settled batch shows the new state.
const pushAction: PrIslandAction = {
  kind: "push",
  label: "Push",
  behavior: "push",
  variant: "secondary",
};
const pullAction: PrIslandAction = {
  kind: "pull",
  label: "Pull",
  behavior: "pull",
  variant: "secondary",
};
const updateFromBaseAction: PrIslandAction = {
  kind: "update-from-base",
  label: "Update branch",
  behavior: "prompt",
  variant: "secondary",
};
const readyAction: PrIslandAction = {
  kind: "ready-for-review",
  label: "Ready for review",
  behavior: "ready",
  variant: "secondary",
};
const mergeAction: PrIslandAction = {
  kind: "merge",
  label: "Merge",
  behavior: "merge",
  variant: "primary",
};
const showChecksAction: PrIslandAction = {
  kind: "show-checks",
  label: "Show checks",
  behavior: "show-checks",
  variant: "secondary",
};
// Continue = start the NEXT unit of work in the same worktree: the engine
// creates + checks out a fresh branch and clears the PR fields; the chats and
// working tree stay exactly as they are (direct — no agent message).
const continueAction: PrIslandAction = {
  kind: "continue",
  label: "Continue",
  behavior: "continue",
  variant: "dashed",
};
const archiveAction: PrIslandAction = {
  kind: "archive",
  label: "Archive",
  behavior: "archive",
  variant: "primary",
};

/** Which actions are parked while the workspace's agent has a turn in flight.
 *  `prompt` actions would queue behind the very turn that is still reshaping
 *  the branch; the direct git/GitHub mutations (push / pull / ready / merge /
 *  continue) could act on a half-pushed state. Archive (deliberately stops the
 *  agent) and Show-checks (pure navigation) stay available. */
export function isActionGatedWhileAgentWorking(
  action: PrIslandAction,
): boolean {
  return action.behavior !== "archive" && action.behavior !== "show-checks";
}

/** Resolve the single state the island renders. */
export function derivePrIslandState(
  input: PrStatusInputs,
  options: { allowContinue?: boolean } = {},
): PrIslandState {
  const { prState, status, pr } = input;
  const prStateEff = pr?.state ?? prState;
  const mergeable = pr?.mergeableState?.toLowerCase() ?? null;

  // 1. Terminal PR states — nothing local matters once it's merged/closed.
  if (prStateEff === "merged" || pr?.mergedAt != null) {
    return {
      kind: "merged",
      label: "Merged",
      tone: "merged",
      actions:
        options.allowContinue === false
          ? [archiveAction]
          : [continueAction, archiveAction],
    };
  }
  if (prStateEff === "closed") {
    // Terminal but NOT celebratory — the red row (tone "closed") with the
    // lone filled Archive. The island renders a GitPullRequestClosed glyph
    // next to this label.
    return {
      kind: "closed",
      label: "Closed",
      tone: "closed",
      actions: [archiveAction],
    };
  }

  // 2. Local blockers — fix the working tree before looking at the PR.
  if (status.conflicts) {
    return {
      kind: "merge-conflicts",
      label: "Merge conflicts",
      tone: "warning",
      actions: [resolveAction],
    };
  }
  if (status.uncommitted > 0) {
    return {
      kind: "uncommitted",
      label: "Uncommitted changes",
      tone: "neutral",
      actions: [commitPushAction],
    };
  }
  if ((status.ahead ?? 0) > 0 && (status.behind ?? 0) > 0) {
    const ahead = status.ahead as number;
    const behind = status.behind as number;
    return {
      kind: "diverged",
      label: `${ahead} ahead and ${behind} behind`,
      tone: "neutral",
      // Rebase/autostash first; the resulting ahead-only state then offers
      // Push. An ordinary push from a diverged branch can never fast-forward.
      actions: [pullAction],
    };
  }
  if ((status.ahead ?? 0) > 0) {
    const n = status.ahead as number;
    return {
      kind: "ahead",
      label: `Ahead by ${n} ${commits(n)}`,
      tone: "neutral",
      actions: [pushAction],
    };
  }
  if ((status.behind ?? 0) > 0) {
    const n = status.behind as number;
    return {
      kind: "behind",
      label: `Behind by ${n} ${commits(n)}`,
      tone: "neutral",
      actions: [pullAction],
    };
  }

  // 3. Draft — offer "Ready for review".
  if (prStateEff === "draft" || mergeable === "draft") {
    return {
      kind: "draft",
      label: "Draft PR open",
      tone: "neutral",
      actions: [readyAction],
    };
  }

  // 4. Open PR readiness — needs GitHub metadata. The island only derives a
  //    state AFTER its initial fetch round settles (loading shows a spinner
  //    row instead — see PrStatusIsland), so a null pr here means GitHub
  //    metadata is genuinely unavailable (offline / gh unauthenticated), and
  //    "PR open" is the honest fallback rather than a loading flash.
  if (!pr) {
    return { kind: "pr-open", label: "PR open", tone: "neutral", actions: [] };
  }

  const pending = input.checks?.pending ?? 0;
  const failed = input.checks?.failed ?? 0;

  // 4a. A known failure wins over "pending". Checks run CONCURRENTLY, so a PR
  //     commonly has one check already failed while others are still in flight
  //     (GitHub's `unstable` state). Surfacing the failure + Show-checks now —
  //     rather than a calm "pending" that hides it — is the correct signal.
  //     With a check rollup the label counts the damage ("1/6 checks failed");
  //     an `unstable` verdict with no failed rollup keeps the generic label.
  if (failed > 0 || mergeable === "unstable") {
    const total = input.checks?.total ?? 0;
    return {
      kind: "unable-to-merge",
      label:
        failed > 0 && total > 0
          ? `${failed}/${total} ${total === 1 ? "check" : "checks"} failed`
          : "Unable to merge",
      tone: "danger",
      actions: [showChecksAction],
    };
  }

  // 4b. CI still running and nothing has failed yet — no action, just wait.
  if (pending > 0) {
    return {
      kind: "checks-pending",
      label: `${pending} ${pending === 1 ? "check" : "checks"} pending…`,
      tone: "neutral",
      actions: [],
    };
  }

  // 4c. GitHub-side merge state.
  switch (mergeable) {
    case "dirty":
      return {
        kind: "merge-conflicts",
        label: "Merge conflicts",
        tone: "warning",
        actions: [resolveAction],
      };
    case "behind": {
      // The repo requires branches to be current before merging ("Require
      // branches to be up to date"). Count from GitHub's compare when
      // available so the label says how far behind.
      const n = pr.behindBy ?? null;
      return {
        kind: "behind-base",
        label:
          n != null && n > 0
            ? `Require branch to be up to date ( ${n} ${commits(n)} behind )`
            : "Require branch to be up to date",
        tone: "neutral",
        actions: [updateFromBaseAction],
      };
    }
    case "blocked":
      return {
        kind: "blocked",
        label: "Blocked from merging",
        tone: "neutral",
        actions: [],
      };
    // `has_hooks` = mergeable + passing, the repo just has pre-receive hooks. It
    // is a STABLE state (never becomes `clean`), so treat it exactly like clean —
    // otherwise a ready PR in a hook-enabled repo is stuck on "Checking…" forever.
    case "clean":
    case "has_hooks":
      if (pr.isMergeable !== false) {
        return {
          kind: "ready-to-merge",
          label: "Ready to merge",
          tone: "success",
          actions: [mergeAction],
        };
      }
      break;
    default:
      break;
  }

  // 4d. Mergeability still computing on GitHub's side, or an unknown state.
  return {
    kind: "checking",
    label: "Checking mergeability…",
    tone: "neutral",
    actions: [],
  };
}
