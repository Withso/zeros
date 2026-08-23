// ──────────────────────────────────────────────────────────
// Conversation pane — top bar
// ──────────────────────────────────────────────────────────
//
// Mounts above the existing chat-tabs row in Conversation pane. Layout:
//
//   ┌────────────────────────────────────────────────────────┐
//   │  W  Project › workspace-name          Open in ▼  ⤓     │
//   └────────────────────────────────────────────────────────┘
//
//   Left:
//     - Project icon + name (read-only; from projects store)
//     - Workspace name (inline-editable on click; saves via
//       git_rename_branch; falls back to "main" pseudo-row label
//       when the active chat sits at the project's root checkout
//       with no worktree)
//     (The Target Branch picker moved out of here — it now lives at the left
//      end of the workbench Changes tab's PR row as the labelled "Target branch"
//      pill; see TargetBranchButton in apps/desktop/src/renderer/shell/pr/target-branch-select.tsx.)
//
//   Right:
//     - "Open in" split button — app logo (click = open the worktree in
//       the current default app, ⌘O) + chevron (menu: Finder first, the
//       supported applications detected on this Mac, then Terminal and Copy
//       path ⌘C).
//       Picking anything except Copy path re-points the default + logo.
//       Detection state lives in apps/desktop/src/renderer/platform/open-apps.ts.
//     - Reserved space (parent Conversation pane still owns "Show Panel" when
//       workbench is collapsed; we don't render it here, parent does)
//
// State source: the active chat's folder. We look up which project
// owns that folder (chat.folder matches project.repoRoot, or is a
// path under project.workspaces[i].path) and resolve the workspace
// from the workspace_list IPC.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  Code,
  Copy,
  Folder,
  Pencil,
  Terminal as TerminalIcon,
} from "lucide-react";

import { Button } from "../../shared/ui";
import { cn } from "../../shared/ui/cn";
import { toast } from "../../shared/ui/primitives/elements";
import { Badge, Kbd, Tooltip } from "@/renderer/shared/ui/primitives";
import { branchDisplayName } from "../../shared/lib/branch-name";
import { WorkbenchToggleButton } from "../workbench/toggle-button";
import { useCustomWindowDrag } from "../use-custom-window-drag";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { selectActiveFolder, useWorkspaceStore } from "../../state/store";
import { type Project } from "../../state/projects-store";
import { findWorkspaceForFolder } from "../../state/workspace-resolution";
import { LOCAL_MAIN_LABEL } from "../../state/local-main-workspace";
import {
  notifyWorkspacesChanged,
  useProjectForFolder,
  useWorkspacesFor,
} from "../../state/use-projects";
import {
  gitRenameBranch,
  isGitErrorShape,
  type Workspace,
} from "../../platform/git";
import { useNativeRuntime } from "../../platform/runtime";
// Finder/Terminal opens route through openPathWithApp (open-apps.ts), which
// dispatches to the same reveal_in_finder / open_in_terminal commands.
import {
  FINDER_APP_ID,
  TERMINAL_APP_ID,
  detectedIdeApps,
  findOpenApp,
  getDetectedOpenApps,
  openPathWithApp,
  refreshDetectedOpenApps,
  resolveOpenInDefault,
  setOpenInDefaultId,
  useDetectedOpenApps,
  useOpenInDefaultId,
  type DetectedOpenApp,
} from "../../platform/open-apps";
import { AgentIcon } from "../../features/agent/agent-icon";
import { RepositoryIcon } from "../../features/repositories/repository-icon";

// ── className constants ──────────────────────────────────

/** Top bar shell — sits above the chat tabs row on bg2 surface so
 *  the breadcrumb + tab strip read as a single raised header strip
 *  above the chat body (bg1).
 *
 *  Padding is intentionally split into explicit pl-* / pr-* so either edge can
 *  be tuned independently as the adjacent panel controls evolve. */
// 2026-06-16: dropped `border-b border-border1 bg-bg2` — the top bar is
// transparent (flat on the column's bg1), matching repository panel / workbench headers, and
// borderless (no chrome seam in the chat column). h-10 keeps this secondary
// workspace toolbar aligned with Workbench below the global navigation bar.
const TOPBAR_CLS = "flex items-center gap-1 h-10 pl-2 pr-2 shrink-0";

/** Breadcrumb chip — left side. Holds project icon + name + chevron
 *  + workspace name + ⋯ menu. */
