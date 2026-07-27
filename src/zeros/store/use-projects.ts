// ──────────────────────────────────────────────────────────
// React bindings for projects + per-project workspaces
// ──────────────────────────────────────────────────────────
//
// `useProjects()` — list + mutate the persisted projects registry.
// `useWorkspacesFor(repoSlug)` — live list of workspaces for one project,
//   queried via the workspace_list IPC. Refreshes on a published event so the
//   global top bar and workspace consumers stay in sync.
//
// We don't go full Redux/Zustand for this — projects are small, mutated
// infrequently, and the cross-tab story isn't urgent. A simple
// subscribe/publish bus with localStorage as the persistence layer is
// enough.
// ──────────────────────────────────────────────────────────

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { unstable_batchedUpdates } from "react-dom";
import {
  loadProjects,
  syncProjectsToEngine,
  type Project,
} from "./projects-store";
import { findProjectForFolder } from "./workspace-resolution";
import {
  isGitErrorShape,
  workspaceCreateFromBranchStatus,
  workspaceGet,
  workspaceLifecycleStatus,
  workspaceList,
  type CreateWorkspaceFromBranchStatus,
  type WorkspaceLifecycleStatus,
  type Workspace,
} from "../../native/git";
import { invalidateRepoReadCaches } from "./read-caches";
import {
  getActiveBridge,
  onActiveBridgeConnected,
} from "../bridge/active-bridge";
import {
  KeyedAsyncCache,
  type AsyncCacheSnapshot,
} from "../lib/keyed-async-cache";
import {
  forgetPersistedWorkspaceList,
  loadPersistedWorkspaceLists,
  persistWorkspaceList,
} from "./workspace-list-persistence";

const MAX_BOOT_PREFETCH_PROJECTS = 8;

// ── Projects subscription bus ────────────────────────────

type ProjectsListener = () => void;
const projectListeners = new Set<ProjectsListener>();
let projectsSnapshot: Project[] | null = null;

function getProjectsSnapshot(): Project[] {
  if (projectsSnapshot === null) projectsSnapshot = loadProjects();
  return projectsSnapshot;
}

function subscribeProjects(listener: ProjectsListener): () => void {
  projectListeners.add(listener);
  return () => {
    projectListeners.delete(listener);
  };
}

function sameProject(a: Project, b: Project): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.repoRoot === b.repoRoot &&
    a.repoSlug === b.repoSlug &&
    a.originUrl === b.originUrl &&
    a.addedAt === b.addedAt
  );
}

function stableProjectRows(
  previous: Project[] | null,
  next: Project[],
): Project[] {
  if (!previous) return next;
  const previousById = new Map(
    previous.map((project) => [project.id, project] as const),
  );
  const stable = next.map((project) => {
    const prior = previousById.get(project.id);
    return prior && sameProject(prior, project) ? prior : project;
  });
  return stable.length === previous.length &&
    stable.every((project, index) => project === previous[index])
    ? previous
    : stable;
}

/** Notify every mounted `useProjects()` consumer that the registry
 *  changed. Call this after any upsert/remove/rename. */
export function notifyProjectsChanged(): void {
  // Replace the shared immutable array BEFORE notifying so every subscriber
  // observes the same registry version in the same React commit.
  projectsSnapshot = stableProjectRows(projectsSnapshot, loadProjects());
  for (const fn of projectListeners) {
    try {
      fn();
    } catch {
      /* listeners shouldn't throw, but keep going if they do */
    }
  }
}

/** Hook returning the current projects list. Re-renders when
 *  `notifyProjectsChanged()` fires. */
export function useProjects(): {
  projects: Project[];
  refresh: () => void;
} {
  const projects = useSyncExternalStore(
    subscribeProjects,
    getProjectsSnapshot,
    getProjectsSnapshot,
  );
  return { projects, refresh: notifyProjectsChanged };
}

/** Resolve the project that owns `folder`, using the same list the global top
 *  bar renders so Column 2 surfaces stay reactive to project-list changes. */
export function useProjectForFolder(
  folder: string | null | undefined,
): Project | null {
  const { projects } = useProjects();
  return useMemo(
    () => findProjectForFolder(folder ?? null, projects),
    [folder, projects],
  );
}

/** On first bridge connect, push the localStorage projects to the engine DB so
 *  the engine has curated projects that have no worktree yet. */
export function useSyncProjectsToEngine(): void {
  useEffect(() => {
    let synced = false;
    let cancelWarm = () => {};
    const run = () => {
      if (synced) return;
      const bridge = getActiveBridge();
      if (!bridge || bridge.status !== "connected") return;
      synced = true;
      syncProjectsToEngine();
      // Warm inactive repository indexes only after critical workspace/chat
      // hydration has had the connection and main thread to itself.
      const warm = () => {
        for (const project of loadProjects().slice(
          0,
          MAX_BOOT_PREFETCH_PROJECTS,
        )) {
          prefetchWorkspacesFor(project.repoSlug);
        }
      };
      if (typeof window.requestIdleCallback === "function") {
        const id = window.requestIdleCallback(warm, { timeout: 1_000 });
        cancelWarm = () => window.cancelIdleCallback(id);
      } else {
        const id = window.setTimeout(warm, 0);
        cancelWarm = () => window.clearTimeout(id);
      }
    };
    const stop = onActiveBridgeConnected(run);
    return () => {
      cancelWarm();
      stop();
    };
  }, []);
}

