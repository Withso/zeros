import { describe, expect, it } from "vitest";
import { ExecutionAuthorizationCache, authorizationHint, type ExecutionAuthorizationLoad } from "./authorization-cache.js";

const W = "11111111-1111-4111-8111-111111111111", O = "22222222-2222-4222-8222-222222222222";
const SENDER = "33333333-3333-4333-8333-333333333333", PAYER = "44444444-4444-4444-8444-444444444444";

function harness(mode: "on" | "shadow" = "on", options: { maxEntries?: number } = {}) {
  const clock = { monotonic: 0, wall: 1_000_000, healthy: true };
  const cache = new ExecutionAuthorizationCache<string>({ mode, healthy: () => clock.healthy, monotonic: () => clock.monotonic, wall: () => clock.wall, ...options });
  let loads = 0;
  const load = (value = "verdict", expiresAt = clock.wall + 60_000): () => Promise<ExecutionAuthorizationLoad<string>> =>
    async () => { loads += 1; return { value, scopes: { workspaceId: W, organizationId: O, userIds: [SENDER, PAYER] }, expiresAt }; };
  return { clock, cache, load, loads: () => loads };
}

describe("execution authorization cache", () => {
  it("serves an entry for 5 s measured from when its load started, then reloads", async () => {
    const h = harness();
    let release!: () => void;
    const slow = h.cache.get("k", async () => { await new Promise<void>(resolve => { release = resolve; }); return h.load()(); });
    h.clock.monotonic = 1_000; release(); await slow;
    h.clock.monotonic = 4_999; await h.cache.get("k", h.load()); expect(h.loads()).toBe(1);
    h.clock.monotonic = 5_000; await h.cache.get("k", h.load()); expect(h.loads()).toBe(2);
  });

  it("never serves past the context's own expiry", async () => {
    const h = harness();
    await h.cache.get("k", h.load("v", h.clock.wall + 100));
    h.clock.wall += 100; await h.cache.get("k", h.load()); expect(h.loads()).toBe(2);
  });

  it("drops entries by workspace, person (sender or payer) and organization; anything else flushes", async () => {
    const h = harness();
    for (const scope of [{ workspaceId: W }, { userId: SENDER }, { userId: PAYER }, { organizationId: O }, {}]) {
      await h.cache.get("k", h.load());
      const before = h.loads();
      h.cache.invalidate(scope);
      await h.cache.get("k", h.load()); expect(h.loads()).toBe(before + 1);
    }
    await h.cache.get("k", h.load());
    h.cache.invalidate({ userId: "55555555-5555-4555-8555-555555555555" });
    await h.cache.get("k", h.load()); expect(h.loads()).toBe(6);
  });

  it("does not keep a load that an invalidation of its scope overtook, but still answers that one check", async () => {
    const h = harness();
    let release!: () => void;
    const pending = h.cache.get("k", async () => { await new Promise<void>(resolve => { release = resolve; }); return h.load("old")(); });
    await Promise.resolve();
    h.cache.invalidate({ workspaceId: W }); release();
    expect(await pending).toBe("old");
    await h.cache.get("k", h.load("new")); expect(h.loads()).toBe(2);
    expect(h.cache.counters.stale).toBe(1);
  });

  it("does not keep a load that a flush overtook", async () => {
    const h = harness();
    let release!: () => void;
    const pending = h.cache.get("k", async () => { await new Promise<void>(resolve => { release = resolve; }); return h.load()(); });
    await Promise.resolve();
    h.cache.flush(); release(); await pending;
    await h.cache.get("k", h.load()); expect(h.loads()).toBe(2);
  });

  it("checks live and keeps nothing while the listener is unhealthy", async () => {
    const h = harness();
    await h.cache.get("k", h.load());
    h.clock.healthy = false;
    await h.cache.get("k", h.load()); await h.cache.get("k", h.load()); expect(h.loads()).toBe(3);
    h.clock.healthy = true;
    await h.cache.get("k", h.load()); await h.cache.get("k", h.load()); expect(h.loads()).toBe(4);
  });

  it("shares one load per key and never caches a refusal", async () => {
    const h = harness();
    let release!: () => void;
    const loader = async () => { await new Promise<void>(resolve => { release = resolve; }); return h.load()(); };
    const both = Promise.all([h.cache.get("k", loader), h.cache.get("k", loader)]);
    await Promise.resolve(); release();
    expect(await both).toEqual(["verdict", "verdict"]); expect(h.loads()).toBe(1);
    await expect(h.cache.get("x", async () => { throw new Error("refused"); })).rejects.toThrow("refused");
    await h.cache.get("x", h.load()); expect(h.loads()).toBe(2);
  });

  it("evicts the least recently used entry at the cap", async () => {
    const h = harness("on", { maxEntries: 2 });
    await h.cache.get("a", h.load()); await h.cache.get("b", h.load());
    await h.cache.get("a", h.load());
    await h.cache.get("c", h.load());
    expect(h.cache.size).toBe(2);
    await h.cache.get("a", h.load()); expect(h.loads()).toBe(3);
    await h.cache.get("b", h.load()); expect(h.loads()).toBe(4);
  });

  it("serves the live verdict in shadow mode and counts a cached allow the live check refuses", async () => {
    const h = harness("shadow");
    await h.cache.get("k", h.load()); await h.cache.get("k", h.load()); expect(h.loads()).toBe(2);
    await expect(h.cache.get("k", async () => { throw Object.assign(new Error("refused"), { status: 403, code: "actor_changed" }); })).rejects.toThrow();
    expect(h.cache.counters.mismatches).toBe(1);
  });

  it("parses hints; anything it cannot narrow flushes", () => {
    expect(authorizationHint("zeros_cloud_v2_authorization", `w:${W}`)).toEqual({ workspaceId: W });
    expect(authorizationHint("zeros_cloud_v2_authorization", `u:${SENDER}`)).toEqual({ userId: SENDER });
    expect(authorizationHint("zeros_cloud_v2_authorization", `o:${O}`)).toEqual({ organizationId: O });
    expect(authorizationHint("zeros_cloud_v2_authorization", "x:1")).toBe("flush");
    expect(authorizationHint("zeros_cloud_v2_execution", JSON.stringify({ workspaceId: W, contextId: SENDER }))).toEqual({ workspaceId: W });
    expect(authorizationHint("zeros_cloud_v2_execution", JSON.stringify({ userId: SENDER, organizationId: O }))).toEqual({ userId: SENDER, organizationId: O });
    expect(authorizationHint("zeros_cloud_v2_execution", "{}")).toBe("flush");
    expect(authorizationHint("zeros_cloud_v2_execution", "not json")).toBe("flush");
    expect(authorizationHint("zeros_cloud_v2_prompts", W)).toEqual({ workspaceId: W });
    expect(authorizationHint("zeros_cloud_v2_prompts", "")).toBe("flush");
    expect(authorizationHint("zeros_cloud_v2_logins", "{}")).toBe("ignore");
  });

  it("does not let a caller that arrives after an invalidation join the load that started before it", async () => {
    const h = harness();
    let release!: () => void;
    const first = h.cache.get("k", async () => { await new Promise<void>(resolve => { release = resolve; }); return h.load("before")(); });
    await Promise.resolve();
    h.cache.invalidate({ workspaceId: W });
    const second = h.cache.get("k", h.load("after"));
    release();
    expect(await first).toBe("before");
    expect(await second).toBe("after");
  });

  it("counts only refusals below 500 as shadow mismatches, by code", async () => {
    const h = harness("shadow");
    await h.cache.get("k", h.load());
    const refused = Object.assign(new Error("gone"), { status: 401, code: "unauthorized" });
    const failed = Object.assign(new Error("down"), { status: 503, code: "unavailable" });
    await expect(h.cache.get("k", async () => { throw failed; })).rejects.toBe(failed);
    await h.cache.get("k", h.load());
    await expect(h.cache.get("k", async () => { throw refused; })).rejects.toBe(refused);
    expect(h.cache.counters.mismatches).toBe(1);
    expect([...h.cache.mismatchCodes]).toEqual([["unauthorized", 1]]);
  });
});
