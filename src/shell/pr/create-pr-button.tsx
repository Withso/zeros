// ──────────────────────────────────────────────────────────
// CreatePrButton — split "Create PR" control for the Column 2 top bar
// ──────────────────────────────────────────────────────────
//
//   ┌───────────────┬───┐
//   │ ⑃ Create PR   │ ▾ │
//   └───────────────┴───┘
//
// Left segment (primary): creates the PR through the engine's authenticated
// GitHub operation. If the worktree is dirty, it refuses to omit those files
// and offers the explicit agent workflow as recovery.
// Dropdown:
//   • Create draft PR    — same direct path, with draft=true.
//   • Ask agent to create — the prior review/commit/push/gh workflow.
//   • Create PR manually — opens GitHub's compare/new-PR page in the browser.
//
// Only rendered for a real worktree that has no PR yet (see the topbar guard).
//
// GitHub access is cross-checked FIRST, on every path that can fail because of
// it (see ghRepoAccess):
//   • before the agent brief is sent, because the agent's own `gh pr create`
//     runs on the very same brokered credential — an unreachable repository
//     fails for it too, after a whole turn spent reviewing and committing;
//   • ahead of the dirty-worktree refusal, so "commit changes first" is never
//     shown for work that committing cannot unblock;
//   • alongside the direct create, so a failure that arrives as the ambiguous
//     "Repository not found" flavour of NOT_AUTHENTICATED doesn't tell an
//     already-connected user to connect GitHub.
// ──────────────────────────────────────────────────────────

import { useCallback, useRef, useState } from "react";
import {
  ChevronDown,
  ExternalLink,
  GitPullRequestCreate,
  GitPullRequestDraft,
  MessageSquareText,
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
  gitLog,
  gitRepoBranchCatalog,
  gitStatus,
  isGitErrorShape,
  type GithubRepoAccess,
  type Workspace,
} from "../../native/git";
import { shellOpenUrl } from "../../native/native";
import { buildPrInstructions, prBubbleDisplayText } from "./pr-instructions";
import { githubCompareUrl } from "./github-url";
import { useGitRemote } from "../../zeros/settings/use-git-remote";
import { useSendToActiveChat } from "./use-send-to-active-chat";
import {
  AGENT_WORKING_REASON,
  useWorkspaceAgentWorking,
} from "./use-agent-working";
import { ZerosSpinner } from "@/loaders";
import {
  createPullRequestFromCommittedChanges,
  GithubAccessError,
  isPrAccessBlocked,
  UncommittedPullRequestError,
} from "./create-pr-action";
import {
  describePrAccessBlock,
  describePrCreateFailure,
  type PrBlockMessage,
} from "./pr-github-access";
import { notifyWorkspacesChanged } from "../../zeros/store/use-projects";
import { useWorkspaceDispatch } from "../../zeros/store/store";
import { requestUserSettingsSection } from "../../zeros/settings/settings-navigation";

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
  const [busy, setBusy] = useState(false);
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
  // prevent. `busy` is written synchronously so a double-click inside one
  // frame can't fire twice before React re-renders the disabled button.
  const busyRef = useRef(false);
  const gateRef = useRef({ disabled: false, agentWorking: false });
  gateRef.current = { disabled: disabled === true, agentWorking };
  const claim = useCallback((): boolean => {
    if (busyRef.current) return false;
    if (gateRef.current.disabled) return false;
    if (gateRef.current.agentWorking) {
      // Only the toast's "Ask agent" button can reach this — both real buttons
      // are already disabled by the same gate. It outlives the click that
      // raised it, so a turn can begin in between; say so rather than swallow
      // the click, because the user has no disabled state to read here.
      toast.error("Agent is working", { description: AGENT_WORKING_REASON });
      return false;
    }
    busyRef.current = true;
    setBusy(true);
    return true;
  }, []);
  const release = useCallback(() => {
    busyRef.current = false;
    setBusy(false);
  }, []);

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
      if (!claim()) return;
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
        // Best-effort live counts; degrade to a still-valid brief on failure.
        let uncommittedCount = 0;
        let hasUpstream = false;
        const [status, counts] = await Promise.allSettled([
          gitStatus(workspace.id),
          gitChangeCounts(workspace.id),
        ]);
        if (status.status === "fulfilled") {
          hasUpstream = Boolean(status.value.upstream);
        }
        if (counts.status === "fulfilled") {
          // The prompt describes the net HEAD-vs-worktree diff. Summing
          // porcelain buckets would count one `AD` path twice even though the
          // staged add and disk deletion cancel out completely.
          uncommittedCount = counts.value.uncommitted;
        }
        const text = buildPrInstructions({
          branch: workspace.branch,
          baseBranch: workspace.baseBranch,
          remote,
          uncommittedCount,
          hasUpstream,
          draft,
        });
        // Auto-sent treatment (2026-07-19): a tidy "Create a PR" bubble with
        // the button's own icon on the brown "sent by Zeros" surface — no
        // attachment pill; the agent still receives the full brief.
        sendToChat({
          text,
          displayText: prBubbleDisplayText(draft),
          autoAction: draft ? "create-draft-pr" : "create-pr",
        });
      } finally {
        release();
      }
    },
    [
      claim,
      release,
      showBlockToast,
      workspace.id,
      workspace.branch,
      workspace.baseBranch,
      remote,
      sendToChat,
    ],
  );

  const createDirect = useCallback(
    async (draft: boolean) => {
      if (!claim()) return;
      // Started here, not inside the orchestrator, so it overlaps the local
      // change-count read and the push instead of queueing in front of them —
      // the happy path pays nothing for it. Never rejects (ghRepoAccess
      // resolves "unknown" on any failure), so leaving it unawaited on the
      // success path cannot raise an unhandled rejection.
      const accessProbe = ghRepoAccess(workspace.id);
      try {
        await createPullRequestFromCommittedChanges(
          {
            changeCounts: async (workspaceId) =>
              gitChangeCounts(workspaceId),
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
        if (err instanceof UncommittedPullRequestError) {
          toast.error("Commit changes before creating this pull request", {
            description:
              "A pull request only includes committed work. Ask the agent to review, commit, and create it.",
            action: {
              label: "Ask agent",
              onClick: () => void askAgentToCreate(draft),
            },
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
        release();
      }
    },
    [
      claim,
      release,
      showBlockToast,
      workspace.id,
      workspace.branch,
      workspace.baseBranch,
      workspace.repoSlug,
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
              : "Create PR"
        }
      >
        {/* span keeps the tooltip live over a disabled button (disabled
            elements receive no pointer events, so the wrapper triggers). */}
        <span className="inline-flex">
          <button
            type="button"
            className={MAIN_BTN_CLS}
            disabled={inert}
            onClick={() => void createDirect(false)}
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
          <DropdownMenuItem
            onSelect={() => void createDirect(true)}
          >
            <GitPullRequestDraft className={cn("text-fg2 size-3.5")} />
            <span>Create draft PR</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void askAgentToCreate(false)}>
            <MessageSquareText className="text-fg2 size-3.5" />
            <span>Ask agent to create PR</span>
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
