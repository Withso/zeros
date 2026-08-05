// ──────────────────────────────────────────────────────────
// Workbench Tab Manager — Types + localStorage persistence
// ──────────────────────────────────────────────────────────

import type { BrowserTabVariant } from "../../features/browser/variant-types";
import {
  Diff as DiffIcon,
  Globe,
  File as FileIcon,
  GitPullRequestArrow,
  Shapes,
  type LucideIcon,
} from "lucide-react";

export type WorkbenchTabType =
  | "changes"
  | "review"
  | "context"
  | "browser"
  | "files";
export type ReviewSubtab =
  | "changes"
  | "description"
  | "commits"
  | "checks"
  | "reviews";
export type ChangesViewMode = "flat" | "tree";
export type ViewerMode = "diff" | "preview" | "edit";

export interface WorkbenchTab {
  id: string;
  type: WorkbenchTabType;
  title: string;
  /** Only Changes and Review are pinned. Browser tabs and EXTRA File tabs are
   *  always removable (including a blank "Open file" from + → File); the one
   *  `fixed` Files home is permanent too, but via its own flag below. */
  pinned?: boolean;
  /** Files only: THE workspace's permanent Files home. Exactly one per
   *  workspace (normalizeWorkbenchTabs enforces and seeds it) and it owns the
   *  leading tab slot. It can never be removed: closing it closes its FILE,
   *  reverting the tab to the blank "Open file" tree — so direct opens always
   *  have a stable first destination (see blankFixedFilesTab). */
  fixed?: boolean;
  /** Files + Changes tabs: the currently-open file (repo-relative POSIX path).
   *  Drives the right-pane viewer AND (Files only) the tab label. On the
   *  Changes tab it's the change selected in its sidebar; on File tabs it's
   *  optional — with none the tab shows its tree + a "select a file" viewer
   *  and is titled "Open file". */
  filePath?: string;
  /** Files/Changes tab: open the viewer in Diff mode (vs the read-only source
   *  "Edit" view). Set when the file is opened from the Changes list; cleared
   *  when opened from All Files (the default view follows the entry point,
   *  and re-opening the same file from the other source switches it in place).
   *  The Diff toggle itself is still gated on the file actually having changes. */
  diff?: boolean;
  /** Files/Changes tab: which diff the viewer shows — mirrors the Changes filter
   *  the file was opened from: "all" (worktree vs base = committed + uncommitted),
   *  "uncommitted" (working tree vs HEAD), or "commit" (that commit's own diff,
   *  via `diffSha`). Omitted → "all" (e.g. opened from All Files). */
  diffScope?: "all" | "uncommitted" | "staged" | "unstaged" | "commit" | "turn";
  /** Files/Changes tab: the commit SHA when `diffScope === "commit"`. */
  diffSha?: string;
  /** Files/Changes tab: when `diffScope === "turn"`, the chat + turn whose
   *  agent-authored diff the viewer shows (opened from the per-turn footer
   *  pills or the Changes-tab turn filter). */
  turnChatId?: string;
  turnId?: string;
  /** Files/Changes tab: show the Discard control in the viewer header. Set ONLY
   *  when opened from the "All changes" filter AND the file has uncommitted work
   *  — discard reverts uncommitted edits to HEAD, which only makes sense from
   *  that full-context view (never the uncommitted/commit filters, never All
   *  Files, never a fully-committed file). */
  discardable?: boolean;
  /** Files/Changes tab: the selected change has no representation in HEAD
   *  (untracked or staged-new). This is deliberately separate from an empty
   *  diff: a tracked file also has an empty diff after it is discarded. */
  isNewFile?: boolean;
  /** Files/Changes tab: bumped after a destructive on-disk reset so an Edit-mode
   *  SourceEditor remounts and cannot retain/re-save a pre-discard draft. */
  contentRevision?: number;
  /** Review tab's last selected inner destination, owned by this worktree. */
  reviewSubtab?: ReviewSubtab;
  /** Changes tab's flat/tree presentation, owned by this worktree. */
  changesView?: ChangesViewMode;
  /** Explicit File/Changes viewer choice. New path intents clear it so the
   * entry point's Diff/Preview/Edit default remains authoritative. */
  viewerMode?: ViewerMode;
  /** File tab only: whether this tab's workspace tree is visible beside its
   * viewer. Owned by the individual tab so A → B → A restores independently.
   * Blank tabs are always visible/tree-only; direct path tabs start collapsed. */
  fileTreeVisible?: boolean;
  url?: string;
  canvasMode?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
  variants?: BrowserTabVariant[];
}

