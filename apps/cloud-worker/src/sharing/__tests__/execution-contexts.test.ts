import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionContexts, type ContextsDeps } from "../execution-contexts";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", U = "33333333-3333-4333-8333-333333333333";
const lease = (contextId: string, expiresAt: number) => ({ contextId, userId: U, generation: "1", expiresAt, agents: { claude: { apiKey: "k".repeat(20) } }, gitIdentity: null });
afterEach(() => vi.useRealTimers());

function fixture(handler: (path: string, body: Record<string, unknown>) => unknown) {
  let now = 1_000_000;
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const deps: ContextsDeps = {
    post: async (path, body) => { calls.push({ path, body: body as Record<string, unknown> }); const value = handler(path, body as Record<string, unknown>); if (value instanceof Error) throw value; return value; },
    now: () => now,
  };
  return { contexts: new ExecutionContexts(deps), calls, advance: (ms: number) => { now += ms; } };
}

describe("execution contexts (slice B)", () => {
  it("leases a turn, renews every live context in one ordered batch, and ends a refused one with its reason", async () => {
    const f = fixture((path, body) => path === "turn-lease" ? lease(String(body.contextId), 1_030_000)
      : { leases: [{ contextId: A, expiresAt: 1_040_000 }, { contextId: B, refused: "access_revoked" }] });
    const ended: string[] = [];
    await f.contexts.turnLease({ chatId: "c", userMessageId: "m1", dispatchId: A, generation: "1", contextId: A });
    await f.contexts.turnLease({ chatId: "c2", userMessageId: "m2", dispatchId: B, generation: "1", contextId: B });
    f.contexts.onEnd(B, reason => ended.push(`B:${reason}`));
    await f.contexts.renew();
    expect(f.calls.at(-1)).toEqual({ path: "execution-leases/renew", body: { contextIds: [A, B] } });
    expect(f.contexts.live(A)).toBe(true);
    expect(f.contexts.expiresAt(A)).toBe(1_040_000);
    expect(f.contexts.live(B)).toBe(false);
    expect(ended).toEqual(["B:access_revoked"]);
  });

  it("keeps only the original deadline when renewal fails (503), then ends it as expired", async () => {
    const f = fixture(path => path === "turn-lease" ? lease(A, 1_030_000) : Object.assign(new Error("unavailable"), { status: 503 }));
    const ended: string[] = [];
    await f.contexts.turnLease({ chatId: "c", userMessageId: "m1", dispatchId: A, generation: "1", contextId: A });
    f.contexts.onEnd(A, reason => ended.push(reason));
    await f.contexts.renew();
    expect(f.contexts.live(A)).toBe(true);
    f.advance(30_001);
    await f.contexts.renew();
    expect(f.contexts.live(A)).toBe(false);
    expect(ended).toEqual(["expired"]);
  });

  it("ends a context at once on revoke-context, and retires with a stable id and the process count", async () => {
    const f = fixture(path => path === "turn-lease" ? lease(A, 1_030_000) : { retired: true });
    const ended: string[] = [];
    await f.contexts.turnLease({ chatId: "c", userMessageId: "m1", dispatchId: A, generation: "1", contextId: A });
    f.contexts.onEnd(A, reason => ended.push(reason));
    f.contexts.revoke(A, "actor_changed");
    expect([f.contexts.live(A), ended]).toEqual([false, ["actor_changed"]]);
    await f.contexts.retire(A, "revoked", 0);
    await f.contexts.retire(A, "revoked", 0);
    const retired = f.calls.filter(call => call.path === `execution-leases/${A}/retired`);
    expect(retired).toHaveLength(2);
    expect(retired[0]!.body).toEqual({ retirementId: retired[1]!.body.retirementId, reason: "revoked", processes: 0 });
  });

  it("refuses a lease reply for another context or with more than one agent", async () => {
    const f = fixture(() => lease(B, 1_030_000));
    await expect(f.contexts.turnLease({ chatId: "c", userMessageId: "m1", dispatchId: A, generation: "1", contextId: A })).rejects.toThrow(/context/i);
    const g = fixture(() => ({ ...lease(A, 1_030_000), agents: { claude: { apiKey: "k".repeat(20) }, cursor: { apiKey: "c" } } }));
    await expect(g.contexts.turnLease({ chatId: "c", userMessageId: "m1", dispatchId: A, generation: "1", contextId: A })).rejects.toThrow();
  });
});

it("holds every lease until this boot's clean attestation is accepted, and grants none when cleanup is unproven", async () => {
  const posts: Array<{ path: string; body: any }> = [];
  let failures = 1;
  const lease = { contextId: "66666666-6666-4666-8666-666666666666", userId: "44444444-4444-4444-8444-444444444444", expiresAt: Date.now() + 30_000, gitIdentity: null };
  const contexts = new ExecutionContexts({ post: async (path, body) => {
    posts.push({ path, body });
    if (path === "execution-leases/boot-clean") { if (failures-- > 0) throw Object.assign(new Error("lost"), { status: 503 }); return { retired: 2 }; }
    return lease;
  } });
  let attested!: (count: number) => void;
  contexts.clean(() => new Promise(resolve => { attested = resolve; }));
  const pending = contexts.clientLease({ clientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestId: "r", operation: "file.write" });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(posts).toEqual([]);
  attested(0);
  await expect(pending).resolves.toMatchObject({ contextId: lease.contextId });
  const cleans = posts.filter(post => post.path === "execution-leases/boot-clean");
  expect(cleans).toHaveLength(2);
  expect(cleans[0]!.body).toEqual({ retirementId: expect.any(String), processes: 0 });
  expect(cleans[1]!.body).toEqual(cleans[0]!.body);
  expect(posts.findIndex(post => post.path === "client-lease")).toBeGreaterThan(posts.findIndex(post => post.path === "execution-leases/boot-clean"));
  contexts.dispose();

  const dirty = new ExecutionContexts({ post: async (path, body) => { posts.push({ path, body }); if (path === "execution-leases/boot-clean") throw Object.assign(new Error("no"), { status: 409 }); return lease; } });
  dirty.clean(async () => 2);
  posts.length = 0;
  await expect(dirty.clientLease({ clientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestId: "r", operation: "file.write" })).rejects.toThrow();
  await expect(dirty.ready()).rejects.toThrow();
  expect(posts.map(post => post.path)).toEqual(["execution-leases/boot-clean"]);
  expect(posts[0]!.body).toMatchObject({ processes: 2 });
  dirty.dispose();
});

