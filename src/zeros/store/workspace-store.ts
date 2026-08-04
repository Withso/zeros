// ──────────────────────────────────────────────────────────
// workspace-store — Zustand store for workspace / shell state
// ──────────────────────────────────────────────────────────
//
// Migration (2026-05-31; see docs/workspace-state-and-performance.md).
// This replaces the React Context + `useReducer` that used to live in
// `store.tsx`. Every consumer of that single Context value re-rendered on
// ANY state change (active chat, selection, drafts, project meta, …). The
// sessions store (`../agent/sessions-store.ts`) already proved the fix:
// hold state in Zustand, let each consumer subscribe to the narrow slice it
// reads, and unrelated changes no longer wake it.
//
// Fidelity guarantee: the EXACT original `reducer`, `Action` union, and
// `initialState` are reused verbatim as the store's engine — no state-
// transition logic was rewritten (that's where regressions hide). Zustand
// only changes how state is *held* and *subscribed to*. `dispatch(action)`
// is preserved 1:1 so every existing `dispatch({ type: ... })` call site
// keeps working unchanged while surfaces migrate to selectors.
//
// No-op preservation: the reducer returns the SAME state reference for
// no-ops (e.g. CONSUME_* id mismatch, REMOVE last tab). `set((s) =>
// reducer(s, a))` then hands Zustand back the identical reference, which
// its `Object.is` check treats as a no-op — so the reducer's no-op short-
// circuits still suppress re-renders exactly as under `useReducer`.
// ──────────────────────────────────────────────────────────

import { create } from "zustand";

import { loadAiSettings } from "../lib/openai";
import { normalizeChatPermissionMode } from "./chat-permission";
import {
  loadCachedChatsForBoot,
  loadLegacyActiveChatId,
} from "./chat-boot-cache";
import { resolveBootActiveChatId } from "./boot-active-chat";
import { setSetting } from "../../native/settings";
import { ACTIVE_CHAT_KEY } from "./chats-local-cache";
import {
  blankFixedFilesTab,
  loadScopes,
  saveScopes,
  defaultScopeFor,
  defaultTabs,
  MAX_PERSISTED_COLUMN3_SCOPES,
  orderRow1Tabs,
  recordRecentBrowser,
  type Column3Tab,
  type Column3ScopeState,
} from "../../shell/column3-tab-manager";
import {
  loadPersistedUiState,
  schedulePersistUiState,
} from "./persist-ui-state";
import {
  loadPersistedDrafts,
  schedulePersistDrafts,
} from "./persist-composer-drafts";
import { loadProjects } from "./projects-store";
import {
  findProjectForFolder,
  folderIsOwnedByProject,
  folderIsWithinRoot,
} from "./workspace-resolution";
import type {
  AiSettings,
  AppView,
  BrowserPickerSelection,
  ChatThread,
  ComposerDraft,
  EditDraftStash,
  HomePage,
  PendingChatSubmission,
  PendingComposerAppend,
  ProjectConnection,
  RepoPageView,
  WorkspacePage,
  WorkspaceState,
} from "./store";

/** Normalize a chat's persisted permission posture to the current vocabulary
 *  (legacy full/auto-edit/ask/plan-only → plan/auto/tool-approval/danger) as it
 *  enters the store from disk / cross-device sync. Returns the same object when
 *  already current, so unchanged chats keep referential identity. */
function migrateChatPermission(c: ChatThread): ChatThread {
  const norm = normalizeChatPermissionMode(c.permissionMode);
  return norm === c.permissionMode ? c : { ...c, permissionMode: norm };
}

// ──────────────────────────────────────────────────────────
// Action union (moved verbatim from store.tsx)
// ──────────────────────────────────────────────────────────
export type Action =
  | {
      type: "SET_BROWSER_PICKER_SELECTION";
      selection: BrowserPickerSelection | null;
    }
  | { type: "SET_ACTIVE_PAGE"; page: WorkspacePage }
  /** Return to Home's last complete destination in one store snapshot. */
  | { type: "OPEN_HOME" }
  // A workspace click changes route + chat/scope as one store snapshot. This
  // prevents subscribers from observing the new page with the previous
  // workspace's chat between two dispatches.
  | {
      type: "OPEN_WORKSPACE";
      folder: string;
      repoRoot: string;
      chatId: string | null;
      /** Cold remembered target: suppress destructive/default work until the
       * exact repository workspace snapshot confirms it. */
      validationPending?: boolean;
      /** Repoint the active-workspace pointers (chat / folder / scope) WITHOUT
       *  leaving the current page. Set by the archive/delete repoint so removing
       *  the active workspace from a full-window Home page (Dashboard / Repo /
       *  Settings) fixes the underlying selection but keeps the user on that page
       *  instead of yanking them into the workspace view. Defaults to false — a
       *  normal open always switches to "workspace". */
      preservePage?: boolean;
    }
  | { type: "CONFIRM_WORKSPACE_TARGET"; folder: string }
  /** Clear a disappearing workspace before destructive owner teardown. */
  | { type: "CLEAR_WORKSPACE_TARGET" }
  // Open the Home tab's repo page for one project. A dedicated action (not a
  // SET_ACTIVE_PAGE payload) so the page and its target repo change atomically
  // — no frame where activePage is "repo" but activeRepoId still points at the
  // previous repo.
  | {
      type: "OPEN_REPO_PAGE";
      projectId: string;
      /** Explicit deep-link view; omitted means restore this repo's memory. */
      view?: RepoPageView;
    }
  | {
      type: "SET_REPO_PAGE_VIEW";
      projectId: string;
      view: RepoPageView;
    }
  | {
      type: "REMOVE_REPO_UI_STATE";
      projectId: string;
      repoRoot: string;
      workspaceFolders?: string[];
    }
  | {
      type: "REMOVE_WORKSPACE_UI_STATE";
      folder: string;
      repoRoot: string;
    }
  /** A confirmed restore had to use a new path. Move every folder-owned
   * selection and chat in the same store transition as the destination. */
  | {
      type: "MOVE_WORKSPACE_UI_STATE";
      fromFolder: string;
      toFolder: string;
      repoRoot: string;
    }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_VIEW"; view: AppView }
  | { type: "CONNECT_PROJECT"; project: ProjectConnection }
  | {
      type: "UPDATE_PROJECT_STATUS";
      status: ProjectConnection["status"];
      errorMessage?: string;
    }
  | { type: "DISCONNECT_PROJECT" }
  | { type: "SET_AI_SETTINGS"; settings: AiSettings }
  // Chat threading (Phase 1B-e)
  | { type: "HYDRATE_CHATS"; chats: ChatThread[]; activeChatId: string | null }
  | { type: "MERGE_CHATS"; chats: ChatThread[] }
  | {
      type: "ADD_CHAT";
      chat: ChatThread;
      /** Creation deep link: publish the workspace route with the new chat. */
      openWorkspace?: {
        repoRoot: string;
        /** The announced worktree is exact but not published by the engine yet. */
        validationPending?: boolean;
      };
    }
  | { type: "SET_ACTIVE_CHAT"; id: string | null }
  | { type: "DELETE_CHAT"; id: string }
  | { type: "ARCHIVE_CHAT"; id: string }
  | { type: "UNARCHIVE_CHAT"; id: string }
  | { type: "UPDATE_CHAT_TITLE"; id: string; title: string }
  /** Compare-and-swap rename for the background AI chat-title call: applies
   *  only while the chat still shows `expectedTitle` (the snippet the call
   *  raced), so a manual rename in the meantime always wins. */
  | {
      type: "UPDATE_CHAT_TITLE_IF";
      id: string;
      title: string;
      expectedTitle: string;
    }
  | {
      type: "UPDATE_CHAT_SETTINGS";
      id: string;
      updates: Partial<
        Pick<
          ChatThread,
          | "model"
          | "effort"
          | "fast"
          | "additionalDirectories"
          | "permissionMode"
          | "lastModeId"
          | "prePlanModeId"
          | "agentId"
          | "agentName"
          | "sessionId"
          | "sourceChatId"
          | "folder"
        >
      >;
    }
  | { type: "TOUCH_CHAT"; id: string }
  | { type: "TOGGLE_PIN_CHAT"; id: string }
  // Phase D3 (2026-05-08): per-surface composer drafts. See comment
  // on `chatComposerDrafts` in WorkspaceState.
  | { type: "SET_CHAT_DRAFT"; chatId: string; draft: ComposerDraft }
  | { type: "CLEAR_CHAT_DRAFT"; chatId: string }
  | {
      type: "SET_EDIT_DRAFT";
      chatId: string;
      messageId: string;
      stash: EditDraftStash;
    }
  | { type: "CLEAR_EDIT_DRAFT"; chatId: string; messageId: string }
  // Auto-submit into Column 2 chat (Phase 2-B)
  | { type: "ENQUEUE_CHAT_SUBMISSION"; submission: PendingChatSubmission }
  | { type: "CONSUME_CHAT_SUBMISSION"; id: string }
  // New-workspace dispatcher one-shot: auto-send a freshly-created chat's
  // SEEDED composer the moment its session is ready. Unlike
  // ENQUEUE_CHAT_SUBMISSION (which carries the text and bypasses the editor),
  // this lets the mounted AgentChat serialize its own seeded composer — full
  // fidelity for inline mentions + attachments with zero duplication of
  // handleSend. Set by the dispatcher's "Create" (when a prompt was typed),
  // consumed by AgentChat.
  | { type: "REQUEST_AUTO_SEND"; chatId: string }
  | { type: "CONSUME_AUTO_SEND"; chatId: string }
  | { type: "ENQUEUE_COMPOSER_APPEND"; append: PendingComposerAppend }
  | { type: "CONSUME_COMPOSER_APPEND"; id: string }
  // EmptyComposer scope override — see newAgentFolder doc on WorkspaceState.
  | { type: "SET_NEW_AGENT_FOLDER"; folder: string | null }
  | { type: "BUMP_PROJECT_GENERATION" }
  // Column 3 tabs (Roadmap 03b)
  | { type: "RESET_COLUMN3_TABS" }
  | {
      type: "ADD_COLUMN3_TAB";
      tab: Column3Tab;
      activate?: boolean;
      /** Exact owner for delayed/background opens. Omitted for active UI. */
      scope?: string;
    }
  | { type: "REMOVE_COLUMN3_TAB"; id: string }
  | {
      type: "CLOSE_COLUMN3_FILE_IF_MATCHES";
      id: string;
      path: string;
      /** The worktree where the delayed close was scheduled. */
      scope: string;
    }
  | { type: "ACTIVATE_COLUMN3_TAB"; id: string; scope?: string }
  | { type: "REORDER_COLUMN3_TABS"; ids: string[] }
  | {
      type: "UPDATE_COLUMN3_TAB";
      id: string;
      updates: Partial<Omit<Column3Tab, "id" | "type">>;
      /** Explicit persisted scope for retained Browser surfaces. Omitted by
       * ordinary active-workspace controls. */
      scope?: string;
    }
  | {
      /** Update a nested destination and focus its owning tab atomically. */
      type: "OPEN_COLUMN3_TAB";
      id: string;
      updates?: Partial<Omit<Column3Tab, "id" | "type">>;
      scope?: string;
    }
  /** Reconcile an async discard with the File tabs in the workspace where the
   *  operation STARTED. `scope` is explicit so switching worktrees while git is
   *  running can never close/update a same-named file in the new workspace. */
  | {
      type: "RECONCILE_COLUMN3_FILE_DISCARD";
      scope: string;
      path: string;
      outcome: "removed" | "reverted";
    };

