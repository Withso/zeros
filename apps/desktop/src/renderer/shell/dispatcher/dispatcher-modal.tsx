// ──────────────────────────────────────────────────────────
// DispatcherPage — one entry point to create a workspace + dispatch
// ──────────────────────────────────────────────────────────
//
// The global "+" destination opens this inside the Home shell. It unifies the
// new-workspace / open-project / clone flows behind one surface:
//
//     project ▾ · source ▾                    ┌ ‹/› ✎ ┐  (context + mode)
//   ┌──────────────────────────────────────────────────┐
//   │  What do you want to work on?                     │     (composer)
//   │  model · fast · effort · plan        📎  Create ↵ │     (toolbar)
//   └──────────────────────────────────────────────────┘
//
// The Code/Design toggle shares the project/source row above the card (the same
// control every workspace's chat strip carries) and picks the new workspace mode:
//
//   Code   → creates a worktree in the selected project
//            (optionally off a chosen PR/branch base) and lands a fresh chat
//            bound to the picked agent + model. With a typed prompt it seeds
//            that chat's composer and one-shot auto-sends the first turn
//            (REQUEST_AUTO_SEND → AgentChat). Empty composer → just the
//            workspace + a ready chat (the user's "create with the agent chat
//            model" rule).
//   Design → the composer yields to a summary of what Design entry will do to
//            this repository — open its design folder, or CREATE one named
//            "<repo> - Design" on first use (engine design/directory.ts) —
//            and "Create" runs the shared direct-create flow with
//            kind: "design" (no agent prompt; Design has none).
//
// The toggle appears only where the Design surface can run (native desktop),
// so a web/remote shell keeps exactly the Code-only page it had.
// ──────────────────────────────────────────────────────────

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FolderOpen, Plus } from "lucide-react";

import { Button, GithubIcon } from "../../shared/ui";
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
import { createDispatcherChat } from "./dispatcher-chat";
import { prepareProjectFolder } from "../project-folder-setup";
import type { AddProjectOptions } from "../add-project-provider";
import {
  loadAgents,
  useAgentsSnapshot,
} from "../../features/agent/agents-cache";
import { useBridgeStatus } from "../../platform/bridge/use-bridge";
import { dbDeleteChat } from "../../features/agent/agent-history-client";
import { discardQueuedContextGraphWrites } from "../../features/agent/composer-editor/context-graph-staging";
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
import {
  CreateFromSource,
  warmCreateSourceProject,
} from "./create-from-source";
import {
  sourceForProject,
  type DispatcherSourceSelection,
} from "./dispatcher-source";
import {
  getActiveOrganizationIdSnapshot,
  getActiveOrganizationSnapshot,
} from "../../features/team/team-store";
import { localWorkspaceOwner } from "../../features/team/organization-capabilities";
import { useNativeRuntime } from "../../platform/runtime";
import { createWorkspaceForProject } from "../create-workspace";
import { RepositoryIcon } from "../../features/repositories/repository-icon";
import {
  WorkspaceModeToggleView,
  type WorkspaceMode,
} from "../../shared/ui/workspace-mode-header";
import {
  designDirectoryTargetKeyForRepo,
  useDesignDirectoryTarget,
} from "../../state/design-directory-target";

interface DispatcherPageProps {
  /** Retained Home surfaces stay mounted. Gate effects and selection resets to
   * the visible Create route so hidden pages remain inert. */
  active: boolean;
  /** Repository context supplied by the global top bar, when available. */
  initialProjectId?: string | null;
  /** Shared add-project flows (from AddProjectProvider) inside the project picker. */
  onOpenProject: (options?: AddProjectOptions) => void;
  onOpenGithubProject: (options?: AddProjectOptions) => void;
  onQuickStart: (options?: AddProjectOptions) => void;
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
  const selectAddedProject = (project: Project) =>
    setSelectedProjectId(project.id);
  const [sourceSelection, setSourceSelection] =
    useState<DispatcherSourceSelection | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [designBusy, setDesignBusy] = useState(false);
  // Which mode the NEXT workspace opens in. Renderer-local intent, kept across
  // project switches (a designer creating several design workspaces should not
  // re-pick Design each time); it collapses to Code wherever Design cannot run.
  const [requestedMode, setRequestedMode] = useState<WorkspaceMode>("code");
  const wasActiveRef = useRef(false);
  const lastInitialProjectIdRef = useRef<string | null | undefined>(undefined);

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

  const needsGitSetup = selectedProject?.isGitRepository === false;
  const base = needsGitSetup
    ? null
    : sourceForProject(sourceSelection, selectedProject);
  const canCreateDesign = designWorkspaceCreationAvailable;
  const mode: WorkspaceMode = canCreateDesign ? requestedMode : "code";

  useEffect(() => {
    if (!active) setProjectMenuOpen(false);
  }, [active]);

