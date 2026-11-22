// Personal cloud under the device's Personal entry, through the real team store:
// keyed by the signed-in account's server Personal organization only, gone at
// once on sign-out or another account, and never shown under an organization.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, OrganizationSummary } from "../control-plane";

const flags = vi.hoisted(() => ({ unified: true }));
vi.mock("../control-plane", () => ({
  CONTROL_PLANE_URL: "https://api.example.test",
  ControlPlaneError: class ControlPlaneError extends Error {},
  controlPlane: { me: vi.fn() },
}));
vi.mock("../team-sync", () => ({ requestTeamResync: vi.fn() }));
vi.mock("../../../config/release-channel", async (original) => ({
  ...(await original<typeof import("../../../config/release-channel")>()),
  isFeatureEnabled: (feature: string) => feature === "unified-workspaces" ? flags.unified : true,
}));

const storage = new Map<string, string>();
(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
  getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => void storage.set(key, value),
  removeItem: (key) => void storage.delete(key), clear: () => storage.clear(),
  key: (index) => [...storage.keys()][index] ?? null, get length() { return storage.size; },
};

const { acceptOrganizationSnapshot, clearTeamStore, getActiveCloudOrganizationIdSnapshot, getActiveOrganizationSnapshot, getActiveOrganizationIdSnapshot } =
  await import("../team-store");
const { setActiveOrganizationSelection } = await import("../active-team");
const { filterProjectsForOrganization, filterRowsForOrganization, canCreateWorkspaceIn, cloudCreateSeatReason } = await import("../organization-capabilities");
const { cloudOrganizationFor } = await import("../personal-cloud");
const { normalizeOrganizationSummary, personalCloudOffer } = await import("../organization-summary");
const { PERSONAL_ORGANIZATION_ID } = await import("../personal-organization");

const A_PERSONAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B_PERSONAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
function account(user: string, personal: string, seat?: "pro" | "free", offered = true): Me {
  const rows = [
    { id: personal, slug: `personal-${user}`, name: user, role: "owner" as const, isPersonal: true, defaultTeamId: null,
      workspaceCapabilities: { local: true, cloud: offered }, teamCapabilities: { multiple: false, canCreate: false }, ...(seat ? { seat } : {}) },
    { id: ORG, slug: "acme", name: "Acme", role: "member" as const, isPersonal: false, defaultTeamId: null,
      workspaceCapabilities: { local: false, cloud: true }, teamCapabilities: { multiple: false, canCreate: false }, seat: "pro" as const },
  ];
  const organizations = rows.map(normalizeOrganizationSummary), personalCloud = personalCloudOffer(rows);
  return { user: { id: user, email: `${user}@example.test`, displayName: null, staffRole: null }, organizations, teams: organizations,
    ...(personalCloud ? { personalCloud } : {}) };
}
const cloudRow = (organizationId: string) => ({ path: `cloud://${organizationId}/dddddddd-dddd-4ddd-8ddd-dddddddddddd`, organizationId, placement: "cloud" as const });
const localRow = { path: "/Users/ada/project", organizationId: null, placement: "local" as const };
const project = (organizationId: string) => ({ repoRoot: `cloud://${organizationId}/dddddddd-dddd-4ddd-8ddd-dddddddddddd` });
const rows = () => [localRow, cloudRow(A_PERSONAL), cloudRow(B_PERSONAL), cloudRow(ORG)];
const active = () => getActiveOrganizationSnapshot() as OrganizationSummary;

beforeEach(() => {
  storage.clear();
  flags.unified = true;
  clearTeamStore({ resetSelection: true });
  setActiveOrganizationSelection(PERSONAL_ORGANIZATION_ID, true);
});

