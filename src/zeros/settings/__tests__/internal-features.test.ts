// The store persists to localStorage at module scope, so each test group
// installs a fresh in-memory stub and re-imports the module
// (vi.resetModules) — mirroring how the renderer sees one snapshot per
// window. Node env has no localStorage; the module must also survive
// that (readPersisted try/catch), covered by the "no storage" case.
//
// Staff-ness is NOT resolved at module scope any more: it is read live from
// the team store's cached `/v1/me` on every call, so these tests mock that
// store and mutate its answer between assertions rather than stubbing an env
// var and re-importing.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Me } from "../../team/control-plane";

type Store = typeof import("../internal-features");

// vi.hoisted so the mock factory can close over this without tripping the TDZ
// (vi.mock is hoisted above the module body).
const teamStore = vi.hoisted(() => ({ me: null as unknown }));

vi.mock("../../team/team-store", () => {
  const snapshot = () => ({
    me: teamStore.me,
    status: "ready" as const,
    error: null,
  });
  return {
    getTeamStoreState: snapshot,
    useTeams: () => ({ ...snapshot(), reload: async () => teamStore.me }),
  };
});

/** Point the mocked store at a signed-in user with the given staff role. */
function signedInAs(staffRole: "developer" | null): void {
  teamStore.me = {
    user: {
      id: "00000000-0000-0000-0000-000000000001",
      email: "someone@example.test",
      displayName: null,
      staffRole,
    },
    teams: [],
  } satisfies Me;
}

/** Signed out, control plane unconfigured, or first fetch still in flight —
 *  all three present as a null `me`. */
function signedOut(): void {
  teamStore.me = null;
}

function installLocalStorageStub(): Map<string, string> {
  const backing = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
  });
  return backing;
}

async function freshStore(): Promise<Store> {
  vi.resetModules();
  return import("../internal-features");
}

beforeEach(() => {
  vi.unstubAllGlobals();
  signedOut();
});

describe("isInternalUser — the staff gate", () => {
  it("is true only when /v1/me reports a staff role", async () => {
    const store = await freshStore();

    signedInAs("developer");
    expect(store.isInternalUser()).toBe(true);

    signedInAs(null);
    expect(store.isInternalUser()).toBe(false);
  });

  it("fails closed for every unresolved state", async () => {
    const store = await freshStore();
    // Signed out, control plane unconfigured, or the fetch not yet landed.
    // "Not yet known" must read as "not internal", never the reverse.
    signedOut();
    expect(store.isInternalUser()).toBe(false);
  });

  it("re-reads the role on every call rather than caching it", async () => {
    const store = await freshStore();
    signedInAs("developer");
    expect(store.isInternalUser()).toBe(true);
    // Sign-out clears the team store; the very next call must reflect that,
    // or account A's staff role would leak into account B's session.
    signedOut();
    expect(store.isInternalUser()).toBe(false);
  });
});

describe("internal feature flags", () => {
  it("defaults off, flips on, and persists to localStorage", async () => {
    const backing = installLocalStorageStub();
    const store = await freshStore();
    expect(store.isInternalFeatureEnabled("copyLogs")).toBe(false);

    store.setInternalFeatureEnabled("copyLogs", true);
    expect(store.isInternalFeatureEnabled("copyLogs")).toBe(true);
    expect(backing.get("zeros.internalFeatures")).toBe(
      JSON.stringify({ copyLogs: true }),
    );

    store.setInternalFeatureEnabled("copyLogs", false);
    expect(store.isInternalFeatureEnabled("copyLogs")).toBe(false);
  });

  it("rehydrates a persisted flag and ignores corrupt payloads", async () => {
    const backing = installLocalStorageStub();
    backing.set("zeros.internalFeatures", JSON.stringify({ copyLogs: true }));
    let store = await freshStore();
    expect(store.isInternalFeatureEnabled("copyLogs")).toBe(true);

    backing.set("zeros.internalFeatures", "not-json{{");
    store = await freshStore();
    expect(store.isInternalFeatureEnabled("copyLogs")).toBe(false);
  });

  it("degrades to off when localStorage is unavailable", async () => {
    // No stub installed — node env genuinely lacks localStorage.
    const store = await freshStore();
    expect(store.isInternalFeatureEnabled("copyLogs")).toBe(false);
    // Writes must not throw either.
    expect(() =>
      store.setInternalFeatureEnabled("copyLogs", true),
    ).not.toThrow();
  });
});

describe("isInternalFeatureActive — the effective gate", () => {
  it("requires BOTH staff AND the flag", async () => {
    installLocalStorageStub();
    const store = await freshStore();
    signedInAs("developer");

    // Flag off: nobody, not even staff.
    expect(store.isInternalFeatureActive("copyLogs")).toBe(false);

    store.setInternalFeatureEnabled("copyLogs", true);
    expect(store.isInternalFeatureActive("copyLogs")).toBe(true);

    // A forged flag (localStorage is user-editable) still does nothing for an
    // ordinary account — this is the whole point of the second factor.
    signedInAs(null);
    expect(store.isInternalFeatureActive("copyLogs")).toBe(false);

    signedOut();
    expect(store.isInternalFeatureActive("copyLogs")).toBe(false);
  });
});
