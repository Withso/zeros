// ──────────────────────────────────────────────────────────
// Column 3 Tab Manager — Types + localStorage persistence
// ──────────────────────────────────────────────────────────

import type { BrowserTabVariant } from "../zeros/browser/variant-types";
import {
  Diff as DiffIcon,
  Globe,
  File as FileIcon,
  GitPullRequestArrow,
  Shapes,
  type LucideIcon,
} from "lucide-react";

export type Column3TabType =
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

export interface Column3Tab {
  id: string;
  type: Column3TabType;
  title: string;
  /** Only Changes and Review are pinned. File and Browser tabs are always
   *  removable, including a blank File tab ("Open file") or Browser tab. */
  pinned?: boolean;
  /** Files + Changes tabs: the currently-open file (repo-relative POSIX path).
   *  Drives the right-pane viewer AND (Files only) the tab label. On the
   *  Changes tab it's the change selected in its sidebar; on File tabs it's
   *  optional — with none the tab shows its tree + a "select a file" viewer
   *  and is titled "Open file". */
  filePath?: string;
  /** Files/Changes tab: open the viewer in Diff mode (vs the read-only source
   *  "Edit" view). Set when the file is opened from the Changes list; cleared
   *  when opened from All Files (D2 — the default view follows the entry point,
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
export const MAX_PERSISTED_COLUMN3_SCOPES = 128;

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
 *  Diff intent (see the diff* fields on Column3Tab). */
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
): Column3Tab {
  if (!filePath.trim()) {
    throw new Error("A File tab requires a non-empty file path");
  }
  return {
    id: nextId("files"),
    type: "files",
    title: baseName(filePath),
    filePath,
    ...(opts?.diff ? { diff: true } : {}),
    ...(opts?.diffScope ? { diffScope: opts.diffScope } : {}),
    ...(opts?.diffSha ? { diffSha: opts.diffSha } : {}),
    ...(opts?.turnChatId ? { turnChatId: opts.turnChatId } : {}),
    ...(opts?.turnId ? { turnId: opts.turnId } : {}),
    ...(opts?.discardable ? { discardable: true } : {}),
    ...(opts?.isNewFile ? { isNewFile: true } : {}),
  };
}

/** Build the blank, closable File surface shown on every fresh workspace and
 *  created by + → File. Selecting a file fills this tab in place. */
export function createEmptyFilesTab(): Column3Tab {
  return {
    id: nextId("files"),
    type: "files",
    title: "Open file",
  };
}

/** How a row-1 file open resolves against the current tabs + the ACTIVE tab.
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
export type Row1OpenPlan =
  | { kind: "focus"; id: string }
  | { kind: "replace"; id: string }
  | { kind: "new" };

/** Keep expensive File surfaces lazy unless they are active or own an unsaved
 * draft. Browsers preserve iframe state; the pinned home views preserve
 * their resolved lists, PR state, and canvas viewport + decoded images. The
 * terminal panel is mounted separately below row 1. Clean, inactive File tabs
 * remain the only lazy surface. */
