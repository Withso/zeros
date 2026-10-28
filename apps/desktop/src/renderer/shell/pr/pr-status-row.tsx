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
// one-tap actions); without one it's a bottom-bordered 40px row holding the
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
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { PanelHeader } from "@/renderer/shared/ui/primitives/panel-header";
import { useRepositoryRemote } from "../../features/repositories/use-repository-remote";
import { useCloudGithubPrDocument } from "../../platform/use-cloud-github-pr";
import type { CloudGithubUnavailableReason } from "@zeros/protocol/cloud-github-connection";

const cloudUnavailableCopy: Record<CloudGithubUnavailableReason, string> = {
  "connection-required": "Connect GitHub in Settings → Integrations to use pull requests.",
  "connection-expired": "Reconnect GitHub in Settings → Integrations to use pull requests.",
  "connection-changed": "Your cloud GitHub connection changed. Refresh this workspace.",
  "installation-required": "Grant the Zeros GitHub App access to this repository in GitHub.",
  "installation-suspended": "Ask your GitHub organization owner to restore the Zeros GitHub App.",
  "access-denied": "Your selected GitHub connection cannot access this repository. Check Settings → Integrations.",
  "sso-required": "Authorize your selected GitHub connection for this organization's SSO.",
  "source-review-required": "This workspace needs its original source access verified. Its files have been retained.",
  "rate-limited": "GitHub rate limit reached. Try again shortly.",
  "unavailable": "Couldn't verify GitHub access. Try again shortly.",
};

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
  const cloud = isCloudWorkspace(prWorkspace?.path) || isCloudWorkspace(prWorkspace?.id);
  const document = useCloudGithubPrDocument(prWorkspace?.id);
  const cloudReady = document?.status === "ready" || document?.status === "busy";
  const supported = document?.capabilities.githubPullRequests === 1;
  const hasChanges = useWorkspaceHasChanges(prWorkspace, active && (!cloud || cloudReady)) ?? false;
  const { remoteUrl } = useRepositoryRemote(prWorkspace?.repoRoot, originUrl, active && !cloud);

  if (prWorkspace && cloud && !supported) {
    const message = document?.githubUnavailableReason ? cloudUnavailableCopy[document.githubUnavailableReason]
      : "Pull requests aren't available for this cloud workspace.";
    return (
      <PanelHeader size="window" className="gap-2">
        <TargetBranchButton workspace={prWorkspace} disabled={!cloudReady} />
        <div className="flex-1" />
        <span className="text-fg3 min-w-0 truncate text-xs" title={message}>
          {message}
        </span>
      </PanelHeader>
    );
  }

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
    <PanelHeader size="window" className="gap-2">
      {prWorkspace ? (
        <>
          {/* Left: pick the base branch (remote-only). Right: Create PR. */}
          <TargetBranchButton workspace={prWorkspace} disabled={cloud ? !cloudReady : !nativeReady} />
          <div className="flex-1" />
          {/* Project capability refresh discovers added/removed remotes. A
              missing remote must not advertise a GitHub-only action. */}
          {(cloud ? supported : nativeReady) && isGithubDotComRemote(cloud ? originUrl : remoteUrl) && (
            <CreatePrButton
              workspace={prWorkspace}
              originUrl={cloud ? originUrl : remoteUrl}
              active={active}
              disabled={!hasChanges || cloud && !cloudReady}
              disabledReason={cloud && !cloudReady ? "Start this workspace to publish its branch" : "Nothing to PR yet — this branch has no changes"}
            />
          )}
        </>
      ) : (
        <span className="text-fg2 min-w-0 flex-1 truncate text-xs">
          No workspace selected.
        </span>
      )}
    </PanelHeader>
  );
}
