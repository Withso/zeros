import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  requestTeamResync: vi.fn(),
}));

vi.mock("../control-plane", () => ({
  CONTROL_PLANE_URL: "https://api.example.test",
  ControlPlaneError: class ControlPlaneError extends Error {},
  controlPlane: { me: mocks.me },
}));

vi.mock("../team-sync", () => ({
  requestTeamResync: mocks.requestTeamResync,
}));

const storage = new Map<string, string>();
(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => void storage.set(key, value),
  removeItem: (key) => void storage.delete(key),
  clear: () => storage.clear(),
  key: (index) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
};

const { acceptOrganizationSnapshot, clearTeamStore, refreshTeams } =
  await import("../team-store");
const { getActiveTeamId, setActiveOrganizationSelection } =
  await import("../active-team");

describe("empty organization refresh", () => {
  beforeEach(() => {
    storage.clear();
    mocks.me.mockReset();
    clearTeamStore();
    mocks.requestTeamResync.mockReset();
  });

  it("re-couriers after a cache generation clear without an auth-status transition", () => {
    clearTeamStore();

    expect(mocks.requestTeamResync).toHaveBeenCalledTimes(1);
  });

  it("drops the durable owner at a real account boundary", () => {
    storage.set("team:active-id", JSON.stringify("org_account_a"));

    clearTeamStore({ resetSelection: true });

    expect(getActiveTeamId()).toBeNull();
  });

  it("explicitly re-couriers an empty context when selection reconciliation is a no-op", async () => {
    mocks.me.mockResolvedValue({
      user: {
        id: "user_1",
        email: "user@example.test",
        displayName: "User",
        staffRole: null,
      },
      organizations: [],
      teams: [],
    });

    await refreshTeams();

    expect(mocks.requestTeamResync).toHaveBeenCalledTimes(1);
  });

  it("retains the durable owner through a mixed-version empty snapshot", () => {
    setActiveOrganizationSelection("org_1", false);

    acceptOrganizationSnapshot({
      user: {
        id: "user_1",
        email: "user@example.test",
        displayName: "User",
        staffRole: null,
      },
      organizations: [],
      teams: [],
    });

    expect(getActiveTeamId()).toBe("org_1");
  });
});