const BREADCRUMB_CLS = "flex items-center gap-1.5 min-w-0 flex-1";

/** Mini project chip (W-style box). */
const PROJECT_ICON_CLS =
  "size-5 shrink-0 inline-flex items-center justify-center rounded-sm bg-bg2-hover text-fg2 text-xs font-medium select-none";

const PROJECT_NAME_CLS = "text-sm text-fg2 shrink-0";

const SEP_CLS = "text-fg2 text-sm shrink-0 select-none";

const WORKSPACE_NAME_CLS =
  "text-sm font-medium text-fg1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap";

const WORKSPACE_NAME_INPUT_CLS =
  "h-6 px-1.5 text-sm font-medium text-fg1 bg-transparent border border-border1 rounded-sm outline-none focus-visible:border-highlighted-bright focus-visible:ring-2 focus-visible:ring-highlighted-bright/30 min-w-0 max-w-[260px]";

/** "Open in" split button — the logo half (opens the default app directly)
 *  and the chevron half (opens the menu) are two separate targets. */
const OPEN_IN_LOGO_BTN_CLS =
  "size-7 shrink-0 rounded-sm text-fg2 hover:text-fg1 hover:bg-bg2-hover/40 transition-[background-color,color] duration-120 ease-out";

const OPEN_IN_CHEVRON_BTN_CLS =
  "h-7 w-5 px-0 shrink-0 rounded-sm text-fg2 hover:text-fg1 hover:bg-bg2-hover/40 transition-[background-color,color] duration-120 ease-out";

// ── Helpers ──────────────────────────────────────────────

interface ResolvedContext {
  project: Project | null;
  workspace: Workspace | null;
}

/** Map a folder path to its owning project + (optional) workspace.
 *  Uses the shared `findProjectForFolder` helper so Zeros-managed
 *  linked-worktree paths resolve through either the current human-readable
 *  repository directory or the legacy embedded repo slug. */
function useResolvedContext(folder: string | null): ResolvedContext {
  // Resolve from the SAME project list the sidebar uses. It is reactive, so a
  // freshly created worktree or bridge reconnect re-resolves without the
  // "No workspace selected" flash.
  const project = useProjectForFolder(folder);

  const { workspaces } = useWorkspacesFor(project?.repoSlug ?? null);
  const workspace = useMemo(
    () => findWorkspaceForFolder(folder, workspaces),
    [workspaces, folder],
  );

  return { project, workspace };
}

// ── Inline rename input ──────────────────────────────────

interface InlineRenameProps {
  workspaceId: string;
  current: string;
  onCommitted: (newBranch: string) => void;
  onCancel: () => void;
}

/** Swap the name half of a ref, keeping its namespace: `jordan/Cream` +
 *  `login-fix` → `jordan/login-fix`. Mirrors resolveExistingBranchPrefix in
 *  engine/git/branch.ts — the last slash is the boundary, whatever the tail
 *  looks like. Exported for the test; it is only ever the fallback for an
 *  engine too old to report the resulting branch itself. */
export function replaceBranchName(branch: string, name: string): string {
  const cut = branch.lastIndexOf("/");
  return cut === -1 ? name : `${branch.slice(0, cut + 1)}${name}`;
}

/** Which branch the breadcrumb should name while a rename's workspace refetch
 *  is still in flight: the one the engine just confirmed, but ONLY while the
 *  store still reports the branch we renamed away from.
 *
 *  Pure so the one piece of state that can go stale here is pinned by a test
 *  rather than by reading a component. Returning null means "no override" —
 *  the store row is current (or belongs to a different workspace) and is the
 *  better answer. */
export function optimisticRenamedBranch(
  workspaceBranch: string | undefined,
  renamed: { from: string; to: string } | null,
): string | null {
  return renamed && workspaceBranch === renamed.from ? renamed.to : null;
}

