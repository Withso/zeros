// Boat sometimes archives a VM seconds after resuming it, with no stop from us (Alpha 2026-11-17/18: 6, 19 and 44 s after
// hydration). Our row stays `running`, reconnects get 302, and waiting messages never move: idle stop skips a workspace
// with pending messages. Design: .context/cloud-api/boat-archive/advisor-1-review.md.
//
// Nothing polls a healthy workspace. Boat is asked only about a suspect: a failed dial of a running route, a message
// that waits too long on a running workspace (database-only scan), and once about 75 s after each wake. Only Boat's
// own answer (`archived`, or the sandbox gone) leads to CloudV2Store.providerStopped, which is fenced to the observed boot.
import { CloudProviderError } from "./provider-error.js";
import type { CloudV2ProviderStopBinding, CloudV2Store } from "./store.js";

export type ProviderStopMode = "off" | "observe" | "on";
export type ProviderStopTrigger = "dial" | "suspect" | "wake_check";
export type ProviderStopResult = "skipped" | "running" | "unknown" | "observed" | "stopped" | "rewake" | "stale";

/** Seconds between Boat reads for one boot: a suspect that keeps looking wrong is asked less and less often. */
const BACKOFF_MS = [15_000, 60_000, 120_000, 300_000];
export const PROVIDER_STOP_WAKE_CHECK_MS = 75_000;
const ARCHIVING_RECHECK_MS = 4_000;

type Deps = {
  mode: ProviderStopMode;
  compute: { inspect(sandboxId: string): Promise<{ state: string; stoppedAt?: Date | null }> };
  store: Pick<CloudV2Store, "providerStopped" | "providerStopSuspects">;
  logger?: Pick<Console, "warn">;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => void;
};

export class ProviderStopCheck {
  private readonly asked = new Map<string, { at: number; step: number }>();
  private readonly running = new Set<string>();
  constructor(private readonly deps: Deps) {}

  get mode() { return this.deps.mode; }

  /** Asks Boat about one observed boot, at most once per backoff step, and finishes the stop if Boat archived it. */
  async check(binding: CloudV2ProviderStopBinding, trigger: ProviderStopTrigger): Promise<ProviderStopResult> {
    if (this.deps.mode === "off") return "skipped";
    const key = `${binding.workspaceId}:${binding.bootId}`, now = this.now();
    const previous = this.asked.get(key);
    if (this.running.has(key) || previous && now < previous.at) return "skipped";
    this.asked.set(key, { at: now + BACKOFF_MS[Math.min(previous?.step ?? 0, BACKOFF_MS.length - 1)]!, step: (previous?.step ?? 0) + 1 });
    this.prune(now);
    this.running.add(key);
    try {
      let inspected: { state: string; stoppedAt?: Date | null };
      try { inspected = await this.deps.compute.inspect(binding.sandboxId); }
      catch (error) {
        if (!(error instanceof CloudProviderError && error.code === "provider_not_found")) return "unknown";
        inspected = { state: "missing", stoppedAt: null };
      }
      if (inspected.state === "archiving") {
        this.schedule(() => { this.asked.delete(key); void this.check(binding, trigger).catch(() => {}); }, ARCHIVING_RECHECK_MS);
        return "unknown";
      }
      if (inspected.state !== "archived" && inspected.state !== "missing") return "running";
      const result = await this.deps.store.providerStopped(binding,
        { trigger, state: inspected.state, stoppedAt: inspected.stoppedAt ?? null }, this.deps.mode);
      if (result !== "stale") this.deps.logger?.warn("[cloud-v2] provider stop", { workspaceId: binding.workspaceId.slice(0, 8),
        sandboxId: binding.sandboxId, trigger, state: inspected.state, stoppedAt: inspected.stoppedAt?.toISOString() ?? null, result });
      return result;
    } finally { this.running.delete(key); }
  }

  /** Database-only scan for running workspaces whose messages do not move; asks Boat about each, within the backoff. */
  async scan(): Promise<void> {
    if (this.deps.mode === "off") return;
    for (const binding of await this.deps.store.providerStopSuspects()) await this.check(binding, "suspect").catch(() => "unknown");
  }

  /** One Boat read about 75 s after a wake: every archive seen so far came within 44 s of hydration. */
  afterWake(binding: CloudV2ProviderStopBinding) {
    if (this.deps.mode === "off") return;
    this.schedule(() => { void this.check(binding, "wake_check").catch(() => {}); }, PROVIDER_STOP_WAKE_CHECK_MS);
  }

  private prune(now: number) {
    if (this.asked.size < 1_000) return;
    for (const [key, value] of this.asked) if (value.at < now - BACKOFF_MS.at(-1)!) this.asked.delete(key);
  }
  private now() { return this.deps.now?.() ?? Date.now(); }
  private schedule(run: () => void, ms: number) {
    if (this.deps.schedule) return this.deps.schedule(run, ms);
    setTimeout(run, ms).unref();
  }
}
