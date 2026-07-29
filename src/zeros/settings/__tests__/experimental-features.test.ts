import { beforeEach, describe, expect, it, vi } from "vitest";

type Store = typeof import("../experimental-features");

function installLocalStorageStub(): Map<string, string> {
  const backing = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
  });
  return backing;
}

/** The snapshot is module-scoped, so each case needs a fresh import to
 *  exercise the boot-time read of localStorage. */
async function freshStore(): Promise<Store> {
  vi.resetModules();
  return import("../experimental-features");
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("experimental feature flags", () => {
  it("defaults every flag off, flips on, and persists to localStorage", async () => {
    const backing = installLocalStorageStub();
    const store = await freshStore();
    expect(store.isExperimentalEnabled("workInLocalMain")).toBe(false);

    store.setExperimentalEnabled("workInLocalMain", true);
    expect(store.isExperimentalEnabled("workInLocalMain")).toBe(true);
    expect(backing.get("zeros.experimentalFeatures")).toBe(
      JSON.stringify({ workInLocalMain: true }),
    );

    store.setExperimentalEnabled("workInLocalMain", false);
    expect(store.isExperimentalEnabled("workInLocalMain")).toBe(false);
  });

  it("reads off for an existing user who only ever set another flag", async () => {
    // The rollout contract: widening the union must not turn a new flag on for
    // anyone. Every shipped install already holds a blob like this one.
    const backing = installLocalStorageStub();
    backing.set(
      "zeros.experimentalFeatures",
      JSON.stringify({ terminalAgents: true }),
    );
    const store = await freshStore();
    expect(store.isExperimentalEnabled("terminalAgents")).toBe(true);
    expect(store.isExperimentalEnabled("workInLocalMain")).toBe(false);
  });

  it("flips one flag without disturbing the others", async () => {
    const backing = installLocalStorageStub();
    backing.set(
      "zeros.experimentalFeatures",
      JSON.stringify({ terminalAgents: true }),
    );
    const store = await freshStore();

    store.setExperimentalEnabled("workInLocalMain", true);
    expect(store.isExperimentalEnabled("terminalAgents")).toBe(true);
    expect(backing.get("zeros.experimentalFeatures")).toBe(
      JSON.stringify({ terminalAgents: true, workInLocalMain: true }),
    );
  });

  it("rehydrates a persisted flag and ignores corrupt payloads", async () => {
    const backing = installLocalStorageStub();
    backing.set(
      "zeros.experimentalFeatures",
      JSON.stringify({ workInLocalMain: true }),
    );
    let store = await freshStore();
    expect(store.isExperimentalEnabled("workInLocalMain")).toBe(true);

    backing.set("zeros.experimentalFeatures", "not-json{{");
    store = await freshStore();
    expect(store.isExperimentalEnabled("workInLocalMain")).toBe(false);
  });

  it("degrades to off when localStorage is unavailable", async () => {
    // No stub installed — the node env genuinely lacks localStorage.
    const store = await freshStore();
    expect(store.isExperimentalEnabled("workInLocalMain")).toBe(false);
    expect(() =>
      store.setExperimentalEnabled("workInLocalMain", true),
    ).not.toThrow();
  });
});
