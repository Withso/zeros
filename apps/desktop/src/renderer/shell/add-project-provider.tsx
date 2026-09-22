// ──────────────────────────────────────────────────────────
// AddProjectProvider — shared "add a project" actions + dialogs
// ──────────────────────────────────────────────────────────
//
// The three ways to add a project (Open project / Open GitHub project /
// Quick start) plus their modals used to live entirely inside Repository panel.
// They now sit here so BOTH surfaces that offer them — the global Dispatcher
// and the full-window no-projects welcome screen
// (NoProjectsView) — drive the exact same flows through one source of
// truth, with the dialogs mounted once.
//
// Mounted around MainShellBody and Settings. All the hooks it needs are stores or
// providers that live above the main shell, so it can sit at that level.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { spawnDefaultChatForWorkspace } from "../state/spawn-default-chat";
import {
  createWorkspaceForProject,
  repoNeedsFirstWorkspace,
} from "./create-workspace";
import { leftmostLiveWorkspace } from "./workspace-tabs";
import { useWorkspaceDispatch } from "../state/store";
import { useOpenWorkspace } from "../state/use-open-workspace";
import { useAgentSessions } from "../features/agent/sessions-hooks";
import {
  deriveProjectName,
  loadProjects,
  normalizeProjectRoot,
  upsertProject,
  type Project,
} from "../state/projects-store";
import {
  notifyProjectsChanged,
  peekWorkspacesFor,
  useProjects,
} from "../state/use-projects";
import {
  workspaceInspectFolder,
  type InspectFolderResult,
} from "../platform/git";
import {
  onMenuOpenProject,
  onProjectChanged,
  onProjectOpenFailed,
  onProjectOpening,
  pickProjectFolder,
} from "../platform/app";
import { toast } from "../shared/ui/primitives/elements";
import { useNativeRuntime } from "../platform/runtime";
import { QuickStartDialog } from "./dialogs/quick-start";
import { OpenGithubProjectDialog } from "./dialogs/open-github-project";
import { AddLocalProjectDialog } from "./dialogs/add-local-project";
import { PublishToGithubDialog } from "./dialogs/publish-to-github";
import { prepareProjectFolder } from "./project-folder-setup";
import { InitializeProjectDialog } from "./dialogs/initialize-project";

/** A folder the user has just picked that hasn't finished registering yet.
 *  Drives the minimal shimmer state in the global top bar. */
export interface PendingProject {
  /** Absolute path of the picked folder. */
  root: string;
  /** Display name (leaf folder name) shown next to the shimmer. */
  name: string;
}

interface AddProjectActions {
  /** Open the native folder picker and register the chosen folder as a project.
   *  A foreign linked-worktree is routed through the Add-local-project
   *  confirmation first. */
  openProject: () => void;
  /** Open the "Open GitHub project" clone dialog. */
  openGithubProject: () => void;
  /** Open the "Start from scratch" new-repo dialog. */
  quickStart: () => void;
  /** Open the new-workspace dispatcher — the unified "+ Create" launcher
   *  (pick a project, type a task, pick the agent/model, Create). */
  openDispatcher: (initialProjectId?: string) => void;
  /** Open the "Publish to GitHub" dialog for a LOCAL project — create a private
   *  repo, add origin, push. `defaultName` prefills the repo name (the project's
   *  leaf folder name). Desktop-only. */
  publishToGithub: (repoRoot: string, defaultName?: string) => void;
  /** Set while a picked folder is mid-open (engine respawning) and the real
   *  project row hasn't landed yet. Null at rest. The top bar renders a shimmer
   *  state for it; it clears the moment the registered project appears. */
  pendingProject: PendingProject | null;
  /** Repo root of a project whose engine is mid-respawn. Null at rest. The top
   *  bar swaps that project's chip for the branded Z shimmer.
   *
   *  The normal "Open project" flow no longer respawns (it registers the repo
   *  and the running engine serves it), so this stays null there — the brief
   *  `pendingProject` placeholder row carries that case. `openingRoot` covers
   *  the residual respawn paths that still fire `project-opening` (a deep-link,
   *  or the legacy re-root command) where the repo may ALREADY be registered:
   *  there no placeholder row renders, so the per-row logo shimmer is the only
   *  cue. Cleared on the engine-up signal (`project-changed`) or a safety
   *  timeout. Native-only (web has no respawn). */
  openingRoot: string | null;
}