/** A bounded, per-workspace browser history used by the + quick-open menu.
 *  Entries survive closing their Browser tab, but never keep iframe state. */
export interface RecentBrowserEntry {
  url: string;
  title: string;
  visitedAt: number;
}

export const MAX_RECENT_BROWSERS = 24;
export const MAX_PERSISTED_WORKBENCH_SCOPES = 128;

export const BROWSER_DEFAULT_WIDTH = 1280;
export const BROWSER_DEFAULT_HEIGHT = 800;
export const BROWSER_MIN_WIDTH = 320;
export const BROWSER_MIN_HEIGHT = 300;
export const BROWSER_VIEWPORT_PRESETS = [
  { label: "Desktop", width: 1440 },
  { label: "Laptop", width: 1280 },
  { label: "Tablet", width: 768 },
  { label: "Mobile", width: 375 },
] as const;

interface TabTypeMeta {
  label: string;
  icon: LucideIcon;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/** Basename of a POSIX repo-relative path. */
function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/** Canonical persisted browser URLs are always explicit http(s), bounded, and
 *  credential-free. Unlike address-bar normalization this never guesses a
 *  scheme: persistence is a trust boundary, not user input assistance. */
function canonicalBrowsableHttpUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  try {
    const url = new URL(raw.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    )
      return "";
    return url.href.length <= 8192 ? url.href : "";
  } catch {
    return "";
  }
}

/** Build a closable File tab for a real repo-relative path. `opts` carries the
 *  Diff intent (see the diff* fields on WorkbenchTab). */
export function createFilesTab(
  filePath: string,
  opts?: {
    diff?: boolean;
    diffScope?:
      | "all"
      | "uncommitted"
      | "staged"
      | "unstaged"
      | "commit"
      | "turn";
    diffSha?: string;
    turnChatId?: string;
    turnId?: string;
    discardable?: boolean;
    isNewFile?: boolean;
  },
): WorkbenchTab {
  if (!filePath.trim()) {
    throw new Error("A File tab requires a non-empty file path");
  }
  return {
    id: nextId("files"),
    type: "files",
    title: baseName(filePath),
    filePath,
    fileTreeVisible: false,
    ...(opts?.diff ? { diff: true } : {}),
    ...(opts?.diffScope ? { diffScope: opts.diffScope } : {}),
    ...(opts?.diffSha ? { diffSha: opts.diffSha } : {}),
    ...(opts?.turnChatId ? { turnChatId: opts.turnChatId } : {}),
    ...(opts?.turnId ? { turnId: opts.turnId } : {}),
    ...(opts?.discardable ? { discardable: true } : {}),
    ...(opts?.isNewFile ? { isNewFile: true } : {}),
  };
}

/** Build a blank File surface. + → File creates these as EXTRA, closable
 *  tabs; the workspace's permanent Files home is the same shape promoted to
 *  `fixed` by normalizeWorkbenchTabs. Selecting a file fills the tab in place. */
export function createEmptyFilesTab(): WorkbenchTab {
  return {
    id: nextId("files"),
    type: "files",
    title: "Open file",
    fileTreeVisible: true,
  };
}

/** The blank "Open file" state the FIXED Files home reverts to when its file
 *  closes. Keeps the tab identity (same id, so the strip pill and per-tab
 *  scroll memory survive) while clearing every per-file field — including the
 *  direct-open collapsed-tree preference, so the reverted home is the same
 *  full-width tree a fresh workspace starts with. */