// ── Workspaces subscription bus ──────────────────────────

type WorkspacesListener = (repoSlug: string) => void;
const workspaceListeners = new Set<WorkspacesListener>();

// Workspace lists are renderer-wide server state. TopBar, Column 2, Column 3,
// useActiveWorkspace, and repo pages all read the same slug; one keyed cache
// prevents those consumers from issuing independent IPC calls and guarantees
// they observe one atomic immutable array.
const workspaceCache = new KeyedAsyncCache<Workspace[]>(64);
const workspaceCollectionCache = new KeyedAsyncCache<Workspace[]>(32);
/** Per-repository publication clock. Cross-repo discovery captures these
 * before its bridge read and may only write keys that no newer exact-key read
 * or confirmed mutation published meanwhile. */
const workspaceRevisionBySlug = new Map<string, number>();
/** Any workspace mutation invalidates an in-flight cross-repo discovery as a
 * whole; its response may have been assembled before the SQLite commit. */
let workspaceMutationEpoch = 0;
/** Boot snapshots may render, but only a live response may use them to reject a
 * remembered workspace target. */
const provisionalWorkspaceSlugs = new Set<string>();
/** id → repoSlug for every live row we've observed. Lets a scoped DB_CHANGED
 * broadcast (which carries opaque ids) map to the exact repo(s) to refresh
 * instead of a global invalidate storm. A workspace's repoSlug is immutable, so
 * a stale entry only yields a slightly coarser (still correct) scope; cleared
 * per repo in forgetWorkspacesFor. */
const workspaceSlugById = new Map<string, string>();
/** Slugs whose seeded (provisional) rows were kept over a transient empty live
 * read; the one scheduled confirming read is allowed to accept [] so a
 * genuinely-empty repo isn't stranded on stale rows. */
const provisionalEmptyGuardHeld = new Set<string>();

function advanceWorkspaceRevision(repoSlug: string): void {
  workspaceRevisionBySlug.set(
    repoSlug,
    (workspaceRevisionBySlug.get(repoSlug) ?? 0) + 1,
  );
}
/** Cross-repo live-union consumers (Dashboard board, sidebar counts). Notified
 * when discovery/reload writes a slug the union may not be individually
 * subscribed to yet (e.g. an unregistered-repo row) so the union re-renders and
 * re-derives its slug set. */
const liveUnionListeners = new Set<() => void>();
function notifyLiveUnion(): void {
  for (const fn of liveUnionListeners) {
    try {
      fn();
    } catch {
      /* one subscriber must not stop the fan-out */
    }
  }
}
const WORKSPACE_CACHE_MAX_AGE_MS = 30_000;
const EMPTY_WORKSPACES: Workspace[] = [];
const NO_WORKSPACE_SNAPSHOT: AsyncCacheSnapshot<Workspace[]> = Object.freeze({
  data: EMPTY_WORKSPACES,
  loading: false,
  refreshing: false,
  error: null,
  updatedAt: 0,
  invalidationVersion: 0,
});

// Seed before any React consumer renders. Mark each entry stale so the first
// exact-key bridge connection revalidates behind the retained rows.
for (const [repoSlug, rows] of loadPersistedWorkspaceLists()) {
  workspaceCache.setData(repoSlug, rows);
  workspaceCache.invalidate(repoSlug);
  provisionalWorkspaceSlugs.add(repoSlug);
  for (const w of rows) workspaceSlugById.set(w.id, repoSlug);
}