// ──────────────────────────────────────────────────────────
// Initial state (moved verbatim from store.tsx)
// ──────────────────────────────────────────────────────────
// Hydrate the reload-survivable slice synchronously. `loadPersistedUiState`
// is type-guarded — bad / missing fields fall back to the defaults below,
// so a corrupt localStorage entry can never crash the store.
const persistedUiState = loadPersistedUiState();

// Composer drafts (chat / empty / edit). Previously volatile-by-design;
// flipped to persistent so reload doesn't lose an in-flight prompt.
// Each record is type-guarded on read — corrupt entries become empty.
const persistedDrafts = loadPersistedDrafts();
const bootChats = loadCachedChatsForBoot().map(migrateChatPermission);
const persistedActiveChatId =
  "activeChatId" in persistedUiState
    ? (persistedUiState.activeChatId ?? null)
    : loadLegacyActiveChatId();
const bootActiveChatId = resolveBootActiveChatId(
  bootChats,
  persistedActiveChatId,
  {
    lastWorkspaceFolder: persistedUiState.lastWorkspaceFolder ?? null,
    activeChatByFolder: persistedUiState.activeChatByFolder ?? {},
  },
);

const MAX_SCOPED_NAV_ENTRIES = 128;
const MAX_ACTIVE_CHAT_MEMORIES = 512;

/** Write one scoped navigation value without allowing persisted maps to grow
 * forever. A touched key moves to the tail, making eviction MRU-like. */
function setBoundedRecord<T>(
  record: Record<string, T>,
  key: string,
  value: T,
  limit = MAX_SCOPED_NAV_ENTRIES,
): Record<string, T> {
  if (record[key] === value && Object.keys(record).length <= limit) {
    return record;
  }
  const next = { ...record };
  delete next[key];
  next[key] = value;
  const keys = Object.keys(next);
  for (let index = 0; index < keys.length - limit; index += 1) {
    delete next[keys[index]];
  }
  return next;
}

function removeRecordKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function removeRecordKeysMatching<T>(
  record: Record<string, T>,
  matches: (key: string) => boolean,
): Record<string, T> {
  if (!Object.keys(record).some(matches)) return record;
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !matches(key)),
  );
}

function moveRecordKeysMatching<T>(
  record: Record<string, T>,
  matches: (key: string) => boolean,
  move: (key: string) => string,
): Record<string, T> {
  const entries = Object.entries(record);
  if (!entries.some(([key]) => matches(key))) return record;
  const next: Record<string, T> = {};
  // Preserve an already-existing destination over stale state being moved into
  // it. A normal adapted restore targets a fresh sibling, so this is only the
  // conservative collision behavior.
  for (const [key, value] of entries) {
    if (!matches(key)) next[key] = value;
  }
  for (const [key, value] of entries) {
    if (!matches(key)) continue;
    const destination = move(key);
    if (!(destination in next)) next[destination] = value;
  }
  return next;
}

function setColumn3Scope(
  record: WorkspaceState["column3ByScope"],
  scope: string,
  value: Column3ScopeState,
): WorkspaceState["column3ByScope"] {
  return setBoundedRecord(record, scope, value, MAX_PERSISTED_COLUMN3_SCOPES);
}

/** Seed the new per-repository memory from the former global workspace value
 * on upgrade. The old field remains the boot/display fallback. */
function initialWorkspaceByRepoRoot(): Record<string, string> {
  const restored = persistedUiState.lastWorkspaceByRepoRoot ?? {};
  if (Object.keys(restored).length > 0) return restored;
  const folder = persistedUiState.lastWorkspaceFolder;
  if (!folder) return {};
  const project = findProjectForFolder(folder, loadProjects());
  return project ? { [project.repoRoot]: folder } : {};
}

/** A restored managed/adopted worktree may have been deleted while the app was
 * closed. Paint its last confirmed snapshot immediately, but suppress default
 * chat creation until the live exact-repository list validates the owner. Main
 * checkout folders are safe without that round trip. */
function initialPendingWorkspaceValidation(): string | null {
  if ((persistedUiState.activePage ?? "workspace") !== "workspace") return null;
  const activeChatFolder = bootActiveChatId
    ? bootChats.find((chat) => chat.id === bootActiveChatId)?.folder
    : null;
  const folder =
    activeChatFolder ||
    persistedUiState.newAgentFolder ||
    persistedUiState.lastWorkspaceFolder;
  if (!folder) return null;
  const project = findProjectForFolder(folder, loadProjects());
  if (!project || folderIsWithinRoot(folder, project.repoRoot)) return null;
  return folder;
}

const initialState: WorkspaceState = {
  currentView: "workspace",
  project: null,
  browserPickerSelection: null,
  activePage: persistedUiState.activePage ?? "workspace",
  lastHomePage: persistedUiState.lastHomePage ?? "dashboard",
  // Restored with activePage so a reload on a repo page reopens the same repo.
  // persist-ui-state guarantees the pair is consistent (a persisted "repo"
  // page without an id falls back to the Dashboard on read).
  activeRepoId: persistedUiState.activeRepoId ?? null,
  repoPageViewByProject: persistedUiState.repoPageViewByProject ?? {},
  isLoading: false,
  aiSettings: loadAiSettings(),
  // The validated local snapshot is available before React mounts. SQLite is
  // still authoritative and revalidates in ChatsPersistence, but cold start no
  // longer paints a null chat and repairs it in a post-paint effect.
  chats: bootChats,
  activeChatId: bootActiveChatId,
  pendingChatSubmission: null,
  pendingAutoSend: {},
  pendingComposerAppend: null,
  // Restored from persist-ui-state so a reload mid-Untitled-tab keeps
  // Column 1 / topbar / tabs / EmptyComposer all agreeing on the same
  // workspace. Without this, those four surfaces diverge after Cmd+R.
  newAgentFolder: persistedUiState.newAgentFolder ?? null,
  // Restored from persist-ui-state so the app reopens on the SAME workspace
  // the user left — resolved synchronously at boot, before HYDRATE_CHATS, so
  // the topbar/tabs never flash "No workspace selected". See WorkspaceState.
  lastWorkspaceFolder: persistedUiState.lastWorkspaceFolder ?? null,
  lastWorkspaceByRepoRoot: initialWorkspaceByRepoRoot(),
  pendingWorkspaceValidationFolder: initialPendingWorkspaceValidation(),
  // Per-workspace last-active chat, restored from persist-ui-state so that
  // switching back to a workspace after a reload still lands on the chat the
  // user was viewing there. See rememberActiveChatForFolder below.
  activeChatByFolder: persistedUiState.activeChatByFolder ?? {},
  projectGeneration: 0,
  chatComposerDrafts: persistedDrafts.chats,
  editComposerDrafts: persistedDrafts.edits,
  // Column-3 tabs, hydrated per worktree (keyed by folder path). See
  // selectColumn3 / column3ScopeKey below.
  column3ByScope: loadScopes(),
};

