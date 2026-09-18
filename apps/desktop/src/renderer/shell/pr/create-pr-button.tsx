// Shared PR controls for every workspace. PR creation uses existing commits;
// local staging and commits remain explicit review actions.

import { useCallback, useRef } from "react";
import {
  ChevronDown,
  ExternalLink,
  GitPullRequestCreate,
  GitPullRequestDraft,
} from "lucide-react";

import { cn } from "../../shared/ui/cn";
import {
  Tooltip,
  splitTriggerClassNames,
} from "@/renderer/shared/ui/primitives";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { toast } from "../../shared/ui/primitives/elements";
import {
  ghPrCreate,
  ghRepoAccess,
  gitChangeCounts,
  gitLog,
  gitRepoBranchCatalog,
  gitStatus,
  isGitErrorShape,
  type GithubRepoAccess,
  type StatusResult,
  type Workspace,
} from "../../platform/git";
import { shellOpenUrl } from "../../platform/app";
import { buildPrInstructions, prBubbleDisplayText } from "./pr-instructions";
import { githubCompareUrl, parseRemote } from "./github-url";
import { useGitRemote } from "../../features/settings/use-git-remote";
import { useSendToActiveChat } from "./use-send-to-active-chat";
import {
  AGENT_WORKING_REASON,
  useWorkspaceAgentWorking,
} from "./use-agent-working";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import {
  createPullRequestForWorkspace,
  GithubAccessError,
  isPrAccessBlocked,
} from "./create-pr-action";
import {
  describePrAccessBlock,
  describePrCreateFailure,
  type PrBlockMessage,
} from "./pr-github-access";
import { notifyWorkspacesChanged } from "../../state/use-projects";
import { useWorkspaceDispatch } from "../../state/store";
import { requestUserSettingsSection } from "../../features/settings/settings-navigation";
import {
  claimPrCreateAction,
  releasePrCreateAction,
  usePrCreateActionClaimed,
} from "./pr-create-claim";

// The shared dropdown chrome in its SPLIT form (primitives/select.tsx): same
// 6px corners, 13px text, 14px glyphs, border3 shell and bg2-highlight hover
// as the Target-branch dropdown across the row — only the action segment and
// the ▾ menu segment hover independently. `enabled:` hovers keep a disabled
// control inert under the cursor while its tooltip explains why.
const {
  shell: CONTAINER_CLS,
  main: MAIN_BTN_CLS,
  chevron: CHEVRON_BTN_CLS,
} = splitTriggerClassNames;

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
  const sendToChat = useSendToActiveChat(workspace.path);
  const dispatch = useWorkspaceDispatch();
  const busy = usePrCreateActionClaimed(workspace.id);
  // The repo's configured push/PR remote — the brief must name the same
  // remote the engine's own git ops use.
  const remote = useGitRemote(workspace.repoRoot);
  // Parked while the agent has a turn in flight: the prompt would queue
  // behind the very turn still reshaping the branch, and the PR brief's
  // uncommitted/upstream counts would describe a half-done tree.
  const workspaceAgentWorking = useWorkspaceAgentWorking(workspace);
  const agentWorking = workspaceAgentWorking;
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
      try {
        await createPullRequestForWorkspace(
          {
            log: (args) => gitLog(args),
            create: (args) => ghPrCreate(args),
            access: () => accessProbe,

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
        if (err instanceof GithubAccessError) {
          showBlockToast(describePrAccessBlock(err.access));
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
            onClick={() =>
              void askAgentToCreate(false)
            }
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
              <ChevronDown />
            </button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          sideOffset={4}
          className="min-w-[190px]"
        >
          <>
              <DropdownMenuItem onSelect={() => void askAgentToCreate(true)}>
                <GitPullRequestDraft className={cn("text-fg2 size-3.5")} />
                <span>Create draft PR</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void createDirect(false)}>
                <GitPullRequestCreate className="text-fg2 size-3.5" />
                <span>Create PR directly</span>
              </DropdownMenuItem>
          </>
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