function sameWorkspace(a: Workspace, b: Workspace): boolean {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

/** Preserve the exact array/object graph when an authoritative refresh is
 * semantically unchanged. This lets Zustand/React subscribers bail instead of
 * reconciling every workspace tab/card after a no-op DB broadcast. */
function stableWorkspaceRows(
  previous: Workspace[] | undefined,
  next: Workspace[],
): Workspace[] {
  if (!previous) return next;
  const previousById = new Map(
    previous.map((workspace) => [workspace.id, workspace] as const),
  );
  const stable = next.map((workspace) => {
    const prior = previousById.get(workspace.id);
    return prior && sameWorkspace(prior, workspace) ? prior : workspace;
  });
  return stable.length === previous.length &&
    stable.every((workspace, index) => workspace === previous[index])
    ? previous
    : stable;
}

/** Fetch one repository's complete live list while retaining the cold-boot
 * provisional-empty guard. Shared by ordinary background reads and awaited
 * create settlement so both paths participate in the same cache generation. */
async function fetchLiveWorkspaceRows(repoSlug: string): Promise<Workspace[]> {
  const prior = workspaceCache.getSnapshot(repoSlug).data;
  const fresh = await workspaceList({ repoSlug, archived: false });
  // Cold-boot defense-in-depth ONLY: a seeded (provisional) slug that reads
  // empty on its first live response is usually a mid-swap / unsynced engine,
  // not a genuine emptying. Keep the seed and require one confirming read.
  if (
    provisionalWorkspaceSlugs.has(repoSlug) &&
    fresh.length === 0 &&
    prior &&
    prior.length > 0 &&
    !provisionalEmptyGuardHeld.has(repoSlug)
  ) {
    provisionalEmptyGuardHeld.add(repoSlug);
    window.setTimeout(() => loadCachedWorkspaces(repoSlug, true), 400);
    // This exact-key response completed after any discovery that captured the
    // prior revision. Even though the cold-start guard retained old rows, that
    // older aggregate response must not become authoritative over this key.
    advanceWorkspaceRevision(repoSlug);
    return prior;
  }
  provisionalEmptyGuardHeld.delete(repoSlug);
  const stable = stableWorkspaceRows(prior, fresh);
  // Advance before returning to KeyedAsyncCache publication. This closes the
  // microtask gap where a slower aggregate discovery could otherwise publish
  // between the exact response completing and its `.then` finalizer running.
  advanceWorkspaceRevision(repoSlug);
  return stable;
}

/** Accept post-read side effects only when `rows` is still the cache's winning
 * generation. An invalidated or superseded response may resolve its caller but
 * must not bless provisional data, persistence, or exact-key indexes. */
function finalizeWorkspaceRows(repoSlug: string, rows: Workspace[]): boolean {
  const snapshot = workspaceCache.getSnapshot(repoSlug);
  if (snapshot.data !== rows || snapshot.loading || snapshot.refreshing) {
    return false;
  }
  // The empty guard deliberately retained a seed. Callers waiting to reveal a
  // new workspace must keep waiting for the scheduled authoritative confirm.
  if (provisionalEmptyGuardHeld.has(repoSlug)) return false;
  provisionalWorkspaceSlugs.delete(repoSlug);
  persistWorkspaceList(repoSlug, rows);
  reindexWorkspaceSlugs(repoSlug, rows);
  notifyLiveUnion();
  return true;
}

/** Populate one live-workspace cache entry. A disconnected bridge leaves an
 * existing snapshot untouched; onActiveBridgeConnected retries automatically. */
function loadCachedWorkspaces(
  repoSlug: string,
  force: boolean,
  maxAgeMs = WORKSPACE_CACHE_MAX_AGE_MS,
): void {
  const bridge = getActiveBridge();
  if (!bridge || bridge.status !== "connected") return;
  void workspaceCache
    .load(repoSlug, () => fetchLiveWorkspaceRows(repoSlug), { force, maxAgeMs })
    .then((rows) => {
      finalizeWorkspaceRows(repoSlug, rows);
    })
    .catch(() => {
      // The immutable cache snapshot carries the error while retaining any
      // confirmed rows. Consumers decide whether that error needs visible UI.
    });
}

/** Populate a dashboard/archive collection while preserving its prior rows. */
function loadCachedWorkspaceCollection(
  key: string,
  fetcher: () => Promise<Workspace[]>,
  force: boolean,
  maxAgeMs = WORKSPACE_CACHE_MAX_AGE_MS,
): void {
  const bridge = getActiveBridge();
  if (!bridge || bridge.status !== "connected") return;
  void workspaceCollectionCache
    .load(
      key,
      async () =>
        stableWorkspaceRows(
          workspaceCollectionCache.getSnapshot(key).data,
          await fetcher(),
        ),
      { force, maxAgeMs },
    )
    .catch(() => {});
}

/** Publish an authoritative git-free row set for one slug into the single
 * source cache (superseding any in-flight per-repo load via the cache's
 * generation guard), persist it, index its ids, and wake cross-repo union
 * consumers — including for slugs they aren't individually subscribed to yet. */
function ingestWorkspaceRows(repoSlug: string, rows: Workspace[]): void {
  if (!repoSlug) return;
  const prior = workspaceCache.peekSnapshot(repoSlug).data;
  // Provisional-empty guard (mirrors loadCachedWorkspaces): a seeded slug that a
  // cross-repo discovery read returns empty for is almost always a mid-swap /
  // unsynced engine, not a genuine emptying — keep the seeded rows and confirm
  // once via a forced per-repo read. Scoped to provisional slugs, so a real
  // archive-to-empty (non-provisional by then) still reaches []. Without this,
  // ONE transient-empty discovery response would blank every repo AND overwrite
  // persistence with []. While held, further empty ingests keep prior; the
  // scheduled confirm is the single authoritative decider.
  if (
    rows.length === 0 &&
    provisionalWorkspaceSlugs.has(repoSlug) &&
    prior &&
    prior.length > 0
  ) {
    if (!provisionalEmptyGuardHeld.has(repoSlug)) {
      provisionalEmptyGuardHeld.add(repoSlug);
      window.setTimeout(() => loadCachedWorkspaces(repoSlug, true), 400);
    }
    return;
  }
  const stable = stableWorkspaceRows(prior, rows);
  workspaceCache.setData(repoSlug, stable);
  advanceWorkspaceRevision(repoSlug);
  provisionalWorkspaceSlugs.delete(repoSlug);
  provisionalEmptyGuardHeld.delete(repoSlug);
  reindexWorkspaceSlugs(repoSlug, stable);
  persistWorkspaceList(repoSlug, stable);
  notifyLiveUnion();
}

function patchArchivedCollections(
  workspace: Workspace,
  action: "upsert" | "remove",
): void {
  for (const key of workspaceCollectionCache.keys()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(key);
    } catch {
      continue;
    }
    if (
      !Array.isArray(parsed) ||
      parsed[0] !== "archived" ||
      (parsed[1] !== null && parsed[1] !== workspace.repoSlug)
    ) {
      continue;
    }
    const prior = workspaceCollectionCache.peekSnapshot(key).data ?? [];
    const without = prior.filter((row) => row.id !== workspace.id);
    const next =
      action === "upsert"
        ? [workspace, ...without].sort(
            (a, b) =>
              (b.archivedAt ?? 0) - (a.archivedAt ?? 0) ||
              b.createdAt - a.createdAt,
          )
        : without;
    workspaceCollectionCache.setData(key, stableWorkspaceRows(prior, next));
  }
}

