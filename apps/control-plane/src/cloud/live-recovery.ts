import { setTimeout as delay } from "node:timers/promises";
import type WebSocket from "ws";
import type { CloudV2Compute } from "./boat.js";
import { LIVE_RECOVERY_PORT, liveRecoveryHideCommand, liveRecoveryHideState, liveRecoveryKey } from "./live-recovery-command.js";
import type { LiveRecoveryProofBinding, LiveRecoveryWitness } from "./live-recovery-signals.js";
import { dialWorker, WorkerConnectionFailure, type WorkerRoute } from "./worker-connection.js";

export const LIVE_CONNECTION_UNAVAILABLE = "live_connection_unavailable";
export const LIVE_RECOVERY_WINDOW_MS = 60_000;
const DIAL_MS = 15_000, RETRY_MS = 2_000;
type BoundRoute = WorkerRoute & { url: string; token: string; bootId: string; workerTokenHash: string };
type Recovery = { route: BoundRoute; abort: AbortController; flight: Promise<void>; repaired: boolean };
type Verification = "connected" | "gateway" | "unavailable" | "changed";

export type LiveRecoveryDeps = {
  route(id: string): Promise<WorkerRoute | null>;
  compute: Pick<CloudV2Compute, "exec" | "hostPort">;
  witness(binding: LiveRecoveryProofBinding, expiresAt: number): Promise<LiveRecoveryWitness>;
  publish(route: WorkerRoute, hosted: { url: string; token: string }): Promise<boolean>;
  condition(route: WorkerRoute, unavailable: boolean): Promise<boolean>;
  rebuild?(route: WorkerRoute): Promise<boolean>;
  recovered?(route: WorkerRoute): Promise<void>;
  mint(workspaceId: string, bootId: string): string;
  ready(workspaceId: string): void;
  logger?: Pick<Console, "warn">;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  dial?: typeof dialWorker;
};

function bound(route: WorkerRoute): route is BoundRoute {
  return route.workspace.state === "running" && !route.workspace.archivedAt && !!route.workspace.boatSandboxId &&
    !!route.url && !!route.token && !!route.bootId && !!route.workerTokenHash;
}
export function sameLiveRoute(a: WorkerRoute, b: WorkerRoute | null): b is BoundRoute {
  return b !== null && bound(b) && a.workspace.id === b.workspace.id && a.workspace.boatSandboxId === b.workspace.boatSandboxId &&
    a.bootId === b.bootId && a.accessEpoch === b.accessEpoch && a.workerTokenHash === b.workerTokenHash && a.url === b.url && a.token === b.token;
}

/** An attempted live connection starts bounded verification; passive catalog
 * reads never start it. Only explicit gateway refusals plus a fresh outbound
 * worker proof in each window authorize the non-destructive route repair. */
export class CloudLiveRecovery {
  private readonly attempts = new Map<string, Recovery>();
  private readonly finished = new Map<string, { boot: string; at: number }>();
  private closed = false;
  private readonly now: () => number;
  constructor(private readonly deps: LiveRecoveryDeps) { this.now = deps.now ?? Date.now; }

  failed(route: WorkerRoute, error: WorkerConnectionFailure): void {
    if (this.closed || error.reason !== "gateway" || !bound(route) || route.workspace.errorCode === LIVE_CONNECTION_UNAVAILABLE) return;
    const previous = this.attempts.get(route.workspace.id);
    if (previous) { if (!sameLiveRoute(previous.route, route)) previous.abort.abort(); return; }
    if (this.finished.get(route.workspace.id)?.boot === route.bootId) return;
    for (const [id, value] of this.finished) if (value.at + 3_600_000 < this.now()) this.finished.delete(id);
    if (this.attempts.size >= 4 || this.finished.size >= 1024) return;
    const attempt: Recovery = { route, abort: new AbortController(), flight: Promise.resolve(), repaired: false };
    this.attempts.set(route.workspace.id, attempt);
    attempt.flight = this.run(attempt).catch(async () => {
      if (!this.closed && !attempt.abort.signal.aborted) await this.unavailable(route, "verification_unavailable");
    }).catch(() => {}).finally(() => {
      if (this.attempts.get(route.workspace.id) === attempt) this.attempts.delete(route.workspace.id);
      if (!attempt.abort.signal.aborted && attempt.repaired) this.finished.set(route.workspace.id, { boot: route.bootId, at: this.now() });
    });
  }

  async connected(route: WorkerRoute): Promise<void> {
    const attempt = this.attempts.get(route.workspace.id);
    if (attempt && sameLiveRoute(attempt.route, route)) {
      attempt.abort.abort(); await attempt.flight;
    }
    this.finished.delete(route.workspace.id);
    if (route.recoveryAttemptId) await this.deps.recovered?.(route);
    if (attempt || route.workspace.errorCode === LIVE_CONNECTION_UNAVAILABLE) await this.deps.condition(route, false);
  }