const AddProjectContext = createContext<AddProjectActions | null>(null);

/** Trigger the shared add-project flows. Must be called inside
 *  <AddProjectProvider>. */
export function useAddProject(): AddProjectActions {
  const ctx = useContext(AddProjectContext);
  if (!ctx) {
    throw new Error("useAddProject must be used within <AddProjectProvider>");
  }
  return ctx;
}

export function AddProjectProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const dispatch = useWorkspaceDispatch();
  const sessions = useAgentSessions();
  const openWorkspace = useOpenWorkspace();
  const { projects, refresh: refreshProjects } = useProjects();
  const nativeRuntime = useNativeRuntime();

  // Picked-but-not-yet-registered project. Set the instant a folder is chosen
  // and cleared once the real project row lands — the top bar paints a minimal
  // shimmer row meanwhile so the open never feels stuck during engine work.
  const [pendingProject, setPendingProject] = useState<PendingProject | null>(
    null,
  );

  // Repo root whose engine is mid-respawn after an open. Drives the branded
  // Z-shimmer that replaces the project row's logo. Unlike pendingProject this
  // survives the row landing in the list, so a re-opened (already-registered)
  // repo still shows the cue for the full respawn. Cleared on `project-changed`
  // (engine up) or the safety timeout below.
  const [openingRoot, setOpeningRoot] = useState<string | null>(null);

  // Quick Start + Open GitHub project dialogs — simple boolean open
  // state since they have no per-row state.
  const [quickStartOpen, setQuickStartOpen] = useState(false);
  const [openGithubOpen, setOpenGithubOpen] = useState(false);
  // Add local project dialog — populated when pickProjectFolder picks a
  // linked-worktree (foreign tool's branch). Stays null when the
  // picked folder is a fresh repo / primary checkout.
  const [adoptFolder, setAdoptFolder] = useState<
    (InspectFolderResult & { path: string }) | null
  >(null);
  const [initializeFolder, setInitializeFolder] = useState<string | null>(null);
  const pendingOpens = useRef(new Set<string>());
  // Publish-to-GitHub dialog target — the local project root (+ name prefill)
  // being published. Null when closed.
  const [publishTarget, setPublishTarget] = useState<{
    repoRoot: string;
    name?: string;
  } | null>(null);

  // Paint the shimmer the instant the user picks a folder — the native
  // `project-opening` event fires BEFORE the (multi-second) engine respawn, so
  // the top bar reflects the choice immediately instead of waiting on the IPC.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void onProjectOpening(({ root }) => {
      setPendingProject({ root, name: deriveProjectName(root) });
      // Also arm the per-row shimmer so an already-registered repo (recent
      // re-open, where the placeholder row is deduped away) still shows it.
      setOpeningRoot(root);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  /** In-app folder opens ask before initializing Git, then land in a managed
   * worktree. Reopening reuses a live workspace. Deep links only register a
   * project: external URLs must not initialize Git or create worktrees. */
  const openFirstWorkspace = useCallback(
    async (
      root: string,
      opts: {
        inspect?: InspectFolderResult;
        autoCreate?: boolean;
        initializeConfirmed?: boolean;
      } = {},
    ) => {
      const repoRoot = normalizeProjectRoot(root);
      if (pendingOpens.current.has(repoRoot)) return;
      pendingOpens.current.add(repoRoot);
      const { autoCreate = true } = opts;
      const land = (project: Project) => {
        const existing = leftmostLiveWorkspace(
          peekWorkspacesFor(project.repoSlug),
        );
        if (existing) openWorkspace(existing);
        else
          dispatch({
            type: "OPEN_REPO_PAGE",
            projectId: project.id,
            view: "workspaces",
          });
      };
      try {
        const current =
          opts.inspect ?? (await workspaceInspectFolder(repoRoot));
        if (autoCreate && !current.isRepo && !opts.initializeConfirmed) {
          setInitializeFolder(repoRoot);
          return;
        }
        const inspect = autoCreate
          ? await prepareProjectFolder(repoRoot, current)
          : current;
        const project = upsertProject({
          repoRoot,
          originUrl: inspect.originUrl ?? undefined,
          isGitRepository: inspect.isRepo,
        });
        notifyProjectsChanged();
        if (autoCreate && (await repoNeedsFirstWorkspace(project.repoSlug))) {
          if (
            await createWorkspaceForProject({
              project,
              dispatch,
              gitSetupComplete: true,
            })
          )
            return;
        }
        land(project);
      } catch (error) {
        toast.error("Couldn't open that project", {
          description: error instanceof Error ? error.message : String(error),
          action: {
            label: "Retry",
            onClick: () =>
              void openFirstWorkspaceRef.current(repoRoot, {
                autoCreate,
                initializeConfirmed: opts.initializeConfirmed,
              }),
          },
        });
      } finally {
        pendingOpens.current.delete(repoRoot);
        setPendingProject((current) =>
          current?.root === repoRoot ? null : current,
        );
      }
    },
    [dispatch, openWorkspace],
  );

  // Clear the per-row opening shimmer the moment the engine reports it has
  // respawned and re-rooted (`project-changed` carries the new root). This is
  // the real "done loading" signal for the row — pendingProject clears earlier
  // (when its registered row lands), but openingRoot must wait for the engine
  // so an already-registered repo's cue lasts the whole respawn.
  //
  // A root arriving here UNREGISTERED means the engine re-rooted at a folder
  // the project list has never seen — in practice a `zeros://open?path=` deep
  // link, which re-rooted the engine but never called upsertProject, so the
  // repo ran invisibly with no sidebar row and no tab. Register it on the spot,
  // through the same add path everything else uses. The registered case (the
  // recent-projects re-open) is left exactly as it was: matching on the live
  // list, not a closure snapshot, is what keeps a re-open from being treated as
  // an add and yanking the user to a new workspace.
  const openFirstWorkspaceRef = useRef(openFirstWorkspace);
  openFirstWorkspaceRef.current = openFirstWorkspace;
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void onProjectChanged(({ root }) => {
      setOpeningRoot((prev) => (prev === root ? null : prev));
      const normalized = normalizeProjectRoot(root);
      const known = loadProjects().some((p) => p.repoRoot === normalized);
      // Register only — see the autoCreate note on openFirstWorkspace. A deep
      // link is the one add trigger a web page can pull, so it must not fork a
      // worktree unattended.
      if (!known) {
        void openFirstWorkspaceRef.current(root, { autoCreate: false });
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // A deep link that never resolved to a project used to die in a main-process
  // console.error — the renderer's only `deep-link` subscriber is the invite
  // handler, which drops non-invite URLs. Surface it.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void onProjectOpenFailed(({ root, reason }) => {
      toast.error("Couldn't open that project", {
        description: root ? `${root} — ${reason}` : reason,
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // Safety net: a respawn that errors (or a cancel) never fires project-changed,
  // so drop the cue after a window comfortably past a normal respawn. Belt-and-
  // suspenders — project-changed is the real signal.
  useEffect(() => {
    if (!openingRoot) return;
    const id = window.setTimeout(() => setOpeningRoot(null), 30_000);
    return () => window.clearTimeout(id);
  }, [openingRoot]);

  // Clear the shimmer the moment the registered project row exists — the real
  // row replaces it seamlessly (both render the same project-row shape).
  useEffect(() => {
    if (!pendingProject) return;
    if (projects.some((p) => p.repoRoot === pendingProject.root)) {
      setPendingProject(null);
    }
  }, [pendingProject, projects]);

  // Safety net so a ghost shimmer can never linger: if the registered row
  // hasn't landed within the window (a File-menu open that adds no project, a
  // wedged respawn, a cancel), drop it. A normal open resolves well under this
  // — the matched-clear above is the real signal; this is belt-and-suspenders.
  useEffect(() => {
    if (!pendingProject) return;
    const id = window.setTimeout(() => setPendingProject(null), 20_000);
    return () => window.clearTimeout(id);
  }, [pendingProject]);

  const openProject = useCallback(async () => {
    if (!nativeRuntime) {
      return;
    }
    try {
      // Pick the folder WITHOUT respawning the engine. Adding a repo no longer
      // kills + re-roots the engine (the 30s freeze) — the running engine serves
      // the new repo over the bridge the moment we upsert it. Returns the
      // absolute path, or null on cancel.
      const root = await pickProjectFolder();
      if (!root) return;
      // Inspect the picked folder before registration. If it is a linked
      // worktree
      // owned by another tool, surface the "Add local project"
      // confirmation dialog instead of silently registering. The dialog
      // then drives workspace_create_from_branch to adopt the branch.
      const inspect = await workspaceInspectFolder(root);
      if (inspect && inspect.isRepo && inspect.isWorktree) {
        // The adopt confirmation dialog takes over from here (its own flow
        // registers the project, whose root differs from this picked worktree).
        setAdoptFolder({ ...inspect, path: root });
        return;
      }
      // The shared flow asks before Git initialization and opens a worktree.
      setPendingProject({ root, name: deriveProjectName(root) });
      // Reuse the inspect from above rather than re-probing the same folder.
      void openFirstWorkspace(root, { inspect });
    } catch (err) {
      toast.error("Couldn't open that project", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [openFirstWorkspace, nativeRuntime]);

  // File → Open Folder / Cmd+Shift+O (native menu) routes here so it shares ONE
  // open-project path with the Dispatcher and the welcome screen. Subscribe
  // once and read the latest openProject through a ref — openProject's identity
  // changes with chats/sessions, and re-subscribing per change would churn the
  // IPC listener for no reason. Mounted app-wide (AddProjectProvider wraps both
  // routes) so the menu shortcut works from Settings too.
  const openProjectRef = useRef(openProject);
  openProjectRef.current = openProject;
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void onMenuOpenProject(() => {
      openProjectRef.current();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const openGithubProject = useCallback(() => {
    setOpenGithubOpen(true);
  }, []);

  const quickStart = useCallback(() => {
    setQuickStartOpen(true);
  }, []);

  const openDispatcher = useCallback(
    (initialProjectId?: string) => {
      dispatch({
        type: "OPEN_CREATE_PAGE",
        projectId: initialProjectId ?? null,
      });
    },
    [dispatch],
  );

  const publishToGithub = useCallback(
    (repoRoot: string, defaultName?: string) => {
      setPublishTarget({ repoRoot, name: defaultName });
    },
    [],
  );

  const value = useMemo<AddProjectActions>(
    () => ({
      openProject,
      openGithubProject,
      quickStart,
      openDispatcher,
      publishToGithub,
      pendingProject,
      openingRoot,
    }),
    [
      openProject,
      openGithubProject,
      quickStart,
      openDispatcher,
      publishToGithub,
      pendingProject,
      openingRoot,
    ],
  );

  return (
    <AddProjectContext.Provider value={value}>
      {children}
      {/* Modals mount once so the Dispatcher and no-projects welcome screen
          share a single dialog instance. */}
      <InitializeProjectDialog
        folder={initializeFolder}
        onClose={() => setInitializeFolder(null)}
        onConfirm={(root) => {
          setInitializeFolder(null);
          setPendingProject({ root, name: deriveProjectName(root) });
          // Re-inspect after confirmation: Git may have changed while the
          // dialog was open. Approval belongs only to this selected root.
          void openFirstWorkspace(root, { initializeConfirmed: true });
        }}
      />
      <QuickStartDialog
        open={quickStartOpen}
        onOpenChange={setQuickStartOpen}
        onCreated={({ repoRoot }) => {
          // Create already authorizes Git setup for this new folder.
          void openFirstWorkspace(repoRoot, { initializeConfirmed: true });
          refreshProjects();
        }}
        onRequestPublish={(repoRoot, name) =>
          setPublishTarget({ repoRoot, name })
        }
      />
      <OpenGithubProjectDialog
        open={openGithubOpen}
        onOpenChange={setOpenGithubOpen}
        onCloned={({ repoRoot }) => {
          void openFirstWorkspace(repoRoot);
          refreshProjects();
        }}
      />
      <AddLocalProjectDialog
        open={adoptFolder !== null}
        onOpenChange={(open) => {
          if (!open) setAdoptFolder(null);
        }}
        inspect={adoptFolder}
        onAdded={({ workspacePath }) => {
          refreshProjects();
          void spawnDefaultChatForWorkspace({
            folder: workspacePath,
            sessions,
            dispatch,
          });
        }}
      />
      <PublishToGithubDialog
        open={publishTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPublishTarget(null);
        }}
        repoRoot={publishTarget?.repoRoot ?? null}
        defaultName={publishTarget?.name}
        onPublished={() => refreshProjects()}
      />
    </AddProjectContext.Provider>
  );
}