/** Commit a confirmed archive across the live exact-key cache and every
 * retained Archived collection in one React batch. The live row remains in its
 * original surface while the operation is busy, so this authoritative result is
 * the sole membership transition and a concrete failure produces no bounce. */
export function commitWorkspaceArchived(workspace: Workspace): void {
  unstable_batchedUpdates(() => {
    const prior = workspaceCache.peekSnapshot(workspace.repoSlug).data;
    // A mutation result is authoritative for this row, not for every sibling
    // in its repository. Never turn a cold key into a partial/empty exact-key
    // list; the scoped revalidation below will populate the complete list.
    if (prior !== undefined) {
      ingestWorkspaceRows(
        workspace.repoSlug,
        prior.filter((row) => row.id !== workspace.id),
      );
    }
    patchArchivedCollections(workspace, "upsert");
  });
}

/** Confirmed inverse of commitWorkspaceArchived. */
export function commitWorkspaceRestored(workspace: Workspace): void {
  unstable_batchedUpdates(() => {
    const prior = workspaceCache.peekSnapshot(workspace.repoSlug).data;
    if (prior !== undefined) {
      ingestWorkspaceRows(workspace.repoSlug, [
        workspace,
        ...prior.filter((row) => row.id !== workspace.id),
      ]);
    }
    patchArchivedCollections(workspace, "remove");
  });
}

/** Confirmed permanent deletion from either live or archived state. */
export function commitWorkspaceDeleted(workspace: Workspace): void {
  unstable_batchedUpdates(() => {
    const prior = workspaceCache.peekSnapshot(workspace.repoSlug).data;
    if (prior !== undefined) {
      ingestWorkspaceRows(
        workspace.repoSlug,
        prior.filter((row) => row.id !== workspace.id),
      );
    }
    patchArchivedCollections(workspace, "remove");
  });
}

/** Exact-key seed seam for cache transition tests. Production population goes
 * through bridge reads; exposing this explicitly keeps tests from pretending a
 * one-row mutation result is a complete repository collection. */
export function setWorkspaceRowsForTesting(
  repoSlug: string,
  rows: Workspace[],
): void {
  ingestWorkspaceRows(repoSlug, rows);
}

/** Re-map this slug's live ids in workspaceSlugById, pruning any id that left
 * the slug so the id→slug index tracks only currently-live rows (no unbounded
 * growth across a session's archives/deletes). */
function reindexWorkspaceSlugs(repoSlug: string, rows: Workspace[]): void {
  const liveIds = new Set(rows.map((w) => w.id));
  for (const [id, slug] of workspaceSlugById) {
    if (slug === repoSlug && !liveIds.has(id)) workspaceSlugById.delete(id);
  }
  for (const w of rows) workspaceSlugById.set(w.id, repoSlug);
}

/** Every repo slug the cross-repo live union must cover: registered projects
 * plus any slug already present in the cache (discovery can surface a live
 * workspace whose repo isn't in the local registry). */
function collectLiveSlugs(): string[] {
  const set = new Set<string>();
  for (const project of getProjectsSnapshot()) {
    if (project.repoSlug) set.add(project.repoSlug);
  }
  for (const key of workspaceCache.keys()) set.add(key);
  return [...set].sort();
}

// One cross-repo git-free discovery read at a time; a forced request arriving
// mid-flight queues exactly one follow-up so a change during discovery is never
// missed. A non-forced request honours a freshness window.
let discoveryInFlight = false;
let discoveryQueued = false;
let lastDiscoveryAt = 0;
let discoveryPromise: Promise<void> | null = null;

/** Populate/repair the single source across ALL repos from one git-free
 * `workspaceList({archived:false})` read: ingest each repo's rows and ingest []
 * for every previously-known slug now absent (cross-repo archive-to-empty +
 * completeness for unregistered-repo rows). This is the fetch-DRIVER the cross-
 * repo union needs — invalidation only marks entries stale, it never reads.
 * Replaces the deleted heavy `withChanges` collection query. */
