// ──────────────────────────────────────────────────────────
// persist-ui-state.ts — Workspace store reload-state snapshot
// ──────────────────────────────────────────────────────────

import type {
  HomePage,
  RepoPageView,
  WorkspacePage,
  WorkspaceState,
} from "./store";

const STORAGE_KEY = "zeros:ui-state:v1";
const DEBOUNCE_MS = 300;

export interface PersistedUiState {
  activePage: WorkspacePage;
  /** Exact chat identity paired with the workspace route in this snapshot. */
  activeChatId: string | null;
  /** Last complete destination under Home; `repo` is paired with activeRepoId. */
  lastHomePage: HomePage;
  /** The repo page's target project id — restored alongside activePage so a
   *  reload on a repo page reopens the same repo. Paired on read: a persisted
   *  "repo" page with no id degrades to the Dashboard. */
  activeRepoId: string | null;
  /** Per-repository hub tab, keyed by stable project id. */
  repoPageViewByProject: Record<string, RepoPageView>;
  newAgentFolder: string | null;
  /** The workspace folder the user was last viewing — restored on boot so the
   *  app reopens on the same workspace instead of "No workspace selected". */
  lastWorkspaceFolder: string | null;
  /** Per-repository last workspace folder, keyed by primary checkout root. */
  lastWorkspaceByRepoRoot: Record<string, string>;
  /** Per-workspace last-active chat: { [folderPath]: chatId }. Restored on boot
   *  so switching back to a workspace lands on the chat the user was viewing
   *  there (not the most-recently-edited one). */
  activeChatByFolder: Record<string, string>;
}

const VALID_PAGES = new Set<WorkspacePage>([
  "workspace",
  "settings",
  "dashboard",
  "customize",
  "repo",
]);
const VALID_REPO_VIEWS = new Set<RepoPageView>([
  "workspaces",
  "environment",
  "git",
  "actions",
  "paths",
]);
/** Persisted navigation identity is useful, but must not grow forever. */
const MAX_SCOPED_NAV_ENTRIES = 128;
const MAX_ACTIVE_CHAT_ENTRIES = 512;

function parsePage(raw: unknown, fallback: WorkspacePage): WorkspacePage {
  if (raw === "design" || raw === "themes") return "workspace";
  // History was folded into the Dashboard (archived workspaces are a column
  // there now) — send anyone who had History persisted to the Dashboard.
  if (raw === "history") return "dashboard";
  return typeof raw === "string" && VALID_PAGES.has(raw as WorkspacePage)
    ? (raw as WorkspacePage)
    : fallback;
}

function parseStringOrNull(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** Validate a persisted { [folder]: chatId } map. Drops any entry whose key or
 *  value isn't a non-empty string, so a corrupt/legacy blob can never seed a
 *  bad folder→chat mapping (it just falls back to an empty map). */
function parseStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.length > 0 && typeof v === "string" && v.length > 0) {
      out[k] = v;
    }
  }
  return out;
}

/** Keep the newest valid entries from a persisted string map. Object insertion
 * order is maintained by each writer, which moves a touched key to the tail. */
function parseBoundedStringMap(
  raw: unknown,
  limit: number,
): Record<string, string> {
  const entries = Object.entries(parseStringMap(raw)).slice(-limit);
  return Object.fromEntries(entries);
}

function parseRepoViewMap(raw: unknown): Record<string, RepoPageView> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter(
      (entry): entry is [string, RepoPageView] =>
        entry[0].length > 0 &&
        typeof entry[1] === "string" &&
        VALID_REPO_VIEWS.has(entry[1] as RepoPageView),
    )
    .slice(-MAX_SCOPED_NAV_ENTRIES);
  return Object.fromEntries(entries);
}

function readLegacySettingString(key: string): string {
  try {
    const raw = localStorage.getItem(`zeros-${key}`);
    if (!raw) return "";
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return raw;
    }
  } catch {
    return "";
  }
}

/** Attribute the former app-global repo view to the repo that owned the route
 * during upgrade. It cannot recover older per-repo choices, but it avoids
 * resetting the user's current destination while the new scoped map takes over. */
