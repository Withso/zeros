import { describe, expect, it } from "vitest";
import { makeMeCreatorConfirmCopy, noCreatorBarKind, selfCreatorEligibility } from "../no-creator-model";

const me = "33333333-3333-4333-8333-333333333333", other = "44444444-4444-4444-8444-444444444444";
const ownership = (canReassign: boolean) => ({ creatorRevision: "7", noCreatorReason: "left" as const, canReassign });

describe("no-Creator bar (owner decision 2026-11-13)", () => {
  it("shows only for a document that negotiated ownership and has no Creator: admin or member", () => {
    expect(noCreatorBarKind({ ownerUserId: null, sharing: { ownership: ownership(true) } })).toBe("admin");
    expect(noCreatorBarKind({ ownerUserId: null, sharing: { ownership: ownership(false) } })).toBe("member");
    expect(noCreatorBarKind({ ownerUserId: other, sharing: { ownership: ownership(true) } })).toBeNull();
    // An older server (no ownership fields) or no sharing: nothing.
    expect(noCreatorBarKind({ ownerUserId: null, sharing: {} })).toBeNull();
    expect(noCreatorBarKind({ ownerUserId: null })).toBeNull();
    expect(noCreatorBarKind(undefined)).toBeNull();
  });

  it("reads the caller's own row: eligible, the reason, or unknown when it is missing (Reassign… only)", () => {
    expect(selfCreatorEligibility(undefined, me)).toEqual({ state: "pending" });
    expect(selfCreatorEligibility([{ userId: other, eligible: true }, { userId: me, eligible: true }], me)).toEqual({ state: "eligible" });
    expect(selfCreatorEligibility([{ userId: me, eligible: false, reason: "on_hold" }], me))
      .toEqual({ state: "ineligible", reason: "You're on hold in this organization, so you can't be the Creator." });
    expect(selfCreatorEligibility([{ userId: me, eligible: false, reason: "repository_access_required" }], me))
      .toEqual({ state: "ineligible", reason: "You need access to this workspace's repository to be its Creator." });
    expect(selfCreatorEligibility([{ userId: me, eligible: false, reason: "account_inactive" }], me))
      .toEqual({ state: "ineligible", reason: "Your account is inactive, so you can't be the Creator." });
    expect(selfCreatorEligibility([{ userId: other, eligible: true }], me)).toEqual({ state: "unknown" });
    expect(selfCreatorEligibility(null, me)).toEqual({ state: "unknown" });
    expect(selfCreatorEligibility([{ userId: me, eligible: true }], null)).toEqual({ state: "unknown" });
  });

  it("names both consequences in the one confirm", () => {
    expect(makeMeCreatorConfirmCopy("api-server")).toEqual({ title: "Make yourself the Creator of api-server?",
      body: "Your agent logins will run every turn here, and commits will carry your Git identity." });
  });
});