export function blankFixedFilesTab(tab: WorkbenchTab): WorkbenchTab {
  return {
    ...tab,
    title: "Open file",
    filePath: undefined,
    fileTreeVisible: true,
    diff: false,
    diffScope: undefined,
    diffSha: undefined,
    turnChatId: undefined,
    turnId: undefined,
    discardable: false,
    isNewFile: false,
    viewerMode: undefined,
    contentRevision: undefined,
  };
}

/** Where a direct open (agent chat, quick open, Changes advance) lands when
 *  the file isn't open anywhere: the FIXED home first — the user's stable
 *  first destination — then any extra blank, then the caller opens a new tab. */
export function findBlankFilesTab(
  tabs: WorkbenchTab[],
): WorkbenchTab | undefined {
  return (
    tabs.find((t) => t.type === "files" && !t.filePath && t.fixed === true) ??
    tabs.find((t) => t.type === "files" && !t.filePath)
  );
}

/** How a workbench file open resolves against the current tabs + the ACTIVE tab.
 *  The ACTIVE File tab WINS: it's reused in place even when the clicked file is
 *  already open in another tab. The file list (All Files / Changes) drives that
 *  one tab like a scratchpad, so clicking through it never yanks the user to a
 *  pre-existing tab (the "jumping" we're avoiding). To keep a file around, use
 *  right-click → "Open in new tab".
 *   • replace — the active tab is a File tab → swap its file in place, unless
 *               that would overwrite another path's unsaved draft.
 *   • focus   — no active File tab to reuse (active is the Browser, or activeId
 *               is stale) AND the file is already open → switch to it
 *               (expected when leaving a non-file context; avoids a duplicate).
 *   • new     — no active File tab and the file isn't already open → add a
 *               fresh File tab. */
export type WorkbenchOpenPlan =
  | { kind: "focus"; id: string }
  | { kind: "replace"; id: string }
  | { kind: "new" };

/** Keep expensive File surfaces lazy unless they are active or own an unsaved
 * draft. Browsers preserve iframe state; the pinned home views preserve
 * their resolved lists, PR state, and canvas viewport + decoded images. The
 * terminal panel is mounted separately below workbench. Clean, inactive File tabs
 * remain the only lazy surface. */
export function shouldMountWorkbenchTab(
  tab: WorkbenchTab,
  activeId: string | null,
  dirtyEditorIds: ReadonlySet<string>,
): boolean {
  return (
    tab.type === "browser" ||
    tab.type === "changes" ||
    tab.type === "review" ||
    tab.type === "context" ||
    tab.id === activeId ||
    dirtyEditorIds.has(tab.id)
  );
}

/** Decide where an opened file lands, given the live tab list + active id. Pure
 *  (no store / React) so the active-tab policy is unit-testable in isolation.
 *  `path` must be the trimmed, non-empty repo-relative path the caller resolved.
 *  Right-click "Open in new tab" and agent-chat refs bypass this on purpose —
 *  they don't reuse the active tab (see use-open-file). */
export function planWorkbenchFileOpen(
  tabs: WorkbenchTab[],
  activeId: string | null,
  path: string,
  activeFileDirty = false,
): WorkbenchOpenPlan {
  // Active File tab → ordinarily reuse it in place, even if `path` is open
  // elsewhere. A dirty editor is the one exception: replacing it with ANOTHER
  // path would unmount its path-keyed SourceEditor and lose unsaved work. Since
  // dirty inactive File tabs remain mounted, focus an existing target — or land
  // in a blank (home first; a blank is never the dirty tab, it has no editor)
  // or a new tab — while the draft stays alive in its original tab.
  const active = tabs.find((t) => t.id === activeId);
  if (active && active.type === "files") {
    if (activeFileDirty && active.filePath !== path) {
      const existing = tabs.find(
        (t) => t.id !== active.id && t.type === "files" && t.filePath === path,
      );
      if (existing) return { kind: "focus", id: existing.id };
      const blank = findBlankFilesTab(tabs);
      return blank ? { kind: "replace", id: blank.id } : { kind: "new" };
    }
    return { kind: "replace", id: active.id };
  }
  // No active File tab to reuse (active is a Browser/non-File, or workbench empty):
  // focus the file if it's already open, else fill a blank (the fixed Files
  // home first) before allocating a fresh tab.
  const existing = tabs.find((t) => t.type === "files" && t.filePath === path);
  if (existing) return { kind: "focus", id: existing.id };
  const empty = findBlankFilesTab(tabs);
  if (empty) return { kind: "replace", id: empty.id };
  return { kind: "new" };
}

