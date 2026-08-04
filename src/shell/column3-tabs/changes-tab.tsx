// ──────────────────────────────────────────────────────────
// Changes engine — the shared model + UI behind the Changes tab
// ──────────────────────────────────────────────────────────
//
// The data model and building blocks the row-1 Changes tab composes (see
// ChangesRow1Tab), plus `useWorkspaceChangeCount` (the Changes pill's badge):
//
//   • useChangesModel → the persisted scope + turn filters (shared live via
//     changes-filter-store), the commits/turns dropdown data, the scope-driven
//     file sections (published to the Viewed store), and the sidebar discard
//     flow. Scopes: everything this branch changed vs its base (committed AND
//     uncommitted — the default, "All changes"), just the uncommitted working
//     tree, or a single picked commit. The choice is remembered per workspace
//     (changes-scope) so it survives tab/workspace switches and reloads.
//   • ChangesList / FileSection / TreeSection / FileRow → files render as ONE
//     flat, header-less list (no groups, conflicts included) with a status
//     glyph, ± counts and a square badge whose SHAPE is the change type (＋
//     created · • modified · − deleted) and whose COLOUR is the lifecycle (grey
//     while uncommitted → green/gold/red once committed; red if conflicted) —
//     in All changes that lifecycle is judged per file, so committed and pending
//     files read distinctly in the same list. Hover reveals Discard ("All
//     changes" filter only) — which fully reverts a tracked file to HEAD or
//     deletes an untracked/new one, after a confirm.
//   • ScopeSelect / TurnSelect / ViewToggle → the filter dropdowns + flat⇄tree
//     toggle; EmptyState / NotAGitRepo / useTrunkGitState / useSourceTarget →
//     the shared target resolution + non-git-trunk onboarding.
//
// Commit / push / pull are NOT surfaced here as manual controls — those
// flows are agent-driven (the underlying gitCommit/gitPush/gitPull bridge
// ops + engine handlers remain intact and are exercised by the agent).
//
// Drives the live git IPC (status / diff / discard / log / show). Only real
// engine worktrees have a git surface; the synthetic "Local main" trunk is a
// first-class editable target, and a non-git folder gets Initialize/Publish.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  GitBranch,
  List,
  ListTree,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";

import {
  gitChangeCounts,
  gitDiff,
  gitLog,
  gitShowCommit,
  gitStatus,
  gitInitInPlace,
  isGitErrorShape,
  workspaceInspectFolder,
  type Commit,
  type ChangeCounts,
  type FileChange,
  type FileChangeStatus,
  type StatusResult,
} from "@/native/git";
import { isNativeRuntime } from "@/native/runtime";
import { useActiveWorkspace } from "@/zeros/store/use-active-workspace";
import { isLocalMainWorkspace } from "@/zeros/store/local-main-workspace";
import { useWorkspaceDispatch } from "@/zeros/store/store";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from "@/zeros/ui/primitives";
import { cn } from "@/zeros/ui/cn";
import { toast } from "@/zeros/ui/primitives/elements";
import { useAddProject } from "../add-project-provider";
import {
  buildFileTree,
  parseUnifiedDiffFiles,
  type ChangedFile,
  type TreeNode,
} from "./changes-parse";
import { type Scope } from "./changes-scope";
import { trackedFilesForScope } from "./changes-scope-files";
import {
  getChangesFilter,
  setChangesScope,
  setChangesTurnFilter,
  useChangesFilter,
} from "./changes-filter-store";
import { turnsList, type TurnInfo } from "@/native/turns";
import { hashString, isFileViewed, publishChanges } from "./use-viewed-files";
import { useScrollMemoryRef } from "../scroll-memory";
import { discardPath } from "./discard-file";
import {
  loadWorkspaceFileRead,
  primeWorkspaceFileDiff,
} from "../workspace-file-data-cache";
import {
  changesSnapshotKey,
  beginChangesSectionsRequest,
  hasChangesSections,
  isCurrentChangesSectionsRequest,
  readChangesCount,
  readChangesSections,
  subscribeChangesSections,
  writeChangesCount,
  writeChangesSections,
  type CachedChangesSection,
  type ChangesSectionKind,
} from "./changes-snapshot-cache";

export type ViewMode = "flat" | "tree";
/** One header-less file list per scope (no groups). `changes` = the uncommitted
 *  working tree (conflicts included, sorted first); `committed` = a branch-vs-base
 *  diff (All changes — committed + uncommitted) or a single commit's diff. Both
 *  render flat. */
type SectionKind = ChangesSectionKind;

export type Section = CachedChangesSection;

// Changes stays mounted across common tab/workspace switches. Retain the last
// complete model per git target as a bounded fallback for first render after a
// deck eviction or app-level scope change.
const changesCommitsCache = new Map<string, Commit[]>();
const changesTurnsCache = new Map<string, TurnInfo[]>();
const trunkGitStateCache = new Map<string, boolean>();
const MAX_CHANGES_CACHE_ENTRIES = 64;