function readLegacyRepoView(): RepoPageView | null {
  const raw = readLegacySettingString("repo-page:view");
  if (raw === "scripts" || raw === "run-actions") return "environment";
  if (VALID_REPO_VIEWS.has(raw as RepoPageView)) return raw as RepoPageView;
  if (readLegacySettingString("repo-page:tab") !== "settings") return null;
  const section = readLegacySettingString("repo-page:section");
  if (section === "scripts" || section === "run-actions") return "environment";
  if (
    section === "environment" ||
    section === "git" ||
    section === "actions" ||
    section === "paths"
  ) {
    return section;
  }
  return "environment";
}

export function loadPersistedUiState(): Partial<PersistedUiState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Partial<PersistedUiState> = {};
    if ("activePage" in parsed) {
      out.activePage = parsePage(parsed.activePage, "workspace");
    }
    if ("activeChatId" in parsed) {
      out.activeChatId = parseStringOrNull(parsed.activeChatId);
    }
    if ("lastHomePage" in parsed) {
      const page = parsePage(parsed.lastHomePage, "dashboard");
      out.lastHomePage = page === "workspace" ? "dashboard" : page;
    }
    if ("activeRepoId" in parsed) {
      out.activeRepoId = parseStringOrNull(parsed.activeRepoId);
    }
    // Pair invariant: the repo page is meaningless without a target repo — a
    // stale/corrupt blob that persisted "repo" with no id lands on the
    // Dashboard instead of a dead page.
    if (out.activePage === "repo" && !out.activeRepoId) {
      out.activePage = "dashboard";
    }
    if (!out.lastHomePage && out.activePage && out.activePage !== "workspace") {
      out.lastHomePage = out.activePage;
    }
    if (out.lastHomePage === "repo" && !out.activeRepoId) {
      out.lastHomePage = "dashboard";
    }
    if ("repoPageViewByProject" in parsed) {
      out.repoPageViewByProject = parseRepoViewMap(
        parsed.repoPageViewByProject,
      );
    }
    if (
      (!out.repoPageViewByProject ||
        Object.keys(out.repoPageViewByProject).length === 0) &&
      out.activeRepoId
    ) {
      const legacyView = readLegacyRepoView();
      if (legacyView) {
        out.repoPageViewByProject = { [out.activeRepoId]: legacyView };
      }
    }
    if ("newAgentFolder" in parsed) {
      out.newAgentFolder = parseStringOrNull(parsed.newAgentFolder);
    }
    if ("lastWorkspaceFolder" in parsed) {
      out.lastWorkspaceFolder = parseStringOrNull(parsed.lastWorkspaceFolder);
    }
    if ("lastWorkspaceByRepoRoot" in parsed) {
      out.lastWorkspaceByRepoRoot = parseBoundedStringMap(
        parsed.lastWorkspaceByRepoRoot,
        MAX_SCOPED_NAV_ENTRIES,
      );
    }
    if ("activeChatByFolder" in parsed) {
      out.activeChatByFolder = parseBoundedStringMap(
        parsed.activeChatByFolder,
        MAX_ACTIVE_CHAT_ENTRIES,
      );
    }
    return out;
  } catch {
    return {};
  }
}

function writeNow(snapshot: PersistedUiState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* quota / private mode */
  }
}

let pendingTimer: number | null = null;
let pendingSnapshot: PersistedUiState | null = null;

function flushPending(): void {
  if (pendingTimer !== null) {
    window.clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (pendingSnapshot !== null) {
    writeNow(pendingSnapshot);
    pendingSnapshot = null;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushPending);
}

export function schedulePersistUiState(state: WorkspaceState): void {
  pendingSnapshot = {
    activePage: state.activePage,
    activeChatId: state.activeChatId,
    lastHomePage: state.lastHomePage,
    activeRepoId: state.activeRepoId,
    repoPageViewByProject: state.repoPageViewByProject,
    newAgentFolder: state.newAgentFolder,
    lastWorkspaceFolder: state.lastWorkspaceFolder,
    lastWorkspaceByRepoRoot: state.lastWorkspaceByRepoRoot,
    activeChatByFolder: state.activeChatByFolder,
  };
  if (pendingTimer !== null) return;
  pendingTimer = window.setTimeout(() => {
    pendingTimer = null;
    if (pendingSnapshot) {
      writeNow(pendingSnapshot);
      pendingSnapshot = null;
    }
  }, DEBOUNCE_MS);
}

export function _resetPersistUiStateForTests(): void {
  if (pendingTimer !== null) {
    window.clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  pendingSnapshot = null;
}
