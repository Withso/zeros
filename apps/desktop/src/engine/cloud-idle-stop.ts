import { readdir, readFile } from "node:fs/promises";
import type { CloudDurabilityAuthority } from "./cloud-durability-runtime";
import { CloudWorkspacePresenceSchema } from "@zeros/protocol/cloud-actors";
import type { TransportClient } from "./transport/types";

export const CLOUD_IDLE_STOP_MS = 10 * 60_000;
const PRESENCE_INTERVAL_MS = 60_000;
const PRESENCE_LEASE_MS = 90_000;

/** Any admitted device can keep an open, used workspace awake. Receipt time
 * is monotonic and server-owned. A presence message never acquires compute;
 * only an already connected, authorized cloud actor can renew this lease. */
export class CloudUserPresence {
  private readonly clients = new Map<string, { client: TransportClient; at: number }>();
  private readonly reports = new Map<string, { client: TransportClient; at: number; present: boolean }>();
  private readonly devices = new Map<string, number>();
  private readonly now: () => number;
  constructor(private readonly options: { now?: () => number; activity(): void }) {
    this.now = options.now ?? (() => performance.now());
  }
  update(client: TransportClient, value: unknown): boolean {
    const parsed = CloudWorkspacePresenceSchema.safeParse(value);
    if (!parsed.success || client.kind !== "cloud" || !client.accountUserId || !client.cloudActor || client.authorized?.() !== true) return false;
    this.active();
    const now = this.now(), key = `${client.accountUserId}:${client.cloudActor.deviceId}`;
    for (const [id, row] of this.reports) if (now - row.at >= PRESENCE_LEASE_MS) this.reports.delete(id);
    if (!parsed.data.present) {
      this.release(client);
      if (this.reports.size < 256) this.reports.set(client.id, { client, at: now, present: false });
      return true;
    }
    for (const [device, at] of this.devices) if (now - at >= PRESENCE_LEASE_MS) this.devices.delete(device);
    if ((!this.devices.has(key) && this.devices.size >= 256) || (!this.clients.has(client.id) && this.clients.size >= 256)) return false;
    const previous = this.devices.get(key);
    const at = previous !== undefined && now - previous < PRESENCE_INTERVAL_MS ? previous : now;
    this.clients.set(client.id, { client, at });
    if (this.reports.has(client.id) || this.reports.size < 256) this.reports.set(client.id, { client, at, present: true });
    if (at !== previous) { this.devices.set(key, at); this.options.activity(); }
    return true;
  }
  release(client: TransportClient): void { this.clients.delete(client.id); this.reports.delete(client.id); }
  /** Unlike idle-stop's active(), automatic updates require a fresh report
   * from every attached device. Missing/expired reports are not absence. */
  snapshot(attached: readonly TransportClient[]): "present" | "absent" | "unknown" {
    const now = this.now();
    let unknown = false;
    for (const client of attached) {
      const row = this.reports.get(client.id);
      if (client.kind !== "cloud" || !client.accountUserId || !client.cloudActor || client.authorized?.() !== true ||
          !row || row.client !== client || now - row.at >= PRESENCE_LEASE_MS) { unknown = true; continue; }
      if (row.present) return "present";
    }
    return unknown ? "unknown" : "absent";
  }
  active(): boolean {
    const now = this.now();
    for (const [id, row] of this.clients) {
      if (now - row.at >= PRESENCE_LEASE_MS || row.client.authorized?.() !== true) this.clients.delete(id);
    }
    return this.clients.size > 0;
  }
}

/** PR discovery updates cached workspace metadata during ordinary polling.
 * It still needs write authorization and checkpoint draining, but it is not
 * evidence of user work. Keep this list narrow; publication is real activity. */
export function isCloudIdleMaintenance(operation: string): boolean {
  return operation === "gh.prSync";
}

/** Ten quiet minutes after work or admitted user presence ends. A connected
 * socket alone, polling read, heartbeat or completed transcript is not activity.
 * stillIdle must also be checked immediately before checkpoint commitment. */
