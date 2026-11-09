import { availableParallelism } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { DurableDesignDependency } from "./dependency-read-set";
import { designDirectoryNameFor } from "./directory-registry";
import { designRecordedCanvasActive } from "./retained-frames";
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
  | { file: string; sourceVersion: string; sanitized: string; sheets?: DesignFrameRenderSheet[]; reused?: true }
  | { file: string; error: string };

const testing: { workers: number | null; frames: number; composed: number; reused: number; workerUrl: URL | null } =
  { workers: null, frames: 0, composed: 0, reused: 0, workerUrl: null };

/** Workers a Bun engine starts unless told otherwise. Node cannot load the
 * TypeScript worker, so a Node engine (the tests) starts none by default. */
const DEFAULT_WORKERS = 3;

/** ZEROS_DESIGN_PREPARATION_WORKERS=<n> prepares cold frames on up to n
 * workers, and 0 turns the pool off. Two cores are always left over. */
export function designPreparationWorkerCount(env: NodeJS.ProcessEnv = process.env, cores = availableParallelism(),
  runtimeDefault = process.versions.bun ? DEFAULT_WORKERS : 0): number {
  if (testing.workers !== null) return Math.min(testing.workers, MAX_WORKERS);
  const configured = env.ZEROS_DESIGN_PREPARATION_WORKERS?.trim();
  const requested = configured ? Number.parseInt(configured, 10) : runtimeDefault;
  if (!Number.isSafeInteger(requested) || requested <= 0) return 0;
  return Math.max(0, Math.min(requested, cores - 2, MAX_WORKERS));
}

interface PoolWorker {
  worker: Worker;
  pending: Map<number, { resolve: (results: unknown[]) => void; reject: (error: Error) => void }>;
}

let pool: PoolWorker[] = [];
let idle: NodeJS.Timeout | null = null;
/** Each call's messages share one read scope on each worker they reach. */
let scopes = 0;
/** The worker that prepared a frame keeps its identity read, so the frame's
 * capture is composed there when that worker is free to take it. */
const preparedOn = new Map<string, PoolWorker>();
const MAX_PREPARED_ON = 4096;
const frameKey = (workspacePath: string, file: string) => `${path.resolve(workspacePath)}\0${file}`;
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
    for (const [key, worker] of preparedOn) if (worker === entry) preparedOn.delete(key);
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
  const retain = designRecordedCanvasActive(workspacePath);
  const results = await inWorkers<string, DesignWorkerFrameIdentity>(files,
    (file) => ({ workspacePath, directory, catalogRevision, files: [file], retain }), {
      answered: (file, worker, answer) => {
        if (!answer.some((result) => "identity" in result)) return;
        const key = frameKey(workspacePath, file);
        preparedOn.delete(key);
        preparedOn.set(key, worker);
        if (preparedOn.size > MAX_PREPARED_ON) preparedOn.delete(preparedOn.keys().next().value!);
      },
    });
  testing.frames += results.filter((result) => "identity" in result).length;
  return results;
}

/** Compose frames' render sources across the pool, for capture batches. As
 * with preparation, whatever a worker did not compose the caller composes. */
export async function composeFrameSourcesInWorkers(workspacePath: string,
  frames: ReadonlyArray<{ file: string; width: number; height: number; sourceVersion?: string }>, options: { deferTailwind: boolean }):
  Promise<DesignWorkerComposedFrame[]> {
  const directory = designDirectoryNameFor(workspacePath);
  const results = await inWorkers<{ file: string; width: number; height: number; sourceVersion?: string }, DesignWorkerComposedFrame>(frames,
    (frame) => ({ kind: "compose", workspacePath, directory, frames: [frame], deferTailwind: options.deferTailwind }),
    { prefer: (frame) => preparedOn.get(frameKey(workspacePath, frame.file)) });
  testing.composed += results.filter((result) => "sanitized" in result).length;
  testing.reused += results.filter((result) => "reused" in result).length;
  return results;
}

async function inWorkers<T, R>(items: readonly T[], message: (item: T) => Record<string, unknown>, options: {
  prefer?: (item: T) => PoolWorker | undefined;
  answered?: (item: T, worker: PoolWorker, results: R[]) => void;
} = {}): Promise<R[]> {
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
  const results: R[] = [];
  const scope = ++scopes;
  const workers = pool.slice(0, count);
  // A worker takes its own items first, then unclaimed ones, then another
  // worker's, so a preference never leaves a worker idle.
  const own = new Map<PoolWorker, T[]>(workers.map((worker) => [worker, []]));
  const shared: T[] = [];
  for (const item of items) {
    const preferred = options.prefer?.(item);
    ((preferred && own.get(preferred)) ?? shared).push(item);
  }
  const steal = () => {
    for (const queue of own.values()) if (queue.length) return queue.pop();
    return undefined;
  };
  const next = (entry: PoolWorker) => own.get(entry)!.shift() ?? shared.shift() ?? steal();
  const take = async (entry: PoolWorker) => {
    for (let item = next(entry); item !== undefined; item = next(entry)) {
      try {
        const answer = await ask(entry, { ...message(item), scope }) as R[];
        results.push(...answer);
        options.answered?.(item, entry, answer);
      } catch { return; }
    }
  };
  inFlight++;
  try {
    await Promise.all(workers.map(take));
  } finally {
    for (const { worker } of workers) {
      try { worker.postMessage({ kind: "release", scope }); } catch { /* the worker already stopped */ }
    }
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
  preparedOn.clear();
  const stopping = pool;
  pool = [];
  await Promise.all(stopping.map(({ worker }) => worker.terminate().catch(() => 0)));
}

export function configureDesignPreparationWorkersForTests(workers: number | null, options: { workerUrl?: URL } = {}): void {
  testing.workers = workers;
  testing.workerUrl = options.workerUrl ?? null;
  unavailable = false;
}

export function designPreparationWorkerStatsForTests(): { frames: number; composed: number; reused: number } {
  return { frames: testing.frames, composed: testing.composed, reused: testing.reused };
}
