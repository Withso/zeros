import React from "react";
import { useNativeRuntime } from "../../platform/runtime";
import {
  gitPush,
  gitPull,
  ghPrMarkReady,
  gitErrorDescription,
  type Workspace,
} from "../../platform/git";
import { Button, Tooltip } from "../../shared/ui/primitives";
import { toast } from "../../shared/ui/primitives/elements";
import { ZerosSpinner } from "../../shared/ui/loading";
import { useGitRemote } from "../../features/settings/use-git-remote";
import { notifyWorkspacesChanged } from "../../state/use-projects";
import { CreatePrButton } from "../pr/create-pr-button";
import { isGithubDotComRemote } from "../pr/github-url";
import { useShowReviewTab } from "../pr/use-open-review-tab";
import { useSendToActiveChat } from "../pr/use-send-to-active-chat";
import {
  AGENT_WORKING_REASON,
  useWorkspaceAgentWorking,
} from "../pr/use-agent-working";
import {
  claimWorkspaceGitAction,
  releaseWorkspaceGitAction,
  useWorkspaceGitActionClaim,
} from "../pr/workspace-git-action-claims";
import { triggerGitRefresh } from "../use-git-refresh-key";
import {
  invalidateSummaryGit,
  useSummaryGitStatus,
} from "./summary-git-status-data";
import {
  summaryGitBlocker,
  summaryGitPrompt,
  summaryGitRows,
  type SummaryGitRow,
} from "./summary-git-status-model";

const ACTION_CLASS =
  "text-fg3 hover:text-fg1 hover:bg-bg1-hover shrink-0 font-normal";

