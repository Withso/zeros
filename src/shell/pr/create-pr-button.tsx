// ──────────────────────────────────────────────────────────
// CreatePrButton — split "Create PR" control for the Column 2 top bar
// ──────────────────────────────────────────────────────────
//
//   ┌───────────────┬───┐
//   │ ⑃ Create PR   │ ▾ │
//   └───────────────┴───┘
//
// Left segment (primary): sends a complete create-PR brief to the active agent,
// which reviews the full change set and decides the commit/title/description.
// Dropdown:
//   • Create draft PR      — the same agent path, with draft=true.
//   • Create PR directly   — deterministic engine path; auto-commits if dirty.
//   • Create draft directly — the direct path, with draft=true.
//   • Create PR manually — opens GitHub's compare/new-PR page in the browser.
//
// Only rendered for a real worktree that has no PR yet (see the topbar guard).
//
// GitHub access is cross-checked FIRST, on every path that can fail because of
// it (see ghRepoAccess):
//   • before the agent brief is sent, because the agent's own `gh pr create`
//     runs on the very same brokered credential — an unreachable repository
//     fails for it too, after a whole turn spent reviewing and committing;
//   • ahead of the auto-commit, so the button never writes a commit for a pull
//     request that could never have opened;
//   • alongside the direct create, so a failure that arrives as the ambiguous
//     "Repository not found" flavour of NOT_AUTHENTICATED doesn't tell an
//     already-connected user to connect GitHub.
// ──────────────────────────────────────────────────────────

import { useCallback, useRef } from "react";
import {
  ChevronDown,
  ExternalLink,
  GitPullRequestCreate,
  GitPullRequestDraft,
} from "lucide-react";

import { cn } from "../../zeros/ui/cn";
import { Tooltip } from "@/zeros/ui/primitives";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../zeros/ui/primitives/dropdown-menu";
import { toast } from "../../zeros/ui/primitives/elements";
import {
  ghPrCreate,
  ghRepoAccess,
  gitChangeCounts,
  gitCommit,
  gitLog,
  gitRepoBranchCatalog,
  gitStage,
  gitStatus,
  isGitErrorShape,
  isWorkspaceOpStillRunning,
  type GithubRepoAccess,
  type StatusResult,
  type Workspace,
} from "../../native/git";
import { shellOpenUrl } from "../../native/native";
import { buildPrInstructions, prBubbleDisplayText } from "./pr-instructions";
import { githubCompareUrl, parseRemote } from "./github-url";
import { useGitRemote } from "../../zeros/settings/use-git-remote";
import { useSendToActiveChat } from "./use-send-to-active-chat";
import {
  AGENT_WORKING_REASON,
  useWorkspaceAgentWorking,
} from "./use-agent-working";
import { ZerosSpinner } from "@/loaders";
import {
  AutoCommitBlockedError,
  AutoCommitFailedError,
  createPullRequestForWorkspace,
  GithubAccessError,
  isPrAccessBlocked,
} from "./create-pr-action";
import {
  describeAutoCommitBlock,
  describeAutoCommitFailure,
} from "./pr-auto-commit";
import {
  describePrAccessBlock,
  describePrCreateFailure,
  type PrBlockMessage,
} from "./pr-github-access";
import { notifyWorkspacesChanged } from "../../zeros/store/use-projects";
import { useWorkspaceDispatch } from "../../zeros/store/store";
import { requestUserSettingsSection } from "../../zeros/settings/settings-navigation";
import { triggerGitRefresh } from "../use-git-refresh-key";
import {
  claimPrCreateAction,
  releasePrCreateAction,
  usePrCreateActionClaimed,
} from "./pr-create-claim";

// 24px (`h-6`) split control on the design-system "secondary" tokens
// (TRANSPARENT fill so it blends with the row's surface + border2, hover
// bg2-hover + border3) — the same family as the Target-branch dropdown
// sitting across the row.
const CONTAINER_CLS =
  "inline-flex shrink-0 items-center overflow-hidden rounded-sm border border-border2 bg-transparent transition-colors duration-120 ease-out hover:border-border3";
// `enabled:` hovers so a disabled button doesn't light up under the cursor
// while its tooltip explains why it's inert.
const MAIN_BTN_CLS =
  "inline-flex h-6 items-center gap-1.5 pl-2 pr-2.5 text-xs font-medium text-fg1 transition-colors duration-120 ease-out enabled:hover:bg-bg2-hover disabled:opacity-50";
const CHEVRON_BTN_CLS =
  "inline-flex h-6 w-6 items-center justify-center border-l border-border2 text-fg2 transition-colors duration-120 ease-out enabled:hover:bg-bg2-hover enabled:hover:text-fg1 disabled:opacity-50";

