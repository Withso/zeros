import {
  LOCAL_STORAGE_CATEGORY_IDS,
  type LocalStorageCategory,
  type LocalStorageCategoryId,
  type LocalStorageClearResult,
  type LocalStorageReport,
} from "../../shared/local-storage";
import type { DuOptions, DuResult } from "./du";
import type { LocalStorageLocations } from "./locations";
import type { LocalStoragePlan } from "./plan";

export type Measurer = (paths: readonly string[], options: DuOptions) => Promise<DuResult>;

export interface LocalStorageServiceOptions {
  locations: () => LocalStorageLocations | Promise<LocalStorageLocations>;
  plan: (locations: LocalStorageLocations) => Promise<LocalStoragePlan>;
  revealTarget: (locations: LocalStorageLocations, id: LocalStorageCategoryId) => Promise<string | null>;
  measure: Measurer;
  emit: (report: LocalStorageReport) => void;
  concurrency?: number;
  timeoutMs?: number;
  progressIntervalMs?: number;
  now?: () => number;
}

export interface LocalStorageService {
  measure(): Promise<LocalStorageReport>;
  cancel(): void;
  clearCache(clear: () => Promise<void>): Promise<LocalStorageClearResult>;
  reveal(id: LocalStorageCategoryId): Promise<string | null>;
  report(): LocalStorageReport;
}

// Small folders first so the page fills in while large trees are still walked.
const ORDER: LocalStorageCategoryId[] = [
  "chats",
  "provider-accounts",
  "window-state",
  "cache",
  "logs",
  "other-app-data",
  "updates",
  "cloud-sync",
  "workspaces",
];

interface Run {
  controller: AbortController;
  promise: Promise<LocalStorageReport>;
  remaining: Set<LocalStorageCategoryId>;
}

