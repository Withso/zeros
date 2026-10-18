import path from "node:path";

import type { Workspace } from "./types";

interface QueuedProbe<T> {
  read: () => Promise<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface ProbeIdentity {
  workspaceId: string;
  root: string;
  revision: number;
}

interface ProbeFlight<T> extends ProbeIdentity {
  running: { revision: number; promise: Promise<T> };
  queued?: QueuedProbe<T>;
}

// Only running reads are retained. Each exact target gets one running probe
// and, after invalidation, at most one follow-up for the latest requested state.
const activeFlights = new Set<ProbeIdentity>();

export function workspaceChangeKey(workspace: Workspace, remote: string): string {
  return JSON.stringify([
    workspace.id, workspace.path, workspace.repoRoot, workspace.branch,
    workspace.baseBranch, remote, workspace.createdAt, workspace.archivedAt,
    workspace.present, workspace.organizationId ?? null, workspace.placement ?? "local",
  ]);
}

/** All consumers of a Local refresh lease the same lazy snapshot. Hold it
 * through their comparisons, not just through the initial porcelain read.
 * An invalidation queues the next generation until the old readers finish. */
export function createWorkspaceChangeSnapshot<T>(
  create: (workspace: Workspace, remote: string) => T,
  canJoin: (snapshot: T) => boolean = () => true,
) {
  interface Snapshot extends ProbeIdentity {
    value: T;
    initialRevision: number;
    readers: number;
    retired: Promise<void>;
    retire: () => void;
  }
  const snapshots = new Map<string, Snapshot>();
  return async function readSnapshot<R>(workspace: Workspace, remote: string, read: (snapshot: T) => Promise<R>): Promise<R> {
    const key = workspaceChangeKey(workspace, remote);
    let entry = snapshots.get(key);
    while (entry && entry.initialRevision !== entry.revision) {
      await entry.retired;
      entry = snapshots.get(key);
    }
    // A slow existing reader may finish its own snapshot, but cannot keep
    // lending an old observation to newly mounted or refreshing consumers.
    if (entry && !canJoin(entry.value)) entry = undefined;
    if (!entry) {
      let retire!: () => void;
      const retired = new Promise<void>((done) => { retire = done; });
      entry = { workspaceId: workspace.id, root: path.resolve(workspace.path), revision: 0,
        initialRevision: 0, readers: 0, value: create(workspace, remote), retired, retire };
      snapshots.set(key, entry);
      activeFlights.add(entry);
    }
    entry.readers += 1;
    try {
      return await read(entry.value);
    } finally {
      entry.readers -= 1;
      if (entry.readers === 0) {
        if (snapshots.get(key) === entry) snapshots.delete(key);
        activeFlights.delete(entry);
        entry.retire();
      }
    }
  };
}

function startProbe<T>(
  flights: Map<string, ProbeFlight<T>>,
  key: string,
  flight: ProbeFlight<T>,
  read: () => Promise<T>,
): Promise<T> {
  const promise = Promise.resolve().then(read);
  flight.running = { revision: flight.revision, promise };
  const settled = () => {
    if (flights.get(key) !== flight || flight.running.promise !== promise) return;
    const queued = flight.queued;
    if (!queued) {
      flights.delete(key);
      activeFlights.delete(flight);
      return;
    }
    flight.queued = undefined;
    void startProbe(flights, key, flight, queued.read).then(queued.resolve, queued.reject);
  };
  void promise.then(settled, settled);
  return promise;
}

/** Separate read kinds share the same watcher/mutation fence, never payloads.
 * A factory keeps the payload type tied to its own exact-key flight map. */
export function createWorkspaceChangeProbe<T>(): (
  workspace: Workspace, remote: string, read: () => Promise<T>,
) => Promise<T> {
  const flights = new Map<string, ProbeFlight<T>>();
  return (workspace, remote, read) => {
    // Resolve this identity for every caller, before sharing: a replacement
    // checkout or changed comparison target must never inherit an older read.
    const key = workspaceChangeKey(workspace, remote);
    const existing = flights.get(key);
    if (existing) {
      if (existing.queued) {
        existing.queued.read = read;
        return existing.queued.promise;
      }
      if (existing.running.revision === existing.revision) return existing.running.promise;
      let resolve!: QueuedProbe<T>["resolve"];
      let reject!: QueuedProbe<T>["reject"];
      const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      existing.queued = { read, promise, resolve, reject };
      return promise;
    }
    const flight = {
      workspaceId: workspace.id,
      root: path.resolve(workspace.path),
      revision: 0,
    } as ProbeFlight<T>;
    const promise = startProbe(flights, key, flight, read);
    flights.set(key, flight);
    activeFlights.add(flight);
    return promise;
  };
}

export const shareWorkspaceChangeProbe = createWorkspaceChangeProbe<boolean>();

/** Exact watcher/mutation invalidation; omitted ids are the coarse fallback.
 * Invalidation does not start work or retain a settled answer. */
export function invalidateWorkspaceChangeProbes(workspaceIds?: readonly string[]): void {
  const ids = workspaceIds ? new Set(workspaceIds) : null;
  for (const flight of activeFlights) {
    if (!ids || ids.has(flight.workspaceId)) flight.revision += 1;
  }
}

/** Checkout suspension uses the exact semantic root, preserving nested owners. */
export function invalidateWorkspaceChangeProbesForRoot(root: string): void {
  const resolved = path.resolve(root);
  for (const flight of activeFlights) {
    if (flight.root === resolved) flight.revision += 1;
  }
}
