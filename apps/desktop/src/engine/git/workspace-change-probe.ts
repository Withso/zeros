import path from "node:path";

import type { Workspace } from "./types";

interface QueuedProbe {
  read: () => Promise<boolean>;
  promise: Promise<boolean>;
  resolve: (value: boolean) => void;
  reject: (reason: unknown) => void;
}

interface ProbeFlight {
  workspaceId: string;
  root: string;
  revision: number;
  running: { revision: number; promise: Promise<boolean> };
  queued?: QueuedProbe;
}

// Only running reads are retained. Each exact target gets one running probe
// and, after invalidation, at most one follow-up for the latest requested state.
const flights = new Map<string, ProbeFlight>();

function startProbe(
  key: string,
  flight: ProbeFlight,
  read: () => Promise<boolean>,
): Promise<boolean> {
  const promise = Promise.resolve().then(read);
  flight.running = { revision: flight.revision, promise };
  const settled = () => {
    if (flights.get(key) !== flight || flight.running.promise !== promise) return;
    const queued = flight.queued;
    if (!queued) {
      flights.delete(key);
      return;
    }
    flight.queued = undefined;
    void startProbe(key, flight, queued.read).then(queued.resolve, queued.reject);
  };
  void promise.then(settled, settled);
  return promise;
}

export function shareWorkspaceChangeProbe(
  workspace: Workspace,
  remote: string,
  read: () => Promise<boolean>,
): Promise<boolean> {
  // Resolve this identity for every caller, before sharing: a replacement
  // checkout or changed comparison target must never inherit an older read.
  const key = JSON.stringify([
    workspace.id,
    workspace.path,
    workspace.repoRoot,
    workspace.branch,
    workspace.baseBranch,
    remote,
    workspace.createdAt,
    workspace.archivedAt,
    workspace.present,
  ]);
  const existing = flights.get(key);
  if (existing) {
    if (existing.queued) {
      existing.queued.read = read;
      return existing.queued.promise;
    }
    if (existing.running.revision === existing.revision) return existing.running.promise;
    let resolve!: QueuedProbe["resolve"];
    let reject!: QueuedProbe["reject"];
    const promise = new Promise<boolean>((done, fail) => {
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
  } as ProbeFlight;
  const promise = startProbe(key, flight, read);
  flights.set(key, flight);
  return promise;
}

/** Exact watcher/mutation invalidation; omitted ids are the coarse fallback.
 * Invalidation does not start work or retain a settled answer. */
export function invalidateWorkspaceChangeProbes(workspaceIds?: readonly string[]): void {
  const ids = workspaceIds ? new Set(workspaceIds) : null;
  for (const flight of flights.values()) {
    if (!ids || ids.has(flight.workspaceId)) flight.revision += 1;
  }
}

/** Checkout suspension uses the exact semantic root, preserving nested owners. */
export function invalidateWorkspaceChangeProbesForRoot(root: string): void {
  const resolved = path.resolve(root);
  for (const flight of flights.values()) {
    if (flight.root === resolved) flight.revision += 1;
  }
}