export function createLocalStorageService(options: LocalStorageServiceOptions): LocalStorageService {
  const concurrency = Math.max(1, Math.min(3, options.concurrency ?? 2));
  const timeoutMs = options.timeoutMs ?? 120_000;
  const progressIntervalMs = options.progressIntervalMs ?? 250;
  const now = options.now ?? Date.now;
  const categories = new Map<LocalStorageCategoryId, LocalStorageCategory>(
    LOCAL_STORAGE_CATEGORY_IDS.map((id) => [
      id,
      { id, status: "unmeasured", bytes: null, measuring: false, progressBytes: null, location: null, revealable: false },
    ]),
  );
  let revision = 0;
  let measuredAt: number | null = null;
  let run: Run | null = null;
  let clearing: Promise<LocalStorageClearResult> | null = null;
  let clearSampling: AbortController | null = null;
  /** Advances on cancel; work queued behind a clear checks it before starting. */
  let cancels = 0;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let current: LocalStorageReport | null = null;

  const report = (): LocalStorageReport =>
    (current ??= {
      revision,
      measuring: run !== null || clearing !== null,
      measuredAt,
      categories: LOCAL_STORAGE_CATEGORY_IDS.map((id) => ({ ...categories.get(id)! })),
    });
  const publish = () => {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = null;
    revision += 1;
    current = null;
    options.emit(report());
  };
  const publishProgress = () => {
    progressTimer ??= setTimeout(publish, progressIntervalMs);
  };
  const update = (id: LocalStorageCategoryId, patch: Partial<LocalStorageCategory>) => {
    categories.set(id, { ...categories.get(id)!, ...patch });
  };
  const applyPlan = (plan: LocalStoragePlan) => {
    for (const id of LOCAL_STORAGE_CATEGORY_IDS)
      update(id, { location: plan[id].location, revealable: plan[id].reveal !== null });
  };
  const settle = (id: LocalStorageCategoryId, result: DuResult) => {
    // An interrupted run leaves the last confirmed value in place.
    if (result.reason === "cancelled") update(id, { measuring: false, progressBytes: null });
    else update(id, { status: result.status, bytes: result.bytes, measuring: false, progressBytes: null });
  };
  const measureOne = async (id: LocalStorageCategoryId, plan: LocalStoragePlan, signal: AbortSignal): Promise<DuResult> => {
    if (signal.aborted) return { status: "unmeasured", bytes: null, reason: "cancelled" };
    if (plan[id].unresolved) return { status: "unmeasured", bytes: null, reason: "failed" };
    const result = await options.measure(plan[id].paths, {
      signal,
      timeoutMs,
      onProgress: (bytes) => {
        update(id, { progressBytes: bytes });
        publishProgress();
      },
    }).catch((): DuResult => ({ status: "unmeasured", bytes: null, reason: "failed" }));
    return signal.aborted ? { ...result, reason: "cancelled" as const } : result;
  };

  function start(ids: LocalStorageCategoryId[]): Run {
    const state: Run = { controller: new AbortController(), promise: Promise.resolve(report()), remaining: new Set(ids) };
    const { controller, remaining } = state;
    const finish = () => {
      for (const id of remaining) update(id, { measuring: false, progressBytes: null });
      if (!controller.signal.aborted) measuredAt = now();
      if (run === state) run = null;
      publish();
      return report();
    };
    for (const id of ids) update(id, { measuring: true, progressBytes: null });
    run = state;
    publish();
    state.promise = (async () => {
      let plan: LocalStoragePlan;
      try {
        plan = await options.plan(await options.locations());
      } catch {
        // A cancelled run keeps its confirmed values even if planning then fails.
        const reason = controller.signal.aborted ? "cancelled" : "failed";
        for (const id of ids) settle(id, { status: "unmeasured", bytes: null, reason });
        if (reason === "failed") remaining.clear();
        return finish();
      }
      if (!controller.signal.aborted) applyPlan(plan);
      const queue = ORDER.filter((id) => remaining.has(id));
      const worker = async () => {
        for (let id = queue.shift(); id; id = queue.shift()) {
          if (controller.signal.aborted) break;
          settle(id, await measureOne(id, plan, controller.signal));
          if (!controller.signal.aborted) remaining.delete(id);
          publish();
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
      return finish();
    })();
    return state;
  }

  const measure = (): Promise<LocalStorageReport> => {
    if (run) return run.promise;
    if (clearing) {
      const queuedAt = cancels;
      const resume = () => (cancels === queuedAt ? measure() : report());
      return clearing.then(resume, resume);
    }
    return start([...LOCAL_STORAGE_CATEGORY_IDS]).promise;
  };

  const cancel = () => {
    cancels += 1;
    run?.controller.abort();
    // The cache is still cleared; only its before/after measurement stops.
    clearSampling?.abort();
  };

  const clearCache = (clear: () => Promise<void>): Promise<LocalStorageClearResult> => {
    if (clearing) return clearing;
    const startedAt = cancels;
    clearSampling = new AbortController();
    const { signal } = clearSampling;
    clearing = (async (): Promise<LocalStorageClearResult> => {
      // Clearing supersedes a measurement in flight, then resumes what it had
      // left, so one measurement still runs at a time.
      const interrupted = run;
      interrupted?.controller.abort();
      await interrupted?.promise;
      const resume = interrupted ? [...interrupted.remaining].filter((id) => id !== "cache") : [];
      update("cache", { measuring: true, progressBytes: null });
      publish();
      let plan: LocalStoragePlan | null = null;
      try {
        plan = await options.plan(await options.locations());
        applyPlan(plan);
      } catch {
        /* clearing does not depend on measuring; Freed is then unknown */
      }
      const sample = (): Promise<DuResult> =>
        plan ? measureOne("cache", plan, signal) : Promise.resolve({ status: "unmeasured", bytes: null });
      const before = await sample();
      let after: DuResult;
      try {
        await clear();
      } finally {
        after = await sample();
        settle("cache", after);
        clearing = null;
        clearSampling = null;
        publish();
        // A cancel while clearing (the page closed) also drops the resume.
        if (resume.length > 0 && cancels === startedAt) start(resume);
      }
      return {
        freedBytes:
          before.status === "measured" && after.status === "measured"
            ? Math.max(0, before.bytes! - after.bytes!)
            : null,
        report: report(),
      };
    })();
    return clearing;
  };

  const reveal = async (id: LocalStorageCategoryId): Promise<string | null> =>
    options.revealTarget(await options.locations(), id);

  return { measure, cancel, clearCache, reveal, report };
}