function runDiscovery(force: boolean): Promise<void> {
  const bridge = getActiveBridge();
  if (!bridge || bridge.status !== "connected") return Promise.resolve();
  if (discoveryInFlight) {
    if (force) discoveryQueued = true;
    return discoveryPromise ?? Promise.resolve();
  }
  if (!force && Date.now() - lastDiscoveryAt < WORKSPACE_CACHE_MAX_AGE_MS) {
    return Promise.resolve();
  }
  discoveryInFlight = true;
  const mutationEpoch = workspaceMutationEpoch;
  const revisionsAtStart = new Map(workspaceRevisionBySlug);
  discoveryPromise = (async () => {
    try {
      const rows = await workspaceList({ archived: false });
      if (mutationEpoch !== workspaceMutationEpoch) {
        // A create/archive/restore/delete landed while this aggregate snapshot
        // was being assembled. Never project its pre-mutation rows; queue one
        // fresh aggregate read after this flight releases.
        discoveryQueued = true;
        return;
      }
      const bySlug = new Map<string, Workspace[]>();
      for (const w of rows) {
        if (!w.repoSlug) continue; // synthetic local-main is already stripped
        const list = bySlug.get(w.repoSlug);
        if (list) list.push(w);
        else bySlug.set(w.repoSlug, [w]);
      }
      const known = new Set<string>([
        ...getProjectsSnapshot()
          .map((p) => p.repoSlug)
          .filter((s): s is string => !!s),
        ...workspaceCache.keys(),
        ...bySlug.keys(),
      ]);
      for (const slug of known) {
        if (
          (workspaceRevisionBySlug.get(slug) ?? 0) !==
          (revisionsAtStart.get(slug) ?? 0)
        ) {
          // A newer exact-key load already won this repository while discovery
          // was in flight. Keep it; other untouched slugs can still ingest.
          continue;
        }
        ingestWorkspaceRows(slug, bySlug.get(slug) ?? []);
      }
      lastDiscoveryAt = Date.now();
    } catch {
      /* leave existing snapshots intact; reconnect / next notify retries */
    } finally {
      discoveryInFlight = false;
      if (discoveryQueued) {
        discoveryQueued = false;
        runDiscovery(true);
      }
    }
  })();
  return discoveryPromise;
}

/** Test seam for the aggregate-vs-exact publication race. Production callers
 * use the live-union hook, which drives the same function on mount/reconnect. */
export function runWorkspaceDiscoveryForTesting(): Promise<void> {
  return runDiscovery(true);
}

/** Await a forced authoritative refresh of one repo's live list and commit it
 * to the single source. The optimistic-create success path awaits this so the
 * real row is present in the cache BEFORE its "Setting up…" placeholder drops,
 * killing the momentary no-tab flash on every surface at once. */
export async function reloadWorkspacesFor(repoSlug: string): Promise<boolean> {
  if (!repoSlug) return false;
  const bridge = getActiveBridge();
  if (!bridge || bridge.status !== "connected") return false;
  try {
    const rows = await workspaceCache.load(
      repoSlug,
      () => fetchLiveWorkspaceRows(repoSlug),
      { force: true },
    );
    return finalizeWorkspaceRows(repoSlug, rows);
  } catch {
    /* keep prior rows; the list bus retries */
    return false;
  }
}

export type TimedOutWorkspaceCreateResolution =
  | "pending"
  | "ready"
  | "rolled-back"
  | "interrupted"
  | "archived";

/** Pure timeout observation classifier, exported to pin the rowless pre-journal
 * race in tests. A missing row is NOT rollback while the engine still owns the
 * prepared id; an inactive durable journal is interrupted and needs recovery. */
export function classifyTimedOutWorkspaceCreate(
  status: WorkspaceLifecycleStatus,
  workspace: Workspace | null,
): TimedOutWorkspaceCreateResolution {
  if (workspace?.archivedAt != null) return "archived";
  if (status.active) return "pending";
  if (status.operation != null) return "interrupted";
  return workspace ? "ready" : "rolled-back";
}

/** Follow a create whose client request timed out without guessing from elapsed
 * time. Live exact-key membership proves publication; the engine's exact
 * lifecycle observation covers the rowless fetch phase and durable journal.
 * The cache subscription normally settles immediately from DB_CHANGED, while
 * polling covers a dropped broadcast or reconnect. */
export function watchTimedOutWorkspaceCreate(args: {
  repoSlug: string;
  workspaceId: string;
  onReady: (workspace: Workspace) => void;
  onUnavailable: (
    reason: Exclude<TimedOutWorkspaceCreateResolution, "pending" | "ready">,
  ) => void;
}): () => void {
  let stopped = false;
  let timer: number | null = null;
  let unsubscribe = () => {};
  const settle = (callback: () => void) => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
    unsubscribe();
    callback();
  };
  const findPublished = (): Workspace | null =>
    workspaceCache
      .peekSnapshot(args.repoSlug)
      .data?.find((row) => row.id === args.workspaceId) ?? null;
  const acceptPublished = (): boolean => {
    const workspace = findPublished();
    if (!workspace) return false;
    settle(() => args.onReady(workspace));
    return true;
  };
  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = window.setTimeout(() => void check(), delayMs);
  };
  const check = async () => {
    if (stopped || acceptPublished()) return;
    await reloadWorkspacesFor(args.repoSlug);
    if (stopped || acceptPublished()) return;
    let status: WorkspaceLifecycleStatus;
    try {
      status = await workspaceLifecycleStatus(args.workspaceId);
    } catch {
      schedule(10_000); // disconnected is not evidence of rollback
      return;
    }
    let workspace: Workspace | null = null;
    try {
      workspace = await workspaceGet(args.workspaceId);
    } catch (error) {
      if (!(isGitErrorShape(error) && error.code === "WORKSPACE_NOT_FOUND")) {
        schedule(10_000);
        return;
      }
    }
    const resolution = classifyTimedOutWorkspaceCreate(status, workspace);
    if (resolution === "pending") {
      schedule(3_000);
      return;
    }
    if (resolution === "ready") {
      if (!workspace) {
        schedule(3_000);
        return;
      }
      // The exact row can become live between the list read above and this probe.
      // Populate the complete repo key before dropping the pending placeholder.
      if (await reloadWorkspacesFor(args.repoSlug)) {
        if (acceptPublished()) return;
      }
      schedule(3_000);
      return;
    }
    settle(() => args.onUnavailable(resolution));
  };
  unsubscribe = workspaceCache.subscribe(args.repoSlug, () => {
    acceptPublished();
  });
  void check();
  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
    unsubscribe();
  };
}

