// In-memory execution token verdicts (design: .context/cloud-api/authority-cache/advisor-1-review.md).
//
// An entry is a successful one-transaction token check. It is served only while the listener is healthy, the entry is
// younger than MAX_AGE_MS measured from when its load started, and its own expiry bounds hold. Notifications only make
// entries go sooner: removals, Stop and outcomes end the context row in the revoking transaction, which notifies
// `zeros_cloud_v2_execution`; settings the fence does not see notify `zeros_cloud_v2_authorization` (migration 0255).
// A lost notification therefore costs at most MAX_AGE_MS plus one check. Refusals are never cached.
//
// A load that read just before a revoking commit can return after that commit's notification was handled. Every
// invalidation bumps a sequence and records it per scope; a load stores its result only if none of its scopes (and no
// flush) moved since it started. The result is still used for the check that loaded it, as without the cache.

export type ExecutionAuthorizationMode = "off" | "shadow" | "on";
export type ExecutionAuthorizationScopes = { workspaceId: string; organizationId: string; userIds: readonly string[] };
export type ExecutionAuthorizationLoad<T> = { value: T; scopes: ExecutionAuthorizationScopes; expiresAt: number };

export const EXECUTION_AUTHORIZATION_MAX_AGE_MS = 5_000;

/** Every table the one-transaction token check reads, and what drops a cached verdict when it changes. A guard test
 * (authorization-cache.integration.test.ts) measures the tables the check reads and fails on any not listed here.
 * - context: the change ends the context row (or deletes its token), which notifies zeros_cloud_v2_execution (0239).
 * - fence: fence_cloud_execution_authority ends the affected contexts in the writing transaction (0254), as above.
 * - hint: a 0255 trigger notifies zeros_cloud_v2_authorization (for some tables in addition to the fence).
 * - age: only the 5 s age bound (clock-driven Hold windows, credential material, chat and prompt writers other than
 *   Stop and outcomes, which end the context). */
export const EXECUTION_AUTHORIZATION_INPUTS = {
  cloud_v2_execution_contexts: ["context", "hint"],
  cloud_v2_execution_tokens: ["context"],
  cloud_v2_workspaces: ["fence", "hint"],
  cloud_v2_github_sources: ["hint"],
  cloud_api_access_settings: ["hint"],
  organization_member_seat_periods: ["hint", "age"],
  organization_members: ["fence"],
  organizations: ["fence"],
  users: ["fence"],
  cloud_agent_organization_connections: ["fence"],
  cloud_agent_credentials: ["fence"],
  cloud_agent_credential_versions: ["age"],
  cloud_v2_prompt_chats: ["age"],
  cloud_v2_prompt_outbox: ["age"],
} as const satisfies Record<string, readonly ("context" | "fence" | "hint" | "age")[]>;
const MAX_ENTRIES = 10_000;
// A load slower than this stores nothing, so per-scope sequences can be pruned after it.
const MAX_LOAD_MS = 30_000;

type Entry<T> = { value: T; scopes: ExecutionAuthorizationScopes; expiresAt: number; loadedAt: number };
type Counters = { hits: number; loads: number; stale: number; invalidations: number; flushes: number; bypasses: number; mismatches: number };