export function shouldMountRow1Tab(
  tab: Column3Tab,
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
 *  they don't reuse the active tab (see use-open-file-in-row1). */
export function planRow1Open(
  tabs: Column3Tab[],
  activeId: string | null,
  path: string,
  activeFileDirty = false,
): Row1OpenPlan {
  // Active File tab → ordinarily reuse it in place, even if `path` is open
  // elsewhere. A dirty editor is the one exception: replacing it with ANOTHER
  // path would unmount its path-keyed SourceEditor and lose unsaved work. Since
  // dirty inactive File tabs remain mounted, focus an existing target or open a
  // new tab while the draft stays alive in its original tab.
  const active = tabs.find((t) => t.id === activeId);
  if (active && active.type === "files") {
    if (activeFileDirty && active.filePath !== path) {
      const existing = tabs.find(
        (t) => t.id !== active.id && t.type === "files" && t.filePath === path,
      );
      return existing ? { kind: "focus", id: existing.id } : { kind: "new" };
    }
    return { kind: "replace", id: active.id };
  }
  // No active File tab to reuse (active is a Browser/non-File, or row 1 empty):
  // focus the file if it's already open, else open a fresh tab.
  const existing = tabs.find((t) => t.type === "files" && t.filePath === path);
  if (existing) return { kind: "focus", id: existing.id };
  const empty = tabs.find((t) => t.type === "files" && !t.filePath);
  if (empty) return { kind: "replace", id: empty.id };
  return { kind: "new" };
}

/** Build a closable Browser tab. Multiple Browser tabs may coexist. */
export function createBrowserTab(opts?: {
  url?: string;
  title?: string;
}): Column3Tab {
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
 *  diff viewer — see ChangesRow1Tab). One per worktree, can't be closed. Its
 *  file* fields carry the sidebar selection so it survives reloads. */
export function createChangesTab(): Column3Tab {
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
export function createReviewTab(): Column3Tab {
  return {
    id: nextId("review"),
    type: "review",
    title: "Review",
  };
}

/** Build THE Context tab — the pinned canvas over the workspace's
 *  `.context-graph/` (composer attachments + shared docs, auto-laid-out,
 *  pan/zoom only). One per worktree, can't be closed. */
export function createContextTab(): Column3Tab {
  return {
    id: nextId("context"),
    type: "context",
    title: "Context",
  };
}

export const TAB_TYPE_META: Record<Column3TabType, TabTypeMeta> = {
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
// (ReviewRow1Tab → ReviewView) — always visible, empty state without a PR.
// The old row-2 source panel (All Files / Changes / "PR #N") is gone: its
// surfaces live in row 1's Changes / Files / Review home tabs now.

// Per-worktree tab state lives under ONE key as a { [folder]: slice } map (see
// loadScopes/saveScopes). The pre-per-scope GLOBAL keys below mixed tabs from
// every worktree, so they can't be cleanly attributed — loadScopes drops them.
const STORAGE_KEY_SCOPES = "column3-tabs-by-scope-v1"; // gitleaks:allow — localStorage key name
const LEGACY_KEY_TABS = "column3-tabs"; // gitleaks:allow — legacy localStorage key name
const LEGACY_KEY_ACTIVE = "column3-active-tab-id";

/** Legacy / relocated tab types dropped from row 1's persisted state. "pr" is
 *  the OLD synthetic active-PR tab (later a row-2 source view, both gone) —
 *  the PR surface is the pinned "review" home tab now, a DIFFERENT type so a
 *  stale persisted "pr" entry still drops cleanly. "terminal" migrated out of
 *  row 1 into the always-present row-2 terminal panel. */
const REMOVED_TAB_TYPES = new Set([
  "design",
  "git",
  "env",
  "todo",
  "pr",
  "terminal",
]);
const CURRENT_TAB_TYPES = new Set<Column3TabType>([
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

/** Canonical row-1 order: the first File tab (when one exists), then the pinned
 *  Changes, Review, and Context homes, followed by all other closable
 *  File/Browser tabs in their relative order. This keeps "Open file" first
 *  without making it permanent. */
export function orderRow1Tabs(tabs: Column3Tab[]): Column3Tab[] {
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
  const firstFileIndex = closable.findIndex((t) => t.type === "files");
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

/** Enforce the row-1 invariants on a persisted tab list:
 *   • legacy types (design/git/…/pr) are dropped;
 *   • exactly ONE Changes tab — the first persisted one becomes THE pinned
 *     Changes tab (its sidebar selection survives), or one is seeded;
 *   • exactly ONE Review tab — the first persisted one is promoted, or one is
 *     seeded (always visible; its body renders an empty state without a PR);
 *   • exactly ONE Context tab — promoted or seeded the same way (pre-Context
 *     persisted slices gain it here, no storage-key bump needed);
 *   • every persisted File tab survives, including blank "Open file" tabs, and
 *     is closable (legacy pins are stripped);
 *   • every persisted Browser tab survives and is closable (legacy pins are
 *     stripped), enabling the multi-browser policy;
 *   • persisted row-1 Terminal tabs are removed (the terminal surface is row 2);
 *   • order is [first File, Changes, Review, Context, ...other closable tabs].
 *  Result never becomes empty because the pinned homes remain. */
export function normalizeRow1Tabs(parsed: Column3Tab[]): Column3Tab[] {
  // Persistence is user-editable and old builds could leave duplicate ids.
  // Validate the small structural core here so one corrupt entry cannot break
  // every workspace's React keys or multi-browser event routing.
  const seenIds = new Set<string>();
  const tabs: Column3Tab[] = [];
  for (const raw of parsed as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Partial<Column3Tab> & { type?: unknown };
    if (
      typeof candidate.type !== "string" ||
      REMOVED_TAB_TYPES.has(candidate.type) ||
      !CURRENT_TAB_TYPES.has(candidate.type as Column3TabType)
    )
      continue;
    const type = candidate.type as Column3TabType;
    const rawId = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const id =
      rawId && rawId.length <= 256 && !seenIds.has(rawId)
        ? rawId
        : nextId(type);
    seenIds.add(id);
    tabs.push({
      ...(candidate as Column3Tab),
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
  const homeChanges: Column3Tab = firstChanges
    ? {
        ...firstChanges,
        title: "Changes",
        pinned: true,
        filePath: changesFilePath,
        reviewSubtab: undefined,
        changesView: validChangesView(firstChanges.changesView),
        viewerMode: changesFilePath
          ? validViewerMode(firstChanges.viewerMode)
          : undefined,
      }
    : { ...createChangesTab(), pinned: true };
  const homeReview: Column3Tab = firstReview
    ? {
        ...firstReview,
        title: "Review",
        pinned: true,
        reviewSubtab: validReviewSubtab(firstReview.reviewSubtab),
        changesView: undefined,
        viewerMode: undefined,
      }
    : { ...createReviewTab(), pinned: true };
  const firstContext = tabs.find((t) => t.type === "context");
  const homeContext: Column3Tab = firstContext
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
        title: url ? tab.title.trim().slice(0, 512) || "Browser" : "Browser",
        url,
        canvasMode: url ? tab.canvasMode : false,
        variants: Array.isArray(tab.variants) ? tab.variants : undefined,
        reviewSubtab: undefined,
        changesView: undefined,
        viewerMode: undefined,
      };
    });
  return orderRow1Tabs([homeChanges, homeReview, homeContext, ...closable]);
}

// ── Per-worktree persistence ───────────────────────────────
// Column-3 tabs belong to a WORKTREE, not the whole app: a file opened in one
// worktree must not appear in another. State is a map keyed by the active
// worktree's folder path (the same identity chats use). The store reads the
// active slice and swaps which slice it reads on a worktree switch — see
// column3ScopeKey / selectColumn3 in workspace-store.ts.

/** One worktree's column-3 tab state. */
export interface Column3ScopeState {
  tabs: Column3Tab[];
  activeId: string | null;
  recentBrowsers: RecentBrowserEntry[];
}

/** Per-worktree tab state, keyed by the worktree's folder path. */
export type Column3ScopeMap = Record<string, Column3ScopeState>;

/** The default slice for a fresh worktree: one closable blank File tab first,
 *  then pinned Changes and Review. Row 2 owns Setup / Run / Terminal. */
export function defaultTabs(): Column3ScopeState {
  const tabs = normalizeRow1Tabs([createEmptyFilesTab()]);
  return { tabs, activeId: defaultActiveId(tabs), recentBrowsers: [] };
}

/** A fresh row lands on its first File tab; a migrated slice with no File tab
 *  falls back to Changes. */
function defaultActiveId(tabs: Column3Tab[]): string {
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
  tab: Pick<Column3Tab, "url" | "title">,
  visitedAt = Date.now(),
): RecentBrowserEntry[] {
  const url = canonicalBrowsableHttpUrl(tab.url);
  if (!url) return entries;
  const title = tab.title?.trim().slice(0, 512) || "Browser";
  return normalizeRecentBrowsers([{ url, title, visitedAt }, ...entries]);
}

// One default slice PER scope, cached so selectColumn3 returns a stable
// reference for an untouched worktree (Zustand's Object.is re-render skip)
// while ids stay unique across worktrees (a worktree switch must remount the
// browser iframe — a shared id would silently reuse the previous worktree's
// page). The reducers seed from the SAME cached slice, so ids line up when
// the first mutation copies it into the store.
const defaultScopeCache = new Map<string, Column3ScopeState>();
const MAX_DEFAULT_SCOPE_CACHE = 256;

/** The (cached) default slice for `scope` — see defaultTabs. Never mutated. */
export function defaultScopeFor(scope: string): Column3ScopeState {
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
 *  normalizeRow1Tabs (seed/promote the pinned homes and preserve closable
 *  File/Browser tabs) and re-validate its activeId.
 *  Drops malformed slices (the per-scope default then applies). Pure (no
 *  localStorage) so it's unit-testable. */
export function migrateScopes(parsed: Column3ScopeMap): Column3ScopeMap {
  const out: Column3ScopeMap = {};
  for (const [scope, slice] of Object.entries(parsed ?? {}).slice(
    -MAX_PERSISTED_COLUMN3_SCOPES,
  )) {
    if (!slice || !Array.isArray(slice.tabs)) continue;
    const tabs = normalizeRow1Tabs(slice.tabs);
    // A persisted activeId that no longer names a tab (including the removed
    // legacy row-1 PR tab or relocated Terminal) falls back to the first File,
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
export function loadScopes(): Column3ScopeMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SCOPES);
    if (!raw) {
      localStorage.removeItem(LEGACY_KEY_TABS);
      localStorage.removeItem(LEGACY_KEY_ACTIVE);
      return {};
    }
    const parsed = JSON.parse(raw) as Column3ScopeMap;
    if (!parsed || typeof parsed !== "object") return {};
    return migrateScopes(parsed);
  } catch {
    return {};
  }
}

/** Persist the whole per-worktree tab map. */
export function saveScopes(map: Column3ScopeMap): void {
  if (typeof window === "undefined") return;
  try {
    const bounded = Object.fromEntries(
      Object.entries(map).slice(-MAX_PERSISTED_COLUMN3_SCOPES),
    );
    localStorage.setItem(STORAGE_KEY_SCOPES, JSON.stringify(bounded));
  } catch {
    /* quota errors ignored */
  }
}
