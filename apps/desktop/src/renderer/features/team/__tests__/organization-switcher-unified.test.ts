import { beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ unified: true }));
vi.mock("../../../config/release-channel", async (original) => ({
  ...(await original<typeof import("../../../config/release-channel")>()),
  isFeatureEnabled: (feature: string) =>
    feature === "unified-workspaces" ? flags.unified : true,
}));

import { organizationDisplayName } from "../organization-switcher";
import { PERSONAL_ORGANIZATION } from "../personal-organization";

beforeEach(() => {
  flags.unified = true;
});

describe("the Personal entry's name", () => {
  it("is the person's home, never Local, with unified-workspaces", () => {
    expect(organizationDisplayName(PERSONAL_ORGANIZATION, "Arun Kumar")).toBe("Arun Kumar");
    expect(organizationDisplayName(PERSONAL_ORGANIZATION, "  ")).toBe("Personal");
    expect(organizationDisplayName(PERSONAL_ORGANIZATION)).toBe("Personal");
    expect(PERSONAL_ORGANIZATION.id).toBe("local-personal");
  });

  it("stays Local without it, and organizations keep their names", () => {
    flags.unified = false;
    expect(organizationDisplayName(PERSONAL_ORGANIZATION, "Arun Kumar")).toBe("Local");
    expect(organizationDisplayName({ isPersonal: false, name: "Withso" }, "Arun Kumar")).toBe("Withso");
  });
});
