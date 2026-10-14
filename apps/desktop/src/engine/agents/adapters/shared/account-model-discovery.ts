import type { AdvertisedModel } from "@zeros/protocol/agent-events";

export const ACCOUNT_MODEL_TTL_MS = 15 * 60 * 1_000;
const DISCOVERY_RETRY_MS = 30_000;

export interface AccountModelState<T = AdvertisedModel[]> {
  readonly identity: string;
  models?: T;
  pending?: Promise<void>;
}

interface Freshness {
  revision: number;
  invalidated: boolean;
  fetchedAt?: number;
  retryAt?: number;
  pendingRevision?: number;
}

/** Sessions capture their account before boot. Only the currently selected
 * account may publish models, even when an older query finishes after a switch. */
export class AccountModelDiscovery<T = AdvertisedModel[]> {
  private state: AccountModelState<T> | undefined;
  private readonly freshness = new WeakMap<AccountModelState<T>, Freshness>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly identity: () => string,
    options: { ttlMs?: number; timeoutMs?: number; now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    // Adapters without a qualified refresh path keep their existing policy.
    this.ttlMs = options.ttlMs ?? Infinity;
    this.timeoutMs = options.timeoutMs ?? Infinity;
  }

  current(): AccountModelState<T> {
    const identity = this.identity();
    if (this.state?.identity !== identity) this.state = { identity };
    return this.state;
  }

  capture(identity?: string): AccountModelState<T> {
    const current = this.current();
    return identity === undefined || current.identity === identity
      ? current
      : { identity };
  }

  private timing(state: AccountModelState<T>): Freshness {
    let timing = this.freshness.get(state);
    if (!timing) {
      timing = { revision: 0, invalidated: false };
      this.freshness.set(state, timing);
    }
    return timing;
  }

  isFresh(state: AccountModelState<T>): boolean {
    const { fetchedAt } = this.timing(state);
    const age = fetchedAt === undefined ? Infinity : this.now() - fetchedAt;
    return state.models !== undefined && age >= 0 && age < this.ttlMs;
  }

  /** Retain the confirmed display snapshot, but fence any older query. Several
   * rejections during a refresh coalesce; they never replay a provider turn. */
  invalidate(state: AccountModelState<T>): void {
    if (this.current() !== state) return;
    const timing = this.timing(state);
    if (timing.invalidated) return;
    timing.invalidated = true;
    timing.revision++;
    timing.fetchedAt = undefined;
    timing.retryAt = undefined;
  }

  discover(
    state: AccountModelState<T>,
    read: () => Promise<T>,
    publish?: (models: T) => void,
  ): Promise<void> {
    if (this.current() !== state) return Promise.resolve();
    const timing = this.timing(state);
    if (state.pending) {
      return timing.pendingRevision === timing.revision
        ? state.pending
        : state.pending.then(() => this.discover(state, read, publish));
    }
    if (this.isFresh(state) || this.now() < (timing.retryAt ?? -Infinity)) {
      return Promise.resolve();
    }
    const revision = timing.revision;
    timing.pendingRevision = revision;
    let resolve!: () => void;
    const work = new Promise<void>((done) => { resolve = done; });
    // A provider may synchronously re-enter discovery. Install the flight first
    // without deferring read(): warm results still publish in one microtask.
    state.pending = work;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (models?: T) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        if (this.current() !== state || timing.revision !== revision) return;
        // Legacy discovery (Claude) treats [] as not discovered yet. Only the
        // adapters opting into bounded freshness publish authoritative empties.
        const legacyEmpty = !Number.isFinite(this.ttlMs) && Array.isArray(models) && models.length === 0;
        if (models === undefined || legacyEmpty) {
          // Do not extend freshness after a failed request. A bounded retry
          // delay prevents active sends/picker reads from flooding a provider.
          timing.retryAt = this.now() + (Number.isFinite(this.ttlMs) ? DISCOVERY_RETRY_MS : 0);
          return;
        }
        // [] is a successful answer, not a reason to restore the bundled list.
        state.models = models;
        timing.fetchedAt = this.now();
        timing.retryAt = undefined;
        timing.invalidated = false;
        try { publish?.(models); } catch { /* Discovery must not fail a turn. */ }
      } finally {
        if (state.pending === work) state.pending = undefined;
        resolve();
      }
    };
    if (Number.isFinite(this.timeoutMs)) {
      timer = setTimeout(() => finish(), this.timeoutMs);
      timer.unref?.();
    }
    try { void read().then(finish, () => finish()); }
    catch { finish(); }
    return work;
  }
}
