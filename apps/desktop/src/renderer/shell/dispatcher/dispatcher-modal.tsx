// ──────────────────────────────────────────────────────────
// DispatcherPage — one entry point to create a workspace + dispatch
// ──────────────────────────────────────────────────────────
//
// The global "+" destination opens this inside the Home shell. It unifies the
// new-workspace / open-project / clone flows behind one surface:
//
//   ┌ project pill ▾ · + folder menu ···· Create from… ▾ ┐  (top bar)
//   │  What do you want to work on?                       │  (composer)
//   │  model · fast · effort · plan          📎  Create ↵ │  (toolbar)
//   └────────────────────────────────────────────────────┘
//
// "Create" creates a git worktree in the selected project (optionally off a
// chosen PR/branch base) and lands a fresh chat bound to the picked agent +
// model. With a typed prompt it seeds that chat's composer and one-shot
// auto-sends the first turn (REQUEST_AUTO_SEND → AgentChat). Empty composer →
// just the workspace + a ready chat (the user's "create with the agent chat
// model" rule).
// ──────────────────────────────────────────────────────────

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  FolderPlus,
  PenTool,
  Sparkles,
} from "lucide-react";

import { GithubIcon } from "../../shared/ui";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { toast } from "../../shared/ui/primitives/elements";

import {
  useProjects,
  notifyWorkspacesChanged,
  peekWorkspacesFor,
  reloadWorkspacesFor,
  watchTimedOutWorkspaceCreate,
} from "../../state/use-projects";
import {
  beginPendingCreate,
  clearWorkspaceSettling,
  finishPendingCreate,
  markWorkspaceSettling,
} from "../../state/pending-workspaces";
import type { Project } from "../../state/projects-store";
import { findProjectForFolder } from "../../state/workspace-resolution";
import {
  useWorkspaceDispatch,
  useChats,
  useActiveChatId,
} from "../../state/store";
import type { ChatThread } from "../../state/store";
import { newChatId } from "../../state/chat-id";
import {
  loadAgents,
  useAgentsSnapshot,
} from "../../features/agent/agents-cache";
import { useBridgeStatus } from "../../platform/bridge/use-bridge";
import { dbDeleteChat } from "../../features/agent/agent-history-client";
import { useAgentSessions } from "../../features/agent/sessions-hooks";
import {
  workspaceCreate,
  workspacePrepareCreate,
  isGitErrorShape,
  isWorkspaceOpStillRunning,
} from "../../platform/git";
import {
  DispatcherComposer,
  type DispatcherCreatePayload,
} from "./dispatcher-composer";
import { CreateFromSource, type DispatcherBase } from "./create-from-source";
import {
  getActiveOrganizationIdSnapshot,
  getActiveOrganizationSnapshot,
} from "../../features/team/team-store";
import { localWorkspaceOwner } from "../../features/team/organization-capabilities";
import { useNativeRuntime } from "../../platform/runtime";
import { createWorkspaceForProject } from "../create-workspace";

interface DispatcherPageProps {
  /** Retained Home surfaces stay mounted. Gate effects and selection resets to
   * the visible Create route so hidden pages remain inert. */
  active: boolean;
  /** Repository context supplied by the global top bar, when available. */
  initialProjectId?: string | null;
  /** Shared add-project flows (from AddProjectProvider) for the + folder menu. */
  onOpenProject: () => void;
  onOpenGithubProject: () => void;
  onQuickStart: () => void;
}

/** Resolve the project to pre-select: the one the active chat lives in (so
 *  "+ Create" while working in repo X targets X), else the first project. */
function resolveInitialProjectId(
  projects: Project[],
  chats: ChatThread[],
  activeChatId: string | null,
): string | null {
  if (activeChatId) {
    const folder = chats.find((c) => c.id === activeChatId)?.folder;
    if (folder) {
      const owner = findProjectForFolder(folder, projects);
      if (owner) return owner.id;
    }
  }
  return projects[0]?.id ?? null;
}

