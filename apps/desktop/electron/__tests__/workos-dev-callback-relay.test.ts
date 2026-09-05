import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../secret-store", () => ({
  createSecretIfAbsent: vi.fn(),
  getSecret: vi.fn(),
  replaceSecretIfUnchanged: vi.fn(),
  watchSecrets: vi.fn(),
}));

import { WorkOSDevCallbackRelay } from "../workos-dev-callback-relay";

function sharedStore() {
  let raw: string | null = null;
  const listeners = new Set<(keys: readonly string[]) => void>();
  const notify = () => {
    queueMicrotask(() => {
      for (const listener of listeners) listener(["auth-workos:dev-callbacks"]);
    });
  };
  return {
    read: () => raw,
    create: (_key: string, value: string) => {
      if (raw !== null) return false;
      raw = value;
      notify();
      return true;
    },
    replace: (_key: string, expected: string, value: string | null) => {
      if (raw !== expected) return false;
      raw = value;
      notify();
      return true;
    },
    watch: (listener: (keys: readonly string[]) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const state = (character: string) => `zeros-dev.${character.repeat(43)}`;
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe("shared Dev WorkOS callback routing", () => {
  it("routes a callback received by a sibling to the initiating process exactly once", async () => {
    const store = sharedStore();
    const initiator = new WorkOSDevCallbackRelay(store);
    const sibling = new WorkOSDevCallbackRelay(store);
    const accept = vi.fn(() => true);
    disposers.push(initiator.register(state("a"), Date.now() + 60_000, accept));
    const callback = { state: state("a"), code: "pkce-bound-code" };
    expect(sibling.deliver(callback)).toBe(true);
    await vi.waitFor(() => expect(accept).toHaveBeenCalledWith(callback));
    expect(accept).toHaveBeenCalledTimes(1);
    expect(sibling.deliver(callback)).toBe(false);
    expect(store.read()).not.toContain("pkce-bound-code");
  });

  it("keeps concurrent attempts independent and cancellation rejects a late callback", async () => {
    const store = sharedStore();
    const first = new WorkOSDevCallbackRelay(store);
    const second = new WorkOSDevCallbackRelay(store);
    const acceptFirst = vi.fn(() => true);
    const acceptSecond = vi.fn(() => true);
    const cancel = first.register(state("a"), Date.now() + 60_000, acceptFirst);
    disposers.push(
      cancel,
      second.register(state("b"), Date.now() + 60_000, acceptSecond),
    );
    cancel();
    expect(first.deliver({ state: state("a"), code: "late" })).toBe(false);
    expect(first.deliver({ state: state("b"), code: "second" })).toBe(true);
    await vi.waitFor(() => expect(acceptSecond).toHaveBeenCalledTimes(1));
    expect(acceptFirst).not.toHaveBeenCalled();
  });

  it("rejects unsolicited, foreign-channel, expired, and oversized callbacks", () => {
    let now = Date.now();
    const store = sharedStore();
    const relay = new WorkOSDevCallbackRelay(store, () => now);
    disposers.push(relay.register(state("a"), now + 100, () => true));
    expect(relay.deliver({ state: state("b"), code: "unknown" })).toBe(false);
    expect(
      relay.deliver({
        state: state("a").replace("zeros-dev", "zeros-alpha"),
        code: "foreign",
      }),
    ).toBe(false);
    expect(relay.deliver({ state: state("a"), code: "x".repeat(8_193) })).toBe(
      false,
    );
    now += 101;
    expect(relay.deliver({ state: state("a"), code: "expired" })).toBe(false);
  });

  it("stores only bounded callback routing material, never the PKCE verifier", () => {
    const store = sharedStore();
    const relay = new WorkOSDevCallbackRelay(store);
    for (const character of "abcdefgh") {
      disposers.push(
        relay.register(state(character), Date.now() + 60_000, () => true),
      );
    }
    expect(() =>
      relay.register(state("i"), Date.now() + 60_000, () => true),
    ).toThrow(/pending/i);
    expect(JSON.parse(store.read()!).entries).toHaveLength(8);
    expect(store.read()).not.toMatch(/verifier|accessToken|refreshToken/);
  });
});
