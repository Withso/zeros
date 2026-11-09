import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { DurableDesignDependency } from "./dependency-read-set";
import { designDirectoryNameFor } from "./directory-registry";
import type { DesignFrameIdentity } from "./identity-cache";
import type { DesignFrameRenderSheet } from "./render-preparation";

/** Workers stop after this long without a batch; they hold a parsed canvas
 * and style caches each. */
const IDLE_MS = 30_000;
const MAX_WORKERS = 8;

export type DesignWorkerFrameIdentity =
  | { file: string; identity: DesignFrameIdentity; modifiedAt: number; complete: boolean; durable: DurableDesignDependency[] | null }
  | { file: string; error: string };

export type DesignWorkerComposedFrame =
  | { file: string; sourceVersion: string; sanitized: string; sheets?: DesignFrameRenderSheet[] }
  | { file: string; error: string };

const testing: { workers: number | null; frames: number; composed: number; workerUrl: URL | null } =
  { workers: null, frames: 0, composed: 0, workerUrl: null };

/** Experimental, off by default: ZEROS_DESIGN_PREPARATION_WORKERS=<n>
 * prepares cold frame identities on up to n workers, leaving two cores. */
export function designPreparationWorkerCount(env: NodeJS.ProcessEnv = process.env, cores = availableParallelism()): number {
  if (testing.workers !== null) return Math.min(testing.workers, MAX_WORKERS);
  const requested = Number.parseInt(env.ZEROS_DESIGN_PREPARATION_WORKERS ?? "0", 10);
  if (!Number.isSafeInteger(requested) || requested <= 0) return 0;
  return Math.max(0, Math.min(requested, cores - 2, MAX_WORKERS));
}

interface PoolWorker {
  worker: Worker;
  pending: Map<number, { resolve: (results: unknown[]) => void; reject: (error: Error) => void }>;
}

let pool: PoolWorker[] = [];
let idle: NodeJS.Timeout | null = null;
/** Batches with work on the pool: the idle stop waits for all of them. */
let inFlight = 0;
let next = 0;
/** Set once a worker failed before it answered anything: the pool stays off
 * for this process instead of starting a failing worker for every batch. */
let unavailable = false;

/** The worker entry. A Bun standalone binary embeds it as its own entrypoint,
 * named by its path under the entrypoints' common folder, apps/desktop/src
 * (scripts/build-sidecar.mjs). */
function workerUrl(): URL {
  if (testing.workerUrl) return testing.workerUrl;
  const own = new URL(import.meta.url);
  const root = own.pathname.indexOf("/$bunfs/root/");
  if (root >= 0) return new URL(`${own.pathname.slice(0, root)}/$bunfs/root/engine/design/preparation-worker.ts`, own);
  return new URL("./preparation-worker.ts", own);
}

function spawn(): PoolWorker {
  // Bun loads the TypeScript worker directly. Node cannot, so a Node engine
  // falls back to its own thread; tests start a bundled worker instead.
  const worker = new Worker(workerUrl());
  const entry: PoolWorker & { answered?: boolean } = { worker, pending: new Map() };
  const fail = (error: Error) => {
    pool = pool.filter((candidate) => candidate !== entry);
    if (!entry.answered && !unavailable) {
      unavailable = true;
      console.warn(`[Zeros] Design preparation workers unavailable; preparing on the engine thread: ${error.message}`);
    }
    for (const { reject } of entry.pending.values()) reject(error);
    entry.pending.clear();
  };
  worker.on("message", (message: { id: number; results?: unknown[]; error?: string }) => {
    const request = entry.pending.get(message.id);
    if (!request) return;
    entry.answered = true;
    entry.pending.delete(message.id);
    // An idle worker never keeps the process alive; one with work does.
    if (entry.pending.size === 0) worker.unref();
    if (message.results) request.resolve(message.results);
    else request.reject(new Error(message.error ?? "Design preparation worker failed."));
  });
  worker.on("error", fail);
  worker.on("exit", () => fail(new Error("Design preparation worker exited.")));
  worker.unref();
  return entry;
}

function scheduleIdleStop(): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => void stopDesignPreparationWorkers(), IDLE_MS);
  idle.unref?.();
}

/** Prepare frames across the pool. Frames a worker could not prepare, or
 * whose worker failed, are left out: the caller prepares those itself. */
export async function prepareFrameIdentitiesInWorkers(workspacePath: string, catalogRevision: string,
  files: readonly string[]): Promise<DesignWorkerFrameIdentity[]> {
  const directory = designDirectoryNameFor(workspacePath);
  const results = await inWorkers<string, DesignWorkerFrameIdentity>(files,
    (file) => ({ workspacePath, directory, catalogRevision, files: [file] }));
  testing.frames += results.filter((result) => "identity" in result).length;
  return results;
}

/** Compose frames' render sources across the pool, for capture batches. As
 * with preparation, whatever a worker did not compose the caller composes. */
export async function composeFrameSourcesInWorkers(workspacePath: string,
  frames: ReadonlyArray<{ file: string; width: number; height: number }>, options: { deferTailwind: boolean }):
  Promise<DesignWorkerComposedFrame[]> {
  const directory = designDirectoryNameFor(workspacePath);
  const results = await inWorkers<{ file: string; width: number; height: number }, DesignWorkerComposedFrame>(frames,
    (frame) => ({ kind: "compose", workspacePath, directory, frames: [frame], deferTailwind: options.deferTailwind }));
  testing.composed += results.filter((result) => "sanitized" in result).length;
  return results;
}

async function inWorkers<T, R>(items: readonly T[], message: (item: T) => Record<string, unknown>): Promise<R[]> {
  const count = unavailable ? 0 : Math.min(designPreparationWorkerCount(), items.length);
  if (count === 0) return [];
  // An idle stop armed by an earlier batch must not end this one's workers.
  if (idle) clearTimeout(idle);
  idle = null;
  try {
    while (pool.length < count) pool.push(spawn());
  } catch {
    if (inFlight === 0) scheduleIdleStop();
    return [];
  }
  // Each worker takes the next item as it finishes one, so heavy frames
  // never wait behind a fixed share. A failed worker stops taking items;
  // whatever is left is done on the engine's thread.
  const queue = [...items];
  const results: R[] = [];
  const take = async (entry: PoolWorker) => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      try { results.push(...await ask(entry, message(item)) as R[]); }
      catch { return; }
    }
  };
  inFlight++;
  try {
    await Promise.all(pool.slice(0, count).map(take));
  } finally {
    if (--inFlight === 0) scheduleIdleStop();
  }
  return results;
}

function ask(entry: PoolWorker, request: Record<string, unknown>): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const id = ++next;
    entry.pending.set(id, { resolve, reject });
    entry.worker.ref();
    entry.worker.postMessage({ id, ...request });
  });
}

export async function stopDesignPreparationWorkers(): Promise<void> {
  if (idle) clearTimeout(idle);
  idle = null;
  const stopping = pool;
  pool = [];
  await Promise.all(stopping.map(({ worker }) => worker.terminate().catch(() => 0)));
}

export function configureDesignPreparationWorkersForTests(workers: number | null, options: { workerUrl?: URL } = {}): void {
  testing.workers = workers;
  testing.workerUrl = options.workerUrl ?? null;
  unavailable = false;
}

export function designPreparationWorkerStatsForTests(): { frames: number; composed: number } {
  return { frames: testing.frames, composed: testing.composed };
}
