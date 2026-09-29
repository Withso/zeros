import { readdir, readFile } from "node:fs/promises";
import type { CloudDurabilityAuthority } from "./cloud-durability-runtime";

export const CLOUD_IDLE_STOP_MS = 10 * 60_000;

/** PR discovery updates cached workspace metadata during ordinary polling.
 * It still needs write authorization and checkpoint draining, but it is not
 * evidence of user work. Keep this list narrow; publication is real activity. */
export function isCloudIdleMaintenance(operation: string): boolean {
  return operation === "gh.prSync";
}

/** Activity-driven, independent of desktop connection lifetime. No polling
 * read, heartbeat or completed transcript can count as an active user job. */
export class CloudIdleStopScheduler {
  private readonly now: () => number;
  private lastActivity: number;
  private revision = 0;
  private active: Promise<void> | null = null;
  private closed = false;
  private wasBusy = false;
  private nextObservation = 0;
  private nextAttempt = 0;
  private attempts = 0;
  private completed = false;
  private syncState: "ready" | "pending" | "failed" = "ready";
  private timer: ReturnType<typeof setInterval> | null = null;
  private authority: CloudDurabilityAuthority | null = null;
  constructor(private readonly options: {
    now?: () => number;
    busy(): boolean;
    stop(authority: CloudDurabilityAuthority, stillIdle: () => boolean): Promise<void | boolean>;
    observed?(state: { busy: boolean; quietSeconds: number }): void;
    failed?(): void;
    blocked?(state: { code: "idle_stop_blocked"; reason: "record_sync" | "checkpoint_or_transport" | "workload_or_checkpoint"; quietSeconds: number; retrySeconds: number }): void;
  }) {
    this.now = options.now ?? (() => performance.now());
    this.lastActivity = this.now();
  }
  activity(): void { this.lastActivity = this.now(); this.revision++; this.attempts = 0; this.nextAttempt = 0; }
  recordSync(state: "ready" | "pending" | "failed"): void { this.syncState = state; }
  /** Start independently of record synchronization, which can hang or fail.
   * The stop callback must revalidate live engine authority before admission. */
  observe(authority: CloudDurabilityAuthority): void {
    if (this.closed) return;
    this.authority = authority;
    if (!this.timer) {
      this.timer = setInterval(() => { if (this.authority) this.consider(this.authority); }, 15_000);
      this.timer.unref?.();
    }
    this.consider(authority);
  }
  consider(authority: CloudDurabilityAuthority): void {
    if (this.closed || this.active || this.completed) return;
    const busy = this.options.busy();
    if (this.now() >= this.nextObservation) {
      this.nextObservation = this.now() + 60_000;
      try { this.options.observed?.({ busy, quietSeconds: Math.floor((this.now() - this.lastActivity) / 1000) }); }
      catch { /* Diagnostics cannot interrupt lifecycle checks. */ }
    }
    if (busy) { this.wasBusy = true; this.activity(); return; }
    if (this.wasBusy) { this.wasBusy = false; this.activity(); return; }
    if (this.now() - this.lastActivity < CLOUD_IDLE_STOP_MS || this.now() < this.nextAttempt) return;
    const revision = this.revision;
    const stillIdle = () => !this.closed && this.revision === revision && !this.options.busy();
    let failed = false;
    this.active = Promise.resolve().then(() => {
      if (stillIdle()) return this.options.stop(authority, stillIdle);
    }).then(result => {
      this.completed = result === true;
    }).catch(() => {
      failed = true;
      try { this.options.failed?.(); } catch { /* diagnostic only */ }
    }).finally(() => {
      this.active = null;
      if (this.completed || this.closed || this.revision !== revision) return;
      const retrySeconds = Math.min(120, 15 * 2 ** Math.min(this.attempts++, 3));
      this.nextAttempt = this.now() + retrySeconds * 1000;
      try { this.options.blocked?.({ code: "idle_stop_blocked", reason: this.syncState !== "ready" ? "record_sync" : failed ? "checkpoint_or_transport" : "workload_or_checkpoint",
        quietSeconds: Math.floor((this.now() - this.lastActivity) / 1000), retrySeconds }); } catch { /* diagnostic only */ }
    });
  }
  async settled(): Promise<void> { await this.active; }
  async close(): Promise<void> { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = null; this.authority = null; await this.active; }
}

/** The qualified worker maps these UIDs for human tools, capture, and native
 * providers. Count sleeping/stopped processes too: inactivity must not kill a
 * background command. Only an exited PID or zombie is harmless. Inspection
 * failure is busy, never evidence that no work exists. No argv is read/logged. */
export async function hasCloudUserProcesses(options: {
  list?: () => Promise<string[]>;
  read?: (path: string) => Promise<string>;
} = {}): Promise<boolean> {
  if (process.platform !== "linux" && !options.list) return true;
  const read = options.read ?? (path => readFile(path, "utf8"));
  try {
    const names = await (options.list ?? (() => readdir("/proc")))();
    const pids = names.filter(name => /^[1-9][0-9]{0,9}$/.test(name));
    if (pids.length > 8192) return true;
    for (const pid of pids) {
      let status: string;
      try { status = await read(`/proc/${pid}/status`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return true; }
      if (status.length > 16_384) return true;
      const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
      const state = /^State:\s+(\S)/m.exec(status)?.[1];
      if (!uid || !state) return true;
      if (state !== "Z" && uid.slice(1).some(value => ["10001", "10002", "10004"].includes(value))) return true;
    }
    return false;
  } catch { return true; }
}