export function DispatcherPage({
  active,
  initialProjectId,
  onOpenProject,
  onOpenGithubProject,
  onQuickStart,
}: DispatcherPageProps) {
  const { projects } = useProjects();
  const agents = useAgentsSnapshot();
  const sessions = useAgentSessions();
  const dispatch = useWorkspaceDispatch();
  const chats = useChats();
  const activeChatId = useActiveChatId();
  const nativeRuntime = useNativeRuntime();
  const designWorkspaceCreationAvailable =
    nativeRuntime.ready || nativeRuntime.expectedElectron;

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [base, setBase] = useState<DispatcherBase | null>(null);
  const [busy, setBusy] = useState(false);
  const [designBusy, setDesignBusy] = useState(false);
  const wasActiveRef = useRef(false);
  const lastInitialProjectIdRef = useRef<string | null | undefined>(undefined);

  // The base is repo-scoped — clear it whenever the target project changes so a
  // branch from project A never leaks into a create on project B.
  useEffect(() => {
    setBase(null);
  }, [selectedProjectId]);

  // Warm the agent registry each time the page becomes active (route through
  // loadAgents — a raw sessions.listAgents() round-trips the engine but never
  // fills the agents-cache snapshot this page renders from, so on a cold
  // cache the model pill would sit in "loading" forever). Gated on a
  // connected bridge like settings-page; the status flip re-runs it.
  const bridgeStatus = useBridgeStatus();
  useEffect(() => {
    if (!active || bridgeStatus !== "connected") return;
    void loadAgents((force) => sessions.listAgents(force)).catch(() => {});
    // `sessions` identity churns with provider state; the ref-free read here
    // is safe because the effect only fires on open/connect edges.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, bridgeStatus]);

  // Pick the requested repository before paint whenever Create becomes active
  // or the top-bar retargets the already-open page. A removed project falls
  // through to the retained valid choice, active-chat owner, then first repo.
  useLayoutEffect(() => {
    const honorRouteTarget =
      active &&
      (!wasActiveRef.current ||
        lastInitialProjectIdRef.current !== initialProjectId);
    wasActiveRef.current = active;
    lastInitialProjectIdRef.current = initialProjectId;
    if (!active) return;
    setSelectedProjectId((prev) =>
      honorRouteTarget &&
      initialProjectId &&
      projects.some((p) => p.id === initialProjectId)
        ? initialProjectId
        : prev && projects.some((p) => p.id === prev)
          ? prev
          : resolveInitialProjectId(projects, chats, activeChatId),
    );
  }, [active, activeChatId, chats, initialProjectId, projects]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const handleCreateDesign = async () => {
    const project = selectedProject;
    if (!project || designBusy || !designWorkspaceCreationAvailable) return;
    setDesignBusy(true);
    try {
      await createWorkspaceForProject({
        project,
        dispatch,
        kind: "design",
      });
    } finally {
      setDesignBusy(false);
    }
  };

  const handleCreate = async (payload: DispatcherCreatePayload) => {
    const project = selectedProject;
    if (!project || busy) return;
    // Organization selection is part of the create intent. Snapshot it before
    // any asynchronous reservation so a switch during prepare cannot retarget
    // the new workspace.
    const owner = localWorkspaceOwner(
      getActiveOrganizationSnapshot(),
      getActiveOrganizationIdSnapshot(),
    );
    // Optimistic create, three beats:
    //   1. prepareCreate reserves identity + final path without touching disk.
    //   2. Navigate NOW: add the chat bound to the announced
    //      path, mark it settling — Workbench shows its "Setting up
    //      workspace" rows, and the chat view defers the agent spawn until
    //      the exact create lifecycle publishes.
    //   3. The heavy workspace.create runs in the background against the
    //      reserved identity; on resolve the workspace list refetch reveals
    //      everything, on failure the optimistic chat is rolled back.
    // `busy` only guards a double-submit in the same frame — it is cleared
    // synchronously after navigation, never held across the awaits.
    setBusy(true);
    const baseBranch = base?.branch;
    let prepared: Awaited<ReturnType<typeof workspacePrepareCreate>>;
    try {
      prepared = await workspacePrepareCreate({
        repoRoot: project.repoRoot,
        repoSlug: project.repoSlug,
        ...(payload.serialized
          ? { prompt: payload.serialized.displayText }
          : {}),
      });
    } catch (err: unknown) {
      setBusy(false);
      if (isGitErrorShape(err)) {
        toast.error(`Couldn't create workspace: ${err.message}`, {
          description: err.remediation ?? err.causeMessage ?? undefined,
        });
      } else {
        toast.error(
          `Couldn't create workspace: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    const pendingToken = beginPendingCreate({
      repoRoot: project.repoRoot,
      repoSlug: project.repoSlug,
      ...owner,
      path: prepared.path,
      branch: prepared.branch,
    });
    // Workbench shows its loading rows from the very first frame; the flag
    // clears once the workspace row lands AND its surface data is in.
    markWorkspaceSettling(prepared.path);
    setBusy(false);

    const chatId = newChatId();
    const chat: ChatThread = {
      id: chatId,
      folder: prepared.path,
      agentId: payload.selection.agentId,
      agentName: payload.selection.agentName,
      model: payload.selection.model,
      effort: payload.effort,
      permissionMode: payload.permissionMode,
      // Carry the EXACT native mode the user picked so bind restores it
      // losslessly (e.g. Claude "Accept Edits" doesn't collapse to "Auto").
      ...(payload.lastModeId ? { lastModeId: payload.lastModeId } : {}),
      ...(payload.fast ? { fast: true } : {}),
      ...(payload.additionalDirectories.length > 0
        ? { additionalDirectories: payload.additionalDirectories }
        : {}),
      title: "Untitled",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // Seed the composer draft BEFORE ADD_CHAT so the AgentChat that mounts
    // for this chat reads it on first render, then mark it for one-shot
    // auto-send — the send waits until the session is ready, and the session
    // itself waits for settling to clear, so the agent never starts before
    // checkout. ADD_CHAT activates the chat (sets activeChatId),
    // switching Conversation pane to the new workspace THIS frame.
    if (payload.serialized) {
      dispatch({
        type: "SET_CHAT_DRAFT",
        chatId,
        draft: {
          text: payload.serialized.displayText,
          attachments: payload.serialized.attachments,
          json: payload.serialized.json,
        },
      });
    }
    dispatch({
      type: "ADD_CHAT",
      chat,
      recordWorkspaceActivity: true,
      openWorkspace: {
        repoRoot: project.repoRoot,
        validationPending: true,
      },
    });
    if (payload.serialized) {
      dispatch({ type: "REQUEST_AUTO_SEND", chatId });
    }

    const rollbackOptimisticChat = () => {
      clearWorkspaceSettling(prepared.path);
      dispatch({ type: "CONSUME_AUTO_SEND", chatId });
      dispatch({ type: "DELETE_CHAT", id: chatId });
      // ChatsPersistence intentionally does not infer deletes when the live
      // list becomes empty. Tombstone this exact optimistic row explicitly so
      // an only-chat failed create cannot return after restart. Engine-side
      // lifecycle recovery carries the same id as a crash-safe backstop.
      void dbDeleteChat(chatId).catch(() => {});
      finishPendingCreate(pendingToken);
    };
    const settleArchivedOptimisticChat = () => {
      // Archive preserves chat metadata/transcript/draft for restore. Cancel
      // only the first-send intent because its cwd intentionally went away.
      clearWorkspaceSettling(prepared.path);
      dispatch({ type: "CONSUME_AUTO_SEND", chatId });
      finishPendingCreate(pendingToken);
    };

    try {
      await workspaceCreate({
        repoRoot: project.repoRoot,
        repoSlug: project.repoSlug,
        ...owner,
        agentId: payload.selection.agentId,
        preparedId: prepared.workspaceId,
        preparedBranch: prepared.branch,
        optimisticChatId: chatId,
        // "Create from…" forks the new worktree off the chosen PR/branch;
        // no selection ⇒ the engine resolves the repo's default branch.
        ...(baseBranch ? { baseBranch } : {}),
        ...(payload.serialized
          ? { prompt: payload.serialized.displayText }
          : {}),
      });
      notifyWorkspacesChanged(project.repoSlug);
      // Await an authoritative refresh so the real row is in the single source
      // BEFORE the pending placeholder drops — no momentary no-tab flash on the
      // top bar / repo hub / sidebar count. A momentary disconnect retains the
      // placeholder until exact lifecycle/row observation can ingest the key.
      if (
        (await reloadWorkspacesFor(project.repoSlug)) &&
        peekWorkspacesFor(project.repoSlug)?.some(
          (workspace) => workspace.id === prepared.workspaceId,
        )
      ) {
        finishPendingCreate(pendingToken);
      } else {
        watchTimedOutWorkspaceCreate({
          repoSlug: project.repoSlug,
          workspaceId: prepared.workspaceId,
          onReady: () => finishPendingCreate(pendingToken),
          onUnavailable: (reason) => {
            if (reason === "archived") {
              settleArchivedOptimisticChat();
              return;
            }
            rollbackOptimisticChat();
            toast.error("Workspace became unavailable after creation", {
              description:
                reason === "interrupted"
                  ? "Creation stopped in a recoverable phase. Restart Zeros to finish recovery."
                  : "The workspace was removed before its list row could be loaded.",
            });
          },
        });
      }
    } catch (err: unknown) {
      if (isWorkspaceOpStillRunning(err)) {
        // The engine got the request and keeps working past the client budget.
        // Keep the optimistic chat + settling state — the reveal fires when
        // the row lands. Nudge the list refetch since the DB_CHANGED broadcast
        // alone doesn't drive the sidebar refetch.
        toast.info("Workspace creation is taking longer than usual", {
          description: "It's still being created in the background.",
        });
        watchTimedOutWorkspaceCreate({
          repoSlug: project.repoSlug,
          workspaceId: prepared.workspaceId,
          onReady: () => finishPendingCreate(pendingToken),
          onUnavailable: (reason) => {
            if (reason === "archived") {
              settleArchivedOptimisticChat();
              return;
            }
            rollbackOptimisticChat();
            toast.error("Couldn't finish creating workspace", {
              description:
                reason === "interrupted"
                  ? "Creation stopped in a recoverable phase. Restart Zeros to finish recovery, then try again."
                  : "The engine rolled the incomplete checkout back safely. Create it again to retry.",
            });
          },
        });
      } else {
        // Hard failure: roll the optimistic surface back — drop the never-used
        // chat (the engine abandoned the announced path), clear the
        // loading state, and cancel any queued auto-send.
        rollbackOptimisticChat();
        if (isGitErrorShape(err)) {
          toast.error(`Couldn't create workspace: ${err.message}`, {
            description: err.remediation ?? err.causeMessage ?? undefined,
          });
        } else {
          toast.error(
            `Couldn't create workspace: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  };

  return (
    <main
      className="bg-bg1 flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto p-8"
      aria-labelledby="create-workspace-title"
      aria-describedby="create-workspace-description"
    >
      <section className="border-border1 bg-bg2 w-full max-w-[640px] overflow-visible rounded-lg border shadow-[var(--shadow-xl)]">
        <h1 id="create-workspace-title" className="sr-only">
          Create a workspace
        </h1>
        <p id="create-workspace-description" className="sr-only">
          Pick a repository and describe a task, or create a design workspace.
        </p>

        {/* Top bar — project pill · + folder menu · Create from…. One
            continuous surface with the composer below: same card background,
            no separator line. */}
        <div className="flex items-center gap-1.5 px-4 pt-3 pb-1">
          {/* Project selector */}
          <DropdownMenu>
            <Tooltip label="Choose project">
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="text-fg1 hover:bg-bg2-hover inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm font-medium transition-colors"
                >
                  <span className="bg-bg2-hover inline-flex size-4 items-center justify-center rounded-sm text-xs">
                    {(selectedProject?.name[0] ?? "·").toUpperCase()}
                  </span>
                  <span className="max-w-[180px] truncate">
                    {selectedProject?.name ?? "Select a project"}
                  </span>
                  <ChevronDown size={12} className="text-fg2 opacity-70" />
                </button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent
              align="start"
              sideOffset={4}
              className="min-w-[220px]"
            >
              {projects.length === 0 && (
                <DropdownMenuItem disabled>No projects yet</DropdownMenuItem>
              )}
              {projects.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  data-selected={p.id === selectedProjectId || undefined}
                  onSelect={() => setSelectedProjectId(p.id)}
                >
                  <span className="bg-bg2-hover inline-flex size-4 items-center justify-center rounded-sm text-xs">
                    {(p.name[0] ?? "·").toUpperCase()}
                  </span>
                  <span className="truncate">{p.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Add a project (open / clone / quick start) */}
          <DropdownMenu>
            <Tooltip label="Add a project">
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="text-fg2 hover:bg-bg2-hover hover:text-fg1 inline-flex size-7 items-center justify-center rounded-sm transition-colors"
                  aria-label="Add a project"
                >
                  <FolderPlus size={15} strokeWidth={1.5} />
                </button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent
              align="start"
              sideOffset={4}
              className="min-w-[200px]"
            >
              <DropdownMenuItem onSelect={() => onOpenProject()}>
                <FolderOpen className="text-fg2" strokeWidth={1.5} />
                <span>Open project</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onOpenGithubProject()}>
                <GithubIcon className="text-fg2" strokeWidth={1.5} />
                <span>Open GitHub project</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onQuickStart()}>
                <Sparkles className="text-fg2" strokeWidth={1.5} />
                <span>Quick start</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex-1" />

          {/* Design workspaces do not have an agent prompt. Preserve their
              Internal-only direct-create route on the full-page surface that
              replaced the old per-repository trailing plus. */}
          {designWorkspaceCreationAvailable && (
            <Tooltip label="Create design workspace">
              <button
                type="button"
                className="text-fg2 hover:bg-bg2-hover hover:text-fg1 inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50"
                aria-label="Create design workspace"
                disabled={!selectedProject || busy || designBusy}
                onClick={() => void handleCreateDesign()}
              >
                <PenTool size={14} strokeWidth={1.5} />
                <span>Design</span>
              </button>
            </Tooltip>
          )}

          {/* Create from… — pick a PR/branch base (right-aligned, matching
              the shared design). Cloud toggle is intentionally omitted. */}
          <CreateFromSource
            project={selectedProject}
            value={base}
            onChange={setBase}
          />
        </div>

        {/* Composer — flush, full-width (no card, no outer padding); its own
            px-4 inset aligns the text + pills with the top row. */}
        <DispatcherComposer
          agents={agents}
          cwd={selectedProject?.repoRoot ?? null}
          originUrl={selectedProject?.originUrl ?? null}
          onCreate={handleCreate}
          busy={busy || designBusy}
        />
      </section>
    </main>
  );
}
