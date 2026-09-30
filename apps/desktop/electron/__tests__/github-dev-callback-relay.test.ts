import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../secret-store", () => ({
  createSecretIfAbsent: vi.fn(), getSecret: vi.fn(),
  replaceSecretIfUnchanged: vi.fn(), watchSecrets: vi.fn(),
}));

import { GithubDevCallbackRelay, GithubDevPendingHandoff } from "../github-dev-callback-relay";

function sharedStore() {
  let raw: string | null = null;
  const watchers = new Set<(keys: readonly string[]) => void>();
  const notify = () => queueMicrotask(() => {
    for (const watcher of watchers) watcher(["github-app:dev-callbacks"]);
  });
  return {
    read: () => raw,
    create: (_key: string, next: string) => {
      if (raw !== null) return false;
      raw = next; notify(); return true;
    },
    replace: (_key: string, before: string, next: string | null) => {
      if (raw !== before) return false;
      raw = next; notify(); return true;
    },
    watch: (fn: (keys: readonly string[]) => void) => {
      watchers.add(fn); return () => { watchers.delete(fn); };
    },
  };
}
const disposers: Array<() => void> = [];
afterEach(() => { disposers.splice(0).forEach(stop => stop()); vi.useRealTimers(); });
const nonce = (value: string) => value.repeat(43);

describe("GitHub callbacks across isolated Dev instances", () => {
  it("keeps pending accounts private to each initiating process", async () => {
    const store = sharedStore(), aRelay = new GithubDevCallbackRelay(store), bRelay = new GithubDevCallbackRelay(store);
    const completedA = vi.fn(), completedB = vi.fn();
    const a = new GithubDevPendingHandoff(aRelay, callback => completedA(a.consume(callback.nonce)));
    const b = new GithubDevPendingHandoff(bRelay, callback => completedB(b.consume(callback.nonce)));
    disposers.push(() => a.clear(), () => b.clear());
    a.save({ nonce: nonce("a"), expiresAtMs: Date.now() + 60_000, ownerSub: "account-a", preserveSelectedMethod: true });
    b.save({ nonce: nonce("b"), expiresAtMs: Date.now() + 60_000, ownerSub: "account-b" });
    expect(store.read()).not.toContain("account-");
    expect(bRelay.deliver({ nonce: nonce("a") })).toBe(true);
    await Promise.resolve();
    expect(completedA).toHaveBeenCalledExactlyOnceWith({ status: "consumed", ownerSub: "account-a", preserveSelectedMethod: true });
    expect(completedB).not.toHaveBeenCalled();
    expect(b.consume(nonce("a"))).toEqual({ status: "mismatch" });
    expect(aRelay.deliver({ nonce: nonce("b") })).toBe(true);
    await Promise.resolve();
    expect(completedB).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: "account-b" }));
    expect(a.consume(nonce("a"))).toEqual({ status: "missing" });
  });

  it("rolls back registration when observing the callback store fails", () => {
    const store = sharedStore();
    vi.spyOn(store, "watch").mockImplementation(() => { throw new Error("watch unavailable"); });
    const relay = new GithubDevCallbackRelay(store);
    expect(() => relay.register(nonce("a"), Date.now() + 60_000, () => true)).toThrow("watch unavailable");
    expect(relay.deliver({ nonce: nonce("a") })).toBe(false);
  });

  it("routes a callback received by B only to initiating instance A", async () => {
    const store = sharedStore(), a = new GithubDevCallbackRelay(store), b = new GithubDevCallbackRelay(store);
    const acceptA = vi.fn(() => true), acceptB = vi.fn(() => true);
    disposers.push(a.register(nonce("a"), Date.now() + 60_000, acceptA));
    disposers.push(b.register(nonce("b"), Date.now() + 60_000, acceptB));
    expect(b.deliver({ nonce: nonce("a") })).toBe(true);
    await Promise.resolve();
    expect(acceptA).toHaveBeenCalledExactlyOnceWith({ nonce: nonce("a") });
    expect(acceptB).not.toHaveBeenCalled();
    expect(b.deliver({ nonce: nonce("a") })).toBe(false);
    expect(a.deliver({ nonce: nonce("b") })).toBe(true);
    await Promise.resolve();
    expect(acceptB).toHaveBeenCalledOnce();
  });

  it("cancel removes only its own attempt and never invokes a sibling", async () => {
    const store = sharedStore(), relay = new GithubDevCallbackRelay(store), accept = vi.fn(() => true);
    const cancel = relay.register(nonce("a"), Date.now() + 60_000, accept);
    disposers.push(cancel, relay.register(nonce("b"), Date.now() + 60_000, () => true));
    cancel();
    expect(relay.deliver({ nonce: nonce("a") })).toBe(false);
    expect(relay.deliver({ nonce: nonce("b") })).toBe(true);
    await Promise.resolve();
    expect(accept).not.toHaveBeenCalled();
  });

  it("rejects expired, unsolicited and malformed callbacks without persisting them", () => {
    vi.useFakeTimers();
    const store = sharedStore(), relay = new GithubDevCallbackRelay(store), accept = vi.fn(() => true);
    disposers.push(relay.register(nonce("a"), Date.now() + 1_000, accept));
    vi.advanceTimersByTime(1_000);
    expect(relay.deliver({ nonce: nonce("a") })).toBe(false);
    expect(relay.deliver({ nonce: nonce("b") })).toBe(false);
    expect(relay.deliver({ nonce: null })).toBe(false);
    expect(relay.deliver({ nonce: "short" })).toBe(false);
    expect(accept).not.toHaveBeenCalled();
  });

  it("relays bounded error tags without putting arbitrary provider text in storage", async () => {
    const store = sharedStore(), relay = new GithubDevCallbackRelay(store), accept = vi.fn(() => true);
    disposers.push(relay.register(nonce("a"), Date.now() + 60_000, accept));
    expect(relay.deliver({ nonce: nonce("a"), error: "untrusted provider detail" })).toBe(true);
    expect(store.read()).not.toContain("untrusted");
    await Promise.resolve();
    expect(accept).toHaveBeenCalledExactlyOnceWith({ nonce: nonce("a"), error: "oauth_failed" });
  });
});
