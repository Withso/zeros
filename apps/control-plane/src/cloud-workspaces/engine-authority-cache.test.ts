import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RolloutFlagName, RolloutFlagReader } from "../rollout-flags.js";
import {
  decideEngineAuthority,
  EngineAuthorityCache,
  installEngineAuthorityCache,
  type EngineAuthorityEntry,
  type EngineAuthorityKey,
} from "./engine-authority-cache.js";
import { CloudWorkspaceEngineAuthorityError, readCurrentCloudEngineAuthority } from "./engine-authority.js";

const WS = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const ENGINE = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";
const TOKEN = `zwh_${"A".repeat(43)}`;
const hash = (token: string) => createHash("sha256").update(token, "utf8").digest();
const KEY: EngineAuthorityKey = { workspaceId: WS, organizationId: ORG, generation: 3, engineInstanceId: ENGINE, workosEnabled: false };
const NOW = 1_800_000_000_000;

function entry(overrides: Partial<EngineAuthorityEntry> = {}): EngineAuthorityEntry {
  return {
    authorityEpoch: 7, accountUserId: USER, heartbeatTokenHash: hash(TOKEN), revoked: false, setupEnrolled: true,
    runtimeReady: false, leaseExpiresAtMs: NOW + 60_000, deadlineMs: NOW + 30_000, ...overrides,
  };
}

type Handlers = { onNotification: (payload: string) => void; onReady: () => void; onUnavailable: () => void };

function harness(options: { flags?: RolloutFlagName[]; value?: EngineAuthorityEntry | null } = {}) {
  let handlers!: Handlers;
  let clock = NOW;
  let value: EngineAuthorityEntry | null = options.value === undefined ? entry() : options.value;
  const held: Array<() => void> = [];
  let hold = false;
  const load = vi.fn(async () => {
    const snapshot = value;
    if (hold) await new Promise<void>(resolve => held.push(resolve));
    return snapshot;
  });
  const enabled = new Set(options.flags ?? ["authority_cache_shadow"]);
  const flags: RolloutFlagReader = { enabled: (org, flag) => org === ORG && enabled.has(flag) };
  const logger = { warn: vi.fn(), info: vi.fn() };
  const cache = new EngineAuthorityCache({
    load, flags, logger, now: () => clock, settleMs: 5, summaryMs: 0,
    subscribe: next => { handlers = next; return { start: async () => {}, healthy: () => true, stop: async () => {} }; },
  });
  cache.start();
  return {
    cache, load, logger, flags: enabled,
    get handlers() { return handlers; },
    set value(next: EngineAuthorityEntry | null) { value = next; },
    advance(ms: number) { clock += ms; },
    hold() { hold = true; },
    release() { hold = false; held.splice(0).forEach(resolve => resolve()); },
  };
}