/** Build a closable Browser tab. Multiple Browser tabs may coexist. */
export function createBrowserTab(opts?: {
  url?: string;
  title?: string;
}): WorkbenchTab {
  const url = canonicalBrowsableHttpUrl(opts?.url);
  return {
    id: nextId("browser"),
    type: "browser",
    title: url ? opts?.title?.trim().slice(0, 512) || "Browser" : "Browser",
    url,
  };
}

/** Build THE Changes tab — a pinned home tab for the branch's
 *  change review surface (PR status row + filterable changed-file sidebar +
 *  diff viewer — see ChangesWorkbenchSurface). One per worktree, can't be closed. Its
 *  file* fields carry the sidebar selection so it survives reloads. */
export function createChangesTab(): WorkbenchTab {
  return {
    id: nextId("changes"),
    type: "changes",
    title: "Changes",
  };
}

/** Build THE Review tab — the pinned PR review surface (ReviewView: PR header /
 *  merge + Changes / Commits / Checks / Reviews). ALWAYS
 *  visible: it renders the live PR while the workspace has one and an
 *  explanatory empty state otherwise (PR creation lives in the Changes tab's
 *  PR status row). One per worktree, can't be closed. */
export function createReviewTab(): WorkbenchTab {
  return {
    id: nextId("review"),
    type: "review",
    title: "Review",
  };
}

/** The path a workbench tab's strip icon should be resolved FROM, or null to use the
 *  tab type's own lucide glyph. A File tab showing a file wears that file's
 *  colored type glyph — the same one the Files tree, the viewer breadcrumb, and
 *  @-mention pills use — so a `.md`, `.json`, or `.sh` tab is identifiable at a
 *  glance instead of every tab reading as the same generic page. A blank
 *  "Open file" tab has no file to describe, so it keeps the generic glyph. */
export function workbenchTabIconPath(tab: WorkbenchTab): string | null {
  if (tab.type !== "files") return null;
  const path = tab.filePath?.trim();
  return path ? path : null;
}

/** Build THE Context tab — the pinned canvas over the workspace's
 *  `.context-graph/` (composer attachments + shared docs, auto-laid-out,
 *  pan/zoom only). One per worktree, can't be closed. */
export function createContextTab(): WorkbenchTab {
  return {
    id: nextId("context"),
    type: "context",
    title: "Context",
  };
}

export const TAB_TYPE_META: Record<WorkbenchTabType, TabTypeMeta> = {
  changes: {
    label: "Changes",
    icon: DiffIcon,
  },
  review: {
    label: "Review",
    icon: GitPullRequestArrow,
  },
  context: {
    label: "Context",
    icon: Shapes,
  },
  browser: {
    label: "Browser",
    icon: Globe,
  },
  files: {
    label: "File",
    icon: FileIcon,
  },
};

// The worktree's PR review surface is THE pinned "review" home tab above
// (ReviewSurface → ReviewView) — always visible, empty state without a PR.
// The legacy secondary source panel (All Files / Changes / "PR #N") is gone;
// those surfaces now live in the Changes / Files / Review workbench tabs.

// Per-worktree tab state lives under ONE key as a { [folder]: slice } map (see
// loadScopes/saveScopes). The pre-per-scope GLOBAL keys below mixed tabs from
// every worktree, so they can't be cleanly attributed — loadScopes drops them.
// Compatibility contract: these established keys intentionally retain their
// former coordinate-based names so upgrades preserve every open workbench tab.
const STORAGE_KEY_SCOPES = "column3-tabs-by-scope-v1"; // gitleaks:allow — localStorage key name
const LEGACY_KEY_TABS = "column3-tabs"; // gitleaks:allow — legacy localStorage key name
const LEGACY_KEY_ACTIVE = "column3-active-tab-id";