export class CloudIdleStopScheduler {
  private readonly now: () => number;
  private lastActivity: number;
  private revision = 0;
  private active: Promise<void> | null = null;
  private inspection: Promise<void> | null = null;
  private inspectionRevision = 0;
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
    /** Kernel workload reads run once per observation, independently of client
     * polling. A failed inspection is busy and completion starts a quiet interval. */
    inspectWorkload?(): Promise<boolean>;
    /** Engine-owned ORIGINAL complete idle-only warm inventory may postpone
     * observational PID reads. Stop still drains exact hosts and proves kernel
     * emptiness. This exception never grants read-only quiet attestation. */
    deferWorkloadInspection?(): boolean;
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
  /** A read cannot renew activity, consume an idle attempt or stop the VM. */
  readActivity(): { revision: number; quietForMs: number; recordSync: "ready" | "pending" | "failed" } {
    return { revision: this.revision, quietForMs: this.closed || this.wasBusy ? 0 : Math.max(0, Math.floor(this.now() - this.lastActivity)),
      recordSync: this.syncState };
  }
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
    if (busy || !this.options.inspectWorkload) { this.considerObserved(authority, busy); return; }
    if (this.workloadInspectionDeferred()) {
      // An earlier PID read may have seen this now-proven idle host. It cannot
      // reset the quiet clock after a newer trusted observation supersedes it.
      this.inspectionRevision++;
      this.considerObserved(authority, false); return;
    }
    if (this.inspection) return;
    const revision = this.revision, inspectionRevision = this.inspectionRevision;
    this.inspection = Promise.resolve().then(() => this.options.inspectWorkload!()).catch(() => true).then(workload => {
      if (!this.closed && this.revision === revision && this.inspectionRevision === inspectionRevision)
        this.considerObserved(authority, workload || this.options.busy());
    }).finally(() => { this.inspection = null; });
  }
  private workloadInspectionDeferred(): boolean {
    try {
      const result: unknown = this.options.deferWorkloadInspection?.();
      if (result === true) return true;
      // A malformed asynchronous hook is never authority; contain rejection
      // without awaiting it or changing inspection/Stop scheduling.
      if (result && (typeof result === "object" || typeof result === "function")) void Promise.resolve(result).catch(() => undefined);
    } catch { /* Unknown inventory preserves conservative kernel inspection. */ }
    return false;
  }
  private considerObserved(authority: CloudDurabilityAuthority, busy: boolean): void {
    if (this.closed || this.active || this.completed) return;
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
  async settled(): Promise<void> { await this.inspection; await this.active; }
  async close(): Promise<void> { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = null; this.authority = null; await this.settled(); }
}

/** The qualified worker maps these UIDs for human tools, capture, and native
 * providers. Count sleeping/stopped processes too: inactivity must not kill a
 * background command. Only an exited PID or zombie is harmless. Inspection
 * failure is busy, never evidence that no work exists. No argv is read/logged. */
export async function hasCloudUserProcesses(options: {
  list?: () => Promise<string[]>;
  read?: (path: string) => Promise<string>;
  idleTerminalPids?: readonly number[];
  /** Engine-owned read-only language services are restartable infrastructure.
   * Their live supervised roots, never names/argv, identify this exception. */
  infrastructurePids?: readonly number[];
  /** Live handoff only: derived from the admitted immutable runtime's cgroup
   * root and healthy root-enrolled resident host. Kernel membership survives
   * reparenting; process names, argv and numeric ancestry cannot authorize it. */
  residentScope?: string;
} = {}): Promise<boolean> {
  if (process.platform !== "linux" && !options.list) return true;
  const read = options.read ?? (path => readFile(path, "utf8"));
  try {
    if (options.residentScope !== undefined && (!/^\/(?:[A-Za-z0-9_.@-]+\/)*zeros-host\.service\/engine-workload-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(options.residentScope) ||
      options.residentScope.split("/").some(part => part === "." || part === ".."))) return true;
    const names = await (options.list ?? (() => readdir("/proc")))();
    const pids = names.filter(name => /^[1-9][0-9]{0,9}$/.test(name));
    if (pids.length > 8192) return true;
    const infrastructure = new Set(options.infrastructurePids), statuses = new Map<string, string>();
    for (const pid of pids) {
      let status: string;
      try { status = await read(`/proc/${pid}/status`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return true; }
      if (status.length > 16_384) return true;
      const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
      const state = /^State:\s+(\S)/m.exec(status)?.[1];
      if (!uid || !state) return true;
      if (state !== "Z" && uid.slice(1).some(value => ["10001", "10002", "10004"].includes(value))) {
        if (options.residentScope && await read(`/proc/${pid}/cgroup`) === `0::${options.residentScope}\n`) continue;
        if (infrastructure.size) {
          let ancestor = pid, source = status, restartable = false;
          for (let depth = 0; depth < 64; depth++) {
            if (infrastructure.has(Number(ancestor))) { restartable = true; break; }
            const parent = /^PPid:\s+([1-9][0-9]{0,9})$/m.exec(source)?.[1];
            if (!parent || parent === ancestor) break;
            ancestor = parent;
            if (infrastructure.has(Number(parent))) { restartable = true; break; }
            source = statuses.get(parent) ?? await read(`/proc/${parent}/status`);
            if (source.length > 16_384) return true;
            statuses.set(parent, source);
          }
          if (restartable) continue;
        }
        // Only known shared interactive shell roots can be idle. Foreground
        // groups, detached children and stopped commands still count. stat has
        // kernel IDs/state only; never read argv or process environments.
        if (state === "S" && options.idleTerminalPids?.includes(Number(pid))) {
          const stat = await read(`/proc/${pid}/stat`);
          if (stat.length > 16_384) return true;
          const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
          if (stat.startsWith(`${pid} (`) && fields[0] === "S" && /^[1-9][0-9]*$/.test(fields[2] ?? "") &&
              /^-?[0-9]+$/.test(fields[4] ?? "") && Number(fields[4]) !== 0 && fields[2] === fields[5]) continue;
        }
        return true;
      }
    }
    return false;
  } catch { return true; }
}