describe("Personal cloud under the Personal entry", () => {
  it("is keyed by the signed-in account's server Personal organization, with the persisted selection unchanged", () => {
    acceptOrganizationSnapshot(account("ada", A_PERSONAL, "pro"));
    expect(active().id).toBe(PERSONAL_ORGANIZATION_ID);
    expect(getActiveOrganizationIdSnapshot()).toBeNull();
    expect(getActiveCloudOrganizationIdSnapshot()).toBe(A_PERSONAL);
    expect(filterRowsForOrganization(rows(), active()).map(row => row.path)).toEqual([localRow.path, cloudRow(A_PERSONAL).path]);
    expect(filterProjectsForOrganization([project(A_PERSONAL), project(B_PERSONAL), project(ORG)], active()).map(row => row.repoRoot))
      .toEqual([project(A_PERSONAL).repoRoot]);
    expect(canCreateWorkspaceIn(active(), "cloud")).toBe(true);
    expect(getActiveOrganizationSnapshot()).toBe(active());
  });

  it("compares the server's id without regard to case: rows, projects and the active cloud id", () => {
    acceptOrganizationSnapshot(account("ada", A_PERSONAL.toUpperCase(), "pro"));
    expect(getActiveCloudOrganizationIdSnapshot()).toBe(A_PERSONAL);
    const upper = { ...cloudRow(A_PERSONAL), organizationId: A_PERSONAL.toUpperCase() };
    expect(filterRowsForOrganization([localRow, cloudRow(A_PERSONAL), upper, cloudRow(B_PERSONAL)], active()).map(row => row.organizationId))
      .toEqual([null, A_PERSONAL, A_PERSONAL.toUpperCase()]);
    expect(filterProjectsForOrganization([{ repoRoot: `cloud://${A_PERSONAL.toUpperCase()}/dddddddd-dddd-4ddd-8ddd-dddddddddddd` }, project(B_PERSONAL)], active()))
      .toHaveLength(1);
  });

  it("lists the rows without Pro but refuses Create with the one free-seat sentence", () => {
    acceptOrganizationSnapshot(account("ada", A_PERSONAL, "free"));
    expect(filterRowsForOrganization(rows(), active()).map(row => row.path)).toContain(cloudRow(A_PERSONAL).path);
    expect(canCreateWorkspaceIn(active(), "cloud")).toBe(false);
    expect(cloudCreateSeatReason(cloudOrganizationFor(active()))).toBe("Creating a cloud workspace requires Pro.");
  });

  it("is gone at once on sign-out and never follows into another account", () => {
    acceptOrganizationSnapshot(account("ada", A_PERSONAL, "pro"));
    expect(getActiveCloudOrganizationIdSnapshot()).toBe(A_PERSONAL);
    clearTeamStore({ resetSelection: true });
    setActiveOrganizationSelection(PERSONAL_ORGANIZATION_ID, true);
    expect(getActiveCloudOrganizationIdSnapshot()).toBeNull();
    expect(filterRowsForOrganization(rows(), active()).map(row => row.path)).toEqual([localRow.path]);
    // Another account on the same Mac: its own Personal cloud only, though A's Personal id is now known on this device.
    acceptOrganizationSnapshot(account("bo", B_PERSONAL, "pro"));
    expect(getActiveCloudOrganizationIdSnapshot()).toBe(B_PERSONAL);
    expect(filterRowsForOrganization(rows(), active()).map(row => row.path)).toEqual([localRow.path, cloudRow(B_PERSONAL).path]);
    expect(filterProjectsForOrganization([project(A_PERSONAL)], active())).toEqual([]);
  });

  it.each([
    ["unified-workspaces is off", () => { flags.unified = false; }, account("ada", A_PERSONAL, "pro")],
    ["the server's Personal row does not offer cloud", () => {}, account("ada", A_PERSONAL, undefined, false)],
  ] as const)("is exactly as before when %s", (_name, set, me) => {
    set();
    acceptOrganizationSnapshot(me);
    expect(active().cloudOrganization).toBeUndefined();
    expect(getActiveCloudOrganizationIdSnapshot()).toBeNull();
    expect(filterRowsForOrganization(rows(), active()).map(row => row.path)).toEqual([localRow.path]);
    expect(canCreateWorkspaceIn(active(), "cloud")).toBe(false);
  });

  it("is exactly as before signed out", () => {
    expect(getActiveCloudOrganizationIdSnapshot()).toBeNull();
    expect(filterRowsForOrganization(rows(), active()).map(row => row.path)).toEqual([localRow.path]);
    expect(canCreateWorkspaceIn(active(), "cloud")).toBe(false);
  });

  it("never shows Personal's cloud under an organization", () => {
    acceptOrganizationSnapshot(account("ada", A_PERSONAL, "pro"));
    setActiveOrganizationSelection(ORG, false);
    expect(getActiveCloudOrganizationIdSnapshot()).toBe(ORG);
    const shown = filterRowsForOrganization(rows(), active()).map(row => row.path);
    expect(shown).toContain(cloudRow(ORG).path);
    expect(shown).not.toContain(cloudRow(A_PERSONAL).path);
    expect(filterProjectsForOrganization([project(A_PERSONAL), project(ORG)], active()).map(row => row.repoRoot)).toEqual([project(ORG).repoRoot]);
  });
});
