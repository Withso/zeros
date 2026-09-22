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
  it("retires the old direct-folder setting without disturbing other preferences", async () => {
    const backing = installLocalStorageStub();
    backing.set(
      "zeros.experimentalFeatures",
      JSON.stringify({ workInLocalMain: true, terminalAgents: true }),
    );
    const store = await freshStore();
    expect(store.isExperimentalEnabled("terminalAgents")).toBe(true);
    store.setExperimentalEnabled("hideArchivedWorkspacesAfter15Days", true);
    expect(JSON.parse(backing.get("zeros.experimentalFeatures")!)).toEqual({
      terminalAgents: true,
      hideArchivedWorkspacesAfter15Days: true,
    });
  });

  it("defaults every flag off, flips on, and persists to localStorage", async () => {
    const backing = installLocalStorageStub();
    const store = await freshStore();
    expect(
      store.isExperimentalEnabled("hideArchivedWorkspacesAfter15Days"),
    ).toBe(false);

    store.setExperimentalEnabled("hideArchivedWorkspacesAfter15Days", true);
    expect(
      store.isExperimentalEnabled("hideArchivedWorkspacesAfter15Days"),
    ).toBe(true);
    expect(backing.get("zeros.experimentalFeatures")).toBe(
      JSON.stringify({ hideArchivedWorkspacesAfter15Days: true }),
    );

    store.setExperimentalEnabled("hideArchivedWorkspacesAfter15Days", false);
    expect(
      store.isExperimentalEnabled("hideArchivedWorkspacesAfter15Days"),
    ).toBe(false);
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
    expect(
      store.isExperimentalEnabled("hideArchivedWorkspacesAfter15Days"),
    ).toBe(false);
  });

  it("flips one flag without disturbing the others", async () => {
    const backing = installLocalStorageStub();
    backing.set(
      "zeros.experimentalFeatures",
      JSON.stringify({ terminalAgents: true }),
    );
    const store = await freshStore();

    store.setExperimentalEnabled("hideArchivedWorkspacesAfter15Days", true);
    expect(store.isExperimentalEnabled("terminalAgents")).toBe(true);
    expect(backing.get("zeros.experimentalFeatures")).toBe(
      JSON.stringify({
        terminalAgents: true,
        hideArchivedWorkspacesAfter15Days: true,
      }),
    );
  });

  it("rehydrates a persisted flag and ignores corrupt payloads", async () => {
    const backing = installLocalStorageStub();
    backing.set(
      "zeros.experimentalFeatures",
      JSON.stringify({ hideArchivedWorkspacesAfter15Days: true }),
    );
    let store = await freshStore();
    expect(
      store.isExperimentalEnabled("hideArchivedWorkspacesAfter15Days"),
    ).toBe(true);

    backing.set("zeros.experimentalFeatures", "not-json{{");
    store = await freshStore();
    expect(
      store.isExperimentalEnabled("hideArchivedWorkspacesAfter15Days"),
    ).toBe(false);
  });

  it("degrades to off when localStorage is unavailable", async () => {
    // No stub installed — the node env genuinely lacks localStorage.
    const store = await freshStore();
    expect(
      store.isExperimentalEnabled("hideArchivedWorkspacesAfter15Days"),
    ).toBe(false);
    expect(() =>
      store.setExperimentalEnabled("hideArchivedWorkspacesAfter15Days", true),
    ).not.toThrow();
  });
});