// ──────────────────────────────────────────────────────────
// Active-workspace folder resolution (shared by every Column 2 surface)
// ──────────────────────────────────────────────────────────
// The active workspace is DERIVED from a folder path. Three surfaces — the
// topbar breadcrumb, the chat-tabs strip, and useActiveWorkspace — must resolve
// it identically, so they all go through `selectActiveFolder`. The `||` (not
// `??`) chain treats an empty-string folder as "unset" and falls through, so a
// legacy chat with `folder: ""` degrades to the last workspace instead of
// "No workspace selected". `lastWorkspaceFolder` is the persisted boot fallback.

/** The LIVE active-workspace folder: the active chat's folder, else the
 *  empty-composer scope. Null when neither is set. Used to decide what to
 *  remember (we never remember an empty/cleared context). */
export function selectLiveFolder(s: WorkspaceState): string | null {
  const activeChat = s.activeChatId
    ? (s.chats.find((c) => c.id === s.activeChatId) ?? null)
    : null;
  return activeChat?.folder || s.newAgentFolder || null;
}

/** The active-workspace folder for DISPLAY/resolution, with the persisted
 *  `lastWorkspaceFolder` as the final fallback so a fresh boot (chats not yet
 *  hydrated) still resolves the workspace the user left. */
export function selectActiveFolder(s: WorkspaceState): string | null {
  return selectLiveFolder(s) || s.lastWorkspaceFolder || null;
}

/** Keep `lastWorkspaceFolder` mirroring the live active-workspace folder so a
 *  reopen lands on the same workspace. Never clears it — leaving for the empty
 *  composer or closing every chat shouldn't forget where you were. Runs after
 *  every dispatch; a no-op reducer result (same live folder) returns the SAME
 *  reference, preserving Zustand's Object.is no-op skip. */
function rememberActiveFolder(next: WorkspaceState): WorkspaceState {
  const live = selectLiveFolder(next);
  if (!live) return next;
  // Hot chat/session actions overwhelmingly keep the same folder. OPEN_WORKSPACE
  // and the boot migration already attribute that identity, so bail before the
  // project-registry read on every unrelated streaming/draft update.
  if (live === next.lastWorkspaceFolder) return next;
  const project = findProjectForFolder(live, loadProjects());
  return {
    ...next,
    lastWorkspaceFolder: live,
    lastWorkspaceByRepoRoot: project
      ? setBoundedRecord(next.lastWorkspaceByRepoRoot, project.repoRoot, live)
      : next.lastWorkspaceByRepoRoot,
  };
}

/** Repository-switch destination. Main is the safe default only when that
 * repository has no remembered selection. */
export function selectLastWorkspaceFolderForRepo(
  s: WorkspaceState,
  repoRoot: string,
): string {
  return s.lastWorkspaceByRepoRoot[repoRoot] ?? repoRoot;
}

/** Repository hub view with an independent default per project. */
export function selectRepoPageView(
  s: WorkspaceState,
  projectId: string,
): RepoPageView {
  return s.repoPageViewByProject[projectId] ?? "workspaces";
}

/** Remember the last-active chat PER workspace folder so returning to a
 *  workspace restores the chat the user was VIEWING — not the most recently
 *  *edited* one. Merely selecting/viewing a chat never bumps `updatedAt`, so
 *  the old `updatedAt DESC` pick (column1's chatsByWorkspace) silently jumped
 *  to whichever chat had the latest activity and lost the user's place. Mirrors
 *  rememberActiveFolder: runs after every dispatch, keyed off the live active
 *  chat. A null active chat (empty composer, just-archived) leaves the prior
 *  memory intact — tabbing to the new-agent surface shouldn't forget which chat
 *  was open. A same-reference no-op return preserves Zustand's Object.is skip.
 *  Stale entries (deleted/archived/moved chats) are harmless because restore
 *  validates against the live chat list (selectActiveChatForFolder). The map is
 *  also bounded so years of removed worktrees cannot grow boot storage forever. */
function rememberActiveChatForFolder(next: WorkspaceState): WorkspaceState {
  const id = next.activeChatId;
  if (!id) return next;
  const folder = next.chats.find((c) => c.id === id)?.folder;
  if (!folder) return next;
  if (next.activeChatByFolder[folder] === id) return next;
  return {
    ...next,
    activeChatByFolder: setBoundedRecord(
      next.activeChatByFolder,
      folder,
      id,
      MAX_ACTIVE_CHAT_MEMORIES,
    ),
  };
}

/** The chat id the user was last viewing in `folder`, but only if that chat is
 *  still live and still belongs to the folder — else null so the caller falls
 *  back to its default pick. Pure; used by the workspace-switch handlers in
 *  column1 to restore the user's place. */
export function selectActiveChatForFolder(
  s: WorkspaceState,
  folder: string | null,
): string | null {
  if (!folder) return null;
  const id = s.activeChatByFolder[folder];
  if (!id) return null;
  const chat = s.chats.find((c) => c.id === id);
  return chat && !chat.archived && chat.folder === folder ? id : null;
}