/** Legacy / relocated tab types dropped from the workbench's persisted state. "pr" is
 *  the OLD synthetic active-PR tab (later a secondary source view, both gone) —
 *  the PR surface is the pinned "review" home tab now, a DIFFERENT type so a
 *  stale persisted "pr" entry still drops cleanly. "terminal" migrated into
 *  the always-present terminal panel. */
const REMOVED_TAB_TYPES = new Set([
  "design",
  "git",
  "env",
  "todo",
  "pr",
  "terminal",
]);
const CURRENT_TAB_TYPES = new Set<WorkbenchTabType>([
  "changes",
  "review",
  "context",
  "browser",
  "files",
]);
const REVIEW_SUBTABS = new Set<ReviewSubtab>([
  "changes",
  "description",
  "commits",
  "checks",
  "reviews",
]);
const CHANGES_VIEW_MODES = new Set<ChangesViewMode>(["flat", "tree"]);
const VIEWER_MODES = new Set<ViewerMode>(["diff", "preview", "edit"]);

function validReviewSubtab(raw: unknown): ReviewSubtab | undefined {
  return typeof raw === "string" && REVIEW_SUBTABS.has(raw as ReviewSubtab)
    ? (raw as ReviewSubtab)
    : undefined;
}

function validChangesView(raw: unknown): ChangesViewMode | undefined {
  return typeof raw === "string" &&
    CHANGES_VIEW_MODES.has(raw as ChangesViewMode)
    ? (raw as ChangesViewMode)
    : undefined;
}

function validViewerMode(raw: unknown): ViewerMode | undefined {
  return typeof raw === "string" && VIEWER_MODES.has(raw as ViewerMode)
    ? (raw as ViewerMode)
    : undefined;
}

/** Canonical workbench order: the FIXED Files home (falling back to the first File
 *  tab in lists that predate the flag), then the pinned Changes, Review, and
 *  Context homes, followed by all other closable File/Browser tabs in their
 *  relative order. The leading slot is stable: extra File tabs never migrate
 *  into it while the home exists. */
export function orderWorkbenchTabs(tabs: WorkbenchTab[]): WorkbenchTab[] {
  const changes = tabs.find((t) => t.type === "changes");
  const review = tabs.find((t) => t.type === "review");
  const context = tabs.find((t) => t.type === "context");
  const systemIds = new Set(
    [changes?.id, review?.id, context?.id].filter((id): id is string =>
      Boolean(id),
    ),
  );
  const closable = tabs
    .filter((t) => !systemIds.has(t.id))
    .map((t) => (t.pinned ? { ...t, pinned: false } : t));
  const fixedIndex = closable.findIndex(
    (t) => t.type === "files" && t.fixed === true,
  );
  const firstFileIndex =
    fixedIndex >= 0
      ? fixedIndex
      : closable.findIndex((t) => t.type === "files");
  const firstFile = firstFileIndex >= 0 ? closable[firstFileIndex] : null;
  const rest = closable.filter((_, index) => index !== firstFileIndex);
  return [
    ...(firstFile ? [firstFile] : []),
    ...(changes ? [{ ...changes, pinned: true }] : []),
    ...(review ? [{ ...review, pinned: true }] : []),
    ...(context ? [{ ...context, pinned: true }] : []),
    ...rest,
  ];
}