export type TimedOutBranchWorkspaceCreateResolution =
  | "pending"
  | "ready"
  | "rolled-back"
  | "interrupted"
  | "archived"
  | "missing-folder";

/** Classify the exact repo+branch probe used when the renderer does not yet
 * know the engine-generated workspace id. */
export function classifyTimedOutBranchWorkspaceCreate(
  status: CreateWorkspaceFromBranchStatus,
): TimedOutBranchWorkspaceCreateResolution {
  if (status.active) return "pending";
  if (status.operation != null) return "interrupted";
  if (!status.workspace) return "rolled-back";
  if (status.workspace.archivedAt != null) return "archived";
  if (status.workspace.present === false) return "missing-folder";
  return "ready";
}

/** Follow create-from-branch/PR after its response times out. The repo+branch
 * key remains known even though the generated workspace id did not make it back
 * to the renderer, so the engine can still distinguish active work, durable
 * interruption, publication, and rollback exactly. */
export function watchTimedOutBranchWorkspaceCreate(args: {
  repoRoot: string;
  repoSlug: string;
  branchName: string;
  onReady: (workspace: Workspace) => void;
  onUnavailable: (
    reason: Exclude<
      TimedOutBranchWorkspaceCreateResolution,
      "pending" | "ready"
    >,
    workspace: Workspace | null,
  ) => void;
}): () => void {
  let stopped = false;
  let timer: number | null = null;
  let unsubscribe = () => {};
  const stop = () => {
    if (stopped) return false;
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
    unsubscribe();
    return true;
  };
  const acceptPublished = (): boolean => {
    const workspace =
      workspaceCache
        .peekSnapshot(args.repoSlug)
        .data?.find(
          (row) =>
            row.branch === args.branchName &&
            row.repoRoot === args.repoRoot &&
            row.archivedAt == null &&
            row.present !== false,
        ) ?? null;
    if (!workspace || !stop()) return false;
    args.onReady(workspace);
    return true;
  };
  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = window.setTimeout(() => void check(), delayMs);
  };
  const check = async () => {
    if (stopped || acceptPublished()) return;
    let status: CreateWorkspaceFromBranchStatus;
    try {
      status = await workspaceCreateFromBranchStatus({
        repoRoot: args.repoRoot,
        repoSlug: args.repoSlug,
        branchName: args.branchName,
      });
    } catch {
      schedule(10_000); // a disconnect is not an operation outcome
      return;
    }
    const resolution = classifyTimedOutBranchWorkspaceCreate(status);
    if (resolution === "pending") {
      schedule(3_000);
      return;
    }
    if (resolution === "ready") {
      // Commit the complete repo list before callers navigate to the new folder.
      // A failed list read is transient, not evidence that the exact row vanished.
      if (!(await reloadWorkspacesFor(args.repoSlug))) {
        schedule(3_000);
        return;
      }
      if (acceptPublished()) return;
      // The exact row exists but a racing/stale collection response did not
      // include it yet. Keep the control pending rather than navigating into a
      // destination the shared cache cannot resolve.
      schedule(3_000);
      return;
    }
    if (stop()) args.onUnavailable(resolution, status.workspace);
  };
  unsubscribe = workspaceCache.subscribe(args.repoSlug, () => {
    acceptPublished();
  });
  void check();
  return () => {
    stop();
  };
}

/** Warm a repository without making a currently rendered view wait for it. */
export function prefetchWorkspacesFor(repoSlug: string): void {
  if (!repoSlug) return;
  loadCachedWorkspaces(repoSlug, false);
}

/** Read the last exact-key workspace snapshot without subscribing or starting
 * I/O. Navigation uses `undefined` to distinguish a cold key from an
 * authoritative empty/missing result, so it never guesses main while a valid
 * remembered worktree may merely be loading. */
export function peekWorkspacesFor(repoSlug: string): Workspace[] | undefined {
  if (!repoSlug) return undefined;
  if (provisionalWorkspaceSlugs.has(repoSlug)) return undefined;
  return workspaceCache.getSnapshot(repoSlug).data;
}

/** Remove every renderer-side snapshot owned by a deleted repository. */
export function forgetWorkspacesFor(repoSlug: string): void {
  if (!repoSlug) return;
  provisionalWorkspaceSlugs.delete(repoSlug);
  provisionalEmptyGuardHeld.delete(repoSlug);
  forgetPersistedWorkspaceList(repoSlug);
  for (const [id, slug] of workspaceSlugById) {
    if (slug === repoSlug) workspaceSlugById.delete(id);
  }
  lastDiscoveryAt = 0; // a repo left — let the next union mount re-discover
  workspaceCache.setData(repoSlug, []);
  advanceWorkspaceRevision(repoSlug);
  workspaceCache.invalidate(repoSlug);
  notifyLiveUnion();
}

/** Tell every `useWorkspacesFor(slug)` consumer to refetch. Pass `*`
 *  to invalidate all consumers (used after sweeping operations like
 *  backfill). */
