import {
  normalizeWorkspacePathQuery,
  WorkspacePathIndex,
  workspacePathScore,
} from "@zeros/protocol/workspace-paths";
import { listWorkspaceMentionPaths } from "../../platform/git";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { deriveWorkspaceEntries, type WorkspaceEntry } from "./mentions";

/** Authoritative query results remain exact-cwd/query snapshots. A bounded
 * index of confirmed paths supplies immediate same-workspace matches while a
 * new query asks the engine's complete index for its authoritative ranking. */
export const mentionFilesCache = new KeyedAsyncCache<WorkspaceEntry[]>({
  maxEntries: 64,
  maxWeight: 40_000,
  weightOf: (entries) => entries.length,
});

interface WarmWorkspace {
  revision: string;
  checkedAt: number;
  users: number;
  paths: Map<string, WorkspaceEntry>;
  index?: WorkspacePathIndex;
}
const workspaces = new Map<string, WarmWorkspace>();
const MAX_WARM_WORKSPACES = 16;
const MAX_WARM_PATHS = 2048;
const FRESH_MS = 2000;
// An opaque cache revision, not a credential. Separate renderer sessions must
// not reuse a previous process's filesystem generation after a reload.
const session = Math.random().toString(36).slice(2);
let revision = 0;
const nextRevision = () => `${session}:${++revision}`;

function pruneWorkspaces(): void {
  for (const [cwd, workspace] of workspaces) {
    if (workspaces.size <= MAX_WARM_WORKSPACES) break;
    if (workspace.users === 0) workspaces.delete(cwd);
  }
}

function warmWorkspace(cwd: string): WarmWorkspace {
  const root = rootFor(cwd);
  const workspace = workspaces.get(root) ?? {
    revision: nextRevision(),
    checkedAt: Date.now(),
    users: 0,
    paths: new Map<string, WorkspaceEntry>(),
  };
  workspaces.delete(root);
  workspaces.set(root, workspace);
  return workspace;
}

function rootFor(cwd: string): string {
  return cwd === "/" || /^[A-Za-z]:[\\/]$/.test(cwd)
    ? cwd
    : cwd.replace(/[\\/]+$/, "");
}

function keyFor(cwd: string, query: string): string {
  return JSON.stringify([rootFor(cwd), normalizeWorkspacePathQuery(query)]);
}

/** The existing file/attachment refresh bus invalidates every query for the
 * affected workspace. Inactive queries retain rows and do no background work. */
export function invalidateMentionFiles(cwd?: string): void {
  // Advance the shared filesystem revision before notifying query subscribers.
  // Every query/composer for this cwd then reuses the same replacement scan.
  for (const [root, workspace] of workspaces) {
    if (cwd !== undefined && root !== rootFor(cwd)) continue;
    workspace.revision = nextRevision();
    workspace.checkedAt = Date.now();
  }
  if (cwd === undefined) {
    mentionFilesCache.invalidateAll();
    return;
  }
  const root = rootFor(cwd);
  for (const key of mentionFilesCache.keys()) {
    if ((JSON.parse(key) as [string, string])[0] === root)
      mentionFilesCache.invalidate(key);
  }
}

async function fetchEntries(key: string): Promise<WorkspaceEntry[]> {
  const [cwd, query] = JSON.parse(key) as [string, string];
  const workspace = warmWorkspace(cwd);
  const revision = workspace.revision;
  const paths = await listWorkspaceMentionPaths(cwd, query, revision);
  const entries = deriveWorkspaceEntries(paths);
  // An invalidated response may still settle for its original caller, but
  // cannot seed the warm index with paths from a rejected generation.
  if (workspace.revision === revision && workspaces.get(cwd) === workspace) {
    let changed = false;
    if (paths.length < 64) {
      const present = new Set(entries.map((entry) => entry.path));
      for (const [path, entry] of workspace.paths) {
        if (!present.has(path) && workspacePathScore(query, entry) !== null) {
          workspace.paths.delete(path);
          changed = true;
        }
      }
    }
    for (const entry of entries) {
      const previous = workspace.paths.get(entry.path);
      workspace.paths.delete(entry.path);
      workspace.paths.set(
        entry.path,
        previous?.kind === entry.kind ? previous : entry,
      );
      if (previous?.kind !== entry.kind) changed = true;
    }
    while (workspace.paths.size > MAX_WARM_PATHS) {
      workspace.paths.delete(workspace.paths.keys().next().value!);
      changed = true;
    }
    if (changed)
      workspace.index = new WorkspacePathIndex(workspace.paths.values());
  }
  pruneWorkspaces();
  const previous = mentionFilesCache.peekSnapshot(key).data;
  return previous?.length === entries.length &&
    previous.every(
      (entry, i) =>
        entry.path === entries[i].path && entry.kind === entries[i].kind,
    )
    ? previous
    : entries;
}

