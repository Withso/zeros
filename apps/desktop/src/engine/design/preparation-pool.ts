import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { DurableDesignDependency } from "./dependency-read-set";
import type { DesignFrameIdentity } from "./identity-cache";

/** Workers stop after this long without a batch; they hold a parsed canvas
 * and style caches each. */
const IDLE_MS = 30_000;
const MAX_WORKERS = 8;

export type DesignWorkerFrameIdentity =
  | { file: string; identity: DesignFrameIdentity; modifiedAt: number; complete: boolean; durable: DurableDesignDependency[] | null }
  | { file: string; error: string };

const testing: { workers: number | null; frames: number } = { workers: null, frames: 0 };

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
  pending: Map<number, { resolve: (results: DesignWorkerFrameIdentity[]) => void; reject: (error: Error) => void }>;
}

let pool: PoolWorker[] = [];
let idle: NodeJS.Timeout | null = null;
let next = 0;

function spawn(): PoolWorker {
  // Bun runs TypeScript workers itself; Node (tests) needs the loader.
  const worker = new Worker(new URL("./preparation-worker.ts", import.meta.url),
    process.versions.bun ? {} : { execArgv: ["--import", "tsx"] });
  const entry: PoolWorker = { worker, pending: new Map() };
  const fail = (error: Error) => {
    pool = pool.filter((candidate) => candidate !== entry);
    for (const { reject } of entry.pending.values()) reject(error);
    entry.pending.clear();
  };
  worker.on("message", (message: { id: number; results?: DesignWorkerFrameIdentity[]; error?: string }) => {
    const request = entry.pending.get(message.id);
    if (!request) return;
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
  const count = Math.min(designPreparationWorkerCount(), files.length);
  if (count === 0) return [];
  try {
    while (pool.length < count) pool.push(spawn());
  } catch {
    return [];
  }
  const shares = Array.from({ length: count }, (_, index) => files.filter((_, at) => at % count === index));
  const settled = await Promise.allSettled(shares.map((share, index) => new Promise<DesignWorkerFrameIdentity[]>((resolve, reject) => {
    const entry = pool[index]!;
    const id = ++next;
    entry.pending.set(id, { resolve, reject });
    entry.worker.ref();
    entry.worker.postMessage({ id, workspacePath, catalogRevision, files: share });
  })));
  scheduleIdleStop();
  const results = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  testing.frames += results.filter((result) => "identity" in result).length;
  return results;
}

export async function stopDesignPreparationWorkers(): Promise<void> {
  if (idle) clearTimeout(idle);
  idle = null;
  const stopping = pool;
  pool = [];
  await Promise.all(stopping.map(({ worker }) => worker.terminate().catch(() => 0)));
}

export function configureDesignPreparationWorkersForTests(workers: number | null): void {
  testing.workers = workers;
}

export function designPreparationWorkerStatsForTests(): { frames: number } {
  return { frames: testing.frames };
}
