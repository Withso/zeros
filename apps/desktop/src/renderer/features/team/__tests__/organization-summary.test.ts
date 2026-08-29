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
      workspaceCapabilities: { local: true, cloud: true },
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