/** Enforce the workbench invariants on a persisted tab list:
 *   • legacy types (design/git/…/pr) are dropped;
 *   • exactly ONE Changes tab — the first persisted one becomes THE pinned
 *     Changes tab (its sidebar selection survives), or one is seeded;
 *   • exactly ONE Review tab — the first persisted one is promoted, or one is
 *     seeded (always visible; its body renders an empty state without a PR);
 *   • exactly ONE Context tab — promoted or seeded the same way (pre-Context
 *     persisted slices gain it here, no storage-key bump needed);
 *   • exactly ONE fixed Files home — the first persisted `fixed` File tab
 *     keeps the flag, else the first File tab is promoted (pre-flag slices),
 *     else a blank home is seeded: the Files surface is permanent now, so its
 *     absence can only be legacy state;
 *   • every persisted File tab survives, including blank "Open file" tabs;
 *     extra File tabs stay closable (legacy pins are stripped);
 *   • every persisted Browser tab survives and is closable (legacy pins are
 *     stripped), enabling the multi-browser policy;
 *   • persisted Terminal tabs are removed (the terminal panel owns that surface);
 *   • order is [fixed Files home, Changes, Review, Context, ...other closable
 *     tabs].
 *  Result never becomes empty because the home tabs remain. */
export function normalizeWorkbenchTabs(parsed: WorkbenchTab[]): WorkbenchTab[] {
  // Persistence is user-editable and old builds could leave duplicate ids.
  // Validate the small structural core here so one corrupt entry cannot break
  // every workspace's React keys or multi-browser event routing.
  const seenIds = new Set<string>();
  const tabs: WorkbenchTab[] = [];
  for (const raw of parsed as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Partial<WorkbenchTab> & { type?: unknown };
    if (
      typeof candidate.type !== "string" ||
      REMOVED_TAB_TYPES.has(candidate.type) ||
      !CURRENT_TAB_TYPES.has(candidate.type as WorkbenchTabType)
    )
      continue;
    const type = candidate.type as WorkbenchTabType;
    const rawId = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const id =
      rawId && rawId.length <= 256 && !seenIds.has(rawId)
        ? rawId
        : nextId(type);
    seenIds.add(id);
    tabs.push({
      ...(candidate as WorkbenchTab),
      id,
      type,
      title: typeof candidate.title === "string" ? candidate.title : "",
    });
  }
  const firstChanges = tabs.find((t) => t.type === "changes");
  const firstReview = tabs.find((t) => t.type === "review");
  const changesFilePath =
    typeof firstChanges?.filePath === "string"
      ? firstChanges.filePath.trim().slice(0, 8192) || undefined
      : undefined;
  const homeChanges: WorkbenchTab = firstChanges
    ? {
        ...firstChanges,
        title: "Changes",
        pinned: true,
        filePath: changesFilePath,
        reviewSubtab: undefined,
        changesView: validChangesView(firstChanges.changesView),
        fileTreeVisible: undefined,
        viewerMode: changesFilePath
          ? validViewerMode(firstChanges.viewerMode)
          : undefined,
      }
    : { ...createChangesTab(), pinned: true };
  const homeReview: WorkbenchTab = firstReview
    ? {
        ...firstReview,
        title: "Review",
        pinned: true,
        reviewSubtab: validReviewSubtab(firstReview.reviewSubtab),
        changesView: undefined,
        viewerMode: undefined,
        fileTreeVisible: undefined,
      }
    : { ...createReviewTab(), pinned: true };
  const firstContext = tabs.find((t) => t.type === "context");
  const homeContext: WorkbenchTab = firstContext
    ? {
        ...firstContext,
        title: "Context",
        pinned: true,
        filePath: undefined,
        reviewSubtab: undefined,
        changesView: undefined,
        viewerMode: undefined,
      }
    : { ...createContextTab(), pinned: true };
  const closable = tabs
    .filter((t) => t.type === "files" || t.type === "browser")
    .map((tab) => {
      if (tab.type === "files") {
        const filePath =
          typeof tab.filePath === "string"
            ? tab.filePath.trim().slice(0, 8192) || undefined
            : undefined;
        return {
          ...tab,
          pinned: false,
          filePath,
          reviewSubtab: undefined,
          changesView: undefined,
          fileTreeVisible: filePath
            ? typeof tab.fileTreeVisible === "boolean"
              ? tab.fileTreeVisible
              : tab.fileTreeVisible === undefined
                ? true
                : false
            : true,
          viewerMode: filePath ? validViewerMode(tab.viewerMode) : undefined,
          title: filePath
            ? tab.title.trim().slice(0, 512) || baseName(filePath)
            : "Open file",
          ...(!filePath
            ? {
                diff: false,
                diffScope: undefined,
                diffSha: undefined,
                turnChatId: undefined,
                turnId: undefined,
                discardable: false,
                isNewFile: false,
              }
            : {}),
        };
      }
      const url = canonicalBrowsableHttpUrl(tab.url);
      return {
        ...tab,
        pinned: false,
        fixed: undefined,
        title: url ? tab.title.trim().slice(0, 512) || "Browser" : "Browser",
        url,
        canvasMode: url ? tab.canvasMode : false,
        variants: Array.isArray(tab.variants) ? tab.variants : undefined,
        reviewSubtab: undefined,
        changesView: undefined,
        viewerMode: undefined,
        fileTreeVisible: undefined,
      };
    });
  // Exactly one fixed Files home: honor the first persisted flag (coerced —
  // persistence is user-editable), promote the first File tab of a pre-flag
  // slice, and seed a blank home when no File tab survived at all.
  const filesTabs = closable.filter((t) => t.type === "files");
  const fixedId = (filesTabs.find((t) => t.fixed === true) ?? filesTabs[0])?.id;
  const withHome: WorkbenchTab[] = closable.map((t) =>
    t.type === "files" ? { ...t, fixed: t.id === fixedId || undefined } : t,
  );
  if (!fixedId) withHome.unshift({ ...createEmptyFilesTab(), fixed: true });
  return orderWorkbenchTabs([
    { ...homeChanges, fixed: undefined },
    { ...homeReview, fixed: undefined },
    { ...homeContext, fixed: undefined },
    ...withHome,
  ]);
}

