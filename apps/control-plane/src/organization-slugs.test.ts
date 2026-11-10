import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_ID_MAX_LENGTH,
  RESERVED_ORGANIZATION_SLUGS,
  organizationIdCandidates,
  organizationIdFromName,
  organizationIdProblem,
} from "./organization-slugs.js";

describe("organization IDs", () => {
  it("derives a display name's own ID", () => {
    expect(organizationIdFromName("Acme Labs")).toBe("acme-labs");
    expect(organizationIdFromName("  --Café   Zürich--  ")).toBe("cafe-zurich");
    expect(organizationIdFromName("株式会社")).toBe("organization");
    // A long name ends on a whole word rather than mid-word.
    expect(organizationIdFromName("International Business Machines Corporation Limited")).toBe(
      "international-business-machines",
    );
    expect(organizationIdFromName("a".repeat(50))).toBe("a".repeat(ORGANIZATION_ID_MAX_LENGTH));
  });

  it("tries the name's own ID, then -org, skipping reserved ones", () => {
    expect(organizationIdCandidates("Acme Labs")).toEqual(["acme-labs", "acme-labs-org"]);
    for (const name of ["Local", "API", "Auth", "Workspace"]) {
      expect(organizationIdCandidates(name)).toEqual([`${name.toLowerCase()}-org`]);
    }
    const long = organizationIdCandidates(`${"Long ".repeat(9)}Name`);
    expect(long).toEqual(["long-long-long-long-long-long-long-long", "long-long-long-long-long-long-long-org"]);
    for (const id of long) expect(id.length).toBeLessThanOrEqual(ORGANIZATION_ID_MAX_LENGTH);
  });

  it("accepts only link-safe, unreserved IDs a new organization may choose", () => {
    expect(organizationIdProblem("acme")).toBeNull();
    expect(organizationIdProblem("a1-b2")).toBeNull();
    for (const id of RESERVED_ORGANIZATION_SLUGS) expect(organizationIdProblem(id)).toBe("reserved");
    for (const id of ["", "Acme", "a_b", "-a", "a-", "a--b", "a b", "a".repeat(ORGANIZATION_ID_MAX_LENGTH + 1)]) {
      expect(organizationIdProblem(id)).toBe("invalid");
    }
    // Personal organizations' IDs stay out of reach.
    expect(organizationIdProblem(`personal-${"0".repeat(32)}`)).toBe("invalid");
  });
});
