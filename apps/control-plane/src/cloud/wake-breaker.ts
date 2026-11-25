/** Failures that can come from Zeros or Boat as a whole rather than from one workspace: a provider reply, the runtime
 * download, a worker that never says hello. Anything a workspace's own state explains (its machine gone, its source
 * access, its checkpoint, the account's budget) never opens the breaker. */
export const CLOUD_V2_BREAKER_CODES: ReadonlySet<string> = new Set([
  "provider_request_failed", "provider_request_timeout", "provider_request_unavailable", "provider_rate_limited",
  "provider_response_invalid", "provider_route_invalid", "provider_credential_rejected",
  "worker_runtime_install_failed", "worker_boot_timeout",
]);
export const CLOUD_V2_BREAKER_WINDOW_MS = 10 * 60_000;
export const CLOUD_V2_BREAKER_WORKSPACES = 3;
/** How long a wake may be held, from its own start, and how long a breaker stays open without a successful wake. */
export const CLOUD_V2_BREAKER_HOLD_MS = 2 * 60 * 60_000;

export type CloudV2BreakerOpen = { key: string; workspaces: number };

/** Per lifecycle process, in memory: a restart (usually the deploy that fixes the cause) starts it closed. With several
 * lifecycle processes each counts only the failures it sees, so each opens on its own. */
export class CloudV2WakeBreaker {
  private readonly failures = new Map<string, Map<string, number>>();
  private readonly last = new Map<string, { key: string; at: number }>();
  private readonly open = new Map<string, number>();
  private readonly held = new Map<string, number>();
  private closedAt: number | null = null;

  get isOpen(): boolean { return this.open.size > 0; }
  get openedAt(): number | null { return this.open.size ? Math.min(...this.open.values()) : null; }

  /** A create or wake failed with `code` (`key` adds Boat's status). Returns the breaker this opened, once. */
  record(workspaceId: string, code: string, key: string, now: number): CloudV2BreakerOpen | null {
    this.prune(now);
    if (!CLOUD_V2_BREAKER_CODES.has(code)) return null;
    this.last.set(workspaceId, { key, at: now });
    const seen = this.failures.get(key) ?? new Map<string, number>();
    seen.set(workspaceId, now);
    this.failures.set(key, seen);
    if (this.open.has(key) || seen.size < CLOUD_V2_BREAKER_WORKSPACES) return null;
    this.open.set(key, now);
    return { key, workspaces: seen.size };
  }

  /** Whether this wake, started at `startedAt`, is held: an open breaker covers its last failure (or a boot deadline,
   * for `boot`), and it is within its own hold. Returns the key that holds it, newly held or not. */
  holds(workspaceId: string, keys: readonly (string | undefined)[], startedAt: number, now: number): { key: string; first: boolean } | null {
    if (now - startedAt >= CLOUD_V2_BREAKER_HOLD_MS) return null;
    const key = keys.find(candidate => candidate !== undefined && this.open.has(candidate));
    if (!key) return null;
    const first = !this.held.has(workspaceId);
    if (first) this.held.set(workspaceId, now);
    return { key, first };
  }

  /** This wake's own last failure: one from before `since`, the wake's start, belongs to an earlier wake. */
  lastKey(workspaceId: string, since: number): string | undefined {
    const last = this.last.get(workspaceId);
    return last && last.at >= since ? last.key : undefined;
  }

  /** A held wake's boot deadline counts from the close: it missed the earlier one while the breaker held it. */
  deadlineFrom(workspaceId: string, from: number): number {
    return this.held.has(workspaceId) && this.closedAt !== null ? Math.max(from, this.closedAt) : from;
  }

  /** Closes every open breaker; returns their keys and how many wakes they held. */
  close(now: number): { keys: string[]; held: number } {
    const keys = [...this.open.keys()];
    this.open.clear(); this.failures.clear();
    this.closedAt = now;
    return { keys, held: this.held.size };
  }

  /** Breakers open past the hold, closed now; their held wakes fail as before. */
  expire(now: number): string[] {
    const expired = [...this.open].filter(([, at]) => now - at >= CLOUD_V2_BREAKER_HOLD_MS).map(([key]) => key);
    for (const key of expired) { this.open.delete(key); this.failures.delete(key); }
    if (!this.open.size) this.held.clear();
    return expired;
  }

  private prune(now: number): void {
    for (const [key, seen] of this.failures) {
      for (const [workspaceId, at] of seen) if (now - at > CLOUD_V2_BREAKER_WINDOW_MS) seen.delete(workspaceId);
      if (!seen.size) this.failures.delete(key);
    }
    for (const [workspaceId, last] of this.last) if (now - last.at > CLOUD_V2_BREAKER_HOLD_MS) this.last.delete(workspaceId);
    for (const [workspaceId, at] of this.held) if (now - at > CLOUD_V2_BREAKER_HOLD_MS) this.held.delete(workspaceId);
  }
}