// ── Per-worktree persistence ───────────────────────────────
// Workbench tabs belong to a WORKTREE, not the whole app: a file opened in one
// worktree must not appear in another. State is a map keyed by the active
// worktree's folder path (the same identity chats use). The store reads the
// active slice and swaps which slice it reads on a worktree switch — see
// workbenchScopeKey / selectWorkbench in workspace-store.ts.

/** One worktree's workbench tab state. */
export interface WorkbenchScopeState {
  tabs: WorkbenchTab[];
  activeId: string | null;
  recentBrowsers: RecentBrowserEntry[];
}

/** Per-worktree tab state, keyed by the worktree's folder path. */
export type WorkbenchScopeMap = Record<string, WorkbenchScopeState>;

/** The default slice for a fresh worktree: the fixed blank Files home first,
 *  then pinned Changes and Review. Terminal panel owns Setup / Run / Terminal. */
export function defaultTabs(): WorkbenchScopeState {
  const tabs = normalizeWorkbenchTabs([createEmptyFilesTab()]);
  return { tabs, activeId: defaultActiveId(tabs), recentBrowsers: [] };
}

/** A fresh row lands on its first File tab; a migrated slice with no File tab
 *  falls back to Changes. */
function defaultActiveId(tabs: WorkbenchTab[]): string {
  return (
    tabs.find((t) => t.type === "files") ??
    tabs.find((t) => t.type === "changes") ??
    tabs[0]
  ).id;
}

/** Sanitize persisted browser history, newest-first and deduplicated by URL. */
export function normalizeRecentBrowsers(
  entries: unknown,
): RecentBrowserEntry[] {
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  return entries
    .map((entry): RecentBrowserEntry | null => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Partial<RecentBrowserEntry>;
      const url = canonicalBrowsableHttpUrl(item.url);
      if (
        !url ||
        typeof item.title !== "string" ||
        typeof item.visitedAt !== "number" ||
        !Number.isFinite(item.visitedAt)
      )
        return null;
      return {
        url,
        title: item.title.trim().slice(0, 512) || "Browser",
        visitedAt: item.visitedAt,
      };
    })
    .filter((entry): entry is RecentBrowserEntry => entry !== null)
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .filter((entry) => {
      if (seen.has(entry.url)) return false;
      seen.add(entry.url);
      return true;
    })
    .slice(0, MAX_RECENT_BROWSERS);
}

