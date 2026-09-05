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
    seed: (value: string) => {
      raw = value;
    },
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
  it.each(["{", JSON.stringify({ version: 1, entries: {} })])(
    "recovers malformed routing data using compare-and-swap",
    (raw) => {
      const store = sharedStore();
      store.seed(raw);
      const relay = new WorkOSDevCallbackRelay(store);
      disposers.push(
        relay.register(state("a"), Date.now() + 60_000, () => true),
      );
      expect(
        JSON.parse(store.read()!).entries.map(
          (entry: { state: string }) => entry.state,
        ),
      ).toEqual([state("a")]);
    },
  );

  it("preserves a sibling replacement raced against corruption recovery", () => {
    const store = sharedStore();
    store.seed("{");
    const expiresAt = Date.now() + 60_000;
    const replace = store.replace;
    vi.spyOn(store, "replace")
      .mockImplementationOnce(() => {
        store.seed(
          JSON.stringify({
            version: 1,
            entries: [{ state: state("b"), expiresAt, callback: null }],
          }),
        );
        return false;
      })
      .mockImplementation(replace);
    const relay = new WorkOSDevCallbackRelay(store);
    disposers.push(relay.register(state("a"), expiresAt, () => true));
    expect(
      JSON.parse(store.read()!).entries.map(
        (entry: { state: string }) => entry.state,
      ),
    ).toEqual([state("b"), state("a")]);
  });

  it("preserves newer schemas without downgrading their pending callbacks", () => {
    const store = sharedStore();
    const raw = JSON.stringify({
      version: 2,
      entries: [{ state: state("b"), future: "opaque" }],
    });
    store.seed(raw);
    const relay = new WorkOSDevCallbackRelay(store);
    expect(() =>
      relay.register(state("a"), Date.now() + 60_000, () => true),
    ).toThrow(/newer version/i);
    expect(relay.deliver({ state: state("b"), code: "callback" })).toBe(false);
    expect(store.read()).toBe(raw);
  });

  it("drops corrupt entries while preserving valid longer-lived sibling records", () => {
    const store = sharedStore();
    const sibling = {
      state: state("b"),
      expiresAt: Date.now() + 24 * 60 * 60_000,
      callback: null,
    };
    store.seed(
      JSON.stringify({ version: 1, entries: [{ state: "invalid" }, sibling] }),
    );
    const relay = new WorkOSDevCallbackRelay(store);
    disposers.push(relay.register(state("a"), Date.now() + 60_000, () => true));
    expect(JSON.parse(store.read()!).entries).toEqual([
      sibling,
      expect.objectContaining({ state: state("a") }),
    ]);
  });

  it("does not erase valid records that exceed this version's registration limit", () => {
    const store = sharedStore();
    const raw = JSON.stringify({
      version: 1,
      entries: [..."abcdefghi"].map((character) => ({
        state: state(character),
        expiresAt: Date.now() + 60_000,
        callback: null,
      })),
    });
    store.seed(raw);
    const relay = new WorkOSDevCallbackRelay(store);
    expect(() =>
      relay.register(state("j"), Date.now() + 60_000, () => true),
    ).toThrow(/too many/i);
    expect(store.read()).toBe(raw);
  });

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
