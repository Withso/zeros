import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationSummary } from "../control-plane";

const flags = vi.hoisted(() => ({ unified: true }));
vi.mock("../../../config/release-channel", async (original) => ({
  ...(await original<typeof import("../../../config/release-channel")>()),
  isFeatureEnabled: (feature: string) =>
    feature === "unified-workspaces" ? flags.unified : true,
}));
vi.mock("../organization-membership-history", async (original) => ({
  ...(await original<typeof import("../organization-membership-history")>()),
  getKnownPersonalOrganizationIds: () => ["legacy-personal"],
}));

import {
  canCreateWorkspaceIn,
  filterProjectsForOrganization,
  filterRowsForOrganization,
  localWorkspaceOwner,
} from "../organization-capabilities";
import { PERSONAL_ORGANIZATION } from "../personal-organization";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

function organization(id: string, overrides: Partial<OrganizationSummary> = {}): OrganizationSummary {
  return {
    id,
    slug: id.slice(0, 4),
    name: id,
    logo: null,
    role: "member",
    isPersonal: false,
    defaultTeamId: null,
    workspaceCapabilities: { local: false, cloud: true },
    teamCapabilities: { multiple: false, canCreate: false },
    ...overrides,
  };
}

const rows = [
  { id: "personal-local", organizationId: null, placement: "local" as const },
  { id: "legacy-personal-local", organizationId: "legacy-personal", placement: "local" as const },
  { id: "a-local", organizationId: ORG_A, placement: "local" as const },
  { id: "a-cloud", organizationId: ORG_A, placement: "cloud" as const },
  { id: "b-local", organizationId: ORG_B, placement: "local" as const },
  { id: "b-cloud", organizationId: ORG_B, placement: "cloud" as const },
];
const ids = (owner: OrganizationSummary | null) =>
  filterRowsForOrganization(rows, owner).map((row) => row.id);

const projects = [
  { repoRoot: "/Users/me/zeros" },
  { repoRoot: `cloud://${ORG_A}/33333333-3333-4333-8333-333333333333` },
  { repoRoot: `cloud://${ORG_B}/44444444-4444-4444-8444-444444444444` },
];
const roots = (owner: OrganizationSummary | null, confirmed: string | null = null) =>
  filterProjectsForOrganization(projects, owner, confirmed).map((project) => project.repoRoot);

beforeEach(() => {
  flags.unified = true;
});

describe("owners with unified-workspaces", () => {
  it("shows unowned Local work under every owner and keeps cloud and historical rows with their organization", () => {
    expect(ids(PERSONAL_ORGANIZATION)).toEqual(["personal-local", "legacy-personal-local"]);
    expect(ids(organization(ORG_A))).toEqual(["personal-local", "legacy-personal-local", "a-local", "a-cloud"]);
    expect(ids(organization(ORG_B))).toEqual(["personal-local", "legacy-personal-local", "b-local", "b-cloud"]);
  });

  it("switching A → B → A shows the same rows each time", () => {
    const a = ids(organization(ORG_A));
    ids(organization(ORG_B));
    expect(ids(organization(ORG_A))).toEqual(a);
  });

  it("fails open while the organization is loading and keeps the input array when nothing is hidden", () => {
    expect(ids(null)).toEqual(rows.map((row) => row.id));
    const local = rows.slice(0, 2);
    expect(filterRowsForOrganization(local, organization(ORG_A))).toBe(local);
  });

  it("lists local projects under every owner and cloud projects only under their organization", () => {
    expect(roots(PERSONAL_ORGANIZATION)).toEqual(["/Users/me/zeros"]);
    expect(roots(organization(ORG_A))).toEqual(["/Users/me/zeros", projects[1].repoRoot]);
    expect(roots(null, ORG_B)).toEqual(["/Users/me/zeros", projects[2].repoRoot]);
  });

  it("creates Local workspaces under every owner and never gives them an organization", () => {
    for (const owner of [null, PERSONAL_ORGANIZATION, organization(ORG_A)])
      expect(canCreateWorkspaceIn(owner, "local")).toBe(true);
    expect(localWorkspaceOwner(organization(ORG_A))).toEqual({ organizationId: null, placement: "local" });
    expect(localWorkspaceOwner(null, ORG_B)).toEqual({ organizationId: null, placement: "local" });
    expect(canCreateWorkspaceIn(PERSONAL_ORGANIZATION, "cloud")).toBe(false);
  });
});

describe("owners without unified-workspaces", () => {
  beforeEach(() => {
    flags.unified = false;
  });

  it("keeps each owner's rows and projects exactly as before", () => {
    expect(ids(PERSONAL_ORGANIZATION)).toEqual(["personal-local", "legacy-personal-local"]);
    expect(ids(organization(ORG_A))).toEqual(["a-local", "a-cloud"]);
    expect(roots(organization(ORG_A))).toEqual([projects[1].repoRoot]);
    expect(roots(PERSONAL_ORGANIZATION)).toEqual(["/Users/me/zeros"]);
  });

  it("keeps Local creation Personal-only", () => {
    expect(canCreateWorkspaceIn(organization(ORG_A), "local")).toBe(false);
    expect(() => localWorkspaceOwner(organization(ORG_A))).toThrow(/cloud/);
  });
});