/** Record the latest committed Browser URL without allowing unbounded
 *  localStorage growth. A later title update refreshes the same entry. */
export function recordRecentBrowser(
  entries: RecentBrowserEntry[],
  tab: Pick<WorkbenchTab, "url" | "title">,
  visitedAt = Date.now(),
): RecentBrowserEntry[] {
  const url = canonicalBrowsableHttpUrl(tab.url);
  if (!url) return entries;
  const title = tab.title?.trim().slice(0, 512) || "Browser";
  return normalizeRecentBrowsers([{ url, title, visitedAt }, ...entries]);
}

// One default slice PER scope, cached so selectWorkbench returns a stable
// reference for an untouched worktree (Zustand's Object.is re-render skip)
// while ids stay unique across worktrees (a worktree switch must remount the
// browser iframe — a shared id would silently reuse the previous worktree's
// page). The reducers seed from the SAME cached slice, so ids line up when
// the first mutation copies it into the store.
const defaultScopeCache = new Map<string, WorkbenchScopeState>();
const MAX_DEFAULT_SCOPE_CACHE = 256;

/** The (cached) default slice for `scope` — see defaultTabs. Never mutated. */
export function defaultScopeFor(scope: string): WorkbenchScopeState {
  let slice = defaultScopeCache.get(scope);
  if (!slice) {
    slice = defaultTabs();
    defaultScopeCache.set(scope, slice);
    while (defaultScopeCache.size > MAX_DEFAULT_SCOPE_CACHE) {
      const oldest = defaultScopeCache.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      defaultScopeCache.delete(oldest);
    }
  }
  return slice;
}

/** Migrate a persisted scope map: run each slice's tabs through
 *  normalizeWorkbenchTabs (seed/promote the pinned homes and preserve closable
 *  File/Browser tabs) and re-validate its activeId.
 *  Drops malformed slices (the per-scope default then applies). Pure (no
 *  localStorage) so it's unit-testable. */
export function migrateScopes(parsed: WorkbenchScopeMap): WorkbenchScopeMap {
  const out: WorkbenchScopeMap = {};
  for (const [scope, slice] of Object.entries(parsed ?? {}).slice(
    -MAX_PERSISTED_WORKBENCH_SCOPES,
  )) {
    if (!slice || !Array.isArray(slice.tabs)) continue;
    const tabs = normalizeWorkbenchTabs(slice.tabs);
    // A persisted activeId that no longer names a tab (including the removed
    // legacy workbench PR tab or relocated Terminal) falls back to the first File,
    // then Changes.
    const activeId =
      slice.activeId && tabs.some((t) => t.id === slice.activeId)
        ? slice.activeId
        : defaultActiveId(tabs);
    out[scope] = {
      tabs,
      activeId,
      recentBrowsers: normalizeRecentBrowsers(slice.recentBrowsers),
    };
  }
  return out;
}

/** Load every worktree's persisted tab slice. One-time: when the new key is
 *  absent, the pre-per-scope global blob is dropped and its keys cleaned up —
 *  it mixed worktrees and can't be attributed to one, so each worktree starts
 *  fresh with the default home tabs. */
export function loadScopes(): WorkbenchScopeMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SCOPES);
    if (!raw) {
      localStorage.removeItem(LEGACY_KEY_TABS);
      localStorage.removeItem(LEGACY_KEY_ACTIVE);
      return {};
    }
    const parsed = JSON.parse(raw) as WorkbenchScopeMap;
    if (!parsed || typeof parsed !== "object") return {};
    return migrateScopes(parsed);
  } catch {
    return {};
  }
}

/** Persist the whole per-worktree tab map. */
export function saveScopes(map: WorkbenchScopeMap): void {
  if (typeof window === "undefined") return;
  try {
    const bounded = Object.fromEntries(
      Object.entries(map).slice(-MAX_PERSISTED_WORKBENCH_SCOPES),
    );
    localStorage.setItem(STORAGE_KEY_SCOPES, JSON.stringify(bounded));
  } catch {
    /* quota errors ignored */
  }
}