  // What Design entry would do to the selected repository's main checkout
  // (open its design folder, or create "<repo> - Design"). Warmed while the
  // page is active so flipping the toggle answers from the cache; a hidden
  // Create page reads nothing.
  const designTarget = useDesignDirectoryTarget(
    active && canCreateDesign && selectedProject
      ? designDirectoryTargetKeyForRepo(selectedProject.repoRoot)
      : null,
  );

  const handleCreateDesign = async () => {
    const project = selectedProject;
    if (!active || !project || busy || designBusy || !canCreateDesign) {
      return;
    }
    setDesignBusy(true);
    try {
      await createWorkspaceForProject({
        project,
        dispatch,
        kind: "design",
        // "Create from…" applies to both modes: a design workspace forked off
        // a PR reviews that PR's design folder.
        ...(base?.branch ? { baseBranch: base.branch } : {}),
      });
    } finally {
      setDesignBusy(false);
    }
  };

  const handleCreate = async (payload: DispatcherCreatePayload) => {
    const project = selectedProject;
    if (!active || !project || busy || designBusy) return;
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
      if (nativeRuntime.ready || nativeRuntime.expectedElectron) {
        await prepareProjectFolder(project.repoRoot);
      }
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

    const chatId = createDispatcherChat({
      dispatch,
      repoRoot: project.repoRoot,
      folder: prepared.path,
      payload,
      validationPending: true,
    });

    const rollbackOptimisticChat = () => {
      discardQueuedContextGraphWrites(prepared.path);
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
      discardQueuedContextGraphWrites(prepared.path);
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
      <div className="flex w-full max-w-[640px] flex-col gap-2">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 id="create-workspace-title" className="sr-only">
            Create a workspace
          </h1>
          <p id="create-workspace-description" className="sr-only">
            Pick a repository and describe a task, or create a design workspace.
          </p>

          {/* Keep project, source and mode together above the prompt. Labels
              truncate in narrow windows while the mode toggle stays visible. */}
          <div
            data-dispatcher-context=""
            className="flex min-w-0 items-center gap-1 px-1"
          >
            {/* Project selector */}
            <DropdownMenu
              open={active && projectMenuOpen}
              onOpenChange={setProjectMenuOpen}
            >
              <Tooltip label="Choose project">
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label="Choose project"
                    disabled={busy || designBusy}
                    className="text-fg2 h-7 min-w-0 gap-1.5 px-2 text-sm font-normal hover:bg-transparent"
                  >
                    <span className="max-w-[180px] truncate">
                      {selectedProject?.name ?? "Add project"}
                    </span>
                    <ChevronDown size={12} className="text-fg2 opacity-70" />
                  </Button>
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
                    onPointerEnter={() => warmCreateSourceProject(p)}
                    onFocus={() => warmCreateSourceProject(p)}
                    onSelect={() => setSelectedProjectId(p.id)}
                  >
                    <span className="bg-bg2-hover inline-flex size-3.5 items-center justify-center rounded-sm text-xs">
                      <RepositoryIcon
                        project={p}
                        className="size-full rounded-sm"
                      />
                    </span>
                    <span className="truncate">{p.name}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => onOpenProject({ onSelect: selectAddedProject })}
                >
                  <FolderOpen className="text-fg2" strokeWidth={1.5} />
                  <span>Open project</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    onOpenGithubProject({ onSelect: selectAddedProject })
                  }
                >
                  <GithubIcon className="text-fg2" strokeWidth={1.5} />
                  <span>Open GitHub project</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => onQuickStart({ onSelect: selectAddedProject })}
                >
                  <Plus className="text-fg2" strokeWidth={1.5} />
                  <span>Start from scratch</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Source selection is metadata until Create is pressed. */}
            {!needsGitSetup && (
              <CreateFromSource
                key={JSON.stringify([
                  selectedProject?.id,
                  selectedProject?.repoRoot,
                  selectedProject?.originUrl,
                ])}
                project={selectedProject}
                value={base}
                active={active}
                disabled={busy || designBusy}
                onChange={(next) =>
                  setSourceSelection(
                    next && selectedProject
                      ? { owner: selectedProject, base: next }
                      : null,
                  )
                }
              />
            )}

            {canCreateDesign && (
              <div
                data-dispatcher-mode-switcher=""
                className="ml-auto flex shrink-0"
              >
                <WorkspaceModeToggleView
                  mode={mode}
                  disabled={busy || designBusy}
                  switching={false}
                  onModeChange={setRequestedMode}
                />
              </div>
            )}
          </div>

          <section aria-label="Workspace prompt">
            <DispatcherComposer
              agents={agents}
              cwd={selectedProject?.repoRoot ?? null}
              originUrl={selectedProject?.originUrl ?? null}
              onCreate={handleCreate}
              busy={busy || designBusy || !selectedProject}
              mode={mode}
              design={{
                projectName: selectedProject?.name ?? null,
                target: designTarget.data,
                loading: designTarget.loading,
                onCreate: () => void handleCreateDesign(),
              }}
            />
          </section>
        </div>
      </div>
    </main>
  );
}
