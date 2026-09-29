import { describe, expect, it } from "vitest";
import {
  canCreateWorkspaceIn,
  filterRowsForOrganization,
  filterProjectsForOrganization,
  localWorkspaceOwner,
} from "../organization-capabilities";
import type { OrganizationSummary } from "../control-plane";

function organization(
  overrides: Partial<OrganizationSummary> = {},
): OrganizationSummary {
  return {
    id: "org_1",
    slug: "acme",
    name: "Acme",
    logo: null,
    role: "owner",
    isPersonal: false,
    defaultTeamId: "team_1",
    workspaceCapabilities: { local: true, cloud: true },
    teamCapabilities: { multiple: false, canCreate: false },
    ...overrides,
  };
}

describe("organization workspace capabilities", () => {
  it("keeps cloud repositories out of Local and local paths out of organizations, including membership refresh", () => {
    const orgId = "11111111-1111-4111-8111-111111111111";
    const cloud = {repoRoot:`cloud://${orgId}/22222222-2222-4222-8222-222222222222`};
    const local = {repoRoot:"/local/project"};
    const other = {repoRoot:"cloud://33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444"};
    const malformed = {repoRoot:"cloud://invalid"};
    const rows = [local,cloud,other,malformed];
    expect(filterProjectsForOrganization(rows,null)).toEqual([local]);
    expect(filterProjectsForOrganization(rows,organization({isPersonal:true}))).toEqual([local]);
    expect(filterProjectsForOrganization(rows,organization({id:orgId}))).toEqual([cloud]);
    expect(filterProjectsForOrganization(rows,null,orgId)).toEqual([cloud]);
    const locals=[local];expect(filterProjectsForOrganization(locals,null)).toBe(locals);
    const clouds=[cloud];expect(filterProjectsForOrganization(clouds,organization({id:orgId}))).toBe(clouds);
  });
  it("allows local workspaces only in Personal, including signed-out use", () => {
    expect(canCreateWorkspaceIn(null, "local")).toBe(true);
    expect(
      canCreateWorkspaceIn(
        organization({
          isPersonal: true,
          workspaceCapabilities: { local: true, cloud: false },
        }),
        "local",
      ),
    ).toBe(true);
    expect(canCreateWorkspaceIn(organization(), "local")).toBe(false);
  });

  it("never allows Personal to create a cloud workspace", () => {
    expect(
      canCreateWorkspaceIn(
        organization({
          isPersonal: true,
          workspaceCapabilities: { local: true, cloud: false },
        }),
        "cloud",
      ),
    ).toBe(false);
  });

  it("requires the collaborative organization's server capability for cloud", () => {
    expect(canCreateWorkspaceIn(organization(), "cloud")).toBe(true);
    expect(
      canCreateWorkspaceIn(
        organization({
          workspaceCapabilities: { local: true, cloud: false },
        }),
        "cloud",
      ),
    ).toBe(false);
    expect(canCreateWorkspaceIn(null, "cloud")).toBe(false);
  });

  it("rejects organization local creation even while membership revalidates", () => {
    expect(() => localWorkspaceOwner(organization())).toThrow(/cloud/i);
    expect(localWorkspaceOwner(null)).toEqual({
      organizationId: null,
      placement: "local",
    });
    expect(() => localWorkspaceOwner(null, "org_confirmed")).toThrow(/cloud/i);
  });

  it("never stamps Personal workspaces with a signed-in account's organization", () => {
    for (const id of ["personal_account_a", "personal_account_b"]) {
      expect(
        localWorkspaceOwner(organization({ id, isPersonal: true })),
      ).toEqual({
        organizationId: null,
        placement: "local",
      });
    }
  });

  it("never treats the device Personal selection as a cloud organization id", () => {
    expect(localWorkspaceOwner(null, "local-personal")).toEqual({
      organizationId: null,
      placement: "local",
    });
  });

  it("never exposes cloud rows in Personal, even with malformed legacy ownership", () => {
    const personal = organization({ id: "personal_1", isPersonal: true });
    const rows = [
      { id: "local", organizationId: null, placement: "local" as const },
      { id: "cloud-null", organizationId: null, placement: "cloud" as const },
      {
        id: "cloud-personal",
        organizationId: personal.id,
        placement: "cloud" as const,
      },
    ];
    expect(
      filterRowsForOrganization(rows, personal).map((row) => row.id),
    ).toEqual(["local"]);
  });

  it("treats legacy unowned rows as Personal and accepts explicit Personal ownership", () => {
    const personal = organization({
      id: "personal_1",
      slug: "personal-user",
      name: "Personal",
      isPersonal: true,
      workspaceCapabilities: { local: true, cloud: false },
    });
    const rows = [
      { id: "legacy" },
      { id: "personal", organizationId: "personal_1" },
      { id: "acme", organizationId: "org_1" },
    ];

    expect(
      filterRowsForOrganization(rows, personal).map((row) => row.id),
    ).toEqual(["legacy", "personal"]);
  });

  it("matches collaborative organization rows by exact owner", () => {
    const rows = [
      { id: "legacy" },
      { id: "acme", organizationId: "org_1" },
      { id: "other", organizationId: "org_2" },
    ];

    expect(
      filterRowsForOrganization(rows, organization()).map((row) => row.id),
    ).toEqual(["acme"]);
  });

  it("keeps pre-ownership local rows visible under a legacy flat Team", () => {
    const rows = [
      { id: "legacy" },
      { id: "flat-team", organizationId: "legacy_team_1" },
      { id: "other", organizationId: "org_2" },
    ];

    expect(
      filterRowsForOrganization(
        rows,
        organization({ id: "legacy_team_1", legacyFlat: true }),
      ).map((row) => row.id),
    ).toEqual(["legacy", "flat-team"]);
  });

  it("fails open before organization state is available and preserves stable arrays", () => {
    const rows = [{ id: "legacy" }, { id: "acme", organizationId: "org_1" }];

    expect(filterRowsForOrganization(rows, null)).toBe(rows);
    expect(filterRowsForOrganization(rows, organization())).not.toBe(rows);
    const allAcme = [{ id: "acme", organizationId: "org_1" }];
    expect(filterRowsForOrganization(allAcme, organization())).toBe(allAcme);
  });
});
