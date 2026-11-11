import { describe, expect, it, vi } from "vitest";

vi.mock("../workspace-api-access-setting", () => ({ showsWorkspaceApiAccess: (organization: unknown, cloud: boolean) => !!organization && cloud }));
import { organizationGeneralSections } from "../organization-general";

describe("an organization's General settings", () => {
  it("offer one local-commands control, Always allow, and no organization local-commands switch", () => {
    const organization = { id: "22222222-2222-4222-8222-222222222222", isPersonal: false, role: "owner" } as never;
    expect(organizationGeneralSections(organization, true)).toEqual(["workspace-api-access", "computer-use", "always-allow-local-commands"]);
    expect(organizationGeneralSections(organization, true)).not.toContain("organization-local-commands");
    // Without cloud access only this Mac's computer use remains.
    expect(organizationGeneralSections(organization, false)).toEqual(["computer-use"]);
  });
});