export function notifyWorkspacesChanged(repoSlug: string | "*" = "*"): void {
  // Any mutation makes a cross-repo discovery stale; reset its freshness clock
  // so a Dashboard/sidebar that REMOUNTS after this actually re-runs discovery
  // (its mount fires runDiscovery(false), which the time gate would otherwise
  // skip for ~30s — showing stale cross-repo rows while it was unmounted).
  lastDiscoveryAt = 0;
  workspaceMutationEpoch++;
  if (repoSlug === "*") workspaceCache.invalidateAll();
  else workspaceCache.invalidate(repoSlug);
  // Dashboard/archive collections can contain rows from any repository. Mark
  // them stale, but let only mounted consumers perform the background read.
  workspaceCollectionCache.invalidateAll();
  // Workspace mutations move branches and checkouts, so picker rows (branch
  // lists, workspace summaries) are stale too. Marking them costs nothing
  // until a picker actually opens.
  invalidateRepoReadCaches(repoSlug);
  for (const fn of workspaceListeners) {
    try {
      fn(repoSlug);
    } catch {
      /* keep going */
    }
  }
}

/** Scoped variant of notifyWorkspacesChanged for a DB_CHANGED broadcast that
 *  carries opaque workspace ids: map each id → its repo slug and invalidate only
 *  those repos (each notifyWorkspacesChanged(slug) still refreshes the archived
 *  History collection). Any unmappable id — a brand-new remote workspace whose
 *  slug we've never seen — falls back to a full '*' invalidate + discovery so
 *  new rows still land. Keeps the common per-change case off the invalidate
 *  storm that made the Dashboard lag the top bar. */
export function notifyWorkspacesChangedForIds(ids: readonly string[]): void {
  const slugs = new Set<string>();
  for (const id of ids) {
    const slug = workspaceSlugById.get(id);
    if (!slug) {
      notifyWorkspacesChanged("*");
      return;
    }
    slugs.add(slug);
  }
  if (slugs.size === 0) {
    notifyWorkspacesChanged("*");
    return;
  }
  for (const slug of slugs) notifyWorkspacesChanged(slug);
}

/** Live workspace list for one project. Refetches via IPC on mount,
 *  and again whenever `notifyWorkspacesChanged()` fires for matching
 *  slug. */