  async exhausted(route: WorkerRoute, error: WorkerConnectionFailure): Promise<void> {
    if (this.closed || !bound(route) || this.attempts.has(route.workspace.id)) return;
    await this.unavailable(route, error.reason);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const attempt of this.attempts.values()) attempt.abort.abort();
    await Promise.all([...this.attempts.values()].map(attempt => attempt.flight));
    this.finished.clear();
  }
  private log(route: WorkerRoute, phase: string, reason: string) {
    this.deps.logger?.warn("[cloud-v2] live connection", { workspaceId: route.workspace.id.slice(0, 8), phase, reason });
  }
  private async current(route: WorkerRoute, signal: AbortSignal): Promise<boolean> {
    if (this.closed || signal.aborted) return false;
    const current = await this.deps.route(route.workspace.id);
    return !this.closed && !signal.aborted && sameLiveRoute(route, current);
  }
  private wait(ms: number, signal: AbortSignal) {
    return this.deps.wait ? this.deps.wait(ms, signal) : delay(Math.max(0, ms), undefined, { signal });
  }
  private async unavailable(route: WorkerRoute, reason: string) {
    if (await this.deps.condition(route, true)) this.log(route, "unavailable", reason);
  }
  private async verify(route: BoundRoute, signal: AbortSignal): Promise<Verification> {
    const deadline = this.now() + LIVE_RECOVERY_WINDOW_MS;
    const witness = await this.deps.witness({ workspaceId: route.workspace.id, sandboxId: route.workspace.boatSandboxId!,
      bootId: route.bootId, accessEpoch: route.accessEpoch }, deadline);
    let gateway = 0;
    try {
      while (this.now() < deadline) {
        if (!await this.current(route, signal)) return "changed";
        const remaining = deadline - this.now();
        // A truncated final probe cannot distinguish a slow gateway refusal
        // from a dead route. Finish this window without inventing that evidence.
        if (remaining < DIAL_MS) { await this.wait(remaining, signal); break; }
        let socket: WebSocket;
        try { socket = await (this.deps.dial ?? dialWorker)(route, this.deps.mint(route.workspace.id, route.bootId), { timeoutMs: DIAL_MS, signal }); }
        catch (error) {
          if (signal.aborted) return "changed";
          if (!(error instanceof WorkerConnectionFailure) || error.reason !== "gateway") return "unavailable";
          gateway++;
          await this.wait(Math.min(RETRY_MS, Math.max(0, deadline - this.now())), signal);
          continue;
        }
        socket.close(1000);
        return await this.current(route, signal) ? "connected" : "changed";
      }
      return await this.current(route, signal) ? gateway >= 2 && witness.seen() ? "gateway" : "unavailable" : "changed";
    } finally { witness.dispose(); }
  }
  private async run(attempt: Recovery): Promise<void> {
    const { route, abort: { signal } } = attempt;
    for (let window = 0; window < 2; window++) {
      const result = await this.verify(route, signal);
      if (result === "changed") return;
      if (result === "connected") { await this.deps.condition(route, false); this.deps.ready(route.workspace.id); return; }
      if (result !== "gateway") { await this.unavailable(route, "gateway_not_proven"); return; }
    }
    if (!await this.current(route, signal)) return;
    attempt.repaired = true;
    this.log(route, "repair", "gateway");
    const sandbox = route.workspace.boatSandboxId!, deadline = this.now() + LIVE_RECOVERY_WINDOW_MS;
    const repairSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - this.now()))]);
    const command = liveRecoveryHideCommand(sandbox, route.bootId, deadline);
    let hidden = false;
    while (this.now() < deadline && !repairSignal.aborted) {
      if (!await this.current(route, signal)) return;
      let state: ReturnType<typeof liveRecoveryHideState> = "pending";
      try { state = liveRecoveryHideState(await this.deps.compute.exec(sandbox, command, 30, repairSignal)); }
      catch { /* Replaying the same receipt never repeats an uncertain hide. */ }
      if (state === "hidden") { hidden = true; break; }
      if (state === "binding_changed") return;
      if (state === "refused") break;
      if (!repairSignal.aborted) await this.wait(Math.min(RETRY_MS, Math.max(0, deadline - this.now())), repairSignal);
    }
    if (!await this.current(route, signal)) return;
    if (!hidden || repairSignal.aborted) { await this.unavailable(route, "route_hide_unconfirmed"); return; }
    let hosted: { url: string; token: string } | undefined;
    while (this.now() < deadline && !repairSignal.aborted) {
      if (!await this.current(route, signal)) return;
      try {
        hosted = await this.deps.compute.hostPort(sandbox, { port: LIVE_RECOVERY_PORT, localhost: true, title: "Zeros worker",
          key: liveRecoveryKey(sandbox, route.bootId), signal: repairSignal });
        break;
      } catch { if (!repairSignal.aborted) await this.wait(Math.min(RETRY_MS, Math.max(0, deadline - this.now())), repairSignal); }
    }
    if (!await this.current(route, signal)) return;
    if (!hosted || repairSignal.aborted) { await this.unavailable(route, "route_host_unconfirmed"); return; }
    if (!await this.deps.publish(route, hosted) || signal.aborted) return;
    const repaired = await this.deps.route(route.workspace.id);
    if (!sameLiveRoute({ ...route, ...hosted }, repaired)) return;
    const result = await this.verify(repaired, signal);
    if (result === "changed") return;
    if (result === "gateway" && await this.deps.rebuild?.(repaired)) return;
    if (result !== "connected") { await this.unavailable(repaired, "route_repair_exhausted"); return; }
    await this.deps.condition(repaired, false);
    this.log(repaired, "ready", "route_repaired"); this.deps.ready(repaired.workspace.id);
  }
}
