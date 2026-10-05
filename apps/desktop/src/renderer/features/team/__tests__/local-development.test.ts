import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  local: true,
  selection: "org_previous",
  me: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("../../../platform/runtime", () => ({
  isLocalDevelopment: () => mocks.local,
  isNativeRuntime: () => true,
  nativeInvoke: mocks.invoke,
}));
vi.mock("../../../platform/settings", () => ({
  getSetting: (_: string, fallback: unknown) => fallback,
  getSettingMigrated: (_: string, __: string, fallback: unknown) =>
    mocks.selection ?? fallback,
  setSetting: () => true,
}));
vi.mock("../control-plane", () => ({
  CONTROL_PLANE_URL: "https://backend.example.test",
  controlPlane: { me: mocks.me },
  ControlPlaneError: Error,
}));
vi.mock("../team-sync", () => ({ requestTeamResync: vi.fn() }));

describe("Local without an account", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.local = true;
    mocks.me.mockReset();
    mocks.invoke.mockReset();
  });

  it("selects the existing Personal key synchronously despite a stale collaborative selection", async () => {
    const active = await import("../active-team");
    const store = await import("../team-store");
    expect(active.getActiveTeamId()).toBe("local-personal");
    expect(active.getActiveOrganizationIsPersonalHint()).toBe(true);
    expect(store.getActiveOrganizationIdSnapshot()).toBeNull();
    expect(store.getActiveOrganizationSnapshot()?.isPersonal).toBe(true);
  });

  it("does not read the account or fetch organizations even with an inherited backend URL", async () => {
    const store = await import("../team-store");
    const auth = await import("../../auth/auth-store");
    expect(await store.refreshTeams()).toBeNull();
    expect(await auth.getSession()).toBeNull();
    expect(mocks.me).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(store.getTeamStoreState().me).toBeNull();
  });

  it("retains the ordinary Dev selection", async () => {
    mocks.local = false;
    const active = await import("../active-team");
    expect(active.getActiveTeamId()).toBe("org_previous");
  });

  it("stops renderer hosted fetch and analytics before native auth or network work", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const { controlPlaneFetch } =
        await import("../../update/control-plane-fetch");
      await expect(
        controlPlaneFetch("https://backend.example.test/v1/me"),
      ).rejects.toThrow("Zeros Local");
      const { initAnalytics } =
        await import("../../../platform/observability/analytics/posthog");
      await initAnalytics();
      expect(fetch).not.toHaveBeenCalled();
      expect(mocks.invoke).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