async function settle(cache: EngineAuthorityCache) {
  await vi.waitFor(() => expect(cache.stats().loads).toBeGreaterThan(0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

const allowed = { allowed: true, authorityEpoch: 7, accountUserId: USER, leaseExpiresAtMs: 0 } as const;

afterEach(() => { installEngineAuthorityCache(undefined); });

describe("engine authority decisions", () => {
  it("allows only a matching token on a live, enrolled, unexpired entry", () => {
    const mode = { kind: "assert" } as const;
    expect(decideEngineAuthority(entry(), hash(TOKEN), mode, NOW)).toMatchObject({ allowed: true, authorityEpoch: 7 });
    expect(decideEngineAuthority(entry(), hash(`zwh_${"B".repeat(43)}`), mode, NOW)).toEqual({ allowed: false });
    expect(decideEngineAuthority(undefined, hash(TOKEN), mode, NOW)).toEqual({ allowed: false });
    expect(decideEngineAuthority(entry(), hash(TOKEN), mode, NOW + 30_000)).toEqual({ allowed: false });
    expect(decideEngineAuthority(entry({ leaseExpiresAtMs: NOW }), hash(TOKEN), mode, NOW)).toEqual({ allowed: false });
    const runtime = entry({ setupEnrolled: false, runtimeReady: false });
    expect(decideEngineAuthority(runtime, hash(TOKEN), mode, NOW)).toEqual({ allowed: false });
    expect(decideEngineAuthority(runtime, hash(TOKEN), { kind: "assert", transitionRecordSync: true }, NOW).allowed).toBe(true);
    expect(decideEngineAuthority(runtime, hash(TOKEN), { kind: "read" }, NOW).allowed).toBe(false);
    expect(decideEngineAuthority(entry({ revoked: true }), hash(TOKEN), { kind: "read" }, NOW).allowed).toBe(false);
  });
});

describe("engine authority cache", () => {
  it("does nothing for organizations without a cache flag", async () => {
    const h = harness({ flags: [] });
    h.handlers.onReady();
    h.cache.observe(KEY, hash(TOKEN), { kind: "assert" }, allowed);
    expect(h.load).not.toHaveBeenCalled();
    expect(h.cache.stats()).toMatchObject({ agree: 0, miss: 0 });
    expect(h.cache.enforcing(ORG)).toBe(false);
  });

  it("loads on a shadow miss and agrees afterwards", async () => {
    const h = harness();
    h.handlers.onReady();
    h.cache.observe(KEY, hash(TOKEN), { kind: "assert" }, allowed);
    await settle(h.cache);
    expect(h.cache.stats()).toMatchObject({ miss: 1, entries: 1 });
    h.cache.observe({ ...KEY, workspaceId: WS.toUpperCase() }, hash(TOKEN), { kind: "assert" }, allowed);
    expect(h.cache.stats().agree).toBe(1);
    expect(h.cache.lookup(KEY, hash(TOKEN), { kind: "read" })).toMatchObject({ allowed: true, authorityEpoch: 7 });
  });

  it("trusts nothing before LISTEN is ready and flushes on listener loss", async () => {
    const h = harness();
    h.cache.observe(KEY, hash(TOKEN), { kind: "assert" }, allowed);
    expect(h.load).not.toHaveBeenCalled();
    expect(h.cache.stats().unavailable).toBe(1);
    h.handlers.onReady();
    h.cache.ensure(KEY);
    await settle(h.cache);
    expect(h.cache.stats().entries).toBe(1);
    h.handlers.onUnavailable();
    expect(h.cache.stats().entries).toBe(0);
    expect(h.cache.lookup(KEY, hash(TOKEN), { kind: "read" })).toBeUndefined();
  });

  it("discards a load that overlapped the listener being lost and regained", async () => {
    const h = harness();
    h.handlers.onReady();
    h.hold();
    h.cache.ensure(KEY);
    h.handlers.onUnavailable();
    h.handlers.onReady();
    h.release();
    await vi.waitFor(() => expect(h.cache.stats().loadsDiscarded).toBe(1));
    expect(h.cache.stats().entries).toBe(0);
  });

  it.each([`w:${WS}`, `o:${ORG}`, `u:${USER}`, "*", "garbage"])("invalidates on %s, including a load in flight", async payload => {
    const h = harness();
    h.handlers.onReady();
    h.cache.ensure(KEY);
    await settle(h.cache);
    h.handlers.onNotification(payload);
    expect(h.cache.stats().entries).toBe(0);
    h.hold();
    h.cache.ensure(KEY);
    h.handlers.onNotification(payload);
    h.release();
    await vi.waitFor(() => expect(h.cache.stats().loadsDiscarded).toBe(1));
    expect(h.cache.stats().entries).toBe(0);
  });

  it("keeps entries of other workspaces, organizations and users", async () => {
    const h = harness();
    h.handlers.onReady();
    h.cache.ensure(KEY);
    await settle(h.cache);
    for (const scope of ["w", "o", "u"]) h.handlers.onNotification(`${scope}:55555555-5555-4555-8555-555555555555`);
    expect(h.cache.stats().entries).toBe(1);
  });

  it("expires an entry at its deadline", async () => {
    const h = harness();
    h.handlers.onReady();
    h.cache.ensure(KEY);
    await settle(h.cache);
    h.advance(30_000);
    expect(h.cache.lookup(KEY, hash(TOKEN), { kind: "read" })).toBeUndefined();
    expect(h.cache.stats().entries).toBe(0);
  });

  it("never caches a denial", async () => {
    const h = harness({ value: null });
    h.handlers.onReady();
    h.cache.ensure(KEY);
    await settle(h.cache);
    expect(h.cache.stats().entries).toBe(0);
  });

  it("counts a stale entry as a mismatch only after a fresh committed read disagrees", async () => {
    const h = harness();
    h.handlers.onReady();
    h.cache.ensure(KEY);
    await settle(h.cache);
    // SQL denies inside the caller's transaction, but committed state still
    // allows: the caller saw its own write. Transient, not a mismatch.
    h.cache.observe(KEY, hash(TOKEN), { kind: "assert" }, { allowed: false });
    await vi.waitFor(() => expect(h.cache.stats().transient).toBe(1));
    // Committed state now denies and no hint arrived: a real stale entry.
    h.value = null;
    h.cache.observe(KEY, hash(TOKEN), { kind: "assert" }, { allowed: false });
    await vi.waitFor(() => expect(h.cache.stats().mismatchCacheAllows).toBe(1));
    expect(h.cache.stats().entries).toBe(0);
    for (const [message] of h.logger.warn.mock.calls) {
      expect(String(message)).not.toContain(WS);
      expect(String(message)).not.toContain(USER);
    }
  });

  it("counts a disagreement resolved by a later hint as converged", async () => {
    const h = harness();
    h.handlers.onReady();
    h.cache.ensure(KEY);
    await settle(h.cache);
    h.cache.observe(KEY, hash(TOKEN), { kind: "assert" }, { allowed: false });
    h.handlers.onNotification(`w:${WS}`);
    await vi.waitFor(() => expect(h.cache.stats().converged).toBe(1));
    expect(h.cache.stats().mismatchCacheAllows).toBe(0);
  });

  it("bounds the number of entries", async () => {
    const h = harness();
    const small = new EngineAuthorityCache({
      load: async () => entry(), now: () => NOW, summaryMs: 0, maxEntries: 2,
      flags: { enabled: () => true },
      subscribe: next => { next.onReady(); return { start: async () => {}, healthy: () => true, stop: async () => {} }; },
    });
    small.start();
    for (const generation of [1, 2, 3]) { small.ensure({ ...KEY, generation }); await new Promise(resolve => setTimeout(resolve, 0)); }
    await vi.waitFor(() => expect(small.stats().loads).toBe(3));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(small.stats().entries).toBe(2);
    await small.stop();
    await h.cache.stop();
  });
});

describe("engine authority reads with the cache installed", () => {
  const input = { ...KEY, heartbeatToken: TOKEN };
  const noSql = { query: vi.fn(async () => { throw new Error("sql must not run"); }) } as never;

  it("serves an enforced read from memory without SQL", async () => {
    const h = harness({ flags: ["authority_cache_enforce"] });
    installEngineAuthorityCache(h.cache);
    h.handlers.onReady();
    h.cache.ensure(KEY);
    await settle(h.cache);
    const read = await readCurrentCloudEngineAuthority(noSql, input);
    expect(read).toMatchObject({ version: 1, authorityEpoch: 7, accountUserId: USER, engineInstanceId: ENGINE });
    expect(read.confirmedUntilMs).toBeLessThanOrEqual(Date.now() + 10_000);
    expect(h.cache.stats().enforcedHits).toBe(1);
  });

  it.each([
    ["shadow only", ["authority_cache_shadow"] as RolloutFlagName[]],
    ["the enforce flag with a lost feed", ["authority_cache_enforce"] as RolloutFlagName[]],
  ])("falls back to SQL with %s", async (_label, flags) => {
    const h = harness({ flags });
    installEngineAuthorityCache(h.cache);
    h.handlers.onReady();
    h.cache.ensure(KEY);
    await settle(h.cache);
    if (flags.includes("authority_cache_enforce")) h.handlers.onUnavailable();
    const tx = { query: vi.fn(async () => ({ rows: [] })) } as never;
    await expect(readCurrentCloudEngineAuthority(tx, input)).rejects.toBeInstanceOf(CloudWorkspaceEngineAuthorityError);
    expect((tx as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledTimes(1);
  });

  it("falls back to SQL when the cached answer is a denial", async () => {
    const h = harness({ flags: ["authority_cache_enforce"] });
    installEngineAuthorityCache(h.cache);
    h.handlers.onReady();
    h.cache.ensure(KEY);
    await settle(h.cache);
    const tx = { query: vi.fn(async () => ({ rows: [] })) } as never;
    await expect(readCurrentCloudEngineAuthority(tx, { ...input, heartbeatToken: `zwh_${"B".repeat(43)}` }))
      .rejects.toBeInstanceOf(CloudWorkspaceEngineAuthorityError);
    expect((tx as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledTimes(1);
  });
});
