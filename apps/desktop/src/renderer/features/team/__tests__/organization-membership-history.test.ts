import { describe, expect, it } from "vitest";
import {
  organizationMembershipTransition,
  type OrganizationMembershipSnapshot,
} from "../organization-membership-history";

function snapshot(
  organizationIds: string[],
  retiredOrganizationIds: string[] = [],
  personalId: string | null = "personal_1",
): OrganizationMembershipSnapshot {
  return {
    userId: "user_1",
    personalId,
    organizationIds,
    retiredOrganizationIds,
    updatedAt: 1,
  };
}

describe("organization membership history", () => {
  it("records removed organizations as durable repair tombstones", () => {
    const transition = organizationMembershipTransition(
      snapshot(["personal_1", "org_a", "org_b"]),
      snapshot(["personal_1", "org_b"]),
    );
    expect(transition.retiredOrganizationIds).toEqual(["org_a"]);
    expect(transition.next.retiredOrganizationIds).toEqual(["org_a"]);
  });

  it("retains tombstones for late creates and removes them after a rejoin", () => {
    const stillRetired = organizationMembershipTransition(
      snapshot(["personal_1"], ["org_a"]),
      snapshot(["personal_1"]),
    );
    expect(stillRetired.retiredOrganizationIds).toEqual(["org_a"]);

    const rejoined = organizationMembershipTransition(
      stillRetired.next,
      snapshot(["personal_1", "org_a"]),
    );
    expect(rejoined.retiredOrganizationIds).toEqual([]);
  });

  it("does not infer removals on the first confirmed hierarchy snapshot", () => {
    expect(
      organizationMembershipTransition(null, snapshot(["personal_1", "org_a"]))
        .retiredOrganizationIds,
    ).toEqual([]);
  });

  it("carries a flat-Team removal across the rolling hierarchy deployment", () => {
    const legacy = snapshot(["org_a", "org_b"], [], null);
    const transition = organizationMembershipTransition(
      legacy,
      snapshot(["personal_1", "org_b"]),
    );

    expect(transition.retiredOrganizationIds).toEqual(["org_a"]);
    expect(transition.next.personalId).toBe("personal_1");
  });
});
