import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Me } from "../../team/control-plane";

type Store = typeof import("../internal-features");

// Create the store before the hoisted mock factory reads it.
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

function signedInAs(
  staffRole: "platform_owner" | "developer" | "support_admin" | null,
): void {
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

// Signed out, control plane unconfigured, and first fetch in flight all use a null snapshot.
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
  it("exposes local Internal controls in the native account-free development app", async () => {
    installLocalStorageStub();
    vi.stubGlobal("window", { __ZEROS_NATIVE__: { localDevelopment: true }, addEventListener: vi.fn() });
    const store = await freshStore();
    expect(store.isInternalUser()).toBe(true);
    for (const feature of ["copyLogs", "zerosBrowser", "computerUse", "simulators"] as const) {
      expect(store.isInternalFeatureActive(feature)).toBe(true);
      store.setInternalFeatureEnabled(feature, false);
      expect(store.isInternalFeatureActive(feature)).toBe(false);
    }
    vi.stubGlobal("window", { __ZEROS_NATIVE__: {}, addEventListener: vi.fn() });
    expect(store.isInternalUser()).toBe(false);
  });

  it("enables every eligible Internal flag by default for authorized staff", async () => {
    installLocalStorageStub();
    const store = await freshStore();
    signedInAs("developer");
    for (const feature of ["copyLogs", "zerosBrowser", "computerUse", "simulators"] as const)
      expect(store.isInternalFeatureActive(feature)).toBe(true);
    signedOut();
    expect(store.isInternalFeatureActive("copyLogs")).toBe(false);
  });
  it("keeps the recorded Design canvas off until staff turn it on, and never for others", async () => {
    const backing = installLocalStorageStub();
    const store = await freshStore();
    signedInAs("developer");
    expect(store.isInternalFeatureEnabled("designGpuCanvas")).toBe(false);
    expect(store.isInternalFeatureActive("designGpuCanvas")).toBe(false);
    store.setInternalFeatureEnabled("designGpuCanvas", true);
    expect(store.isInternalFeatureActive("designGpuCanvas")).toBe(true);
    expect(JSON.parse(backing.get("zeros.internalFeatures")!)).toEqual({ designGpuCanvas: true });
    signedInAs(null);
    expect(store.isInternalFeatureActive("designGpuCanvas")).toBe(false);
  });
  it("is true for owners and developers, not a legacy support capability", async () => {
    const store = await freshStore();

    signedInAs("developer");
    expect(store.isInternalUser()).toBe(true);

    signedInAs("platform_owner");
    expect(store.isInternalUser()).toBe(true);

    signedInAs("support_admin");
    expect(store.isInternalUser()).toBe(false);

    signedInAs(null);
    expect(store.isInternalUser()).toBe(false);
  });

  it("fails closed for every unresolved state", async () => {
    const store = await freshStore();
    // Unknown identity must fail closed.
    signedOut();
    expect(store.isInternalUser()).toBe(false);
  });

  it("re-reads the role on every call rather than caching it", async () => {
    const store = await freshStore();
    signedInAs("developer");
    expect(store.isInternalUser()).toBe(true);
    // Sign-out must invalidate staff access before a new account can use this window.
    signedOut();
    expect(store.isInternalUser()).toBe(false);
  });
});

describe("internal feature flags", () => {
  it("defaults resource summary on only for internal users and preserves an opt-out", async () => {
    const backing = installLocalStorageStub();
    const store = await freshStore();
    expect(store.isInternalFeatureEnabled("resourceSummary")).toBe(true);
    for (const role of [null, "support_admin", "developer", "platform_owner"] as const) {
      signedInAs(role);
      expect(store.isInternalFeatureActive("resourceSummary")).toBe(
        role === "developer" || role === "platform_owner",
      );
    }
    signedOut();
    expect(store.isInternalFeatureActive("resourceSummary")).toBe(false);
    signedInAs("developer");
    store.setInternalFeatureEnabled("resourceSummary", false);
    expect(JSON.parse(backing.get("zeros.internalFeatures")!)).toEqual({ resourceSummary: false });
    expect((await freshStore()).isInternalFeatureActive("resourceSummary")).toBe(false);
  });

  it("reads the retired Cloud Computer key without granting access or losing other flags", async () => {
    const backing = installLocalStorageStub();
    backing.set("zeros.internalFeatures", JSON.stringify({ cloudComputerV2: true, copyLogs: true }));
    const store = await freshStore();
    for (const role of [null, "developer", "platform_owner", "support_admin"] as const) {
      signedInAs(role);
      expect(store.isInternalFeatureEnabled("cloudComputerV2" as never)).toBe(false);
      expect(store.isInternalFeatureActive("cloudComputerV2" as never)).toBe(false);
    }
    expect(store.isInternalFeatureEnabled("copyLogs")).toBe(true);
    store.setInternalFeatureEnabled("copyLogs", false);
    expect(JSON.parse(backing.get("zeros.internalFeatures")!)).toEqual({ cloudComputerV2: true, copyLogs: false });
  });
  it("starts staged agent control features on for staff only", async () => {
    const backing = installLocalStorageStub();
    const store = await freshStore();
    for (const feature of ["zerosBrowser", "computerUse", "simulators", "localOrchestration"] as const) {
      expect(store.isInternalFeatureEnabled(feature)).toBe(true);
      signedInAs("developer");
      expect(store.isInternalFeatureActive(feature)).toBe(true);
      signedInAs(null);
      expect(store.isInternalFeatureActive(feature)).toBe(false);
    }
    signedInAs("developer");
    store.setInternalFeatureEnabled("simulators", false);
    expect(store.isInternalFeatureActive("simulators")).toBe(false);
    expect(JSON.parse(backing.get("zeros.internalFeatures")!)).toEqual({
      simulators: false,
    });
  });
  it("defaults on, preserves explicit opt-outs, and persists to localStorage", async () => {
    const backing = installLocalStorageStub();
    const store = await freshStore();
    expect(store.isInternalFeatureEnabled("copyLogs")).toBe(true);

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
    expect(store.isInternalFeatureEnabled("copyLogs")).toBe(true);
  });

  it("retains defaults without granting access when localStorage is unavailable", async () => {
    // Leave localStorage unstubbed so this exercises the Node test environment without usable storage.
    const store = await freshStore();
    expect(store.isInternalFeatureEnabled("copyLogs")).toBe(true);
    expect(store.isInternalFeatureActive("copyLogs")).toBe(false);
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

    store.setInternalFeatureEnabled("copyLogs", false);
    expect(store.isInternalFeatureActive("copyLogs")).toBe(false);

    store.setInternalFeatureEnabled("copyLogs", true);
    expect(store.isInternalFeatureActive("copyLogs")).toBe(true);

    // User-editable storage can enable a flag, not grant a staff role.
    signedInAs(null);
    expect(store.isInternalFeatureActive("copyLogs")).toBe(false);

    signedOut();
    expect(store.isInternalFeatureActive("copyLogs")).toBe(false);
  });
});
