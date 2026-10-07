import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, OrganizationSummary } from "../control-plane";

const state = vi.hoisted(() => ({ me: null as Me | null }));
vi.mock("../team-store", () => ({
  getTeamStoreState: () => ({ me: state.me }),
  useTeams: () => ({ me: state.me }),
}));
import {
  cloudWorkspaceAccountAccess,
  hasCloudWorkspaceAccountAccess,
  useCloudWorkspaceAccountAccess,
} from "../cloud-workspace-account-access";

const organization = {
  id: "11111111-1111-4111-8111-111111111111",
  isPersonal: false,
  role: "member",
  workspaceCapabilities: { local: false, cloud: true },
} as OrganizationSummary;
function account(organizations = [organization]): Me {
  return {
    user: { id: "nonstaff-member", email: "fixture@example.test", displayName: null, staffRole: null },
    organizations,
    teams: organizations,
  };
}
function readHook() {
  let allowed = false;
  function Probe() {
    allowed = useCloudWorkspaceAccountAccess(organization.id);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return allowed;
}
beforeEach(() => { state.me = account(); });

describe("Cloud workspace account admission after rollout", () => {
  it("admits a nonstaff member without reading or setting a preference", () => {
    expect(hasCloudWorkspaceAccountAccess(organization.id)).toBe(true);
    expect(readHook()).toBe(true);
  });
  it("denies signed-out and cold accounts synchronously", () => {
    state.me = null;
    expect(hasCloudWorkspaceAccountAccess()).toBe(false);
    expect(hasCloudWorkspaceAccountAccess(organization.id)).toBe(false);
    expect(readHook()).toBe(false);
  });
  it("uses the target organization, never another organization's entitlement", () => {
    state.me = account([
      { ...organization, workspaceCapabilities: { local: false, cloud: false } },
      { ...organization, id: "22222222-2222-4222-8222-222222222222" },
    ]);
    expect(hasCloudWorkspaceAccountAccess(organization.id)).toBe(false);
    expect(readHook()).toBe(false);
    expect(hasCloudWorkspaceAccountAccess("22222222-2222-4222-8222-222222222222")).toBe(true);
  });
  it("keeps server-granted guests eligible for separate exact-document capability checks", () => {
    state.me = account([]);
    expect(hasCloudWorkspaceAccountAccess(organization.id)).toBe(true);
  });
  it("never treats a Personal owner as Cloud, even with a malformed entitlement", () => {
    state.me = account([{ ...organization, isPersonal: true }]);
    expect(cloudWorkspaceAccountAccess(state.me, organization.id)).toBe(false);
  });
  it("observes entitlement revocation and account replacement on the next read", () => {
    expect(readHook()).toBe(true);
    state.me = account([{ ...organization, workspaceCapabilities: { local: false, cloud: false } }]);
    expect(readHook()).toBe(false);
    state.me = null;
    expect(readHook()).toBe(false);
  });
});
