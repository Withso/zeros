import { describe, expect, it } from "vitest";
import { normalizeOrganizationSummary } from "../organization-summary";

describe("normalizeOrganizationSummary", () => {
  it("maps a legacy flat Team to a collaborative organization", () => {
    expect(
      normalizeOrganizationSummary({
        id: "org-1",
        slug: "acme",
        name: "Acme",
        role: "owner",
      }),
    ).toEqual({
      id: "org-1",
      slug: "acme",
      name: "Acme",
      logo: null,
      role: "owner",
      isPersonal: false,
      legacyFlat: true,
      defaultTeamId: null,
      workspaceCapabilities: { local: false, cloud: true },
      teamCapabilities: { multiple: false, canCreate: false },
    });
  });

  it("never restores cloud eligibility for Personal", () => {
    expect(
      normalizeOrganizationSummary({
        id: "personal-1",
        slug: "personal",
        name: "Ada",
        role: "owner",
        isPersonal: true,
        workspaceCapabilities: { local: true, cloud: true },
      }).workspaceCapabilities,
    ).toEqual({ local: true, cloud: false });
  });

  it("ignores old server permission to create organization workspaces locally", () => {
    expect(normalizeOrganizationSummary({
      id: "org-1", slug: "team", name: "Team", role: "owner", isPersonal: false,
      workspaceCapabilities: { local: true, cloud: true },
    }).workspaceCapabilities).toEqual({ local: false, cloud: true });
  });

  it("keeps a known organization seat and drops it for Personal or unknown values", () => {
    const wire = { id: "org-1", slug: "team", name: "Team", role: "member" as const, isPersonal: false };
    expect(normalizeOrganizationSummary({ ...wire, seat: "hold" }).seat).toBe("hold");
    expect(normalizeOrganizationSummary(wire)).not.toHaveProperty("seat");
    expect(normalizeOrganizationSummary({ ...wire, seat: "vip" as never })).not.toHaveProperty("seat");
    expect(normalizeOrganizationSummary({ ...wire, isPersonal: true, seat: "free" })).not.toHaveProperty("seat");
  });

  it("marks a pre-hierarchy flat Team for legacy local-row compatibility", () => {
    const normalized = normalizeOrganizationSummary({
      id: "legacy_team_1",
      slug: "arun-org",
      name: "Arun Raj Kumar's Org",
      role: "owner",
    });

    expect(normalized.isPersonal).toBe(false);
    expect(normalized.legacyFlat).toBe(true);
  });
});
