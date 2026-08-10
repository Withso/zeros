import { describe, expect, it } from "vitest";
import {
  canCreateWorkspaceIn,
  filterRowsForOrganization,
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
  it("always allows a local workspace, including signed-out legacy use", () => {
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

  it("stamps new local rows with the selected semantic owner", () => {
    expect(localWorkspaceOwner(organization())).toEqual({
      organizationId: "org_1",
      placement: "local",
    });
    expect(localWorkspaceOwner(null)).toEqual({
      organizationId: null,
      placement: "local",
    });
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

  it("fails open before organization state is available and preserves stable arrays", () => {
    const rows = [{ id: "legacy" }, { id: "acme", organizationId: "org_1" }];

    expect(filterRowsForOrganization(rows, null)).toBe(rows);
    expect(filterRowsForOrganization(rows, organization())).not.toBe(rows);
    const allAcme = [{ id: "acme", organizationId: "org_1" }];
    expect(filterRowsForOrganization(allAcme, organization())).toBe(allAcme);
  });
});