export function useWorkspacesFor(repoSlug: string | null): {
  workspaces: Workspace[];
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  refresh: () => void;
} {
  // Stable key-scoped functions keep useSyncExternalStore from resubscribing on
  // unrelated renders while still switching atomically to another repo entry.
  const subscribe = useCallback(
    (listener: () => void) =>
      repoSlug ? workspaceCache.subscribe(repoSlug, listener) : () => {},
    [repoSlug],
  );
  const getSnapshot = useCallback(
    () =>
      repoSlug ? workspaceCache.getSnapshot(repoSlug) : NO_WORKSPACE_SNAPSHOT,
    [repoSlug],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Explicit refreshes bypass freshness but keep the last complete list on
  // screen until the replacement array commits in one notification.
  const refresh = useCallback(() => {
    if (repoSlug) loadCachedWorkspaces(repoSlug, true);
  }, [repoSlug]);

  const revalidate = useCallback(() => {
    if (repoSlug) loadCachedWorkspaces(repoSlug, false, -1);
  }, [repoSlug]);

  useEffect(() => {
    const listener: WorkspacesListener = (slug) => {
      if (slug === "*" || slug === repoSlug) revalidate();
    };
    workspaceListeners.add(listener);
    return () => {
      workspaceListeners.delete(listener);
    };
  }, [revalidate, repoSlug]);

  // Refetch when the bridge (re)connects. getActiveBridge() is null on first mount
  // (BridgeProvider sets the singleton in a later root effect) + the client is
  // swapped on engine respawn. Without this the top bar's worktrees stay empty
  // after a cold open until a manual refetch, and go stale after an engine HMR
  // respawn. The subscribe-time fire (`initial`) happens on EVERY mount while
  // the app is healthy, so it honours the freshness window — a fresh shared
  // cache costs nothing. Only genuine (re)connect transitions force a read.
  useEffect(() => {
    return onActiveBridgeConnected((_client, { initial }) => {
      if (!repoSlug) return;
      if (initial) loadCachedWorkspaces(repoSlug, false);
      else loadCachedWorkspaces(repoSlug, false, -1);
    });
  }, [repoSlug]);

  return {
    workspaces: snapshot.data ?? EMPTY_WORKSPACES,
    loading: repoSlug !== null && snapshot.loading,
    refreshing: repoSlug !== null && snapshot.refreshing,
    error: snapshot.error,
    refresh,
  };
}

/** Live list of ARCHIVED workspaces. With no `repoSlug` this is the Dashboard's
 *  flat cross-repo source; passing a slug keeps compact surfaces such as the
 *  top-bar archive browser server-scoped to one repository. Refetches on mount,
 *  bridge (re)connect, and relevant workspace-bus notifications. */
export function useArchivedWorkspaces(repoSlug?: string): {
  workspaces: Workspace[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
} {
  const key = JSON.stringify(["archived", repoSlug ?? null]);
  const subscribe = useCallback(
    (listener: () => void) => workspaceCollectionCache.subscribe(key, listener),
    [key],
  );
  const getSnapshot = useCallback(
    () => workspaceCollectionCache.getSnapshot(key),
    [key],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = useCallback(() => {
    loadCachedWorkspaceCollection(
      key,
      () =>
        workspaceList({ archived: true, ...(repoSlug ? { repoSlug } : {}) }),
      true,
    );
  }, [key, repoSlug]);

  const revalidate = useCallback(
    (maxAgeMs = -1) => {
      loadCachedWorkspaceCollection(
        key,
        () =>
          workspaceList({ archived: true, ...(repoSlug ? { repoSlug } : {}) }),
        false,
        maxAgeMs,
      );
    },
    [key, repoSlug],
  );

  useEffect(() => {
    // Cross-repo consumers refetch on any change; scoped consumers ignore
    // unrelated repos. `*` is emitted by archive/restore and reaches both.
    const listener: WorkspacesListener = (changedSlug) => {
      if (!repoSlug || changedSlug === "*" || changedSlug === repoSlug)
        revalidate();
    };
    workspaceListeners.add(listener);
    return () => {
      workspaceListeners.delete(listener);
    };
  }, [revalidate, repoSlug]);

  useEffect(() => {
    // Mount-time fire honours the freshness window; only genuine (re)connects
    // force a read (see useWorkspacesFor).
    return onActiveBridgeConnected((_client, { initial }) =>
      revalidate(initial ? WORKSPACE_CACHE_MAX_AGE_MS : -1),
    );
  }, [revalidate]);

  return {
    workspaces: snapshot.data ?? EMPTY_WORKSPACES,
    loading: snapshot.loading,
    error: snapshot.error,
    refresh,
  };
}

/** Live, FLAT cross-repo list of NON-archived workspaces — the Dashboard board
 *  and home-sidebar repo counts. Derived by UNIONing the same per-repo
 *  `workspaceCache` entries the top bar reads (via useWorkspacesFor), so for any
 *  repo every surface projects the IDENTICAL Workspace objects and the views can
 *  never structurally disagree — the old separate heavy `withChanges` collection
 *  query (which diverged in seeding, latency, and invalidation) is gone.
 *
 *  Kept live by: per-slug cache subscriptions (re-subscribed when the project
 *  set changes) + a `liveUnionListeners` poke for discovery-only slugs + a
 *  fetch-driver (runDiscovery on mount / bridge reconnect / coarse bus events,
 *  and a per-slug reload on scoped bus events). hasChanges is intentionally NOT
 *  here — cards probe it lazily. */
export function useLiveWorkspaces(): {
  workspaces: Workspace[];
  loading: boolean;
} {
  const { projects } = useProjects();
  // (Re)subscription identity: the registered slugs. Discovery-only slugs
  // (unregistered repos) are folded in at snapshot time + via the union bus.
  const projectSlugsKey = useMemo(
    () =>
      projects
        .map((project) => project.repoSlug)
        .filter(Boolean)
        .sort()
        .join("\n"),
    [projects],
  );

  // Ref-memoized union so useSyncExternalStore gets a STABLE array while nothing
  // changed — rebuilt only when the slug set or any per-slug data reference
  // changes. peekSnapshot keeps the read pure (no LRU mutation during render).
  const unionRef = useRef<{
    key: string;
    refs: Array<Workspace[] | undefined>;
    union: Workspace[];
  } | null>(null);

  const getSnapshot = useCallback((): Workspace[] => {
    const slugs = collectLiveSlugs();
    const refs = slugs.map((slug) => workspaceCache.peekSnapshot(slug).data);
    const key = slugs.join("\n");
    const prev = unionRef.current;
    if (
      prev &&
      prev.key === key &&
      prev.refs.length === refs.length &&
      prev.refs.every((ref, index) => ref === refs[index])
    ) {
      return prev.union;
    }
    const union: Workspace[] = [];
    for (const rows of refs) if (rows) union.push(...rows);
    unionRef.current = { key, refs, union };
    return union;
  }, []);

  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribes = collectLiveSlugs().map((slug) =>
        workspaceCache.subscribe(slug, listener),
      );
      liveUnionListeners.add(listener);
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
        liveUnionListeners.delete(listener);
      };
    },
    // Re-subscribe when the registered project set changes so a new repo's key
    // gets a direct subscription. projectSlugsKey is the intentional trigger
    // even though the body reads live module state (collectLiveSlugs) rather
    // than the key itself; discovery-only keys ride the union bus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectSlugsKey],
  );

  const workspaces = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const loading =
    workspaces.length === 0 &&
    collectLiveSlugs().some(
      (slug) => workspaceCache.peekSnapshot(slug).loading,
    );

  // Fetch-driver: nothing above READS from the bridge (invalidation only marks
  // entries stale). Discovery on mount + a per-slug reload on scoped bus events
  // keeps non-focused repos fresh; a coarse '*' event re-runs discovery.
  useEffect(() => {
    runDiscovery(false);
    const listener: WorkspacesListener = (slug) => {
      if (slug === "*") runDiscovery(true);
      else loadCachedWorkspaces(slug, false, -1);
    };
    workspaceListeners.add(listener);
    return () => {
      workspaceListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    return onActiveBridgeConnected((_client, { initial }) =>
      runDiscovery(!initial),
    );
  }, []);

  return { workspaces, loading };
}
