import type { Tx } from "../db.js";

/** Wakes relay rooms waiting for a workspace's worker. Only a hint: it is
 * delivered on commit, carries no authority, and relay polling remains. */
export const CLOUD_V2_READY_CHANNEL = "zeros_cloud_v2_ready";
export const CLOUD_V2_BOOT_CHANNEL = "zeros_cloud_v2_boot";

export async function notifyCloudV2WorkerReady(tx: Tx, workspaceId: string): Promise<void> {
  await tx.query("SELECT pg_notify($1, $2)", [CLOUD_V2_READY_CHANNEL, workspaceId]);
}

export async function notifyCloudV2WorkerBoot(tx: Tx, workspaceId: string, bootId: string, phase: "hello" | "applied"): Promise<void> {
  await tx.query("SELECT pg_notify($1, $2)", [CLOUD_V2_BOOT_CHANNEL, JSON.stringify({ workspaceId, bootId, phase })]);
}

type Hint = { bootId?: string; expectsApplied: boolean; ready: boolean; at: number };

/** These hints schedule a dial, never authorize it. Missing or evicted hints
 * fall back to one bounded wait and a fresh route/authority read. */
export class WorkerReadySignals {
  private readonly hints = new Map<string, Hint>();
  private readonly waits = new Map<string, Set<() => void>>();

  hello(id: string, bootId: string, expectsApplied: boolean): void {
    const previous = this.hints.get(id);
    if (previous?.bootId === bootId && previous.ready) return;
    this.remember(id, { bootId, expectsApplied, ready: false, at: Date.now() });
  }
  ready(id: string): void {
    if (this.hints.get(id)?.expectsApplied) return;
    this.remember(id, { expectsApplied: false, ready: true, at: Date.now() });
  }
  applied(id: string, bootId: string): void {
    const previous = this.hints.get(id);
    if (previous?.expectsApplied && previous.bootId !== bootId) return;
    this.remember(id, { bootId, expectsApplied: true, ready: true, at: Date.now() });
  }
  notification(payload: string): void {
    try {
      if (payload.length > 256) return;
      const value: unknown = JSON.parse(payload);
      if (!value || typeof value !== "object" || !("workspaceId" in value) || !("bootId" in value) || !("phase" in value)) return;
      if (typeof value.workspaceId !== "string" || !/^[a-f0-9-]{36}$/.test(value.workspaceId) ||
          typeof value.bootId !== "string" || !/^[a-f0-9-]{36}$/.test(value.bootId)) return;
      if (value.phase === "hello") this.hello(value.workspaceId, value.bootId, true);
      else if (value.phase === "applied") this.applied(value.workspaceId, value.bootId);
    } catch { /* Notification loss affects latency only. */ }
  }
  wait(id: string, notBefore: number, starting: boolean, signal: AbortSignal, ms: number): Promise<void> {
    const ready = () => {
      const hint = this.hints.get(id);
      const fresh = hint && (!starting || hint.at >= notBefore) && Date.now() - hint.at < 120_000;
      return signal.aborted || (fresh ? hint.ready : !starting);
    };
    if (ready()) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer); signal.removeEventListener("abort", finish);
        waits.delete(check); if (!waits.size) this.waits.delete(id);
        resolve();
      };
      const check = () => { if (ready()) finish(); };
      const waits = this.waits.get(id) ?? new Set<() => void>();
      waits.add(check); this.waits.set(id, waits);
      const timer = setTimeout(finish, Math.max(0, ms)); timer.unref();
      signal.addEventListener("abort", finish, { once: true });
      check();
    });
  }
  private remember(id: string, value: Hint): void {
    this.hints.delete(id);
    if (this.hints.size >= 4096) this.hints.delete(this.hints.keys().next().value!);
    this.hints.set(id, value);
    for (const check of this.waits.get(id) ?? []) check();
  }
}