/** The most-recently-touched LIVE chat in `folder`, or null. Pure. */
export function selectMostRecentChatForFolder(
  s: WorkspaceState,
  folder: string | null,
): string | null {
  if (!folder) return null;
  let best: ChatThread | null = null;
  for (const c of s.chats) {
    if (c.archived || c.folder !== folder) continue;
    if (!best || (c.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = c;
  }
  return best?.id ?? null;
}

/** THE chat to land on when a workspace comes into view: the chat the user was
 *  last VIEWING there (validated), else the most-recently-touched live chat at
 *  that path, else null (caller then auto-spawns a default chat — the app-wide
 *  invariant since 2026-07-06 is that a workspace in view ALWAYS has an active
 *  chat; Column 2 renders a dead pane otherwise). Pure; shared by the boot
 *  hydrator, the column-1/workspace-open handlers, and the tab strip's
 *  selection keeper so the pick can never drift between surfaces. */
export function selectChatToRestoreForFolder(
  s: WorkspaceState,
  folder: string | null,
): string | null {
  return (
    selectActiveChatForFolder(s, folder) ??
    selectMostRecentChatForFolder(s, folder)
  );
}

// ──────────────────────────────────────────────────────────
// Column-3 tabs — scoped per worktree (folder path)
// ──────────────────────────────────────────────────────────
// Tabs belong to a worktree, not the app — a file opened in one worktree must
// not appear in another. The scope key is the active worktree's folder (the
// same identity chats use); switching worktrees just reads a different slice
// (no remount, so column 3's terminal panel and resize state survive).

/** The key under which the ACTIVE worktree's tab slice lives — its folder path,
 *  or a sentinel for the ambient/no-folder scope. */
export function column3ScopeKey(s: WorkspaceState): string {
  return column3ScopeForFolder(selectActiveFolder(s));
}

/** Normalize a workspace folder into the same key used by column3ScopeKey.
 *  Async file operations carry this key explicitly to avoid cross-worktree
 *  races after the active workspace changes. */
export function column3ScopeForFolder(folder: string | null): string {
  if (!folder) return "__ambient__";
  return folder.replace(/\/+$/, "") || "/";
}

/** The ACTIVE worktree's row-1 tab slice, or its cached default home tabs,
 *  before the user has touched tabs in this worktree. Returns a
 *  stable reference per scope, so the selector hooks below don't re-render on
 *  unrelated state changes. */
export function selectColumn3(s: WorkspaceState): Column3ScopeState {
  const scope = column3ScopeKey(s);
  return s.column3ByScope[scope] ?? defaultScopeFor(scope);
}

/** Remove one or more tabs while preserving the close-neighbor policy: if the
 *  active tab is removed, prefer the first survivor to its right, then the
 *  nearest survivor to its left. Shared by ordinary close, invariant repair,
 *  and discard of a path that may be open in duplicate tabs. */
function removeColumn3Tabs(
  cur: Column3ScopeState,
  shouldRemove: (tab: Column3Tab) => boolean,
): Column3ScopeState {
  const removed = new Set(cur.tabs.filter(shouldRemove).map((t) => t.id));
  if (removed.size === 0) return cur;

  const tabs = cur.tabs.filter((t) => !removed.has(t.id));
  if (!cur.activeId || !removed.has(cur.activeId)) {
    return { ...cur, tabs, activeId: cur.activeId };
  }

  const activeIndex = cur.tabs.findIndex((t) => t.id === cur.activeId);
  const right = cur.tabs.slice(activeIndex + 1).find((t) => !removed.has(t.id));
  const left = cur.tabs
    .slice(0, activeIndex)
    .reverse()
    .find((t) => !removed.has(t.id));
  return { ...cur, tabs, activeId: right?.id ?? left?.id ?? null };
}

// ──────────────────────────────────────────────────────────
// Reducer (moved verbatim from store.tsx)
// ──────────────────────────────────────────────────────────
function reducer(state: WorkspaceState, action: Action): WorkspaceState {
  switch (action.type) {
    case "SET_BROWSER_PICKER_SELECTION":
      return { ...state, browserPickerSelection: action.selection };
    case "SET_ACTIVE_PAGE":
      if (action.page === "workspace") {
        if (state.activePage === "workspace") return state;
        return { ...state, activePage: action.page };
      }
      if (action.page === "repo" && !state.activeRepoId) {
        return {
          ...state,
          activePage: "dashboard",
          lastHomePage: "dashboard",
          pendingWorkspaceValidationFolder: null,
        };
      }
      if (
        state.activePage === action.page &&
        state.lastHomePage === action.page &&
        state.pendingWorkspaceValidationFolder === null
      ) {
        return state;
      }
      return {
        ...state,
        activePage: action.page,
        lastHomePage: action.page as HomePage,
        pendingWorkspaceValidationFolder: null,
      };
    case "OPEN_HOME": {
      const page =
        state.lastHomePage === "repo" && !state.activeRepoId
          ? "dashboard"
          : state.lastHomePage;
      if (
        state.activePage === page &&
        state.lastHomePage === page &&
        state.pendingWorkspaceValidationFolder === null
      ) {
        return state;
      }
      return {
        ...state,
        activePage: page,
        lastHomePage: page,
        pendingWorkspaceValidationFolder: null,
      };
    }
    case "OPEN_WORKSPACE": {
      const newAgentFolder = action.chatId ? null : action.folder;
      const pendingWorkspaceValidationFolder = action.validationPending
        ? action.folder
        : null;
      const lastWorkspaceByRepoRoot = setBoundedRecord(
        state.lastWorkspaceByRepoRoot,
        action.repoRoot,
        action.folder,
      );
      // A repoint (preservePage) fixes the active-workspace target but must not
      // navigate — it keeps whatever page is showing (e.g. the Dashboard). A
      // normal open always lands on the workspace view.
      const nextActivePage = action.preservePage
        ? state.activePage
        : "workspace";
      if (
        state.activePage === nextActivePage &&
        state.activeChatId === action.chatId &&
        state.newAgentFolder === newAgentFolder &&
        state.lastWorkspaceFolder === action.folder &&
        state.lastWorkspaceByRepoRoot === lastWorkspaceByRepoRoot &&
        state.pendingWorkspaceValidationFolder ===
          pendingWorkspaceValidationFolder
      ) {
        return state;
      }
      return {
        ...state,
        activePage: nextActivePage,
        activeChatId: action.chatId,
        newAgentFolder,
        lastWorkspaceFolder: action.folder,
        lastWorkspaceByRepoRoot,
        pendingWorkspaceValidationFolder,
      };
    }
    case "CONFIRM_WORKSPACE_TARGET":
      if (
        state.pendingWorkspaceValidationFolder !== action.folder ||
        selectActiveFolder(state) !== action.folder
      ) {
        return state;
      }
      return { ...state, pendingWorkspaceValidationFolder: null };
    case "CLEAR_WORKSPACE_TARGET":
      if (
        state.activeChatId === null &&
        state.newAgentFolder === null &&
        state.lastWorkspaceFolder === null &&
        state.pendingWorkspaceValidationFolder === null
      ) {
        return state;
      }
      return {
        ...state,
        activeChatId: null,
        newAgentFolder: null,
        lastWorkspaceFolder: null,
        pendingWorkspaceValidationFolder: null,
      };
    case "OPEN_REPO_PAGE": {
      const repoPageViewByProject = action.view
        ? setBoundedRecord(
            state.repoPageViewByProject,
            action.projectId,
            action.view,
          )
        : state.repoPageViewByProject;
      if (
        state.activePage === "repo" &&
        state.lastHomePage === "repo" &&
        state.activeRepoId === action.projectId &&
        state.pendingWorkspaceValidationFolder === null &&
        state.repoPageViewByProject === repoPageViewByProject
      ) {
        return state;
      }
      return {
        ...state,
        activePage: "repo",
        lastHomePage: "repo",
        activeRepoId: action.projectId,
        pendingWorkspaceValidationFolder: null,
        repoPageViewByProject,
      };
    }
    case "SET_REPO_PAGE_VIEW": {
      if (state.repoPageViewByProject[action.projectId] === action.view) {
        return state;
      }
      return {
        ...state,
        repoPageViewByProject: setBoundedRecord(
          state.repoPageViewByProject,
          action.projectId,
          action.view,
        ),
      };
    }
    case "REMOVE_REPO_UI_STATE": {
      const removedFolders = [
        action.repoRoot,
        ...(action.workspaceFolders ?? []),
      ].filter(Boolean);
      const projects = loadProjects();
      const folderWasRemoved = (folder: string) =>
        folderIsOwnedByProject(
          folder,
          action.projectId,
          projects,
          removedFolders,
        );
      const removedActiveRepo = state.activeRepoId === action.projectId;
      const repoPageViewByProject = removeRecordKey(
        state.repoPageViewByProject,
        action.projectId,
      );
      const lastWorkspaceByRepoRoot = removeRecordKey(
        state.lastWorkspaceByRepoRoot,
        action.repoRoot,
      );
      const removedVisibleRepo =
        removedActiveRepo && state.activePage === "repo";
      const activeChatFolder = state.activeChatId
        ? state.chats.find((chat) => chat.id === state.activeChatId)?.folder
        : null;
      const lastWorkspaceFolder =
        state.lastWorkspaceFolder && folderWasRemoved(state.lastWorkspaceFolder)
          ? null
          : state.lastWorkspaceFolder;
      return {
        ...state,
        activePage: removedVisibleRepo ? "dashboard" : state.activePage,
        lastHomePage:
          removedActiveRepo && state.lastHomePage === "repo"
            ? "dashboard"
            : state.lastHomePage,
        activeRepoId: removedActiveRepo ? null : state.activeRepoId,
        activeChatId:
          activeChatFolder && folderWasRemoved(activeChatFolder)
            ? null
            : state.activeChatId,
        repoPageViewByProject,
        lastWorkspaceByRepoRoot,
        lastWorkspaceFolder,
        newAgentFolder:
          state.newAgentFolder && folderWasRemoved(state.newAgentFolder)
            ? null
            : state.newAgentFolder,
        activeChatByFolder: removeRecordKeysMatching(
          state.activeChatByFolder,
          folderWasRemoved,
        ),
        column3ByScope: removeRecordKeysMatching(
          state.column3ByScope,
          folderWasRemoved,
        ),
        pendingWorkspaceValidationFolder:
          state.pendingWorkspaceValidationFolder &&
          folderWasRemoved(state.pendingWorkspaceValidationFolder)
            ? null
            : state.pendingWorkspaceValidationFolder,
      };
    }
    case "REMOVE_WORKSPACE_UI_STATE": {
      const projects = loadProjects();
      const project = findProjectForFolder(action.repoRoot, projects);
      const folderWasRemoved = (folder: string) =>
        folderIsWithinRoot(folder, action.folder) &&
        (!project ||
          folderIsOwnedByProject(folder, project.id, projects, [
            action.folder,
          ]));
      const activeChatRemoved = state.activeChatId
        ? state.chats.some(
            (chat) =>
              chat.id === state.activeChatId && folderWasRemoved(chat.folder),
          )
        : false;
      const remembered = folderWasRemoved(
        state.lastWorkspaceByRepoRoot[action.repoRoot] ?? "",
      )
        ? setBoundedRecord(
            state.lastWorkspaceByRepoRoot,
            action.repoRoot,
            action.repoRoot,
          )
        : state.lastWorkspaceByRepoRoot;
      return {
        ...state,
        activeChatId: activeChatRemoved ? null : state.activeChatId,
        lastWorkspaceByRepoRoot: remembered,
        lastWorkspaceFolder:
          state.lastWorkspaceFolder &&
          folderWasRemoved(state.lastWorkspaceFolder)
            ? action.repoRoot
            : state.lastWorkspaceFolder,
        newAgentFolder:
          state.newAgentFolder && folderWasRemoved(state.newAgentFolder)
            ? null
            : state.newAgentFolder,
        activeChatByFolder: removeRecordKeysMatching(
          state.activeChatByFolder,
          folderWasRemoved,
        ),
        column3ByScope: removeRecordKeysMatching(
          state.column3ByScope,
          folderWasRemoved,
        ),
        pendingWorkspaceValidationFolder:
          state.pendingWorkspaceValidationFolder &&
          folderWasRemoved(state.pendingWorkspaceValidationFolder)
            ? null
            : state.pendingWorkspaceValidationFolder,
      };
    }
    case "MOVE_WORKSPACE_UI_STATE": {
      if (
        !action.fromFolder ||
        !action.toFolder ||
        action.fromFolder === action.toFolder
      ) {
        return state;
      }
      const projects = loadProjects();
      const project = findProjectForFolder(action.repoRoot, projects);
      const belongsToMovedWorkspace = (folder: string) =>
        folderIsWithinRoot(folder, action.fromFolder) &&
        (!project ||
          folderIsOwnedByProject(folder, project.id, projects, [
            action.fromFolder,
          ]));
      const moveFolder = (folder: string) =>
        action.toFolder + folder.slice(action.fromFolder.length);
      const moveMaybe = (folder: string | null) =>
        folder && belongsToMovedWorkspace(folder) ? moveFolder(folder) : folder;
      const remembered = state.lastWorkspaceByRepoRoot[action.repoRoot];
      return {
        ...state,
        chats: state.chats.map((chat) =>
          belongsToMovedWorkspace(chat.folder)
            ? { ...chat, folder: moveFolder(chat.folder) }
            : chat,
        ),
        lastWorkspaceByRepoRoot:
          remembered && belongsToMovedWorkspace(remembered)
            ? setBoundedRecord(
                state.lastWorkspaceByRepoRoot,
                action.repoRoot,
                moveFolder(remembered),
              )
            : state.lastWorkspaceByRepoRoot,
        lastWorkspaceFolder: moveMaybe(state.lastWorkspaceFolder),
        newAgentFolder: moveMaybe(state.newAgentFolder),
        activeChatByFolder: moveRecordKeysMatching(
          state.activeChatByFolder,
          belongsToMovedWorkspace,
          moveFolder,
        ),
        column3ByScope: moveRecordKeysMatching(
          state.column3ByScope,
          belongsToMovedWorkspace,
          moveFolder,
        ),
        pendingWorkspaceValidationFolder: moveMaybe(
          state.pendingWorkspaceValidationFolder,
        ),
      };
    }
    case "SET_LOADING":
      return { ...state, isLoading: action.loading };
    case "SET_AI_SETTINGS":
      return { ...state, aiSettings: action.settings };
    // ── Chat threads ──────────────────────────────────────
    case "HYDRATE_CHATS":
      return {
        ...state,
        chats: action.chats.map(migrateChatPermission),
        activeChatId: action.activeChatId,
      };
    case "MERGE_CHATS": {
      // Live cross-device sync (DB_CHANGED): fold the engine's chat list into the
      // local one — ADD chats we don't have, refresh ones the engine has a NEWER
      // copy of — WITHOUT touching activeChatId, drafts, or local-only UI state.
      // The updatedAt guard keeps a just-made local edit from being reverted by a
      // stale notification that races the write-through.
      if (action.chats.length === 0) return state;
      const byId = new Map(state.chats.map((c) => [c.id, c]));
      let changed = false;
      for (const raw of action.chats) {
        const incoming = migrateChatPermission(raw);
        const existing = byId.get(incoming.id);
        if (!existing) {
          byId.set(incoming.id, incoming);
          changed = true;
        } else if ((incoming.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
          byId.set(incoming.id, { ...existing, ...incoming });
          changed = true;
        }
      }
      return changed ? { ...state, chats: [...byId.values()] } : state;
    }
    case "ADD_CHAT": {
      // Chat tabs are unbounded — every live chat in a workspace shows
      // as a tab and the strip scrolls, so there's nothing to evict.
      // Creating a chat also consumes the EmptyComposer scope (the chat
      // now carries its own folder).
      return {
        ...state,
        chats: [...state.chats, action.chat],
        activeChatId: action.chat.id,
        newAgentFolder: null,
        ...(action.openWorkspace
          ? {
              activePage: "workspace" as const,
              lastWorkspaceFolder: action.chat.folder,
              lastWorkspaceByRepoRoot: setBoundedRecord(
                state.lastWorkspaceByRepoRoot,
                action.openWorkspace.repoRoot,
                action.chat.folder,
              ),
              pendingWorkspaceValidationFolder: action.openWorkspace
                .validationPending
                ? action.chat.folder
                : null,
            }
          : {}),
      };
    }
    case "SET_ACTIVE_CHAT":
      // Activating an existing chat also clears the scope override;
      // the user left the new-agent surface. Only the empty case
      // preserves the override so "+" on a workspace flows through.
      return {
        ...state,
        activeChatId: action.id,
        newAgentFolder: action.id === null ? state.newAgentFolder : null,
      };
    case "DELETE_CHAT": {
      const deleted = state.chats.find((c) => c.id === action.id);
      const next = state.chats.filter((c) => c.id !== action.id);
      const nextDrafts =
        action.id in state.chatComposerDrafts
          ? Object.fromEntries(
              Object.entries(state.chatComposerDrafts).filter(
                ([k]) => k !== action.id,
              ),
            )
          : state.chatComposerDrafts;
      const editPrefix = `${action.id}:`;
      const hasEditDrafts = Object.keys(state.editComposerDrafts).some((k) =>
        k.startsWith(editPrefix),
      );
      const nextEditDrafts = hasEditDrafts
        ? Object.fromEntries(
            Object.entries(state.editComposerDrafts).filter(
              ([k]) => !k.startsWith(editPrefix),
            ),
          )
        : state.editComposerDrafts;
      // Replacement pick when the ACTIVE chat is deleted: stay in the same
      // workspace (most-recent live sibling at the deleted chat's folder)
      // rather than jumping to whatever chat happens to sit last in the
      // global array — that jump silently teleported the user to another
      // worktree. Fall back to the most-recent live chat anywhere; null only
      // when no live chats remain (the tab strip's selection keeper then
      // auto-spawns a fresh chat so Column 2 never shows a dead pane).
      let nextActiveId = state.activeChatId;
      if (state.activeChatId === action.id) {
        const pick = (pred: (c: ChatThread) => boolean): string | null => {
          let best: ChatThread | null = null;
          for (const c of next) {
            if (c.archived || !pred(c)) continue;
            if (!best || (c.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = c;
          }
          return best?.id ?? null;
        };
        nextActiveId =
          (deleted?.folder ? pick((c) => c.folder === deleted.folder) : null) ??
          pick(() => true);
      }
      return {
        ...state,
        chats: next,
        activeChatId: nextActiveId,
        // Keep the chrome pinned to the deleted chat's workspace when no
        // replacement exists there — mirrors ARCHIVE_CHAT's safety net so
        // the strip never degrades to "No workspace selected".
        newAgentFolder:
          state.activeChatId === action.id && nextActiveId === null
            ? (deleted?.folder ?? state.newAgentFolder)
            : state.newAgentFolder,
        chatComposerDrafts: nextDrafts,
        editComposerDrafts: nextEditDrafts,
        pendingAutoSend: removeRecordKey(state.pendingAutoSend, action.id),
      };
    }
    case "ARCHIVE_CHAT": {
      // Soft-delete: flip the archived flag and drop the active
      // selection if the archived chat was open. Pin is cleared so the
      // chat doesn't reappear in pinned the moment it's restored — the
      // user can re-pin from Archived if they want.
      //
      // If the archived chat was active, ALSO pin newAgentFolder to the
      // closed chat's folder so the chrome (Column 1 highlight, topbar,
      // tabs strip) doesn't degrade to "No workspace selected". Callers
      // that pick a replacement chat (column2-panes handleCloseTab)
      // will overwrite this with SET_ACTIVE_CHAT, which clears
      // newAgentFolder for them — so this is only the safety net for
      // archive paths that don't run that handler.
      const target = state.chats.find((c) => c.id === action.id);
      if (!target || target.archived) return state;
      const wasActive = state.activeChatId === action.id;
      // When the ACTIVE chat is archived, hand the selection to the most-
      // recently-touched live sibling in the SAME workspace instead of
      // nulling it — a null selection renders a dead Column 2 (the
      // EmptyComposer landing was deleted 2026-06-18). Callers with a better
      // pick (column2-panes' pane-neighbor strategy) dispatch their own
      // SET_ACTIVE_CHAT right after, which simply overrides this. Null only
      // when the workspace has no live chats left — then newAgentFolder pins
      // the scope and the tab strip's keeper auto-spawns a fresh chat.
      let replacementId: string | null = null;
      if (wasActive) {
        let best: ChatThread | null = null;
        for (const c of state.chats) {
          if (c.id === action.id || c.archived || c.folder !== target.folder)
            continue;
          if (!best || (c.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = c;
        }
        replacementId = best?.id ?? null;
      }
      return {
        ...state,
        chats: state.chats.map((c) =>
          c.id === action.id ? { ...c, archived: true, pinned: false } : c,
        ),
        activeChatId: wasActive ? replacementId : state.activeChatId,
        newAgentFolder:
          wasActive && replacementId === null
            ? target.folder
            : state.newAgentFolder,
        pendingAutoSend: removeRecordKey(state.pendingAutoSend, action.id),
      };
    }
    case "UNARCHIVE_CHAT": {
      // Restore a closed chat from History back into the tab strip.
      // Restored tabs follow the same placement contract as new tabs: append
      // at the right. createdAt is the persisted strip-order key, so advance it
      // beyond every live sibling (also handles two opens in one millisecond).
      const target = state.chats.find((c) => c.id === action.id);
      if (!target || !target.archived) return state;
      let reopenedAt = Date.now();
      for (const chat of state.chats) {
        if (chat.folder !== target.folder || chat.archived) continue;
        const createdAt = Number.isFinite(chat.createdAt) ? chat.createdAt : 0;
        reopenedAt = Math.max(reopenedAt, createdAt + 1);
      }
      return {
        ...state,
        chats: state.chats.map((c) =>
          c.id === action.id
            ? {
                ...c,
                archived: false,
                createdAt: reopenedAt,
                updatedAt: reopenedAt,
              }
            : c,
        ),
      };
    }
    case "UPDATE_CHAT_TITLE":
      return {
        ...state,
        chats: state.chats.map((c) =>
          c.id === action.id
            ? { ...c, title: action.title, updatedAt: Date.now() }
            : c,
        ),
      };
    case "UPDATE_CHAT_TITLE_IF":
      return {
        ...state,
        chats: state.chats.map((c) =>
          c.id === action.id && c.title === action.expectedTitle
            ? { ...c, title: action.title, updatedAt: Date.now() }
            : c,
        ),
      };
    case "UPDATE_CHAT_SETTINGS":
      return {
        ...state,
        chats: state.chats.map((c) =>
          c.id === action.id
            ? { ...c, ...action.updates, updatedAt: Date.now() }
            : c,
        ),
      };
    case "TOUCH_CHAT":
      return {
        ...state,
        chats: state.chats.map((c) =>
          c.id === action.id ? { ...c, updatedAt: Date.now() } : c,
        ),
      };
    case "TOGGLE_PIN_CHAT":
      return {
        ...state,
        chats: state.chats.map((c) =>
          c.id === action.id ? { ...c, pinned: !c.pinned } : c,
        ),
      };
    case "SET_CHAT_DRAFT":
      return {
        ...state,
        chatComposerDrafts: {
          ...state.chatComposerDrafts,
          [action.chatId]: action.draft,
        },
      };
    case "CLEAR_CHAT_DRAFT": {
      if (!(action.chatId in state.chatComposerDrafts)) return state;
      const next = { ...state.chatComposerDrafts };
      delete next[action.chatId];
      return { ...state, chatComposerDrafts: next };
    }
    case "SET_EDIT_DRAFT": {
      const key = `${action.chatId}:${action.messageId}`;
      return {
        ...state,
        editComposerDrafts: {
          ...state.editComposerDrafts,
          [key]: action.stash,
        },
      };
    }
    case "CLEAR_EDIT_DRAFT": {
      const key = `${action.chatId}:${action.messageId}`;
      if (!(key in state.editComposerDrafts)) return state;
      const next = { ...state.editComposerDrafts };
      delete next[key];
      return { ...state, editComposerDrafts: next };
    }
    case "ENQUEUE_COMPOSER_APPEND":
      return { ...state, pendingComposerAppend: action.append };
    case "CONSUME_COMPOSER_APPEND":
      // Guard against double-consume races (two AgentChat instances
      // briefly mounted during chat-switch, both watching the slot).
      if (state.pendingComposerAppend?.id !== action.id) return state;
      return { ...state, pendingComposerAppend: null };
    case "ENQUEUE_CHAT_SUBMISSION":
      return { ...state, pendingChatSubmission: action.submission };
    case "CONSUME_CHAT_SUBMISSION":
      // Only clear if the id matches — prevents a race where a new
      // submission lands between AIChatPanel reading and dispatching.
      if (state.pendingChatSubmission?.id !== action.id) return state;
      return { ...state, pendingChatSubmission: null };
    case "REQUEST_AUTO_SEND":
      if (state.pendingAutoSend[action.chatId]) return state;
      return {
        ...state,
        pendingAutoSend: {
          ...state.pendingAutoSend,
          [action.chatId]: true,
        },
      };
    case "CONSUME_AUTO_SEND": {
      if (!state.pendingAutoSend[action.chatId]) return state;
      const next = { ...state.pendingAutoSend };
      delete next[action.chatId];
      return { ...state, pendingAutoSend: next };
    }
    case "SET_NEW_AGENT_FOLDER":
      return { ...state, newAgentFolder: action.folder };
    case "BUMP_PROJECT_GENERATION":
      return { ...state, projectGeneration: state.projectGeneration + 1 };
    // ── Column 3 tabs — scoped per worktree (see selectColumn3) ──
    // Each case reads/writes the ACTIVE worktree's slice in column3ByScope,
    // seeding from the per-scope default home tabs when the
    // worktree has no slice yet.
    case "RESET_COLUMN3_TABS": {
      const scope = column3ScopeKey(state);
      return {
        ...state,
        column3ByScope: setColumn3Scope(
          state.column3ByScope,
          scope,
          defaultTabs(),
        ),
      };
    }
    case "ADD_COLUMN3_TAB": {
      const scope = action.scope ?? column3ScopeKey(state);
      const cur = state.column3ByScope[scope] ?? defaultScopeFor(scope);
      // Changes + Review + Context are singletons. A duplicate add
      // activates the existing home tab instead of creating duplicate
      // persistent surfaces. File and Browser tabs are both multi-instance and
      // closable; ADD strips legacy/caller pins below.
      if (
        action.tab.type === "changes" ||
        action.tab.type === "review" ||
        action.tab.type === "context"
      ) {
        const existing = cur.tabs.find((t) => t.type === action.tab.type);
        if (existing) {
          if (action.activate === false || cur.activeId === existing.id)
            return state;
          return {
            ...state,
            column3ByScope: setColumn3Scope(state.column3ByScope, scope, {
              ...cur,
              activeId: existing.id,
            }),
          };
        }
      }
      // Duplicate ids break React keys and active-tab lookup; treat them as an
      // idempotent add rather than corrupting the slice.
      if (cur.tabs.some((t) => t.id === action.tab.id)) return state;
      // ADDs never mint permanence: the fixed Files home is born only with the
      // slice (defaultTabs/normalizeRow1Tabs), so a stray caller flag can't
      // create a second unremovable tab.
      const tab =
        action.tab.type === "changes" ||
        action.tab.type === "review" ||
        action.tab.type === "context"
          ? { ...action.tab, pinned: true }
          : action.tab.pinned || action.tab.fixed
            ? { ...action.tab, pinned: false, fixed: undefined }
            : action.tab;
      const activeId = action.activate !== false ? tab.id : cur.activeId;
      const next: Column3ScopeState = {
        ...cur,
        // If the user previously closed every File surface, the next File
        // reclaims the leading slot; later File/Browser tabs append normally.
        tabs: orderRow1Tabs([...cur.tabs, tab]),
        activeId,
        recentBrowsers:
          tab.type === "browser"
            ? recordRecentBrowser(cur.recentBrowsers, tab)
            : cur.recentBrowsers,
      };
      return {
        ...state,
        column3ByScope: setColumn3Scope(state.column3ByScope, scope, next),
      };
    }
    case "REMOVE_COLUMN3_TAB": {
      const scope = column3ScopeKey(state);
      const cur = state.column3ByScope[scope] ?? defaultScopeFor(scope);
      // The pinned Changes/Review/Context homes are permanent; extra File and
      // Browser tabs close normally, including blank ones.
      const target = cur.tabs.find((t) => t.id === action.id);
      if (!target) return state;
      if (
        target.type === "changes" ||
        target.type === "review" ||
        target.type === "context"
      )
        return state;
      // The FIXED Files home is permanent too, but its ✕ means "close the
      // FILE": revert the tab to the blank Open-file tree in place (same id,
      // same slot, stays active). Already blank → nothing to close.
      if (target.type === "files" && target.fixed) {
        if (!target.filePath) return state;
        return {
          ...state,
          column3ByScope: setColumn3Scope(state.column3ByScope, scope, {
            ...cur,
            tabs: cur.tabs.map((t) =>
              t.id === target.id ? blankFixedFilesTab(t) : t,
            ),
          }),
        };
      }
      const next = removeColumn3Tabs(cur, (t) => t.id === action.id);
      return {
        ...state,
        column3ByScope: setColumn3Scope(state.column3ByScope, scope, next),
      };
    }
    case "ACTIVATE_COLUMN3_TAB": {
      const scope = action.scope ?? column3ScopeKey(state);
      const cur = state.column3ByScope[scope] ?? defaultScopeFor(scope);
      if (!cur.tabs.some((t) => t.id === action.id)) return state;
      if (cur.activeId === action.id) return state;
      return {
        ...state,
        column3ByScope: setColumn3Scope(state.column3ByScope, scope, {
          ...cur,
          activeId: action.id,
        }),
      };
    }
    case "OPEN_COLUMN3_TAB": {
      const updated = action.updates
        ? reducer(state, {
            type: "UPDATE_COLUMN3_TAB",
            id: action.id,
            updates: action.updates,
            scope: action.scope,
          })
        : state;
      return reducer(updated, {
        type: "ACTIVATE_COLUMN3_TAB",
        id: action.id,
        scope: action.scope,
      });
    }
    case "CLOSE_COLUMN3_FILE_IF_MATCHES": {
      const cur =
        state.column3ByScope[action.scope] ?? defaultScopeFor(action.scope);
      const target = cur.tabs.find((tab) => tab.id === action.id);
      // Missing-file closes are delayed to tolerate atomic-save renames. The
      // owning tab may point at another path by the time that grace expires;
      // make the identity check and mutation one reducer transaction.
      if (
        !target ||
        (target.type !== "files" && target.type !== "changes") ||
        target.filePath !== action.path
      )
        return state;
      return reducer(state, {
        type: "UPDATE_COLUMN3_TAB",
        scope: action.scope,
        id: action.id,
        updates: {
          filePath: undefined,
          diff: false,
          diffScope: undefined,
          diffSha: undefined,
          turnChatId: undefined,
          turnId: undefined,
          discardable: false,
          isNewFile: false,
          viewerMode: undefined,
        },
      });
    }
    case "REORDER_COLUMN3_TABS": {
      const scope = column3ScopeKey(state);
      const cur = state.column3ByScope[scope] ?? defaultScopeFor(scope);
      // Reorder using the supplied id list. Tabs missing from the list
      // are preserved at the end (defensive — caller should pass all ids).
      const byId = new Map(cur.tabs.map((t) => [t.id, t] as const));
      const reordered: Column3Tab[] = [];
      for (const id of action.ids) {
        const tab = byId.get(id);
        if (tab) {
          reordered.push(tab);
          byId.delete(id);
        }
      }
      for (const tab of byId.values()) reordered.push(tab);
      // Pinned row-1 homes keep their canonical slots no matter what order the
      // caller supplied; File tabs remain closable.
      return {
        ...state,
        column3ByScope: setColumn3Scope(state.column3ByScope, scope, {
          ...cur,
          tabs: orderRow1Tabs(reordered),
          activeId: cur.activeId,
        }),
      };
    }
    case "UPDATE_COLUMN3_TAB": {
      const scope = action.scope ?? column3ScopeKey(state);
      const cur = state.column3ByScope[scope] ?? defaultScopeFor(scope);
      const target = cur.tabs.find((t) => t.id === action.id);
      if (!target) return state;
      // An update that clears a File path means "close the file". The FIXED
      // Files home reverts to its blank Open-file state in place (it can never
      // be removed); an extra File tab closes with its file — closing one
      // never silently turns it into a second blank tab.
      if (
        target.type === "files" &&
        Object.prototype.hasOwnProperty.call(action.updates, "filePath") &&
        (!action.updates.filePath || !action.updates.filePath.trim())
      ) {
        if (target.fixed) {
          if (!target.filePath) return state;
          return {
            ...state,
            column3ByScope: setColumn3Scope(state.column3ByScope, scope, {
              ...cur,
              tabs: cur.tabs.map((t) =>
                t.id === target.id ? blankFixedFilesTab(t) : t,
              ),
            }),
          };
        }
        const next = removeColumn3Tabs(cur, (t) => t.id === action.id);
        return {
          ...state,
          column3ByScope: setColumn3Scope(state.column3ByScope, scope, next),
        };
      }
      let updatedTarget: Column3Tab = {
        ...target,
        ...action.updates,
        // Type, not mutable persisted metadata, owns the close invariant.
        pinned:
          target.type === "changes" ||
          target.type === "review" ||
          target.type === "context",
        // Permanence is born with the slice (defaultTabs/normalizeRow1Tabs):
        // updates can neither demote the fixed Files home nor mint a new one.
        fixed: target.fixed,
      };
      if (
        (target.type === "files" || target.type === "changes") &&
        Object.prototype.hasOwnProperty.call(action.updates, "filePath") &&
        action.updates.filePath !== target.filePath &&
        !Object.prototype.hasOwnProperty.call(action.updates, "viewerMode")
      ) {
        updatedTarget.viewerMode = undefined;
      }
      if (target.type === "browser") {
        const url =
          typeof updatedTarget.url === "string"
            ? updatedTarget.url.trim().slice(0, 8192)
            : "";
        updatedTarget = {
          ...updatedTarget,
          title: url
            ? typeof updatedTarget.title === "string" &&
              updatedTarget.title.trim()
              ? updatedTarget.title.trim().slice(0, 512)
              : "Browser"
            : "Browser",
          url,
          canvasMode: url ? updatedTarget.canvasMode : false,
        };
      } else if (
        target.type === "files" &&
        Object.prototype.hasOwnProperty.call(action.updates, "filePath") &&
        typeof action.updates.filePath === "string"
      ) {
        const path = action.updates.filePath.trim();
        const suppliedTitle = action.updates.title?.trim();
        updatedTarget = {
          ...updatedTarget,
          filePath: path,
          title:
            suppliedTitle ||
            path.slice(path.lastIndexOf("/") + 1) ||
            "Open file",
        };
      }
      return {
        ...state,
        column3ByScope: setColumn3Scope(state.column3ByScope, scope, {
          ...cur,
          tabs: cur.tabs.map((t) => (t.id === action.id ? updatedTarget : t)),
          recentBrowsers:
            target.type === "browser" &&
            (Object.prototype.hasOwnProperty.call(action.updates, "url") ||
              Object.prototype.hasOwnProperty.call(action.updates, "title"))
              ? recordRecentBrowser(cur.recentBrowsers, updatedTarget)
              : cur.recentBrowsers,
        }),
      };
    }
    case "RECONCILE_COLUMN3_FILE_DISCARD": {
      const scope = column3ScopeForFolder(action.scope);
      const cur = state.column3ByScope[scope] ?? defaultScopeFor(scope);
      if (action.outcome === "removed") {
        // A deleted/staged-new file or reverted rename no longer exists at this
        // path. Close EVERY duplicate File tab for it; leaving any open
        // would expose a stale reader error instead of the tab lifecycle the
        // user requested. The permanent surfaces can't close: the pinned
        // Changes tab clears its selection and the fixed Files home reverts
        // to its blank Open-file state instead.
        const next = removeColumn3Tabs(
          cur,
          (t) => t.type === "files" && !t.fixed && t.filePath === action.path,
        );
        let revertedPermanent = false;
        const tabs = next.tabs.map((t) => {
          if (t.type === "files" && t.fixed && t.filePath === action.path) {
            revertedPermanent = true;
            return blankFixedFilesTab(t);
          }
          const isChangesHit =
            t.type === "changes" && t.filePath === action.path;
          if (!isChangesHit) return t;
          revertedPermanent = true;
          return {
            ...t,
            filePath: undefined,
            diff: false,
            diffScope: undefined,
            diffSha: undefined,
            turnChatId: undefined,
            turnId: undefined,
            discardable: false,
            isNewFile: false,
            viewerMode: undefined,
          };
        });
        if (next === cur && !revertedPermanent) return state;
        return {
          ...state,
          column3ByScope: setColumn3Scope(
            state.column3ByScope,
            scope,
            revertedPermanent ? { ...next, tabs } : next,
          ),
        };
      }

      // A tracked file still exists at the same path after revert. Every live
      // worktree-diff tab for it (File tabs AND the Changes tab's selection)
      // should land in Edit immediately; `discardable` may already have been
      // cleared if the user switched the Changes filter while git was running.
      // Historical commit/turn diffs remain untouched. The next git refresh may
      // remove the Diff toggle entirely or retain a committed branch diff.
      let changed = false;
      const tabs: Column3Tab[] = cur.tabs.map((t) => {
        if (
          (t.type !== "files" && t.type !== "changes") ||
          t.filePath !== action.path ||
          t.diffScope === "commit" ||
          t.diffScope === "turn" ||
          (!t.diff && !t.discardable && !t.isNewFile)
        )
          return t;
        changed = true;
        return {
          ...t,
          diff: false,
          discardable: false,
          isNewFile: false,
          viewerMode: "edit",
          contentRevision: (t.contentRevision ?? 0) + 1,
        };
      });
      if (!changed) return state;
      return {
        ...state,
        column3ByScope: setColumn3Scope(state.column3ByScope, scope, {
          ...cur,
          tabs,
        }),
      };
    }
    case "SET_VIEW":
      return { ...state, currentView: action.view };
    case "CONNECT_PROJECT":
      return {
        ...state,
        project: action.project,
        currentView: "workspace",
      };
    case "UPDATE_PROJECT_STATUS":
      return {
        ...state,
        project: state.project
          ? {
              ...state.project,
              status: action.status,
              errorMessage: action.errorMessage,
            }
          : null,
      };
    case "DISCONNECT_PROJECT":
      return {
        ...state,
        project: null,
        currentView: "onboarding",
        browserPickerSelection: null,
      };
    default:
      return state;
  }
}

// ──────────────────────────────────────────────────────────
// Store
// ──────────────────────────────────────────────────────────
// Shape = the full WorkspaceState (flat) + a `dispatch` that runs the
// verbatim reducer. Keeping state flat (rather than nested under a `state`
// key) is what lets the reducer's same-reference no-op returns flow
// straight into Zustand's `Object.is` skip. `dispatch` is a stable
// reference for the store's lifetime, so selecting it never re-renders.
export interface WorkspaceStore extends WorkspaceState {
  dispatch: (action: Action) => void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  ...initialState,
  // rememberActiveFolder keeps `lastWorkspaceFolder` in sync with the live
  // workspace after every action; rememberActiveChatForFolder records the
  // active chat per workspace folder so switching back restores the user's
  // place (a no-op reducer result stays a no-op through both).
  dispatch: (action) =>
    set((s) =>
      rememberActiveChatForFolder(rememberActiveFolder(reducer(s, action))),
    ),
}));

// ──────────────────────────────────────────────────────────
// Reload-persistence (formerly the effects in WorkspaceProvider)
// ──────────────────────────────────────────────────────────
// Mirror the persisted slices to localStorage whenever they change. The
// schedule helpers debounce internally (300 ms UI-state / 500 ms drafts) and
// flush on `beforeunload`. We compare the exact fields the old effect
// dependency arrays watched, so a write is scheduled on precisely the same
// changes — no more, no less. Subscribed once at module load; lives for the
// app's lifetime, so there's no teardown.
useWorkspaceStore.subscribe((s, prev) => {
  if (
    s.activePage !== prev.activePage ||
    s.lastHomePage !== prev.lastHomePage ||
    s.activeRepoId !== prev.activeRepoId ||
    s.repoPageViewByProject !== prev.repoPageViewByProject ||
    s.activeChatId !== prev.activeChatId ||
    s.newAgentFolder !== prev.newAgentFolder ||
    s.lastWorkspaceFolder !== prev.lastWorkspaceFolder ||
    s.lastWorkspaceByRepoRoot !== prev.lastWorkspaceByRepoRoot ||
    s.activeChatByFolder !== prev.activeChatByFolder
  ) {
    schedulePersistUiState(s);
  }
  // Keep the pre-v2 key current for downgrade/migration compatibility. The
  // atomic UI snapshot above is preferred on boot, so an interrupted write can
  // never pair a new chat id with an older workspace folder.
  if (s.activeChatId !== prev.activeChatId) {
    setSetting(ACTIVE_CHAT_KEY, s.activeChatId);
  }
  if (
    s.chatComposerDrafts !== prev.chatComposerDrafts ||
    s.editComposerDrafts !== prev.editComposerDrafts
  ) {
    schedulePersistDrafts(s);
  }
  // Column-3 tabs persist per worktree. Centralized here (not in <Column3>'s
  // effect) so a tab mutation is saved even when column 3 is collapsed.
  if (s.column3ByScope !== prev.column3ByScope) {
    saveScopes(s.column3ByScope);
  }
});

/** Stable `dispatch` without subscribing to any state. Write-only / event-
 *  handler consumers use this instead of `useWorkspace()` so they stop
 *  re-rendering on unrelated state changes. The selected reference never
 *  changes, so this hook never triggers a re-render. */
export function useWorkspaceDispatch(): (action: Action) => void {
  return useWorkspaceStore((s) => s.dispatch);
}

// ──────────────────────────────────────────────────────────
// Selector hooks — prefer these over useWorkspace() so a consumer
// re-renders ONLY when the slice it reads changes (the migration's whole
// point). Single-field selectors return the field reference directly, so
// Zustand's default `Object.is` compare suppresses re-renders when that
// field is untouched. Derived selectors that build a fresh array/object
// (e.g. a filtered chat list) must wrap the selector in `useShallow` at the
// call site, or return a primitive — see column2-terminal-deck / the
// derived-folder reads in column2-topbar & the store helper hooks.
// ──────────────────────────────────────────────────────────

/** `activePage` ("workspace" | "settings" | "dashboard" | "customize" |
 *  "repo"). */
export function useActivePage(): WorkspaceState["activePage"] {
  return useWorkspaceStore((s) => s.activePage);
}

/** The project id the Home-tab repo page targets (meaningful when
 *  `activePage === "repo"`), or null. */
export function useActiveRepoId(): string | null {
  return useWorkspaceStore((s) => s.activeRepoId);
}

/** The id of the active chat, or null. */
export function useActiveChatId(): string | null {
  return useWorkspaceStore((s) => s.activeChatId);
}

/** EmptyComposer scope override folder, or null. */
export function useNewAgentFolder(): string | null {
  return useWorkspaceStore((s) => s.newAgentFolder);
}

/** The connected project, or null. */
export function useProjectConnection(): WorkspaceState["project"] {
  return useWorkspaceStore((s) => s.project);
}

/** Bumps when the engine project root swaps (Open Workspace). */
export function useProjectGeneration(): number {
  return useWorkspaceStore((s) => s.projectGeneration);
}

/** The browser tab's element-picker selection (drives @selection
 *  mentions), or null. */
export function useBrowserPickerSelection(): WorkspaceState["browserPickerSelection"] {
  return useWorkspaceStore((s) => s.browserPickerSelection);
}

/** One-shot auto-submit hand-off into Column 2's chat, or null. */
export function usePendingChatSubmission(): WorkspaceState["pendingChatSubmission"] {
  return useWorkspaceStore((s) => s.pendingChatSubmission);
}

/** Exact-chat auto-send intent. Selecting one scalar keeps unrelated queued
 * workspace chats from re-rendering this AgentChat. */
export function usePendingAutoSend(chatId: string | null | undefined): boolean {
  return useWorkspaceStore(
    (s) => !!chatId && s.pendingAutoSend[chatId] === true,
  );
}

/** One-shot append-to-composer hand-off (⌥+click element), or null. */
export function usePendingComposerAppend(): WorkspaceState["pendingComposerAppend"] {
  return useWorkspaceStore((s) => s.pendingComposerAppend);
}

/** The full chat-thread list. Re-renders on any chat mutation — use only
 *  in list/grouping surfaces (sidebar, tab strip); prefer {@link useChatById}
 *  when you only care about one chat. */
export function useChats(): ChatThread[] {
  return useWorkspaceStore((s) => s.chats);
}

/** A single chat by id (stable reference until THAT chat changes), or null.
 *  Unrelated chat mutations preserve this chat's object identity, so the
 *  subscriber doesn't re-render on sibling-chat churn. */
export function useChatById(
  chatId: string | null | undefined,
): ChatThread | null {
  return useWorkspaceStore((s) =>
    chatId ? (s.chats.find((c) => c.id === chatId) ?? null) : null,
  );
}

/** The ACTIVE worktree's Column 3 tab list. Re-renders only when this
 *  worktree's tabs change or the active worktree switches — selectColumn3
 *  returns a stable slice reference per scope, so Object.is suppresses the
 *  rest. */
export function useColumn3Tabs(): Column3Tab[] {
  return useWorkspaceStore((s) => selectColumn3(s).tabs);
}

/** The active Column 3 tab id for the active worktree, or null. */
export function useActiveColumn3TabId(): string | null {
  return useWorkspaceStore((s) => selectColumn3(s).activeId);
}

/** Recently visited Browser pages for the active workspace, newest first. */
export function useRecentColumn3Browsers(): Column3ScopeState["recentBrowsers"] {
  return useWorkspaceStore((s) => selectColumn3(s).recentBrowsers);
}

/** A single per-message edit-draft by `${chatId}:${messageId}` key. */
export function useEditComposerDraft(key: string): EditDraftStash | undefined {
  return useWorkspaceStore((s) => s.editComposerDrafts[key]);
}