export class ExecutionAuthorizationCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly loading = new Map<string, Promise<T>>();
  private readonly moved = new Map<string, { sequence: number; at: number }>();
  private sequence = 0;
  private flushedAt = 0;
  readonly counters: Counters = { hits: 0, loads: 0, stale: 0, invalidations: 0, flushes: 0, bypasses: 0, mismatches: 0 };

  constructor(private readonly options: {
    mode: ExecutionAuthorizationMode;
    healthy: () => boolean;
    maxAgeMs?: number;
    maxEntries?: number;
    /** Monotonic ms for ages (performance.now()). */
    monotonic?: () => number;
    /** Wall-clock ms for expiry bounds (Date.now()). */
    wall?: () => number;
  }) {}

  get mode() { return this.options.mode; }

  /** Serves a fresh entry, or runs `load` (one flight per key) and keeps its result when nothing moved meanwhile. */
  async get(key: string, load: () => Promise<ExecutionAuthorizationLoad<T>>): Promise<T> {
    if (this.options.mode === "off") return (await load()).value;
    const healthy = this.options.healthy();
    if (!healthy) { this.counters.bypasses += 1; this.flush(); return (await load()).value; }
    if (this.options.mode === "on") {
      const entry = this.fresh(key);
      if (entry) { this.counters.hits += 1; return entry.value; }
      const flight = this.loading.get(key);
      if (flight) return flight;
    }
    const cached = this.options.mode === "shadow" ? this.fresh(key) : undefined;
    const flight = this.load(key, load);
    if (this.options.mode === "on") {
      this.loading.set(key, flight);
      void flight.finally(() => { if (this.loading.get(key) === flight) this.loading.delete(key); }).catch(() => {});
      return flight;
    }
    // Shadow: the live verdict is served; a cached verdict that the live check refuses is counted.
    try { return await flight; }
    catch (error) { if (cached) this.counters.mismatches += 1; throw error; }
  }

  /** Drops the entries of a workspace, of a person (sender or payer), or of an organization. */
  invalidate(scope: { workspaceId?: string; userId?: string; organizationId?: string }) {
    const now = this.monotonic();
    this.sequence += 1;
    this.counters.invalidations += 1;
    const keys = [scope.workspaceId && `w:${scope.workspaceId}`, scope.userId && `u:${scope.userId}`, scope.organizationId && `o:${scope.organizationId}`]
      .filter((value): value is string => Boolean(value));
    if (!keys.length) return this.flush();
    for (const key of keys) this.moved.set(key, { sequence: this.sequence, at: now });
    for (const [key, entry] of this.entries)
      if (keys.some(scopeKey => scopeKeys(entry.scopes).includes(scopeKey))) this.entries.delete(key);
    this.prune(now);
  }

  flush() {
    this.sequence += 1;
    this.flushedAt = this.sequence;
    this.counters.flushes += 1;
    this.entries.clear();
    this.moved.clear();
  }

  get size() { return this.entries.size; }

  private async load(key: string, load: () => Promise<ExecutionAuthorizationLoad<T>>): Promise<T> {
    const started = this.monotonic(), sequence = this.sequence;
    this.counters.loads += 1;
    const result = await load();
    const now = this.monotonic();
    if (this.options.healthy() && now - started < MAX_LOAD_MS && this.flushedAt <= sequence &&
        !scopeKeys(result.scopes).some(scopeKey => (this.moved.get(scopeKey)?.sequence ?? 0) > sequence)) {
      this.entries.delete(key);
      this.entries.set(key, { value: result.value, scopes: result.scopes, expiresAt: result.expiresAt, loadedAt: started });
      while (this.entries.size > (this.options.maxEntries ?? MAX_ENTRIES)) this.entries.delete(this.entries.keys().next().value!);
    } else this.counters.stale += 1;
    return result.value;
  }

  private fresh(key: string): Entry<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.monotonic() - entry.loadedAt >= (this.options.maxAgeMs ?? EXECUTION_AUTHORIZATION_MAX_AGE_MS) || this.wall() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    // Least recently used goes first when the cap is reached.
    this.entries.delete(key); this.entries.set(key, entry);
    return entry;
  }

  private prune(now: number) {
    for (const [key, value] of this.moved) if (now - value.at > MAX_LOAD_MS) this.moved.delete(key);
  }

  private monotonic() { return this.options.monotonic?.() ?? performance.now(); }
  private wall() { return this.options.wall?.() ?? Date.now(); }
}

function scopeKeys(scopes: ExecutionAuthorizationScopes) {
  return [`w:${scopes.workspaceId}`, `o:${scopes.organizationId}`, ...scopes.userIds.map(id => `u:${id}`)];
}

/** Parses an invalidation hint. Anything unexpected flushes: a hint is never trusted to narrow. */
export function authorizationHint(channel: string, payload: string | undefined):
  { workspaceId?: string; userId?: string; organizationId?: string } | "flush" | "ignore" {
  const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value) ? value : undefined;
  if (channel === "zeros_cloud_v2_authorization") {
    const match = /^([wuo]):([a-f0-9-]{36})$/.exec(payload ?? "");
    if (!match) return "flush";
    return match[1] === "w" ? { workspaceId: match[2]! } : match[1] === "u" ? { userId: match[2]! } : { organizationId: match[2]! };
  }
  if (channel === "zeros_cloud_v2_prompts") {
    const workspaceId = uuid((() => { try { return JSON.parse(payload ?? "")?.workspaceId; } catch { return undefined; } })()) ?? uuid(payload);
    return workspaceId ? { workspaceId } : "flush";
  }
  if (channel === "zeros_cloud_v2_execution") {
    let value: unknown;
    try { value = JSON.parse(payload ?? ""); } catch { return "flush"; }
    if (!value || typeof value !== "object") return "flush";
    const record = value as Record<string, unknown>;
    const scope = { ...(uuid(record.workspaceId) ? { workspaceId: uuid(record.workspaceId)! } : {}),
      ...(uuid(record.userId) ? { userId: uuid(record.userId)! } : {}),
      ...(uuid(record.organizationId) ? { organizationId: uuid(record.organizationId)! } : {}) };
    return Object.keys(scope).length ? scope : "flush";
  }
  return "ignore";
}