/** Mounted only for managed Local Git workspaces, for both owner types. */
export function SummaryGitStatus({
  workspace,
  originUrl,
  active,
  onNavigate,
}: {
  workspace: Workspace;
  originUrl: string | null;
  active: boolean;
  onNavigate: () => void;
}) {
  const nativeReady = useNativeRuntime().ready;
  const { git, pr, refresh } = useSummaryGitStatus(
    workspace,
    active && nativeReady,
  );
  const agentWorking = useWorkspaceAgentWorking(workspace);
  const acting = useWorkspaceGitActionClaim(workspace.id);
  const sendToChat = useSendToActiveChat(workspace.path);
  const showPr = useShowReviewTab();
  const remote = useGitRemote(workspace.repoRoot);
  const facts = git.data;
  const rows = summaryGitRows({
    facts,
    prNumber: workspace.prNumber,
    prState: workspace.prState,
    pr: pr.data ?? null,
    baseBranch: workspace.baseBranch,
  });
  const unavailable = !nativeReady
    ? "The engine is reconnecting"
    : git.error
      ? "Refresh Git status before continuing"
      : !facts
        ? "Reading Git status…"
        : undefined;
  const createReason =
    unavailable ??
    summaryGitBlocker(facts) ??
    (facts?.all === 0
      ? "Nothing to PR yet — this branch has no changes"
      : undefined);

  const run = async (row: SummaryGitRow) => {
    if (!active) return;
    if (row.action === "view-pr") {
      showPr();
      onNavigate();
      return;
    }
    if (agentWorking || unavailable || row.disabledReason || !facts) return;
    // Native Pull addresses the configured remote's same-named branch. A
    // differently configured upstream needs an explicit, inspected integration.
    const foreignUpstream =
      facts.upstream &&
      facts.upstream !== `${remote}/${facts.branch ?? workspace.branch}`;
    const direct =
      row.action === "ready-for-review" ||
      ((row.action === "push" || row.action === "pull") && !foreignUpstream);
    const owner = claimWorkspaceGitAction(workspace.id, {
      kind: row.action,
      behavior: !direct
        ? "prompt"
        : row.action === "ready-for-review"
          ? "ready"
          : row.action === "push"
            ? "push"
            : "pull",
    });
    if (!owner) return;
    const finish = () => {
      invalidateSummaryGit(workspace);
      triggerGitRefresh(workspace.path);
      notifyWorkspacesChanged(workspace.repoSlug);
      releaseWorkspaceGitAction(owner);
    };
    if (!direct) {
      const text =
        foreignUpstream && (row.action === "push" || row.action === "pull")
          ? `Inspect this branch's tracking configuration before ${row.action === "pull" ? "pulling" : "pushing"}: its upstream is ${facts.upstream}, while the configured push destination is ${remote}/${facts.branch ?? workspace.branch}. Reconcile the intended branch safely, preserving all commits and uncommitted work. Do not push into the base branch, discard work, or force-push.`
          : summaryGitPrompt(row, facts, workspace.baseBranch, remote);
      const sent = sendToChat({
        text,
        displayText: row.label,
        autoAction:
          row.action === "commit-and-push"
            ? "commit-and-push"
            : row.action === "pull-base"
              ? "update-branch"
              : "resolve",
        onSettled: finish,
      });
      if (!sent) releaseWorkspaceGitAction(owner);
      return;
    }
    try {
      if (row.action === "push") await gitPush({ workspaceId: workspace.id });
      else if (row.action === "pull") {
        const result = await gitPull({
          workspaceId: workspace.id,
          strategy: "rebase",
          autoStash: true,
        });
        if (result.conflicts.length)
          toast.error("Pull hit merge conflicts", {
            description:
              "Use Resolve to finish the operation and preserve your changes.",
          });
      } else if (workspace.prNumber != null) {
        await ghPrMarkReady({
          workspaceId: workspace.id,
          prNumber: workspace.prNumber,
        });
      }
    } catch (error) {
      toast.error(
        row.action === "push"
          ? "Couldn't push"
          : row.action === "pull"
            ? "Couldn't pull"
            : "Couldn't mark ready for review",
        { description: gitErrorDescription(error) },
      );
    } finally {
      finish();
    }
  };

  return (
    <section
      aria-label="Git status"
      className="border-border1 border-t pt-3"
      data-summary-git-status=""
    >
      <div className="text-fg3 text-3xxs mb-1 px-1.5 font-medium">
        Git status
      </div>
      {workspace.prNumber == null &&
        (!originUrl || isGithubDotComRemote(originUrl)) && (
          <div className="px-1.5 py-1">
            <CreatePrButton
              workspace={workspace}
              originUrl={originUrl}
              appearance="primary"
              active={active && nativeReady}
              disabled={!!createReason}
              disabledReason={createReason}
            />
          </div>
        )}
      {rows.map((row) => {
        const reason =
          row.action === "view-pr"
            ? undefined
            : agentWorking
              ? AGENT_WORKING_REASON
              : (unavailable ??
                row.disabledReason ??
                (acting ? "Another Git action is running" : undefined));
        return (
          <div
            key={row.id}
            className="flex min-w-0 items-start justify-between gap-2 px-1.5 py-0.5"
            data-git-status-row={row.id}
          >
            <span className="text-fg2 min-w-0 py-0.5 text-xs break-words">
              {row.name}
            </span>
            <Tooltip label={reason ?? ""} disabled={!reason}>
              <span className="inline-flex shrink-0">
                <Button
                  variant="ghost"
                  size="compact"
                  className={ACTION_CLASS}
                  disabled={!active || !!reason}
                  aria-label={row.label}
                  aria-busy={acting?.kind === row.action || undefined}
                  onClick={() => void run(row)}
                >
                  {acting?.kind === row.action && (
                    <span aria-hidden="true">
                      <ZerosSpinner size={12} tone="inherit" />
                    </span>
                  )}
                  {row.label}
                </Button>
              </span>
            </Tooltip>
          </div>
        );
      })}
      {git.error && (
        <div className="flex items-center justify-between gap-2 px-1.5 py-0.5">
          <span className="text-fg3 text-xs">Git status unavailable</span>
          <Button
            variant="ghost"
            size="compact"
            className={ACTION_CLASS}
            onClick={refresh}
            disabled={!active || !nativeReady}
          >
            Retry
          </Button>
        </div>
      )}
      {facts && !git.error && rows.length === 0 && (
        <p className="text-fg3 px-1.5 py-1 text-xs">Working tree clean</p>
      )}
    </section>
  );
}