function InlineRename({
  workspaceId,
  current,
  onCommitted,
  onCancel,
}: InlineRenameProps) {
  const [value, setValue] = useState(branchDisplayName(current));
  const [busy, setBusy] = useState(false);

  const commit = useCallback(async () => {
    const next = value.trim();
    if (busy) return;
    if (!next || next === branchDisplayName(current)) {
      onCancel();
      return;
    }
    setBusy(true);
    try {
      const renamed = await gitRenameBranch({ workspaceId, newName: next });
      // Report what the ENGINE produced. It keeps the branch inside whatever
      // namespace it already lives in (Settings → Git makes the prefix a
      // choice), so this used to hardcode `zeros/${next}` — a branch that does
      // not exist for every workspace on any other prefix, including an
      // unprefixed one, which got a `zeros/` that was never created.
      //
      // That was invisible until 2026-07-30 because the caller ignored the
      // value it was handed; it now drives the breadcrumb for the length of
      // the workspace refetch, so being right about the namespace is the
      // difference between a correct label and a wrong one on screen.
      //
      // The fallback covers an engine too old to report the branch back, and
      // mirrors the engine's rule exactly: everything up to the LAST slash.
      // Deriving it from branchDisplayName instead would be wrong for the two
      // cases that matter most here — a branch already renamed once, and an
      // adopted `cursor/foo` — because that rule concedes a prefix only when
      // the tail is allocator-shaped, and neither of those tails is.
      onCommitted(renamed ?? replaceBranchName(current, next));
    } catch (err: unknown) {
      if (isGitErrorShape(err)) {
        toast.error(`Couldn't rename branch: ${err.message}`, {
          description: err.remediation ?? undefined,
        });
      } else {
        toast.error(
          `Couldn't rename branch: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      onCancel();
    } finally {
      setBusy(false);
    }
  }, [busy, current, onCancel, onCommitted, value, workspaceId]);

  return (
    <input
      autoFocus
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      disabled={busy}
      className={WORKSPACE_NAME_INPUT_CLS}
      spellCheck={false}
      aria-label="Rename workspace"
    />
  );
}

// ── Open-in split button ─────────────────────────────────

/** True when a key event originates from a surface that owns typing —
 *  the ⌘C copy-path shortcut must never hijack a real copy there
 *  (composer, rename input, xterm's hidden textarea, …). */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** An app's mark: the real installed-app icon when detection extracted
 *  one, else a bundled/lucide fallback per app. */
export function OpenAppIcon({ app }: { app: DetectedOpenApp }) {
  if (app.iconDataUrl) {
    return (
      <img
        src={app.iconDataUrl}
        alt=""
        draggable={false}
        className="size-4 shrink-0"
      />
    );
  }
  if (app.id === FINDER_APP_ID) return <Folder className="text-fg2 size-3.5" />;
  if (app.id === TERMINAL_APP_ID)
    return <TerminalIcon className="text-fg2 size-3.5" />;
  // Reuse bundled monochrome marks when a CLI has no application bundle or
  // native icon extraction misses.
  if (app.id === "opencode" || app.id === "cursor") {
    return (
      <AgentIcon
        agentId={app.id}
        iconUrl={null}
        size={14}
        monochrome
        className="text-fg2"
      />
    );
  }
  return <Code className="text-fg2 size-3.5" />;
}

interface OpenInDropdownProps {
  /** Target path — the workspace path when one is active, the project
   *  root otherwise. */
  path: string;
}

/** Everything the "Open in" surfaces need for a given target `path`: the
 *  resolved app rows, the current default, and the open / re-point / copy
 *  actions (all bound to `path`). Shared by the topbar split button and
 *  the pane-menu submenu so both stay in lockstep with the same default. */
function useOpenInMenu(path: string) {
  const detected = useDetectedOpenApps();
  const defaultId = useOpenInDefaultId();

  // Cold cache (first run after this feature ships / fresh profile):
  // detection normally runs at workspace creation, so probe once here
  // for workspaces that predate the feature.
  useEffect(() => {
    if (getDetectedOpenApps() === null) void refreshDetectedOpenApps();
  }, []);

  const ides = detectedIdeApps(detected);
  const defaultApp = resolveOpenInDefault(detected, defaultId);
  const finderApp = findOpenApp(detected, FINDER_APP_ID)!;
  const terminalApp = findOpenApp(detected, TERMINAL_APP_ID)!;

  const openWith = useCallback(
    async (app: DetectedOpenApp) => {
      try {
        await openPathWithApp(app.id, path);
      } catch (err: unknown) {
        toast.error(
          `Couldn't open in ${app.name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Most likely a stale detection (app uninstalled) — re-probe so
        // the menu heals itself.
        void refreshDetectedOpenApps();
      }
    },
    [path],
  );

  /** Menu pick (everything except Copy path): re-point the default,
   *  then open. */
  const selectApp = useCallback(
    (app: DetectedOpenApp) => {
      setOpenInDefaultId(app.id);
      void openWith(app);
    },
    [openWith],
  );

  const handleCopyPath = useCallback(() => {
    try {
      void navigator.clipboard.writeText(path);
      toast.success("Path copied");
    } catch {
      /* clipboard may be blocked; non-essential */
    }
  }, [path]);

  return {
    defaultId,
    ides,
    defaultApp,
    finderApp,
    terminalApp,
    openWith,
    selectApp,
    handleCopyPath,
  };
}

type OpenInMenu = ReturnType<typeof useOpenInMenu>;

/** The shared app rows (Finder → detected IDEs → Terminal → Copy path),
 *  identical in the topbar split-button dropdown and the pane-menu
 *  submenu. The current default is marked with the ⌘O hint (and
 *  data-selected, which the menu's focus-on-open pass highlights). */
function OpenInMenuRows({ menu }: { menu: OpenInMenu }) {
  const {
    ides,
    defaultApp,
    finderApp,
    terminalApp,
    selectApp,
    handleCopyPath,
  } = menu;
  const shortcutHint = (appId: string) =>
    defaultApp.id === appId ? <Kbd className="ml-auto">⌘O</Kbd> : null;

  return (
    <>
      <DropdownMenuItem
        data-selected={defaultApp.id === finderApp.id || undefined}
        onSelect={() => selectApp(finderApp)}
      >
        <OpenAppIcon app={finderApp} />
        <span>Finder</span>
        {shortcutHint(FINDER_APP_ID)}
      </DropdownMenuItem>
      {ides.map((app) => (
        <DropdownMenuItem
          key={app.id}
          data-selected={defaultApp.id === app.id || undefined}
          onSelect={() => selectApp(app)}
        >
          <OpenAppIcon app={app} />
          <span>{app.name}</span>
          {shortcutHint(app.id)}
        </DropdownMenuItem>
      ))}
      <DropdownMenuItem
        data-selected={defaultApp.id === terminalApp.id || undefined}
        onSelect={() => selectApp(terminalApp)}
      >
        <OpenAppIcon app={terminalApp} />
        <span>Terminal</span>
        {shortcutHint(TERMINAL_APP_ID)}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={handleCopyPath}>
        <Copy className="text-fg2 size-3.5" />
        <span>Copy path</span>
        <Kbd className="ml-auto">⌘C</Kbd>
      </DropdownMenuItem>
    </>
  );
}

/** Split button: the logo half opens `path` in the current default app
 *  (Finder until the user picks something else; also ⌘O), the chevron
 *  half opens the menu. Menu order: Finder, detected IDEs, Terminal,
 *  Copy path — picking anything except Copy path becomes the new
 *  default and its logo takes over the trigger. Also the sole owner of
 *  the ⌘O / ⌘C shortcuts (the pane-menu submenu is a pure visual entry
 *  point; see OpenInSubmenu). */
function OpenInDropdown({ path }: OpenInDropdownProps) {
  const menu = useOpenInMenu(path);
  const { defaultApp, defaultId, openWith, handleCopyPath } = menu;
  const workspacePageActive = useWorkspaceStore(
    (state) => state.activePage === "workspace",
  );

  // ⌘O — open in the current default app. Reaches the renderer because
  // the native menu's Open Folder… accelerator moved to ⌘⇧O (menu.ts).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!workspacePageActive) return;
      if (e.defaultPrevented) return;
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.code !== "KeyO") return;
      e.preventDefault();
      void openWith(resolveOpenInDefault(getDetectedOpenApps(), defaultId));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [defaultId, openWith, workspacePageActive]);

  // ⌘C — copy the worktree path, but ONLY when it can't be a real copy:
  // no text selection anywhere and focus not on a typing surface.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!workspacePageActive) return;
      if (e.defaultPrevented) return;
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.code !== "KeyC") return;
      if (isEditableTarget(e.target)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      e.preventDefault();
      handleCopyPath();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleCopyPath, workspacePageActive]);

  return (
    <div className="flex shrink-0 items-center">
      <Tooltip label={`Open in ${defaultApp.name} (⌘O)`}>
        <Button
          variant="ghost"
          size="icon-sm"
          className={OPEN_IN_LOGO_BTN_CLS}
          onClick={() => void openWith(defaultApp)}
          aria-label={`Open in ${defaultApp.name}`}
        >
          <OpenAppIcon app={defaultApp} />
        </Button>
      </Tooltip>
      <DropdownMenu>
        <Tooltip label="Open in…">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={OPEN_IN_CHEVRON_BTN_CLS}
              aria-label="Open path in another app"
            >
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          sideOffset={4}
          className="min-w-[200px]"
        >
          <OpenInMenuRows menu={menu} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Third "Open in" surface: a bare NAME chip that opens the same app rows on
 *  click. Used by the chat's "Created <workspace>" provenance row, where the
 *  workspace name is already the subject of the sentence — so the name itself
 *  is the trigger and there is no chevron, no logo, and no split half. Like
 *  OpenInSubmenu this is a pure pointer entry point; ⌘O / ⌘C stay owned by
 *  OpenInDropdown. */
export function OpenInBadgeMenu({
  path,
  label,
}: OpenInDropdownProps & { label: string }) {
  const menu = useOpenInMenu(path);

  return (
    <DropdownMenu>
      <Tooltip label="Open in…">
        <DropdownMenuTrigger asChild>
          <Badge
            variant="accent"
            role="button"
            tabIndex={0}
            aria-label={`Open ${label} in…`}
            // Only the cursor: the chip's size, weight and colour live in the
            // `accent` variant (typography and color come
            // from the primitive, not from a call site's className).
            className="cursor-pointer"
          >
            {label}
          </Badge>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="min-w-[200px]"
      >
        <OpenInMenuRows menu={menu} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Pane-menu "Open in" surface: a submenu whose trigger carries the
 *  current default app's logo ("logo represents where it will open") and
 *  reveals the same app rows on hover. Mounted inside the pane "⋯" menu
 *  (see ChatTabs). The ⌘O / ⌘C shortcuts stay owned by the hidden
 *  topbar's OpenInDropdown, so this stays a pure pointer entry point. */
export function OpenInSubmenu({ path }: OpenInDropdownProps) {
  const menu = useOpenInMenu(path);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <OpenAppIcon app={menu.defaultApp} />
        <span>Open in</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[200px]">
        <OpenInMenuRows menu={menu} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

// ── Top bar root ─────────────────────────────────────────

export interface ConversationHeaderProps {
  /** Whether Workbench (the right design panel) is currently collapsed.
   *  When true, the workbench toggle button moves from Workbench's header
   *  (which is unmounted) into this topbar so the user can still
   *  expand the design panel from here. */
  workbenchCollapsed?: boolean;
  /** Toggles the design-panel visibility. Wired here so the workbench
   *  collapse button can live as a real DOM descendant of this drag
   *  region; sibling overlays do not subtract from it. */
  onToggleWorkbench?: () => void;
}

export function ConversationHeader({
  workbenchCollapsed = false,
  onToggleWorkbench,
}: ConversationHeaderProps = {}) {
  // Window drag + double-click-zoom via JS/IPC instead of CSS drag
  // region — so single clicks on this row dismiss popovers as
  // expected (macOS `-webkit-app-region: drag` swallows clicks).
  const topbarRef = useRef<HTMLDivElement | null>(null);
  useCustomWindowDrag(topbarRef);
  // Resolve the breadcrumb folder inside the selector so this returns a
  // primitive string|null — the topbar re-renders only when the resolved
  // folder changes, not on every `chats` mutation. `selectActiveFolder` falls
  // back to `newAgentFolder` (Untitled tab) and then the persisted
  // `lastWorkspaceFolder`, so a fresh boot resolves the workspace the user left
  // instead of flashing "No workspace selected" before chats hydrate.
  const folder = useWorkspaceStore(selectActiveFolder);
  const { project, workspace } = useResolvedContext(folder);

  const [renaming, setRenaming] = useState(false);
  // The branch the engine just reported for a rename, held only until the
  // workspace row catches up. `notifyWorkspacesChanged` is a bridge round
  // trip, so without this the breadcrumb keeps showing the OLD name for the
  // length of that refetch — right after the user renamed it, which is the one
  // moment they are looking at it.
  //
  // Reset during RENDER, keyed on the branch it was recorded against, rather
  // than cleared by an effect: an effect only fires after commit, so the first
  // render that sees the refetched row would still paint the optimistic name
  // and then correct itself. Storing what we renamed FROM is what makes it
  // self-clearing — the moment `workspace.branch` is anything else the store
  // has landed (or the user switched workspaces), and the optimistic value is
  // dropped on that same render. If the refetch never lands, the name shown is
  // still the one the ENGINE confirmed it wrote, which is the correct answer to
  // be stuck on; the stale row is the wrong one.
  // (Same shape as the grown/body pair in chat-transcript-preview.tsx.)
  //
  // Declared up here with the other hooks, ahead of the no-project early
  // return below — see the note on that return.
  const [renamed, setRenamed] = useState<{ from: string; to: string } | null>(
    null,
  );
  // 2026-05-23: reactive hook so the "Open in" dropdown unhides
  // when a late-arriving preload bridge lands. Must be called
  // unconditionally before the early-return below to satisfy
  // React's rules-of-hooks (the no-project branch returns before
  // the rest of the component runs).
  const nativeReady = useNativeRuntime().ready;

  // Empty state — no active chat, or chat folder isn't in a tracked
  // project. The top bar still renders so the chrome doesn't jump
  // height when switching chats, but the content is muted.
  if (!project) {
    return (
      <div ref={topbarRef} className={TOPBAR_CLS}>
        <span className="text-fg2 px-1.5 text-xs">No workspace selected</span>
        <div className="flex-1" />
        {workbenchCollapsed && onToggleWorkbench && (
          <WorkbenchToggleButton
            workbenchCollapsed
            onToggle={onToggleWorkbench}
          />
        )}
      </div>
    );
  }

  // Repo-root chats land here with workspace = null (no engine-managed
  // worktree owns the project root). Match the tab strip + sidebar by
  // showing the synthetic "Local main" label. The rename affordance stays
  // hidden (workspace is still null), which is intentional — the synthetic
  // workspace has no engine id to dispatch IPCs against.
  const isLocalMain = !workspace && folder === project.repoRoot;

  const optimisticBranch = optimisticRenamedBranch(workspace?.branch, renamed);

  const workspaceLabel = workspace
    ? branchDisplayName(optimisticBranch ?? workspace.branch)
    : isLocalMain
      ? LOCAL_MAIN_LABEL
      : "main";

  const handleRenameCommitted = (newBranch: string) => {
    if (workspace) setRenamed({ from: workspace.branch, to: newBranch });
    setRenaming(false);
    if (workspace) notifyWorkspacesChanged(workspace.repoSlug);
  };

  const openInPath = workspace?.path ?? project.repoRoot;

  return (
    <div ref={topbarRef} className={TOPBAR_CLS}>
      <div className={BREADCRUMB_CLS}>
        <span className={PROJECT_ICON_CLS} aria-hidden="true">
          <RepositoryIcon project={project} className="size-full rounded-sm" />
        </span>
        <span className={PROJECT_NAME_CLS}>{project.name}</span>
        <span className={SEP_CLS} aria-hidden="true">
          ›
        </span>
        {workspace && renaming ? (
          <InlineRename
            workspaceId={workspace.id}
            // The optimistic value too, so reopening the box inside the
            // refetch window seeds it with the name the user just chose
            // rather than the one they renamed away from.
            current={optimisticBranch ?? workspace.branch}
            onCommitted={handleRenameCommitted}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <Tooltip
            label={workspace ? "Click to rename" : "Project main checkout"}
          >
            <button
              type="button"
              className={cn(
                WORKSPACE_NAME_CLS,
                workspace &&
                  "group/wsname hover:bg-bg2-hover/40 inline-flex cursor-text items-center gap-1 rounded-sm px-1.5 py-0.5 transition-[background-color] duration-120 ease-out",
                !workspace && "px-1.5 py-0.5",
              )}
              onClick={() => {
                if (workspace) setRenaming(true);
              }}
              disabled={!workspace}
            >
              <span className="truncate">{workspaceLabel}</span>
              {workspace && (
                <Pencil className="text-fg2 size-3 shrink-0 opacity-0 transition-opacity duration-120 ease-out group-hover/wsname:opacity-100" />
              )}
            </button>
          </Tooltip>
        )}
      </div>
      {/* The Run affordance lives at the right end of Workbench's terminal row
          — see RunControl (run-control.tsx). Create PR moved too: it lives in
          the workbench Changes tab's PR status row (ChangesWorkbenchSurface → PrStatusRow),
          the same row that becomes the PR status island once a PR exists. */}
      {nativeReady && <OpenInDropdown path={openInPath} />}
      {workbenchCollapsed && onToggleWorkbench && (
        <WorkbenchToggleButton
          workbenchCollapsed
          onToggle={onToggleWorkbench}
        />
      )}
    </div>
  );
}
