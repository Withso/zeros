// ──────────────────────────────────────────────────────────
// PrStatusRow — the shared worktree PR status row
// ──────────────────────────────────────────────────────────
//
//   ┌─────────────────────────────────────────────────────┐
//   │ my-branch → [origin/main ⇅]          [⑃ Create PR ▾] │   (no PR)
//   ├─────────────────────────────────────────────────────┤
//   │ PR #N · status · checks · one-tap actions…           │   (with PR)
//   └─────────────────────────────────────────────────────┘
//
// One row owned by Workbench above the retained Changes and Review tab bodies,
// so creation/status stays mounted — and keeps one live snapshot — across a
// hop between them. With a PR it IS the PR status island (live status +
// one-tap actions); without one it's the same borderless 40px row holding the
// target-branch picker (left) and the Create PR split-button (right). The two
// are mutually exclusive on `prNumber`, exactly like the old topbar
// button/island pair — so an adopted-PR workspace can never see both at once.
//
// Not rendered for Local main (the merge target — it never has a PR).
// ──────────────────────────────────────────────────────────

import React from "react";

import { useNativeRuntime } from "@/renderer/platform/runtime";
import { type Workspace } from "@/renderer/platform/git";
import { PrStatusIsland } from "./pr-status-island";
import { CreatePrButton } from "./create-pr-button";
import { TargetBranchButton } from "./target-branch-select";
import { useWorkspaceHasChanges } from "./use-workspace-has-changes";
import { isGithubDotComRemote } from "./github-url";

export function PrStatusRow({
  workspace,
  originUrl,
  active,
}: {
  workspace: Workspace | null;
  originUrl: string | null;
  /** Inactive/collapsed workspace surfaces stay inert (no Git/GitHub reads). */
  active: boolean;
}) {
  const nativeReady = useNativeRuntime().ready;
  const prWorkspace = workspace;
  // "Anything to PR?" gates the button's ENABLED state (not its visibility —
  // this row is the stable home for PR creation, so the button stays put).
  // Tri-state hook; this row wants the plain boolean (unknown → treated as
  // "nothing to PR yet", preserving the prior disabled-button behavior).
  const hasChanges = useWorkspaceHasChanges(prWorkspace, active) ?? false;

  if (prWorkspace && prWorkspace.prNumber != null) {
    // key: reset island state on workspace switch (same as the old render site).
    return (
      <PrStatusIsland
        key={prWorkspace.id}
        workspace={prWorkspace}
        active={active}
        localDesktop={nativeReady}
      />
    );
  }
  return (
    <div className="bg-bg1 flex h-10 shrink-0 items-center gap-2 px-2">
      {prWorkspace ? (
        <>
          {/* Left: pick the base branch (remote-only). Right: Create PR. */}
          <TargetBranchButton workspace={prWorkspace} disabled={!nativeReady} />
          <div className="flex-1" />
          {/* `originUrl` is only the project row's boot cache and is legitimately
              blank for folders registered without one (bind-folder, quick start,
              pre-backfill rows). Hide the button only when we positively know the
              remote is a non-GitHub host; the engine re-resolves the real remote
              per op, so a blank cache must not remove PR creation. */}
          {nativeReady && (!originUrl || isGithubDotComRemote(originUrl)) && (
            <CreatePrButton
              workspace={prWorkspace}
              originUrl={originUrl}
              disabled={!hasChanges}
              disabledReason="Nothing to PR yet — this branch has no changes"
            />
          )}
        </>
      ) : (
        <span className="text-fg2 min-w-0 flex-1 truncate text-xs">
          No workspace selected.
        </span>
      )}
    </div>
  );
}
