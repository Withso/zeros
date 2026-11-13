// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ generation: 0 }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: async () => ({ access_token: "synthetic-session", user: { sub: "u" } }) }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => state.generation, getTeamStoreState: () => ({ me: null }), subscribeOrganizationSnapshots: () => () => {} }));
vi.mock("../../features/team/control-plane", () => ({ CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {} }));
import type { Workspace } from "../../platform/git";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { filterDashboardRowsBy, type DashboardRow } from "../../features/dashboard/dashboard-model";
import { readDashboardBy, resetDashboardPreferencesForTests, saveDashboardBy } from "../../features/dashboard/preferences";
import { creatorLookup } from "../cloud-workspace-creators";
import { loadOrganizationRoster, memberName, organizationRosterSnapshot, resetOrganizationRostersForTests } from "../organization-roster";

const org = "11111111-1111-4111-8111-111111111111", me = "33333333-3333-4333-8333-333333333333", alex = "44444444-4444-4444-8444-444444444444";
const cloudId = (n: number) => `2222222${n}-2222-4222-8222-222222222222`;
const row = (path: string): DashboardRow => ({ workspace: { id: path, path } as Workspace, project: null, repoName: "zeros", title: path, branch: "b", lastActiveAt: 0 });

beforeEach(() => { localStorage.clear(); resetDashboardPreferencesForTests(); resetOrganizationRostersForTests(); state.generation = 0; });
afterEach(() => vi.unstubAllGlobals());

describe("Home's By filter", () => {
  const local = row("/studio/a"), mine = row(cloudWorkspaceKey({ organizationId: org, workspaceId: cloudId(1) }));
  const alexs = row(cloudWorkspaceKey({ organizationId: org, workspaceId: cloudId(2) })), unknown = row(cloudWorkspaceKey({ organizationId: org, workspaceId: cloudId(3) }));
  const creatorOf = creatorLookup([{ id: cloudId(1), ownerUserId: me }, { id: cloudId(2), ownerUserId: alex }] as never);
  const rows = [local, mine, alexs, unknown];
  const by = (value: Parameters<typeof filterDashboardRowsBy>[1]) => filterDashboardRowsBy(rows, value, me, item => creatorOf(item.workspace));

  it("judges cloud rows by their current Creator; Local rows are always Me, and an unknown Creator matches no person", () => {
    expect(by("anyone")).toEqual(rows);
    expect(by("me")).toEqual([local, mine]);
    expect(by(`user:${alex}`)).toEqual([alexs]);
    expect(by(`user:${me}`)).toEqual([mine]);
  });

  it("3B: No Creator shows exactly the cloud rows whose Creator is gone, never a row still loading or a Local one, and is kept per organization", () => {
    const orphan = row(cloudWorkspaceKey({ organizationId: org, workspaceId: cloudId(4) }));
    const lookup = creatorLookup([{ id: cloudId(1), ownerUserId: me }, { id: cloudId(4), ownerUserId: null }] as never);
    const rowsWith = [local, mine, unknown, orphan];
    expect(filterDashboardRowsBy(rowsWith, "none", me, item => lookup(item.workspace))).toEqual([orphan]);
    expect(filterDashboardRowsBy(rowsWith, "me", me, item => lookup(item.workspace))).toEqual([local, mine]);
    saveDashboardBy(org, "none");
    resetDashboardPreferencesForTests();
    expect(readDashboardBy(org)).toBe("none");
  });

  it("keeps By per organization, in storage, and reads anything malformed as Anyone", () => {
    expect(readDashboardBy(org)).toBe("anyone");
    saveDashboardBy(org, `user:${alex}`);
    resetDashboardPreferencesForTests();
    expect(readDashboardBy(org)).toBe(`user:${alex}`);
    expect(readDashboardBy("99999999-9999-4999-8999-999999999999")).toBe("anyone");
    localStorage.setItem(`zeros:dashboard-by:v1:${org}`, "user:<script>");
    resetDashboardPreferencesForTests();
    expect(readDashboardBy(org)).toBe("anyone");
    expect(localStorage.getItem(`zeros:dashboard-by:v1:${org}`)).toBeNull();
    saveDashboardBy(org, "me");
    saveDashboardBy(org, "anyone");
    expect(localStorage.getItem(`zeros:dashboard-by:v1:${org}`)).toBeNull();
  });
});

describe("the organization roster", () => {
  it("shares one read per organization and account, names people from it, and drops a reply from a previous account", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls++; return Response.json({ members: [
      { id: alex, email: "alex@example.test", display_name: "Alex", avatar_url: "https://example.test/a.png", role: "member" },
      { id: me, email: "me@example.test", display_name: null, avatar_url: "javascript:alert(1)", role: "admin" }] }); }));
    await Promise.all([loadOrganizationRoster(org), loadOrganizationRoster(org)]);
    expect(calls).toBe(1);
    const roster = organizationRosterSnapshot(org);
    expect(roster).toEqual([{ id: alex, name: "Alex", avatarUrl: "https://example.test/a.png", role: "member" }, { id: me, name: "me", avatarUrl: null, role: "admin" }]);
    expect(memberName(roster, alex)).toBe("Alex");
    expect(memberName(roster, "55555555-5555-4555-8555-555555555555")).toBe("A teammate");
    const late = loadOrganizationRoster("66666666-6666-4666-8666-666666666666");
    state.generation = 1;
    await expect(late).rejects.toThrow();
    expect(organizationRosterSnapshot("66666666-6666-4666-8666-666666666666")).toBeNull();
    expect(organizationRosterSnapshot(org)).toBeNull();   // another account: not this roster
  });
});