it("keeps an open connection's client context alive by renewal for as long as it is open, and stops when it is released", async () => {
  let now = 1_000_000;
  const batches: string[][] = [];
  const contexts = new ExecutionContexts({ now: () => now, post: async (path, body: any) => {
    if (path !== "execution-leases/renew") throw new Error(path);
    batches.push(body.contextIds);
    return { leases: body.contextIds.map((contextId: string) => ({ contextId, expiresAt: now + 30_000 })) };
  } });
  const client = "66666666-6666-4666-8666-666666666666", person = "44444444-4444-4444-8444-444444444444";
  contexts.adopt(client, person);
  expect(contexts.userOf(client)).toBe(person);
  for (let elapsed = 0; elapsed < 120_000; elapsed += 10_000) { now += 10_000; await contexts.renew(); }
  expect(contexts.live(client)).toBe(true);
  expect(batches.every(batch => batch.includes(client))).toBe(true);
  const before = batches.length;
  contexts.release(client);
  now += 10_000; await contexts.renew();
  expect(batches.slice(before).flat()).not.toContain(client);
  expect(contexts.live(client)).toBe(false);
  contexts.dispose();
});

it("sends the legacy material outcome with the clean-boot attestation, and grants nothing when cleanup was refused", async () => {
  const posts: Array<{ path: string; body: any }> = [];
  const lease = { contextId: "66666666-6666-4666-8666-666666666666", userId: "44444444-4444-4444-8444-444444444444", expiresAt: Date.now() + 30_000, gitIdentity: null };
  const contexts = new ExecutionContexts({ post: async (path, body) => { posts.push({ path, body }); return path === "execution-leases/boot-clean" ? { retired: 0 } : lease; } });
  await contexts.clean(async () => ({ processes: 0, legacyMaterial: "removed" }));
  expect(posts[0]).toEqual({ path: "execution-leases/boot-clean", body: { retirementId: expect.any(String), processes: 0, legacyMaterial: "removed" } });
  contexts.dispose();
  const refused = new ExecutionContexts({ post: async (path, body) => { posts.push({ path, body }); if (path === "execution-leases/boot-clean") return { retired: 0 }; return lease; } });
  posts.length = 0;
  await expect(refused.clean(async () => ({ processes: 0, legacyMaterial: "refused" }))).rejects.toThrow();
  await expect(refused.clientLease({ clientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestId: "r", operation: "file.write" })).rejects.toThrow();
  expect(posts.map(post => post.path)).toEqual(["execution-leases/boot-clean"]);
  refused.dispose();
});

it("carries the refused classes with the clean-boot attestation, once each and sorted, and nothing when there are none", async () => {
  const posts: Array<{ path: string; body: any }> = [];
  const make = () => new ExecutionContexts({ post: async (path, body) => { posts.push({ path, body }); return { retired: 0 }; } });
  const refused = make();
  await expect(refused.clean(async () => ({ processes: 1, legacyMaterial: "refused", refusals: ["seed_target_modified", "cgroup_unreadable", "seed_target_modified"] }))).rejects.toThrow();
  expect(posts[0]!.body).toEqual({ retirementId: expect.any(String), processes: 1, legacyMaterial: "refused", refusals: ["cgroup_unreadable", "seed_target_modified"] });
  refused.dispose();
  posts.length = 0;
  const clean = make();
  await clean.clean(async () => ({ processes: 0, legacyMaterial: "none", refusals: [] }));
  expect(posts[0]!.body).toEqual({ retirementId: expect.any(String), processes: 0, legacyMaterial: "none" });
  clean.dispose();
});

it("never posts a boot-clean body the shared schema would refuse: an inconsistent proof goes as refused io_error", async () => {
  const { CloudV2BootCleanRequestSchema } = await import("@zeros/protocol/cloud-v2-relay");
  const posts: Array<{ path: string; body: any }> = [];
  const contexts = new ExecutionContexts({ post: async (path, body) => { posts.push({ path, body }); return { retired: 0 }; } });
  // A clean result that names a class is inconsistent (J-S2): it goes as unproven, refused material instead.
  await expect(contexts.clean(async () => ({ processes: 0, legacyMaterial: "none", refusals: ["survivors"] }))).rejects.toThrow();
  expect(CloudV2BootCleanRequestSchema.safeParse(posts[0]!.body).success).toBe(true);
  expect(posts[0]!.body).toMatchObject({ legacyMaterial: "refused", refusals: ["io_error"] });
  contexts.dispose();
});