function writeBoundedCache<T>(
  cache: Map<string, T>,
  key: string,
  value: T,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CHANGES_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function sameChangedFile(a: ChangedFile, b: ChangedFile): boolean {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

/** Preserve row and collection identities after a no-op Git refresh. FileRow
 * memoization only helps when the refreshed model reuses the unchanged row. */
function stableSections(previous: Section[], next: Section[]): Section[] {
  const previousFiles = new Map(
    previous
      .flatMap((section) => section.files)
      .map((file) => [file.path, file] as const),
  );
  const stabilized = next.map((section, sectionIndex) => {
    const files = section.files.map((file) => {
      const prior = previousFiles.get(file.path);
      return prior && sameChangedFile(prior, file) ? prior : file;
    });
    const priorSection = previous[sectionIndex];
    if (
      priorSection?.kind === section.kind &&
      priorSection.title === section.title &&
      files.length === priorSection.files.length &&
      files.every((file, index) => file === priorSection.files[index])
    ) {
      return priorSection;
    }
    return { ...section, files };
  });
  return stabilized.length === previous.length &&
    stabilized.every((section, index) => section === previous[index])
    ? previous
    : stabilized;
}

function sectionsCacheKey(workspaceId: string, scope: Scope): string {
  return changesSnapshotKey(workspaceId, scope);
}

function commitsCacheKey(workspaceId: string, baseBranch: string): string {
  return JSON.stringify([workspaceId, baseBranch]);
}

function pathBaseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

// Coalesce the active Changes list and PR status row onto the SAME `git status`
// result for one refresh generation. The entry is removed as soon as it
// settles: this is in-flight deduplication, never a stale status cache.
const statusRequests = new Map<string, Promise<StatusResult>>();

function statusRequestKey(workspaceId: string, refreshKey: number): string {
  return JSON.stringify([workspaceId, refreshKey]);
}

/** Exported so the PR-status island joins the same coalesced generation
 *  instead of issuing a second `git status` for the same refresh key. */
export function statusForGeneration(
  workspaceId: string,
  refreshKey: number,
): Promise<StatusResult> {
  const key = statusRequestKey(workspaceId, refreshKey);
  const pending = statusRequests.get(key);
  if (pending) return pending;
  const request = gitStatus(workspaceId).finally(() => {
    if (statusRequests.get(key) === request) statusRequests.delete(key);
  });
  statusRequests.set(key, request);
  return request;
}

// Coalesce the (up to two) mounted Changes surfaces' turns fetches onto ONE
// request per refresh generation — same in-flight-only dedup as status above.
// Besides halving the IPC, a shared snapshot means the deleted-turn cleanup in
// useChangesModel can't judge a turn picked from one surface's fresher list
// against the other's stale one.
const turnsRequests = new Map<string, Promise<TurnInfo[]>>();

function turnsForGeneration(
  workspaceId: string,
  refreshKey: number,
): Promise<TurnInfo[]> {
  const key = JSON.stringify([workspaceId, refreshKey]);
  const pending = turnsRequests.get(key);
  if (pending) return pending;
  const request = turnsList(workspaceId).finally(() => {
    if (turnsRequests.get(key) === request) turnsRequests.delete(key);
  });
  turnsRequests.set(key, request);
  return request;
}

// ── source target + change count ─────────────────────────────

/** Resolve the active workspace into the git target the source views address.
 *  Real worktree → its id (full git + PR). Local-main "trunk" → its repoRoot,
 *  which the engine resolves to the primary checkout's working tree — a
 *  first-class EDITABLE target (status/diff/log + stage/commit/discard), the
 *  same as a worktree. There's no PR surface for the trunk itself (main is the
 *  base a PR merges INTO, not a feature branch), so the Review tab renders
 *  its empty state for the trunk. */
export function useSourceTarget(): {
  workspace: ReturnType<typeof useActiveWorkspace>["workspace"];
  isLocalMain: boolean;
  workspaceId: string | null;
  changesTarget: string | null;
} {
  const { workspace } = useActiveWorkspace();
  const isLocalMain = !!workspace && isLocalMainWorkspace(workspace);
  const workspaceId = workspace && !isLocalMain ? workspace.id : null;
  const changesTarget = isLocalMain ? workspace?.repoRoot || null : workspaceId;
  return { workspace, isLocalMain, workspaceId, changesTarget };
}

/** All-changes count for the active workspace — exactly the number of rows in
 * the default Changes scope, including committed work. */
export function useWorkspaceChangeCount(refreshKey: number): number {
  const { changesTarget } = useSourceTarget();
  return useChangeCount(changesTarget, refreshKey);
}

// ── lightweight change counts for the badge + scope menu ─────

const ZERO_CHANGE_COUNTS: ChangeCounts = Object.freeze({
  all: 0,
  uncommitted: 0,
  staged: 0,
  unstaged: 0,
});
const changeCountRequests = new Map<string, Promise<ChangeCounts>>();

/** Shared by the Changes badge/menu, Create-PR state, and PR status row so one
 * refresh generation cannot briefly disagree about the net working-tree diff. */
export function changeCountsForGeneration(
  workspaceId: string,
  refreshKey: number,
): Promise<ChangeCounts> {
  const key = JSON.stringify([workspaceId, refreshKey]);
  const pending = changeCountRequests.get(key);
  if (pending) return pending;
  const request = gitChangeCounts(workspaceId).finally(() => {
    if (changeCountRequests.get(key) === request) {
      changeCountRequests.delete(key);
    }
  });
  changeCountRequests.set(key, request);
  return request;
}

export function useChangeCounts(
  workspaceId: string | null,
  refreshKey: number,
): ChangeCounts {
  const [snapshot, setSnapshot] = useState<{
    workspaceId: string;
    counts: ChangeCounts;
  }>({ workspaceId: "", counts: ZERO_CHANGE_COUNTS });
  useEffect(() => {
    if (!workspaceId) {
      setSnapshot({ workspaceId: "", counts: ZERO_CHANGE_COUNTS });
      return;
    }
    let cancelled = false;
    void changeCountsForGeneration(workspaceId, refreshKey)
      .then((counts) => {
        if (cancelled) return;
        writeChangesCount(workspaceId, counts.all);
        setSnapshot({ workspaceId, counts });
      })
      .catch(() => {
        if (!cancelled) {
          // Preserve an exact owner's last confirmed totals on a transient
          // bridge/Git failure. A refresh is not evidence that its data is zero.
          setSnapshot((current) =>
            current.workspaceId === workspaceId
              ? current
              : {
                  workspaceId,
                  counts: {
                    ...ZERO_CHANGE_COUNTS,
                    all: readChangesCount(workspaceId) ?? 0,
                  },
                },
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshKey]);

  return useMemo(() => {
    if (!workspaceId) return ZERO_CHANGE_COUNTS;
    if (snapshot.workspaceId === workspaceId) return snapshot.counts;
    return {
      ...ZERO_CHANGE_COUNTS,
      all: readChangesCount(workspaceId) ?? 0,
    };
  }, [snapshot, workspaceId]);
}

export function useChangeCount(
  workspaceId: string | null,
  refreshKey: number,
): number {
  return useChangeCounts(workspaceId, refreshKey).all;
}

// ── non-git trunk: Initialize Git / Publish to GitHub ────────

/** For Local main, detect a folder that isn't READY for workspaces yet
 *  — either not a git repo, OR a repo with zero commits (unborn HEAD, e.g. a
 *  freshly `git init`'d folder). Both can't host a worktree/diff (`git diff HEAD`
 *  / `rev-parse HEAD` fail), so the panel offers Initialize / Publish instead of
 *  a raw `git … failed`. `checked` gates the trunk render until the (async) probe
 *  resolves, so the raw error never flashes first. Worktrees (root null) report
 *  `{ nonGit: false, checked: true }`. Re-runs on `refreshKey`, so it clears the
 *  moment the folder is initialized. */
export function useTrunkGitState(
  root: string | null,
  refreshKey: number,
): { nonGit: boolean; checked: boolean } {
  const [state, setState] = useState<{
    root: string;
    nonGit: boolean;
    checked: boolean;
  }>(() => {
    const cached = root ? trunkGitStateCache.get(root) : undefined;
    return {
      root: root ?? "",
      nonGit: cached ?? false,
      checked: !root || !isNativeRuntime() || cached !== undefined,
    };
  });
  useEffect(() => {
    if (!root || !isNativeRuntime()) {
      setState({ root: root ?? "", nonGit: false, checked: true });
      return;
    }
    let cancelled = false;
    void workspaceInspectFolder(root)
      .then((res) => {
        if (cancelled) return;
        const nonGit = !!res && (!res.isRepo || res.hasCommits === false);
        writeBoundedCache(trunkGitStateCache, root, nonGit);
        setState({ root, nonGit, checked: true });
      })
      .catch(() => {
        if (!cancelled) {
          const cached = trunkGitStateCache.get(root);
          setState({
            root,
            nonGit: cached ?? false,
            checked: cached !== undefined,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [root, refreshKey]);
  if (!root || !isNativeRuntime()) return { nonGit: false, checked: true };
  if (state.root === root) {
    if (state.checked) return state;
    const cached = trunkGitStateCache.get(root);
    return cached === undefined
      ? { nonGit: false, checked: false }
      : { nonGit: cached, checked: true };
  }
  const cached = trunkGitStateCache.get(root);
  return cached === undefined
    ? { nonGit: false, checked: false }
    : { nonGit: cached, checked: true };
}

/** Empty state shown until a project folder has a usable first commit. Offers
 *  the local initialization path and the existing Publish-to-GitHub flow. */
export function NotAGitRepo({
  repoRoot,
  defaultName,
  onInitialized,
}: {
  repoRoot: string;
  defaultName?: string;
  onInitialized: () => void;
}) {
  const { publishToGithub } = useAddProject();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initialize = useCallback(async () => {
    if (!repoRoot || busy) return;
    setBusy(true);
    setError(null);
    try {
      await gitInitInPlace(repoRoot);
      onInitialized(); // bumps refreshKey → re-inspect clears this state
    } catch (e) {
      setError(isGitErrorShape(e) ? e.message : String(e));
      setBusy(false);
    }
  }, [repoRoot, busy, onInitialized]);

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
      <GitBranch
        className="text-muted-fg size-10"
        strokeWidth={1}
        aria-hidden
      />
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void initialize()}
        >
          {busy ? "Initializing…" : "Initialize Git"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => publishToGithub(repoRoot, defaultName)}
        >
          Publish to GitHub
        </Button>
      </div>
      <div className="text-fg2 max-w-sm text-xs">
        Repository needs initializing
      </div>
      {error && (
        <div className="bg-red-bg text-red-fg mx-auto max-w-sm rounded-md px-3 py-2 text-xs">
          {error}
        </div>
      )}
    </div>
  );
}

// ── the Changes data model ───────────────────────────────────

/** Untracked paths → ChangedFile rows. They appear in no diff, so their "+N" is
 *  the file's own line count; they're always uncommitted (grey square). Shared by
 *  the Uncommitted and All-changes scopes. */
async function buildUntrackedFiles(
  folder: string,
  paths: string[],
): Promise<ChangedFile[]> {
  const files = await Promise.all(
    paths.map(async (p) => {
      let additions = 0;
      let hash = "";
      if (folder) {
        // Use the shared generation-guarded read. If a filesystem event lands
        // while this request is in flight, its stale result can satisfy only
        // this superseded caller; the cache queues and publishes the exact-key
        // successor for the current Changes/File viewer generation.
        const res = await loadWorkspaceFileRead(
          { cwd: folder, path: p, contentRevision: 0 },
          { force: true },
        ).catch(() => null);
        // The path can be removed between `git status` and this content read.
        // Treat an explicit ENOENT as authoritative for this generation so a
        // racing delete never publishes a clickable phantom row. Transport
        // failures remain visible with unknown counts and retry on refresh.
        if (
          res?.kind === "error" &&
          res.error === "file no longer exists on disk"
        ) {
          return null;
        }
        if (res?.kind === "text" && res.content != null) {
          additions = countLines(res.content);
          hash = hashString(res.content);
        }
      }
      const file: ChangedFile = {
        path: p,
        status: "untracked" as FileChangeStatus,
        additions,
        deletions: 0,
        patch: "",
        binary: false,
        staged: false,
        committed: false,
        isNewFile: true,
        hash,
      };
      return file;
    }),
  );
  return files.filter((file): file is ChangedFile => file !== null);
}

/** Conflicted (unmerged) files → ChangedFile rows: no ± (they need resolving, not
 *  diffing), always rendered first and red. Shared by Uncommitted and All. */
function buildConflictedFiles(conflicted: FileChange[]): ChangedFile[] {
  return conflicted.map((f) => ({
    path: f.path,
    status: "conflicted" as FileChangeStatus,
    additions: 0,
    deletions: 0,
    patch: "",
    binary: false,
    staged: false,
  }));
}

/** The Changes DATA MODEL behind the Changes tab: the persisted scope + turn
 *  filters, the commits/turns dropdown data, the scope-driven file sections
 *  (published to the Viewed store), and the sidebar discard flow. Selection
 *  and layout stay with the caller (ChangesRow1Tab). */
export interface ChangesModel {
  scope: Scope;
  setScope: (s: Scope) => void;
  turnFilter: TurnInfo | null;
  selectTurnFilter: (t: TurnInfo | null) => void;
  turns: TurnInfo[];
  commits: Commit[];
  /** The scope-driven lists (empty while a turn filter overrides them). */
  sections: Section[];
  /** What to render: the selected turn's authored files, else `sections`. */
  effectiveSections: Section[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  discardTarget: ChangedFile | null;
  setDiscardTarget: (f: ChangedFile | null) => void;
  runDiscard: (f: ChangedFile) => void;
  /** Live totals for every non-historical scope, independent of selection. */
  changeCounts: ChangeCounts;
}

export function useChangesModel({
  workspaceId,
  baseBranch,
  folder,
  refreshKey,
  onChanged,
}: {
  workspaceId: string;
  baseBranch: string;
  folder: string;
  refreshKey: number;
  onChanged: (changedCwd?: string) => void;
}): ChangesModel {
  const dispatch = useWorkspaceDispatch();
  // Scope + turn filter live in the SHARED per-target store (see
  // changes-filter-store): multiple Changes surfaces can be mounted at once
  // for the same workspace, and per-instance copies would let their lists
  // diverge and race conflicting Viewed-store publishes. First
  // visit → "All changes"; after that the persisted choice, per git target.
  const { scope, turn: turnFilterId } = useChangesFilter(workspaceId);
  const sectionKey = sectionsCacheKey(workspaceId, scope);
  const commitKey = commitsCacheKey(workspaceId, baseBranch);
  // Cached dropdown rows paint in the same render as a workspace switch; their
  // effects below replace them atomically in the background.
  const [turnsSnapshot, setTurnsSnapshot] = useState<{
    workspaceId: string;
    turns: TurnInfo[];
  }>(() => ({
    workspaceId,
    turns: changesTurnsCache.get(workspaceId) ?? [],
  }));
  const turns = useMemo(
    () =>
      turnsSnapshot.workspaceId === workspaceId
        ? turnsSnapshot.turns
        : (changesTurnsCache.get(workspaceId) ?? []),
    [turnsSnapshot, workspaceId],
  );
  const setScope = useCallback(
    // Also clears the turn filter — scope + turn are mutually exclusive.
    (s: Scope) => setChangesScope(workspaceId, s),
    [workspaceId],
  );
  // Pick a turn from the dropdown (or "No turns" = null) and persist the choice.
  const selectTurnFilter = useCallback(
    (t: TurnInfo | null) =>
      setChangesTurnFilter(
        workspaceId,
        t ? { chatId: t.chatId, turnId: t.turnId } : null,
      ),
    [workspaceId],
  );
  // Turn filter (v13): when set, the list shows ONE turn's agent-authored
  // changes and overrides the scope above. Resolved against the loaded turns
  // list; an identity whose turn hasn't loaded (or was reset/deleted — see the
  // cleanup in the turns effect) resolves to null and the scope filter
  // applies. Once resolved, the SAME TurnInfo reference is kept across turns
  // reloads of the same selection (matching the old functional-setState
  // behavior), so effectiveSections/row callbacks don't churn every refresh.
  const turnFilterRef = useRef<TurnInfo | null>(null);
  const turnFilter = useMemo(() => {
    if (!turnFilterId) {
      turnFilterRef.current = null;
      return null;
    }
    const prev = turnFilterRef.current;
    if (
      prev &&
      prev.chatId === turnFilterId.chatId &&
      prev.turnId === turnFilterId.turnId
    ) {
      return prev;
    }
    const resolved =
      turns.find(
        (t) =>
          t.chatId === turnFilterId.chatId && t.turnId === turnFilterId.turnId,
      ) ?? null;
    turnFilterRef.current = resolved;
    return resolved;
  }, [turnFilterId, turns]);
  // Every retained surface for this exact scope observes one immutable
  // renderer-wide snapshot. A response published by either surface therefore
  // updates both atomically (including an authoritative empty array).
  const subscribeSections = useCallback(
    (listener: () => void) => subscribeChangesSections(sectionKey, listener),
    [sectionKey],
  );
  const getSectionsSnapshot = useCallback(
    () => readChangesSections(sectionKey),
    [sectionKey],
  );
  const cachedSections = useSyncExternalStore(
    subscribeSections,
    getSectionsSnapshot,
    getSectionsSnapshot,
  );
  const sections = useMemo(() => cachedSections ?? [], [cachedSections]);
  const setSections = useCallback(
    (next: React.SetStateAction<Section[]>) => {
      const current = readChangesSections(sectionKey) ?? [];
      const resolved = typeof next === "function" ? next(current) : next;
      writeChangesSections(
        workspaceId,
        scope,
        stableSections(current, resolved),
      );
    },
    [scope, sectionKey, workspaceId],
  );
  // Recent commit rows power the scope menu before its refresh completes.
  const [commitsSnapshot, setCommitsSnapshot] = useState<{
    key: string;
    commits: Commit[];
  }>(() => ({
    key: commitKey,
    commits: changesCommitsCache.get(commitKey) ?? [],
  }));
  const commits =
    commitsSnapshot.key === commitKey
      ? commitsSnapshot.commits
      : (changesCommitsCache.get(commitKey) ?? []);
  const [discardTarget, setDiscardTarget] = useState<ChangedFile | null>(null);
  // Loading/error also carry their source key. A newly selected cold target
  // therefore cannot flash the previous target's rows, error, or false empty
  // state before the reload effect starts.
  const [requestSnapshot, setRequestSnapshot] = useState<{
    key: string;
    loading: boolean;
    error: string | null;
  }>(() => ({
    key: sectionKey,
    loading: !hasChangesSections(sectionKey),
    error: null,
  }));
  const loading =
    !hasChangesSections(sectionKey) &&
    (requestSnapshot.key === sectionKey ? requestSnapshot.loading : true);
  const error =
    requestSnapshot.key === sectionKey ? requestSnapshot.error : null;
  const setLoading = useCallback(
    (next: boolean) => {
      setRequestSnapshot((current) => ({
        key: sectionKey,
        loading: next,
        error: current.key === sectionKey ? current.error : null,
      }));
    },
    [sectionKey],
  );
  const setError = useCallback(
    (next: string | null) => {
      setRequestSnapshot((current) => ({
        key: sectionKey,
        loading:
          current.key === sectionKey
            ? current.loading
            : !hasChangesSections(sectionKey),
        error: next,
      }));
    },
    [sectionKey],
  );
  const [busy, setBusy] = useState(false);
  // Monotonic request id: a slower pre-discard/pre-refresh response must never
  // overwrite a newer authoritative list and resurrect a removed file.
  const reloadRequest = useRef(0);

  // Commits this worktree added on top of its base (`base..HEAD`, newest
  // first) — NOT the base branch's whole history. Reloaded per workspace /
  // base / refresh.
  useEffect(() => {
    let cancelled = false;
    void gitLog({ workspaceId, limit: 50, base: baseBranch })
      .then((c) => {
        if (!cancelled) {
          writeBoundedCache(changesCommitsCache, commitKey, c);
          setCommitsSnapshot({ key: commitKey, commits: c });
        }
      })
      .catch(() => {
        // A transient git error must not blank a confirmed scope menu.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, baseBranch, commitKey, refreshKey]);

  // Turns for this workspace (newest first) — powers the turn-filter dropdown.
  // The selected turn resolves against this fresh list (see `turnFilter`
  // above); a stored selection whose turn was since reset/deleted is cleared
  // here — only once the FRESH list confirms it's gone, never preemptively
  // while the list is still loading.
  useEffect(() => {
    let cancelled = false;
    void turnsForGeneration(workspaceId, refreshKey)
      .then((t) => {
        if (cancelled) return;
        writeBoundedCache(changesTurnsCache, workspaceId, t);
        setTurnsSnapshot({ workspaceId, turns: t });
        const saved = getChangesFilter(workspaceId).turn;
        if (
          saved &&
          !t.some((x) => x.chatId === saved.chatId && x.turnId === saved.turnId)
        ) {
          setChangesTurnFilter(workspaceId, null);
        }
      })
      .catch(() => {
        // Preserve the last confirmed turn menu until a later refresh succeeds.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshKey]);

  // Build the file list, per scope:
  //  • Uncommitted / Staged / Unstaged: the full patch for that exact Git
  //    comparison is authoritative for tracked rows. Status only enriches those
  //    rows and supplies untracked/conflict membership. This is crucial for AD:
  //    it cancels out of Uncommitted but remains visible on both index sides.
  //  • All changes: this branch's whole contribution vs its fork point, COMMITTED
  //    and uncommitted, in one list — a `worktree-vs-base` diff (fork point → the
  //    working tree) plus the untracked files from `gitStatus`. Files that still
  //    have uncommitted work read grey; fully-committed ones colour by type.
  //  • A commit: that commit's own diff (`gitShowCommit`).
  const reload = useCallback(async () => {
    const requestId = ++reloadRequest.current;
    const publicationToken = beginChangesSectionsRequest(sectionKey);
    setLoading(true);
    setError(null);
    try {
      let files: ChangedFile[] = [];
      let kind: SectionKind = "changes";
      if (
        scope.kind === "uncommitted" ||
        scope.kind === "staged" ||
        scope.kind === "unstaged"
      ) {
        const mode =
          scope.kind === "staged"
            ? "index-vs-head"
            : scope.kind === "unstaged"
              ? "worktree-vs-index"
              : "worktree-vs-head";
        const [status, scopeDiff] = await Promise.all([
          statusForGeneration(workspaceId, refreshKey),
          gitDiff({ workspaceId, mode, rawPatch: true }),
        ]);
        const tracked = trackedFilesForScope(scopeDiff.patch ?? "", status);
        const includeUntracked =
          scope.kind === "uncommitted" || scope.kind === "unstaged";
        const untracked = includeUntracked
          ? await buildUntrackedFiles(folder, status.untracked)
          : [];
        const conflicted = buildConflictedFiles(status.conflicted);
        const flat = [...tracked, ...untracked].sort((a, b) =>
          a.path.localeCompare(b.path),
        );
        // One flat, header-less list — conflicts first, then the exact scope.
        files = [...conflicted, ...flat];
        kind = "changes";
      } else if (scope.kind === "all") {
        // The whole branch vs its fork point — committed AND uncommitted — in one
        // flat list. `worktree-vs-base` diffs the fork point against the WORKING
        // TREE, so a file changed by a commit AND edited since shows ONCE with its
        // net diff. `gitStatus` adds the untracked files (in no diff) and tells us
        // which tracked paths still have uncommitted work, so those read grey
        // (in-progress) while fully-committed changes colour by type.
        const [diffRes, status] = await Promise.all([
          gitDiff({ workspaceId, mode: "worktree-vs-base", rawPatch: true }),
          statusForGeneration(workspaceId, refreshKey),
        ]);
        const conflictedPaths = new Set(status.conflicted.map((f) => f.path));
        const dirty = new Set<string>([
          ...status.staged.map((f) => f.path),
          ...status.unstaged.map((f) => f.path),
          ...status.untracked,
        ]);
        const newPaths = new Set(
          [...status.staged, ...status.unstaged]
            .filter((f) => f.status === "added")
            .map((f) => f.path),
        );
        const tracked = parseUnifiedDiffFiles(diffRes.patch ?? "")
          // Conflicts render separately (red, first) — drop them here so a
          // mid-merge file isn't listed twice.
          .filter((f) => !conflictedPaths.has(f.path))
          .map((f) => ({
            ...f,
            committed: !dirty.has(f.path),
            // worktree-vs-base patch hash → the Viewed auto-unmark key (matches
            // the row-1 viewer, which also diffs vs base).
            hash: hashString(f.patch),
            isNewFile: newPaths.has(f.path),
          }));
        const untracked = await buildUntrackedFiles(folder, status.untracked);
        const conflicted = buildConflictedFiles(status.conflicted);
        const flat = [...tracked, ...untracked].sort((a, b) =>
          a.path.localeCompare(b.path),
        );
        files = [...conflicted, ...flat];
        kind = "committed";
      } else {
        // A single commit — its own diff.
        const patch = (await gitShowCommit({ workspaceId, sha: scope.sha }))
          .patch;
        files = parseUnifiedDiffFiles(patch ?? "").map((f) => ({
          ...f,
          hash: hashString(f.patch),
        }));
        kind = "committed";
      }
      if (
        requestId !== reloadRequest.current ||
        !isCurrentChangesSectionsRequest(sectionKey, publicationToken)
      ) {
        return;
      }
      // FileViewer addresses the same scope with an exact keyed query. Prime
      // every parsed patch before publishing rows so the first click can render
      // the completed diff in the selection commit (no loading interstitial).
      for (const file of files) {
        // An empty aggregate patch is authoritative only for a known new file
        // (untracked content is synthesized by FileViewer). Conflicts and rare
        // status-only tracked rows still need the per-path Git fallback.
        if (!file.patch && !file.isNewFile && file.status !== "untracked") {
          continue;
        }
        primeWorkspaceFileDiff(
          {
            workspaceId,
            path: file.path,
            diffScope: scope.kind,
            ...(scope.kind === "commit" ? { diffSha: scope.sha } : {}),
          },
          file.patch ?? "",
        );
      }
      // Publish the ordered change set + per-file hashes for the Viewed flow
      // (row dimming + the auto-advance sweep + auto-unmark-on-change). The hash
      // is authoritative only in "All changes" (full = the complete change set).
      publishChanges(
        workspaceId,
        files.map((f) => ({ path: f.path, hash: f.hash ?? "" })),
        scope.kind === "all",
      );
      setSections(files.length ? [{ kind, title: null, files }] : []);
    } catch (e) {
      if (
        requestId !== reloadRequest.current ||
        !isCurrentChangesSectionsRequest(sectionKey, publicationToken)
      ) {
        return;
      }
      setError(isGitErrorShape(e) ? e.message : String(e));
      // Keep the complete prior list behind the error. Clearing it here makes
      // a transient bridge/git failure look like rows disappeared one by one.
    } finally {
      if (
        requestId === reloadRequest.current &&
        (isCurrentChangesSectionsRequest(sectionKey, publicationToken) ||
          hasChangesSections(sectionKey))
      ) {
        setLoading(false);
      }
    }
  }, [
    workspaceId,
    sectionKey,
    scope,
    folder,
    refreshKey,
    setSections,
    setLoading,
    setError,
  ]);

  useEffect(() => {
    void reload();
    return () => {
      // Invalidates an in-flight request on scope/target/refresh changes and on
      // unmount. The next effect's reload claims the following request id.
      reloadRequest.current += 1;
    };
  }, [reload]);

  // A confirmation can stay open while an agent/terminal refresh lands. If
  // that path disappeared, became fully committed, or the user left the only
  // discardable scope, dismiss the stale dialog instead of letting Confirm run
  // a pathspec operation against an obsolete row.
  useEffect(() => {
    if (!discardTarget || loading) return;
    const live = sections
      .flatMap((section) => section.files)
      .find((file) => file.path === discardTarget.path);
    if (scope.kind !== "all" || live?.committed !== false) {
      setDiscardTarget(null);
    }
  }, [discardTarget, loading, scope.kind, sections]);

  // Scope totals refresh independently of the selected historical/turn filter.
  // The headline badge consumes `.all`; each menu row consumes its own exact
  // comparison, so an AD path reads 0 / 0 / 1 / 1 as Git actually represents it.
  const changeCounts = useChangeCounts(workspaceId, refreshKey);

  // ── discard ──
  // The ONLY write control here. Stage / unstage / commit / push are
  // agent-driven (no manual buttons). Discard fully reverts a tracked file to
  // HEAD, or DELETES an untracked / staged-new file — both destructive, so the
  // row's Discard opens a confirm (discardTarget) and this runs on confirm.
  const runDiscard = useCallback(
    (file: ChangedFile) => {
      setDiscardTarget(null);
      setBusy(true);
      void (async () => {
        try {
          // No status hint — discardPath self-resolves from `git status`, so a
          // file the diff-vs-base parser labelled "added" but that's actually
          // committed (tracked) gets reverted, not silently skipped.
          const outcome = await discardPath(workspaceId, file.path);
          // Target the workspace where this async operation began. If the user
          // switched worktrees while git ran, a same-named tab there is safe.
          dispatch({
            type: "RECONCILE_COLUMN3_FILE_DISCARD",
            scope: folder,
            path: file.path,
            outcome,
          });
          // Remove the confirmed path synchronously; the generation refresh
          // below replaces this optimistic list with authoritative git state.
          // This eliminates the clickable stale-row window after deletion.
          setSections((current) =>
            current
              .map((section) => ({
                ...section,
                files: section.files.filter(
                  (entry) => entry.path !== file.path,
                ),
              }))
              .filter((section) => section.files.length > 0),
          );
          onChanged(folder);
        } catch (e) {
          const message = isGitErrorShape(e) ? e.message : String(e);
          setError(message);
          toast.error(`Couldn't discard ${pathBaseName(file.path)}`, {
            description: message,
          });
          // Staged-new discard is unstage → clean. If clean fails, the index
          // still changed; refresh the authoritative generation on failures as
          // well so a partially completed operation never leaves stale rows.
          onChanged(folder);
        } finally {
          setBusy(false);
        }
      })();
    },
    [workspaceId, folder, dispatch, onChanged, setSections, setError],
  );

  // The list source: a selected turn's authored files override the scope-driven
  // `sections`. Mapped to ChangedFile rows (committed-style: coloured by type,
  // no discard — a turn view is read-only).
  const turnSections: Section[] = useMemo(() => {
    if (!turnFilter) return [];
    return [
      {
        kind: "committed",
        title: null,
        files: turnFilter.files.map((f) => ({
          path: f.path,
          oldPath: f.oldPath,
          status: f.status as FileChangeStatus,
          additions: f.additions,
          deletions: f.deletions,
          patch: "",
          binary: false,
          staged: false,
          committed: true,
        })),
      },
    ];
  }, [turnFilter]);
  const effectiveSections = turnFilter ? turnSections : sections;

  return {
    scope,
    setScope,
    turnFilter,
    selectTurnFilter,
    turns,
    commits,
    sections,
    effectiveSections,
    loading,
    error,
    busy,
    discardTarget,
    setDiscardTarget,
    runDiscard,
    changeCounts,
  };
}

/** The changed-file list body — error / loading / empty / flat list / folder
 *  tree. The Changes tab's sidebar list body. */
export function ChangesList({
  sections,
  view,
  loading,
  error,
  turnFilterActive,
  rowActions,
  scrollKey,
}: {
  sections: Section[];
  view: ViewMode;
  loading: boolean;
  error: string | null;
  /** Loading never blanks an active turn view — its rows come from the turn
   *  record, not the in-flight scope reload. */
  turnFilterActive: boolean;
  rowActions: RowActions;
  /** Keyed scroll memory (see shell/scroll-memory). The list remounts on
   *  every workspace switch (per-target ChangesSurface key), so a key scoped
   *  to the worktree restores the reader's place on return. */
  scrollKey?: string;
}) {
  const listScrollRef = useScrollMemoryRef(scrollKey ?? null);
  return (
    <div
      ref={listScrollRef}
      className="min-h-0 flex-1 overflow-auto"
      aria-busy={loading || undefined}
    >
      {error && (
        <div className="bg-red-bg text-red-fg m-3 rounded-md px-3 py-2 text-xs">
          {error}
        </div>
      )}
      {loading && !turnFilterActive && sections.length === 0 ? null : error &&
        sections.length === 0 ? null : sections.length === 0 ? (
        <div className="text-fg2 px-3 py-4 text-xs">No changes.</div>
      ) : view === "flat" ? (
        sections.map((s) => (
          <FileSection key={s.kind} section={s} {...rowActions} />
        ))
      ) : (
        sections.map((s) => (
          <TreeSection key={s.kind} section={s} {...rowActions} />
        ))
      )}
    </div>
  );
}

// ── scope / view controls ──────────────────────

/** First line of a commit message (the summary). */
function commitSummary(message: string): string {
  return message.split("\n", 1)[0] || message;
}

/** Scope picker: All changes · Uncommitted · or any recent commit. Picking a
 *  commit scopes the list to that commit's own diff. A non-default scope renders
 *  as a tag with a clear-to-"All changes" × beside it (no × inside the tag). */
export function ScopeSelect({
  scope,
  commits,
  changeCounts,
  onChange,
}: {
  scope: Scope;
  commits: Commit[];
  /** Live exact-comparison totals for the four non-historical scopes. */
  changeCounts: ChangeCounts;
  onChange: (s: Scope) => void;
}) {
  const isDefault = scope.kind === "all";
  const label =
    scope.kind === "all"
      ? "All changes"
      : scope.kind === "uncommitted"
        ? "Uncommitted"
        : scope.kind === "staged"
          ? "Staged"
          : scope.kind === "unstaged"
            ? "Unstaged"
            : commitSummary(scope.message);
  const countLabel = (count: number) =>
    `${count} file${count === 1 ? "" : "s"} changed`;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "text-fg1 hover:bg-bg2-hover flex min-w-0 items-center gap-1 rounded-sm text-sm font-normal transition-colors",
              // A non-default scope reads as a tag (filled --bg2 pill); the
              // default is a plain text trigger (no resting bg).
              isDefault ? "px-1.5 py-0.5" : "bg-bg2 px-2 py-0.5",
            )}
          >
            <span className="max-w-40 truncate">{label}</span>
            <ChevronDown className="text-fg2 size-3 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-80 w-72 overflow-auto"
        >
          <DropdownMenuItem
            data-selected={scope.kind === "all" || undefined}
            onClick={() => onChange({ kind: "all" })}
          >
            <span>
              All changes
              <span className="text-fg2 text-2xxs block">
                {countLabel(changeCounts.all)}
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-selected={scope.kind === "uncommitted" || undefined}
            onClick={() => onChange({ kind: "uncommitted" })}
          >
            <span>
              Uncommitted
              <span className="text-fg2 text-2xxs block">
                {countLabel(changeCounts.uncommitted)}
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-selected={scope.kind === "staged" || undefined}
            onClick={() => onChange({ kind: "staged" })}
          >
            <span>
              Staged
              <span className="text-fg2 text-2xxs block">
                {countLabel(changeCounts.staged)}
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-selected={scope.kind === "unstaged" || undefined}
            onClick={() => onChange({ kind: "unstaged" })}
          >
            <span>
              Unstaged
              <span className="text-fg2 text-2xxs block">
                {countLabel(changeCounts.unstaged)}
              </span>
            </span>
          </DropdownMenuItem>
          {commits.length > 0 && (
            <DropdownMenuSeparator className="bg-border3" />
          )}
          {commits.map((c) => (
            <DropdownMenuItem
              key={c.sha}
              data-selected={
                (scope.kind === "commit" && scope.sha === c.sha) || undefined
              }
              onClick={() =>
                onChange({ kind: "commit", sha: c.sha, message: c.message })
              }
            >
              <span className="min-w-0">
                <span className="block truncate">
                  {commitSummary(c.message)}
                </span>
                <span className="text-fg2 text-2xxs block truncate">
                  {c.abbreviatedSha} · {c.authorName}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {!isDefault && (
        <Tooltip label="Show all changes">
          <button
            type="button"
            onClick={() => onChange({ kind: "all" })}
            className="text-fg2 hover:bg-bg2-hover hover:text-fg1 flex size-5 shrink-0 items-center justify-center rounded-sm transition-colors"
          >
            <X className="size-3.5" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/** First non-empty line of a turn's summary (the user's prompt), trimmed. */
function turnSummary(t: TurnInfo): string {
  const s = (t.summary ?? "").trim();
  return s.length > 0 ? s : "Turn";
}

/** Coarse "x ago" for the turn dropdown subtitle. */
function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Turn filter: "No turns" (the scope filter applies) or one file-changing turn
 *  (its agent-authored changes). Newest first. Conversational/no-op turns never
 *  reach this list. Mirrors ScopeSelect's tag styling and sits beside it. Hidden
 *  entirely when the workspace has no file-changing turns yet. */
export function TurnSelect({
  turns,
  selected,
  onChange,
}: {
  turns: TurnInfo[];
  selected: TurnInfo | null;
  onChange: (t: TurnInfo | null) => void;
}) {
  if (turns.length === 0 && !selected) return null;
  const label = selected ? turnSummary(selected) : "No turns";
  return (
    <div className="flex min-w-0 items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "text-fg1 hover:bg-bg2-hover flex min-w-0 items-center gap-1 rounded-sm text-sm font-normal transition-colors",
              selected ? "bg-bg2 px-2 py-0.5" : "px-1.5 py-0.5",
            )}
          >
            <span className="max-w-40 truncate">{label}</span>
            <ChevronDown className="text-fg2 size-3 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-80 w-72 overflow-auto"
        >
          <DropdownMenuItem
            data-selected={!selected || undefined}
            onClick={() => onChange(null)}
          >
            No turns
          </DropdownMenuItem>
          {turns.length > 0 && <DropdownMenuSeparator className="bg-border3" />}
          {turns.map((t) => (
            <DropdownMenuItem
              key={`${t.chatId}:${t.turnId}`}
              data-selected={
                (selected?.chatId === t.chatId &&
                  selected.turnId === t.turnId) ||
                undefined
              }
              onClick={() => onChange(t)}
            >
              <span className="min-w-0">
                <span className="block truncate">{turnSummary(t)}</span>
                <span className="text-fg2 text-2xxs block truncate">
                  {t.files.length} file{t.files.length === 1 ? "" : "s"} ·{" "}
                  {relTime(t.startedAt)}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {selected && (
        <Tooltip label="No turns">
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-fg2 hover:bg-bg2-hover hover:text-fg1 flex size-5 shrink-0 items-center justify-center rounded-sm transition-colors"
          >
            <X className="size-3.5" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/** Single flat ⇄ tree toggle. Flat is the default: it shows the TREE icon with
 *  no bg (click → switch to the folder tree). Tree view shows the LIST icon WITH
 *  a bg (click → back to the flat default). The icon is the view you'd switch
 *  to; the bg marks that you've left the default. */
export function ViewToggle({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  const tree = view === "tree";
  return (
    <Tooltip label={tree ? "Flat list" : "Folder tree"}>
      <button
        type="button"
        onClick={() => onChange(tree ? "flat" : "tree")}
        className={cn(
          "flex size-6 items-center justify-center rounded-sm transition-colors",
          tree ? "bg-bg2-hover text-fg1" : "text-fg2 hover:bg-bg2-hover/50",
        )}
      >
        {tree ? (
          <List className="size-3.5" />
        ) : (
          <ListTree className="size-3.5" />
        )}
      </button>
    </Tooltip>
  );
}

// ── file list (flat) ─────────────────────────────────────────

export interface RowActions {
  selected: string | null;
  busy: boolean;
  /** Section default for the badge colour + A/M/D letter: a committed scope (a
   *  single commit, or All changes) hides the letter and colours by type;
   *  uncommitted leaves it grey with the letter. A row may override the COLOUR
   *  via `file.committed` (All changes, which mixes both). */
  committed: boolean;
  /** "All changes" filter on a writable (non-trunk) worktree → Discard is
   *  available on hover, but only per-file when the row has uncommitted work
   *  (`file.committed === false`); a fully-committed file has nothing to
   *  discard, so its hover Discard is hidden. */
  interactive: boolean;
  /** Git target key for the Viewed store (dims rows the user marked viewed). */
  viewedKey: string;
  /** Changes only when the external viewed-file store publishes. Used to
   * memoize ordering without re-sorting on ordinary file selection. */
  viewedVersion: number;
  onSelect: (f: ChangedFile) => void;
  /** Intent prefetch: warms content and a hidden virtualized diff before the
   * click's urgent selection update. */
  onPrefetch?: (f: ChangedFile) => void;
  onDiscard: (f: ChangedFile) => void;
}

/** A collapsible group header (Conflicts / Files changed). The flat `changes`
 *  list has `title === null` and renders no header at all. */
function SectionHeader({
  open,
  title,
  count,
  onToggle,
}: {
  open: boolean;
  title: string;
  count: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-fg2 hover:bg-bg2-hover/40 flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs font-medium transition-colors"
    >
      {open ? (
        <ChevronDown className="size-3" />
      ) : (
        <ChevronRight className="size-3" />
      )}
      {title}
      <span className="text-fg2">{count}</span>
    </button>
  );
}

function FileSection({
  section,
  selected,
  viewedKey,
  viewedVersion,
  ...actions
}: { section: Section } & RowActions) {
  const [open, setOpen] = useState(true);
  // Viewed files sink to the bottom (still dimmed) so the review sweep always
  // works top-to-bottom — the next unviewed change is the topmost row. Stable
  // sort keeps each group in its original order.
  const ordered = useMemo(
    () =>
      [...section.files].sort(
        (x, y) =>
          Number(isFileViewed(viewedKey, x.path)) -
          Number(isFileViewed(viewedKey, y.path)),
      ),
    // `isFileViewed` reads an external mutable registry. Its published version
    // is intentionally the dependency that invalidates this derived ordering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [section.files, viewedKey, viewedVersion],
  );
  const rows = ordered.map((f) => (
    <FileRow
      key={f.path}
      file={f}
      depth={1}
      showDir
      isSelected={selected === f.path}
      viewed={isFileViewed(viewedKey, f.path)}
      {...actions}
    />
  ));
  if (section.title == null) return <div>{rows}</div>;
  return (
    <div>
      <SectionHeader
        open={open}
        title={section.title}
        count={section.files.length}
        onToggle={() => setOpen((o) => !o)}
      />
      {open && rows}
    </div>
  );
}

const FileRow = React.memo(function FileRow({
  file,
  depth,
  showDir,
  isSelected,
  viewed,
  busy,
  committed,
  interactive,
  onSelect,
  onPrefetch,
  onDiscard,
}: {
  file: ChangedFile;
  depth: number;
  isSelected: boolean;
  viewed: boolean;
  /** Flat list → show the dimmed directory prefix; tree → basename only. */
  showDir?: boolean;
} & Omit<RowActions, "selected" | "viewedKey" | "viewedVersion">) {
  // Discard on hover only when the row has uncommitted work — a fully-committed
  // file (committed === true) has nothing to discard, so hide it.
  const canDiscard = interactive && file.committed === false;
  const isRename =
    file.status === "renamed" && !!file.oldPath && file.oldPath !== file.path;
  return (
    <div
      onClick={() => onSelect(file)}
      onPointerEnter={() => onPrefetch?.(file)}
      onFocus={() => onPrefetch?.(file)}
      className={cn(
        "group/change-row flex cursor-pointer items-center gap-2 py-1 pr-3 text-xs transition-colors",
        isSelected ? "bg-bg2-hover" : "hover:bg-bg2-hover/40",
        // Viewed → dimmed (the user has reviewed this change).
        viewed && "opacity-45",
      )}
      style={{ paddingLeft: 4 + depth * 14 }} // check:ui ignore-line (18px left at depth 1 (flat Changes list); 12px right via pr-3)
    >
      {isRename ? (
        // Moved file → "old/path → new/path" (both dirs dimmed, names bright).
        <Tooltip label={`${file.oldPath} → ${file.path}`}>
          <span className="flex min-w-0 flex-1 items-center text-sm">
            <span className="min-w-0 truncate">
              <PathLabel path={file.oldPath!} showDir={showDir} />
            </span>
            <span className="text-fg2 shrink-0 px-1.5">→</span>
            <span className="min-w-0 truncate">
              <PathLabel path={file.path} showDir={showDir} />
            </span>
          </span>
        </Tooltip>
      ) : (
        <Tooltip label={file.path}>
          <span className="min-w-0 flex-1 truncate text-sm">
            <PathLabel path={file.path} showDir={showDir} />
          </span>
        </Tooltip>
      )}

      {/* Right side: status glyph + ± counts + state dot, with Discard stacked
          on top and revealed on hover/focus. Both layers keep one fixed grid
          cell, and the action remains the pointer target even while transparent:
          moving from the row into the icon can no longer bounce pointer events
          back to the hidden status SVG and collapse the hover state. */}
      <div className="grid min-w-5 shrink-0 items-center">
        <span
          className={cn(
            "col-start-1 row-start-1 flex items-center gap-1.5 transition-opacity",
            canDiscard &&
              "pointer-events-none group-hover/change-row:opacity-0",
          )}
        >
          {!committed && <StatusGlyph status={file.status} />}
          <span className="text-2xxs tabular-nums">
            {file.additions > 0 && (
              <span className="text-green-primary">+{file.additions}</span>
            )}
            {file.deletions > 0 && (
              <span className="text-red-primary ml-1">−{file.deletions}</span>
            )}
          </span>
          {/* Square COLOUR is per-file when the scope sets it (All changes mixes
              committed + uncommitted), else the section default. */}
          <StatusSquare
            status={file.status}
            committed={file.committed ?? committed}
          />
        </span>
        {canDiscard && (
          <div className="relative z-10 col-start-1 row-start-1 flex items-center justify-self-end opacity-0 transition-opacity group-hover/change-row:opacity-100 focus-within:opacity-100">
            <RowBtn
              title="Discard"
              disabled={busy}
              onClick={() => onDiscard(file)}
            >
              <Undo2 className="size-3.5" />
            </RowBtn>
          </div>
        )}
      </div>
    </div>
  );
});

function RowBtn({
  title,
  disabled,
  onClick,
  className,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={title} className="pointer-events-none">
      <button
        type="button"
        aria-label={title}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className={cn(
          "text-fg2 hover:bg-bg2-hover hover:text-fg1 flex size-5 items-center justify-center rounded-sm transition-colors disabled:opacity-30",
          className,
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** The change TYPE behind a row's badge. created = added/untracked (＋),
 *  modified = modified/renamed (•), deleted (−), conflicted (•, always red). */
type ChangeKind = "created" | "modified" | "deleted" | "conflicted";

function changeKind(status: FileChangeStatus): ChangeKind {
  if (status === "conflicted") return "conflicted";
  if (status === "added" || status === "untracked") return "created";
  if (status === "deleted") return "deleted";
  return "modified"; // modified | renamed
}

const KIND_STYLE: Record<
  ChangeKind,
  { committedColor: string; label: string }
> = {
  created: { committedColor: "text-green-primary", label: "Created" },
  modified: { committedColor: "text-yellow-primary", label: "Modified" },
  deleted: { committedColor: "text-red-primary", label: "Deleted" },
  conflicted: { committedColor: "text-red-primary", label: "Conflicted" },
};

/** A 12px lucide-style square badge (square-plus / -dot / -minus — none ship in
 *  lucide-react 1.17, so they're inlined). The SHAPE is the change TYPE (＋
 *  created · • modified · − deleted); the COLOUR is the lifecycle: grey while
 *  uncommitted (untracked / staged / unstaged), then the type's colour once
 *  committed (green created · gold modified · red deleted). A conflict is red
 *  regardless — you must resolve it. Read-only: staging / commits happen via the
 *  agent or terminal, never here. */
function StatusSquare({
  status,
  committed,
}: {
  status: FileChangeStatus;
  committed: boolean;
}) {
  const kind = changeKind(status);
  const { committedColor, label } = KIND_STYLE[kind];
  const color =
    kind === "conflicted"
      ? "text-red-primary"
      : committed
        ? committedColor
        : "text-fg2";
  return (
    <svg
      role="img"
      aria-label={label}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0", color)}
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      {kind === "created" && (
        <>
          <path d="M8 12h8" />
          <path d="M12 8v8" />
        </>
      )}
      {kind === "deleted" && <path d="M8 12h8" />}
      {(kind === "modified" || kind === "conflicted") && (
        <circle cx="12" cy="12" r="1" />
      )}
    </svg>
  );
}

/** A file path as a dimmed directory prefix + a bright basename (flat list);
 *  tree rows pass showDir=false to show just the basename. */
function PathLabel({ path, showDir }: { path: string; showDir?: boolean }) {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  return (
    <>
      {showDir && dir && <span className="text-fg2">{dir}</span>}
      <span className="text-fg1">{name}</span>
    </>
  );
}

/** A/M/D/R/U/! — uniform 12px --fg1 letters (the change TYPE, read off the
 *  letter not a colour; the square-dot beside it carries the lifecycle STATE). */
function StatusGlyph({ status }: { status: FileChangeStatus }) {
  const ch: Record<FileChangeStatus, string> = {
    added: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
    untracked: "U",
    conflicted: "!",
  };
  return (
    <span className="text-fg1 w-3.5 shrink-0 text-center text-xs font-medium">
      {ch[status]}
    </span>
  );
}

// ── file list (tree) ─────────────────────────────────────────

function TreeSection({ section, ...a }: { section: Section } & RowActions) {
  const tree = useMemo(() => buildFileTree(section.files), [section.files]);
  const [open, setOpen] = useState(true);
  const rows = tree.map((node) => (
    <TreeRow key={node.name + (node.path ?? "")} node={node} depth={1} {...a} />
  ));
  if (section.title == null) return <div>{rows}</div>;
  return (
    <div>
      <SectionHeader
        open={open}
        title={section.title}
        count={section.files.length}
        onToggle={() => setOpen((o) => !o)}
      />
      {open && rows}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  selected,
  viewedKey,
  viewedVersion,
  ...actions
}: { node: TreeNode; depth: number } & RowActions) {
  const [open, setOpen] = useState(true);
  if (node.file) {
    return (
      <FileRow
        file={node.file}
        depth={depth}
        isSelected={selected === node.file.path}
        viewed={isFileViewed(viewedKey, node.file.path)}
        {...actions}
      />
    );
  }
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-fg2 hover:bg-bg2-hover/40 flex w-full items-center gap-1.5 py-1 pr-3 text-left text-xs transition-colors"
        style={{ paddingLeft: 4 + depth * 14 }} // check:ui ignore-line (tree folder row — same 4+depth*14 indent as FileRow so files/folders align)
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <Folder className="size-3.5" />
        <span className="truncate">{node.name}</span>
      </button>
      {open &&
        node.children.map((c) => (
          <TreeRow
            key={c.name + (c.path ?? "")}
            node={c}
            depth={depth + 1}
            selected={selected}
            viewedKey={viewedKey}
            viewedVersion={viewedVersion}
            {...actions}
          />
        ))}
    </div>
  );
}

// (DiscardDialog + discardPath now live in ./discard-file — shared with the
//  row-1 diff header so discard behaves identically in both places.)

/** Line count for an untracked file's contents → its "+N" (untracked files
 *  appear in no diff, so we count their lines here; it's all additions). */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return body.length === 0 ? 0 : body.split("\n").length;
}

// ── misc ─────────────────────────────────────────────────────

export function EmptyState({
  title,
  subtitle,
  icon: Icon = GitBranch,
}: {
  title: string;
  subtitle: string;
  /** Glyph above the title — defaults to the source-view branch mark. */
  icon?: LucideIcon;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-10 text-center">
      <Icon className="text-fg2 size-7" />
      <p className="text-fg1 m-0 text-sm font-medium">{title}</p>
      <p className="text-fg2 m-0 max-w-[420px] text-xs leading-[1.55]">
        {subtitle}
      </p>
    </div>
  );
}
