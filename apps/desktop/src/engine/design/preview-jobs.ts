import type { DesignCatalogAdmission } from "./catalog";
import { DesignCaptureCleanupUnconfirmedError, DESIGN_PREVIEW_JOB_TIMEOUT_MS } from "@zeros/protocol/design-capture";

/** A lane runs one job at a time, except thumbnail batches: two, so one
 * composes while the other captures. Lanes share one record table. */
const LANE_CONCURRENCY = { preview: 1, thumbnails: 2 } as const;
export type DesignPreviewJobLane = keyof typeof LANE_CONCURRENCY;
/** How far ahead a cancellation still fences a delayed request. Beyond it, a
 * job no request could have started is settled without a record. */
const CANCEL_FENCE_MS = 10 * 60_000;

export interface DesignPreviewJobOwner {
  workspaceId: string;
  directoryId: string;
  jobId: string;
  deadline: number;
}
interface Job {
  key: string;
  lane: DesignPreviewJobLane;
  owner: DesignPreviewJobOwner;
  admission: DesignCatalogAdmission;
  controller: AbortController;
  settled: Promise<void>;
  finish(): void;
  done: boolean;
  unconfirmed?: boolean;
  started?: boolean;
  start?: () => Promise<void>;
  cancelQueued?: () => void;
}

/** Connection-owned native preview work. The result travels to its original
 * caller only; retained terminal records contain no source or image payload. */
export class DesignPreviewJobs {
  private jobs = new Map<string, Job>();
  private pending: Job[] = [];
  private running = new Set<Job>();
  private stopped = false;
  private unconfirmed = false;

  usage() { return { running: this.running.size, queued: this.pending.length, records: this.jobs.size }; }

  private key(owner: DesignPreviewJobOwner, admission: DesignCatalogAdmission) {
    return JSON.stringify([admission.connectionId, admission.authority, owner.workspaceId, owner.directoryId, owner.jobId]);
  }

  private create(owner: DesignPreviewJobOwner, admission: DesignCatalogAdmission, horizon = DESIGN_PREVIEW_JOB_TIMEOUT_MS + 1_000): Job {
    if (this.unconfirmed) throw new DesignCaptureCleanupUnconfirmedError();
    if (this.stopped || !admission.authorized()) throw new Error("Design preview owner retired.");
    if (!Number.isSafeInteger(owner.deadline) || owner.deadline > Date.now() + horizon) throw new Error("Invalid Design preview deadline.");
    for (const [key, job] of this.jobs) if (job.done && !job.unconfirmed && job.owner.deadline < Date.now()) this.jobs.delete(key);
    for (const [key, job] of this.jobs) {
      if (this.jobs.size < 128) break;
      // Every cancellation fences delayed requests for its entire deadline,
      // including jobs that already started. Successful completions can yield
      // bounded metadata capacity; cancellation is not successful completion.
      if (job.done && job.started && !job.controller.signal.aborted && !job.unconfirmed) this.jobs.delete(key);
    }
    if (this.jobs.size >= 128) throw new Error("Design preview capacity reached.");
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => { finish = resolve; });
    const job: Job = { key: this.key(owner, admission), lane: "preview", owner: { ...owner }, admission,
      controller: new AbortController(), settled, finish, done: false };
    this.jobs.set(job.key, job);
    return job;
  }

  run<T>(owner: DesignPreviewJobOwner, admission: DesignCatalogAdmission, work: (signal: AbortSignal) => Promise<T>,
    lane: DesignPreviewJobLane = "preview"): Promise<T> {
    if (this.unconfirmed) return Promise.reject(new DesignCaptureCleanupUnconfirmedError());
    if (!Number.isSafeInteger(owner.deadline) || owner.deadline < Date.now()) return Promise.reject(new Error("Design preview job retired at its deadline."));
    const key = this.key(owner, admission);
    if (this.jobs.has(key)) return Promise.reject(new Error("Design preview job already retired or started."));
    if (this.pending.length >= 32) return Promise.reject(new Error("Design preview capacity reached."));
    let job: Job;
    try { job = this.create(owner, admission); }
    catch (error) { return Promise.reject(error); }
    job.lane = lane;
    const result = new Promise<T>((resolve, reject) => {
      job.cancelQueued = () => { reject(job.controller.signal.reason); job.done = true; job.finish(); };
      job.start = async () => {
        job.cancelQueued = undefined;
        job.started = true;
        const timeout = setTimeout(() => job.controller.abort(new Error("Design preview timed out.")), Math.max(1, owner.deadline - Date.now()));
        try {
          if (this.unconfirmed) throw new DesignCaptureCleanupUnconfirmedError();
          if (owner.deadline < Date.now()) job.controller.abort(new Error("Design preview timed out."));
          if (!admission.authorized()) job.controller.abort(new Error("Design preview owner retired."));
          job.controller.signal.throwIfAborted();
          const value = await work(job.controller.signal);
          job.controller.signal.throwIfAborted();
          if (!admission.authorized()) throw new Error("Design preview owner retired.");
          resolve(value);
        } catch (error) {
          job.unconfirmed = error instanceof DesignCaptureCleanupUnconfirmedError;
          if (job.unconfirmed) this.unconfirmed = true;
          reject(error);
        }
        finally {
          clearTimeout(timeout);
          job.done = true;
          job.finish();
          this.running.delete(job);
          this.pump();
        }
      };
    });
    this.pending.push(job);
    this.pump();
    return result;
  }

  private pump(): void {
    for (let index = 0; index < this.pending.length;) {
      const job = this.pending[index]!;
      let busy = 0;
      for (const other of this.running) if (other.lane === job.lane) busy++;
      if (busy >= LANE_CONCURRENCY[job.lane]) {
        index++;
        continue;
      }
      this.pending.splice(index, 1);
      this.running.add(job);
      const start = job.start!;
      job.start = undefined;
      void start();
    }
  }

  async cancel(owner: DesignPreviewJobOwner, admission: DesignCatalogAdmission): Promise<{ settled: true }> {
    const key = this.key(owner, admission);
    if (!this.jobs.has(key) && (owner.deadline < Date.now() || owner.deadline > Date.now() + CANCEL_FENCE_MS)) return { settled: true };
    // A deadline run() refused today becomes admissible later, so the
    // tombstone may extend past the run bound.
    const job = this.jobs.get(key) ?? this.create(owner, admission, CANCEL_FENCE_MS);
    job.controller.abort(new Error("Design preview cancelled."));
    if (job.cancelQueued) {
      this.pending = this.pending.filter((candidate) => candidate !== job);
      job.start = undefined;
      job.cancelQueued();
      job.cancelQueued = undefined;
    }
    if (!job.start && !this.running.has(job) && !job.done) { job.done = true; job.finish(); }
    // Cancel-before-start installs a bounded tombstone. A delayed request from
    // the same connection cannot start after this terminal acknowledgement.
    await job.settled;
    if (job.unconfirmed) throw new DesignCaptureCleanupUnconfirmedError();
    return { settled: true };
  }

  retire(connectionId: string): void {
    for (const job of this.jobs.values())
      if (job.admission.connectionId === connectionId && !job.done)
        job.controller.abort(new Error("Design preview connection retired."));
    this.pump();
  }

  retireUnauthorized(): void {
    for (const job of this.jobs.values()) if (!job.done && !job.admission.authorized())
      job.controller.abort(new Error("Design preview authority retired."));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const job of this.jobs.values()) job.controller.abort(new Error("Design preview host stopped."));
    this.pump();
    await Promise.all([...this.jobs.values()].map((job) => job.settled));
    this.jobs.clear();
  }
}