/** Test isolation for both authoritative and speculative snapshots. */
export function clearMentionFilesCache(): void {
  mentionFilesCache.clear();
  workspaces.clear();
}

/** One active search and the newest waiting query per composer. Typing during
 * a filesystem read cannot queue an unbounded series of obsolete tree walks.
 * Subscribers follow the current key, so an old request's finally cannot clear
 * a newer workspace's ownership or replace its results. */
export class MentionFileSearch {
  private key: string | null = null;
  private queued: string | null = null;
  private running: { key: string; cwd: string; version: number } | null = null;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly notify: () => void) {}

  snapshot(cwd: string, query: string) {
    const snapshot = mentionFilesCache.getSnapshot(keyFor(cwd, query));
    if (snapshot.data !== undefined) return snapshot;
    const matches = workspaces.get(rootFor(cwd))?.index?.search(query);
    // An incomplete warm index can supply matches, never an authoritative
    // empty result. Hidden/deep paths still come from the full engine search.
    return matches?.length ? { ...snapshot, data: matches } : snapshot;
  }

  search(cwd: string | null, query: string): void {
    const key = cwd ? keyFor(cwd, query) : null;
    if (key === this.key) return;
    const workspace = cwd ? warmWorkspace(cwd) : undefined;
    if (workspace) workspace.users += 1;
    this.unsubscribe?.();
    this.key = key;
    this.queued = null;
    if (key && workspace) {
      pruneWorkspaces();
      let version = mentionFilesCache.getSnapshot(key).invalidationVersion;
      const unsubscribe = mentionFilesCache.subscribe(key, () => {
        const next = mentionFilesCache.getSnapshot(key).invalidationVersion;
        if (next !== version) {
          version = next;
          this.request(key);
        }
        this.notify();
      });
      this.unsubscribe = () => {
        unsubscribe();
        workspace.users -= 1;
        pruneWorkspaces();
      };
    } else this.unsubscribe = undefined;
    if (key) this.request(key);
  }

  refresh(cwd: string | null, query: string): void {
    if (cwd) {
      const workspace = warmWorkspace(cwd);
      if (Date.now() - workspace.checkedAt > FRESH_MS)
        invalidateMentionFiles(cwd);
    }
    this.search(cwd, query);
    if (this.key) this.request(this.key);
  }

  clear(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.key = null;
    this.queued = null;
  }

  private request(key: string): void {
    const snapshot = mentionFilesCache.getSnapshot(key);
    const version = snapshot.invalidationVersion;
    const [cwd] = JSON.parse(key) as [string, string];
    if (this.running?.cwd === cwd) {
      // Repeated focus/open intent shares this read. Only a different query or
      // an intervening file change warrants another request after it settles.
      this.queued =
        this.running.key === key && this.running.version === version
          ? null
          : key;
      return;
    }
    const running = { key, cwd, version };
    this.running = running;
    void mentionFilesCache
      .load(key, () => fetchEntries(key), {
        maxAgeMs: FRESH_MS,
        force: snapshot.error !== null,
      })
      .catch(() => {}) // The exact-key snapshot reports failure and retains rows.
      .finally(() => {
        // A slow old workspace cannot own the active workspace's queue.
        if (this.running !== running) return;
        this.running = null;
        const queued = this.queued;
        this.queued = null;
        if (queued && queued === this.key) this.request(queued);
      });
  }
}