interface CreatePrButtonProps {
  workspace: Workspace;
  /** The owning project's origin remote (for the "Create PR manually" URL). */
  originUrl: string | null;
  /** Externally disabled (e.g. the Changes tab's PR row keeps the button
   *  ALWAYS visible but inert while the branch has nothing to PR). */
  disabled?: boolean;
  /** Tooltip shown on the main segment while `disabled` explains why. */
  disabledReason?: string;
}

export function CreatePrButton({
  workspace,
  originUrl,
  disabled,
  disabledReason,
}: CreatePrButtonProps) {
  const sendToChat = useSendToActiveChat();
  const dispatch = useWorkspaceDispatch();
  const busy = usePrCreateActionClaimed(workspace.id);
  // The repo's configured push/PR remote — the brief must name the same
  // remote the engine's own git ops use.
  const remote = useGitRemote(workspace.repoRoot);
  // Parked while the agent has a turn in flight: the prompt would queue
  // behind the very turn still reshaping the branch, and the PR brief's
  // uncommitted/upstream counts would describe a half-done tree.
  const agentWorking = useWorkspaceAgentWorking(workspace);
  const inert = busy || disabled === true || agentWorking;
  // Guards read LIVE state through a ref, not through a captured render.
  // "Ask agent" is reachable from a toast that outlives the click that raised
  // it, so a closure-captured `agentWorking` would happily queue a PR brief
  // behind a turn that started in between — the exact thing the gate exists to
  // prevent. The exact-workspace claim is shared outside this component so it
  // also closes double-clicks and Changes/Review → File → back remount races.
  const gateRef = useRef({ disabled: false, agentWorking: false });
  gateRef.current = { disabled: disabled === true, agentWorking };
  const claim = useCallback(() => {
    if (gateRef.current.disabled) return null;
    if (gateRef.current.agentWorking) {
      // Only the toast's "Ask agent" button can reach this — both real buttons
      // are already disabled by the same gate. It outlives the click that
      // raised it, so a turn can begin in between; say so rather than swallow
      // the click, because the user has no disabled state to read here.
      toast.error("Agent is working", { description: AGENT_WORKING_REASON });
      return null;
    }
    return claimPrCreateAction(workspace.id);
  }, [workspace.id]);

  const openGithubSettings = useCallback(() => {
    requestUserSettingsSection("integrations");
    dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
  }, [dispatch]);

  const showBlockToast = useCallback(
    (message: PrBlockMessage) => {
      toast.error(message.title, {
        description: message.description,
        ...(message.openSettings
          ? {
              action: {
                label: "Open GitHub settings",
                onClick: openGithubSettings,
              },
            }
          : {}),
      });
    },
    [openGithubSettings],
  );

  const askAgentToCreate = useCallback(
    async (draft: boolean) => {
      const owner = claim();
      if (!owner) return;
      let releaseOnExit = true;
      try {
        // Cross-check access BEFORE spending a turn. The agent's `gh pr create`
        // runs through the same brokered credential this probe tests (see the
        // gh shim in the engine's credential broker), so a repository the
        // connection can't reach fails for the agent too — only later, after it
        // has reviewed the diff and written a commit the user didn't ask for.
        const access = await ghRepoAccess(workspace.id);
        if (isPrAccessBlocked(access)) {
          showBlockToast(describePrAccessBlock(access));
          return;
        }
        // Best-effort live facts; failures stay explicitly unknown. Inventing
        // "clean" or "no upstream" here can make the agent skip work or push
        // with the wrong assumptions precisely when the bridge is unhealthy.
        let uncommittedCount: number | null = null;
        let statusKnown = false;
        let hasUpstream: boolean | null = null;
        let repository: string | undefined;
        // The blocker facts come from the SAME status read — this path is the
        // recovery the conflict refusal offers, so the brief has to name what
        // the direct create refused to commit.
        let conflictedCount = 0;
        let operationInProgress: StatusResult["conflictState"] = null;
        const [status, counts, catalog] = await Promise.allSettled([
          gitStatus(workspace.id),
          gitChangeCounts(workspace.id),
          gitRepoBranchCatalog({ repoRoot: workspace.repoRoot }),
        ]);
        if (status.status === "fulfilled") {
          statusKnown = true;
          hasUpstream = Boolean(status.value.upstream);
          conflictedCount = status.value.conflicted.length;
          operationInProgress = status.value.conflictState;
        }
        if (counts.status === "fulfilled") {
          // The prompt describes the net HEAD-vs-worktree diff. Summing
          // porcelain buckets would count one `AD` path twice even though the
          // staged add and disk deletion cancel out completely.
          uncommittedCount = counts.value.uncommitted;
        }
        if (catalog.status === "fulfilled" && catalog.value) {
          const configured =
            catalog.value.remotes.find(
              (candidate) => candidate.name === remote,
            ) ??
            catalog.value.remotes.find(
              (candidate) => candidate.name === catalog.value?.effectiveRemote,
            );
          const parsed =
            configured?.isGitHub === true ? parseRemote(configured.url) : null;
          if (parsed) repository = `${parsed.owner}/${parsed.repo}`;
        }
        const text = buildPrInstructions({
          branch: workspace.branch,
          baseBranch: workspace.baseBranch,
          remote,
          repository,
          uncommittedCount,
          statusKnown,
          conflictedCount,
          operationInProgress,
          hasUpstream,
          draft,
        });
        // Auto-sent treatment (2026-07-19): a tidy "Create a PR" bubble with
        // the button's own icon on the brown "sent by Zeros" surface — no
        // attachment pill; the agent still receives the full brief.
        const sent = sendToChat({
          text,
          displayText: prBubbleDisplayText(draft),
          autoAction: draft ? "create-draft-pr" : "create-pr",
          onSettled: () => releasePrCreateAction(owner),
        });
        // Keep the synchronous claim (and spinner) through the accepted turn;
        // onSettled releases it on either success or failure. If no active
        // chat accepted the send, the ordinary finally releases immediately.
        if (sent) releaseOnExit = false;
      } finally {
        if (releaseOnExit) releasePrCreateAction(owner);
      }
    },
    [
      claim,
      showBlockToast,
      workspace.id,
      workspace.repoRoot,
      workspace.branch,
      workspace.baseBranch,
      remote,
      sendToChat,
    ],
  );

  const createDirect = useCallback(
    async (draft: boolean) => {
      const owner = claim();
      if (!owner) return;
      // Started here, not inside the orchestrator, so it overlaps the local
      // change-count read and the push instead of queueing in front of them —
      // the happy path pays nothing for it. Never rejects (ghRepoAccess
      // resolves "unknown" on any failure), so leaving it unawaited on the
      // success path cannot raise an unhandled rejection.
      const accessProbe = ghRepoAccess(workspace.id);
      // Set by onCommitted so the catch can tell "nothing happened" apart from
      // "the work is committed, only the pull request failed".
      let didCommit = false;
      try {
        await createPullRequestForWorkspace(
          {
            changeCounts: async (workspaceId) => gitChangeCounts(workspaceId),
            status: (workspaceId) => gitStatus(workspaceId),
            stage: (args) => gitStage(args),
            commit: (args) => gitCommit(args),
            log: (args) => gitLog(args),
            create: (args) => ghPrCreate(args),
            access: () => accessProbe,
            onCommitted: (result) => {
              didCommit = true;
              // The engine withholds the DB_CHANGED echo from the client that
              // caused a git.commit (it normally already knows), so nothing
              // else tells THIS renderer the tree just went clean — and the
              // push + GitHub round trip that follows can take seconds, or
              // fail, leaving the Changes tab describing a tree that no longer
              // exists.
              triggerGitRefresh(workspace.path);
              // A commit nobody typed a message for is the one part of this
              // flow the user has to be told about, whatever GitHub does next.
              toast.success(
                result.files === 1
                  ? "Committed 1 change"
                  : `Committed ${result.files} changes`,
                { description: result.subject },
              );
            },
          },
          {
            workspaceId: workspace.id,
            branch: workspace.branch,
            baseBranch: workspace.baseBranch,
            draft,
          },
        );
        // The workspace row is the durable source for the PR status island.
        // Refresh it instead of showing a redundant success toast.
        notifyWorkspacesChanged(workspace.repoSlug);
      } catch (err) {
        // The commit outlives a failed pull request. Without this the workspace
        // row keeps advertising uncommitted work (the Dashboard card's
        // "Commit & Push") for a tree that is already committed.
        if (didCommit) notifyWorkspacesChanged(workspace.repoSlug);
        if (err instanceof GithubAccessError) {
          showBlockToast(describePrAccessBlock(err.access));
          return;
        }
        if (err instanceof AutoCommitBlockedError) {
          // The one refusal left: committing a conflicted (or mid-rebase) tree
          // would put `<<<<<<<` markers in the pull request. The agent is the
          // recovery, and its brief names the conflicts (see buildPrInstructions).
          const message = describeAutoCommitBlock(err.blocker);
          toast.error(message.title, {
            description: message.description,
            action: {
              label: "Ask agent",
              onClick: () => void askAgentToCreate(draft),
            },
          });
          return;
        }
        if (err instanceof AutoCommitFailedError) {
          // Never `describePrCreateFailure` here: GitHub was never reached, and
          // the engine's own sentence for a failed commit is the entire
          // `git commit -m <generated message>` argv.
          const facts = isGitErrorShape(err.reason) ? err.reason : null;
          const message = describeAutoCommitFailure({
            stillRunning: isWorkspaceOpStillRunning(err.reason),
            ...(facts?.remediation ? { remediation: facts.remediation } : {}),
          });
          toast.error(message.title, {
            description: message.description,
            ...(message.canAskAgent
              ? {
                  action: {
                    label: "Ask agent",
                    onClick: () => void askAgentToCreate(draft),
                  },
                }
              : {}),
          });
          return;
        }
        // Let the preflight explain the failure when it reached a verdict: a
        // push refused for an unreachable repository surfaces here as a bare
        // NOT_AUTHENTICATED (git reports GitHub's 404 as "Repository not
        // found"), which on its own reads as "you are signed out".
        const access: GithubRepoAccess = await accessProbe;
        // A non-GitError (a bridge timeout, a thrown string) still has to keep
        // whatever sentence it carries — dropping it for generic copy would
        // hide the only detail there is.
        const facts = isGitErrorShape(err)
          ? err
          : { message: err instanceof Error ? err.message : String(err) };
        showBlockToast(describePrCreateFailure(facts, access));
      } finally {
        releasePrCreateAction(owner);
      }
    },
    [
      claim,
      showBlockToast,
      workspace.id,
      workspace.branch,
      workspace.baseBranch,
      workspace.repoSlug,
      workspace.path,
      askAgentToCreate,
    ],
  );

  const handleManual = useCallback(async () => {
    // Open the compare page on the CONFIGURED remote's repository — in a fork
    // workflow (origin = your fork, git.remote = upstream) the stored origin
    // URL names a different GitHub repo than the one PRs target. Best-effort:
    // fall back to the stored origin URL when the catalog isn't reachable.
    let remoteUrl: string | null = originUrl;
    try {
      const catalog = await gitRepoBranchCatalog({
        repoRoot: workspace.repoRoot,
      });
      const configured = catalog?.remotes.find(
        (r) => r.name === catalog.effectiveRemote,
      );
      if (configured) remoteUrl = configured.url;
    } catch {
      /* engine unavailable — the stored origin URL is the best we have */
    }
    const url = githubCompareUrl(
      remoteUrl,
      workspace.baseBranch,
      workspace.branch,
    );
    if (!url) {
      toast.error("Can't open GitHub", {
        description:
          "This project has no recognizable GitHub remote to open a PR against.",
      });
      return;
    }
    void shellOpenUrl(url);
  }, [originUrl, workspace.repoRoot, workspace.baseBranch, workspace.branch]);

  return (
    <div className={CONTAINER_CLS}>
      <Tooltip
        label={
          agentWorking
            ? AGENT_WORKING_REASON
            : disabled && disabledReason
              ? disabledReason
              : "Send PR creation to the agent"
        }
      >
        {/* span keeps the tooltip live over a disabled button (disabled
            elements receive no pointer events, so the wrapper triggers). */}
        <span className="inline-flex">
          <button
            type="button"
            className={MAIN_BTN_CLS}
            disabled={inert}
            onClick={() => void askAgentToCreate(false)}
          >
            {busy ? (
              <ZerosSpinner size={14} />
            ) : (
              <GitPullRequestCreate className="size-3.5" />
            )}
            <span>Create PR</span>
          </button>
        </span>
      </Tooltip>
      <DropdownMenu>
        <Tooltip label="More PR options">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={CHEVRON_BTN_CLS}
              disabled={inert}
              aria-label="More PR options"
            >
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          sideOffset={4}
          className="min-w-[190px]"
        >
          <DropdownMenuItem onSelect={() => void askAgentToCreate(true)}>
            <GitPullRequestDraft className={cn("text-fg2 size-3.5")} />
            <span>Create draft PR</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void createDirect(false)}>
            <GitPullRequestCreate className="text-fg2 size-3.5" />
            <span>Create PR directly</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void createDirect(true)}>
            <GitPullRequestDraft className="text-fg2 size-3.5" />
            <span>Create draft directly</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handleManual()}>
            <ExternalLink className="text-fg2 size-3.5" />
            <span>Create PR manually</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
