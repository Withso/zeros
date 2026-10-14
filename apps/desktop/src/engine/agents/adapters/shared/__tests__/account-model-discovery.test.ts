import { describe, expect, it, vi } from "vitest";
import { AccountModelDiscovery } from "../account-model-discovery";

const TTL = 15 * 60 * 1_000;
const model = (value: string) => ({ value, label: value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("account model discovery freshness", () => {
  it("installs the flight before a provider synchronously re-enters discovery", async () => {
    const cache = new AccountModelDiscovery(() => "account", { ttlMs: TTL });
    const state = cache.current(), duplicate = vi.fn(async () => [model("duplicate")]);
    let joined: Promise<void> | undefined;
    const work = cache.discover(state, () => {
      joined = cache.discover(state, duplicate);
      return Promise.resolve([model("current")]);
    });
    await Promise.all([work, joined]);
    expect(duplicate).not.toHaveBeenCalled();
    expect(state.models).toEqual([model("current")]);
  });
  it("honors an empty account catalog until the 15-minute expiry", async () => {
    let now = 0;
    const cache = new AccountModelDiscovery(() => "account", { ttlMs: TTL, now: () => now });
    const state = cache.current();
    const read = vi.fn(async () => []);
    await cache.discover(state, read);
    expect(state.models).toEqual([]);
    now = TTL - 1;
    await cache.discover(state, read);
    expect(read).toHaveBeenCalledTimes(1);
    now = TTL;
    await cache.discover(state, read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("retains the confirmed catalog while sharing one expired refresh", async () => {
    let now = 0;
    const cache = new AccountModelDiscovery(() => "account", { ttlMs: TTL, now: () => now });
    const state = cache.current();
    await cache.discover(state, async () => [model("first")]);
    const confirmed = state.models;
    now = TTL;
    const next = deferred<ReturnType<typeof model>[]>();
    const read = vi.fn(() => next.promise);
    const first = cache.discover(state, read);
    const second = cache.discover(state, read);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    expect(state.models).toBe(confirmed);
    next.resolve([model("second")]);
    await Promise.all([first, second]);
    expect(state.models).toEqual([model("second")]);
  });

  it("does not let a pre-rejection query overwrite the single replacement refresh", async () => {
    const cache = new AccountModelDiscovery(() => "account", { ttlMs: TTL });
    const state = cache.current();
    const old = deferred<ReturnType<typeof model>[]>();
    const original = cache.discover(state, () => old.promise);
    await Promise.resolve();
    cache.invalidate(state);
    const next = deferred<ReturnType<typeof model>[]>();
    const read = vi.fn(() => next.promise);
    const first = cache.discover(state, read);
    cache.invalidate(state);
    const second = cache.discover(state, read);
    expect(read).not.toHaveBeenCalled();
    old.resolve([model("rejected")]);
    await original;
    await Promise.resolve();
    expect(state.models).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    next.resolve([]);
    await Promise.all([first, second]);
    expect(state.models).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps a different account and a later return to the same key isolated", async () => {
    let identity = "a";
    const cache = new AccountModelDiscovery(() => identity, { ttlMs: TTL });
    const oldState = cache.current();
    const old = deferred<ReturnType<typeof model>[]>();
    const original = cache.discover(oldState, () => old.promise);
    identity = "b";
    await cache.discover(cache.current(), async () => [model("b")]);
    identity = "a";
    const current = cache.current();
    await cache.discover(current, async () => [model("a-new")]);
    old.resolve([model("a-old")]);
    await original;
    cache.invalidate(oldState);
    expect(cache.current()).toBe(current);
    expect(current.models).toEqual([model("a-new")]);
  });

  it("does not extend freshness on failure or hammer an unavailable provider", async () => {
    let now = 0;
    const cache = new AccountModelDiscovery(() => "account", { ttlMs: TTL, now: () => now });
    const state = cache.current();
    await cache.discover(state, async () => [model("first")]);
    now = TTL;
    const read = vi.fn(async () => { throw new Error("offline"); });
    await cache.discover(state, read);
    await cache.discover(state, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(state.models).toEqual([model("first")]);
    now += 30_000;
    await cache.discover(state, read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps the legacy no-TTL policy for adapters without a refresh policy", async () => {
    const cache = new AccountModelDiscovery(() => "account");
    const state = cache.current();
    const read = vi.fn(async () => [model("first")]);
    await cache.discover(state, read);
    await cache.discover(state, read);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps an empty legacy discovery eligible for the next Claude query", async () => {
    const cache = new AccountModelDiscovery(() => "account");
    const state = cache.current();
    const read = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([model("available")]);
    await cache.discover(state, read);
    expect(state.models).toBeUndefined();
    await cache.discover(state, read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(state.models).toEqual([model("available")]);
  });
});
