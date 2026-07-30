// ──────────────────────────────────────────────────────────
// ReviewRow1Tab — THE pinned row-1 Review tab
// ──────────────────────────────────────────────────────────
//
// The PR review surface, second in row 1 and never closable: the shared PR
// STATUS row first (the same PrStatusRow as the Changes tab — Target branch +
// Create PR without a PR, the live status island with one), then ReviewView
// (PR header / state / merge + Changes / Commits / Checks / Reviews sub-tabs)
// for the active workspace's PR. ALWAYS visible — unlike the old conditional
// "PR #N" pill it replaced, so instead of appearing/disappearing with the PR
// it renders an explanatory empty state until one exists. The status island's
// #N chip / Show-checks land here (use-open-review-tab).
//
// Data flows through the shared git refresh bus (useGitRefreshKey): agent
// commits/pushes and gh writes re-pull the PR, checks, commits and reviews.
// ──────────────────────────────────────────────────────────

import React from "react";

import { useActiveWorkspace } from "@/zeros/store/use-active-workspace";
import { useWorkspaceDispatch } from "@/zeros/store/store";
import { useGitRefreshKey } from "../use-git-refresh-key";
import { useWorkspaceAgentWorking } from "../pr/use-agent-working";
import { type Column3Tab } from "../column3-tab-manager";
import { parseRemote } from "../pr/github-url";
import { PrStatusRow } from "../pr/pr-status-row";
import { resolveReviewProvider } from "../pr/review-provider";
import { EmptyState, useSourceTarget } from "./changes-tab";
import { ReviewView } from "./review-tab";

interface TabBodyProps {
  tab: Column3Tab;
  active: boolean;
  scope?: string;
}

// Memoised like the other row-1 bodies; the hooks below still see live
// workspace/refresh updates through context and subscriptions.
export const ReviewRow1Tab = React.memo(function ReviewRow1Tab({
  tab,
  active,
  scope,
}: TabBodyProps) {
  const dispatch = useWorkspaceDispatch();
  const { workspace, isLocalMain, changesTarget } = useSourceTarget();
  // The owning project supplies the origin remote for "Create PR manually".
  const { project } = useActiveWorkspace();
  // `project.originUrl` is a boot cache that is blank for folders registered
  // without one, so a missing host is "unknown", not "not GitHub". A workspace
  // only carries a prNumber because a GitHub engine path stamped it, so falling
  // back to github.com keeps that PR reviewable instead of claiming the repo
  // lives on another forge.
  const originHost = parseRemote(project?.originUrl)?.host ?? "github.com";
  const provider = resolveReviewProvider(originHost);
  // Agent turn-end / git & gh writes / editor saves → re-pull the PR surface.
  const refreshKey = useGitRefreshKey(workspace?.path, changesTarget);
  // Parks the header's Merge / Mark-as-ready writes while a turn is in flight.
  const agentWorking = useWorkspaceAgentWorking(workspace);

  // The trunk ("Local main") never has a PR — main is the base a PR merges
  // INTO — and a workspace without one has nothing to review yet.
  const body =
    !workspace || isLocalMain || workspace.prNumber == null ? (
      <EmptyState
        title="No pull request"
        subtitle="This workspace has no open pull request yet. Pick a target branch and create one above — its status and this review surface light up together."
      />
    ) : !provider ? (
      <EmptyState
        title="Review unavailable"
        subtitle="Zeros can review pull requests from github.com remotes today. This repository uses a different Git host."
      />
    ) : (
      <ReviewView
        // Per-workspace remount — don't carry a prior workspace's PR / auth
        // state across a chat or workspace switch.
        key={workspace.id}
        provider={provider}
        workspaceId={workspace.id}
        baseBranch={workspace.baseBranch ?? "main"}
        branch={workspace.branch}
        prNumber={workspace.prNumber}
        prUrl={workspace.prUrl ?? null}
        repoSlug={workspace.repoSlug ?? null}
        refreshKey={refreshKey}
        // Live polling runs only while this is the visible row-1 tab.
        active={active}
        agentWorking={agentWorking}
        sub={tab.reviewSubtab ?? "changes"}
        onSubChange={(reviewSubtab) =>
          dispatch({
            type: "UPDATE_COLUMN3_TAB",
            id: tab.id,
            scope,
            updates: { reviewSubtab },
          })
        }
      />
    );
  return (
    <div className="bg-bg1 flex h-full min-h-0 flex-col">
      {/* Local main is the merge target, so it has no PR status/create row. */}
      {!isLocalMain && (
        <PrStatusRow
          workspace={workspace}
          originUrl={project?.originUrl ?? null}
          active={active}
        />
      )}
      {body}
    </div>
  );
});
