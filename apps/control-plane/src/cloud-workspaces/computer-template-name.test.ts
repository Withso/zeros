import { describe, expect, it } from "vitest";
import { computerTemplateSnapshotName } from "./computer-template-name.js";

const input = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  organizationSlug: "Example Org",
  buildId: "22222222-2222-4222-8222-222222222222",
  version: 7,
  channel: "alpha" as const,
  accountScope: "fixture-account",
  billingOrg: "fixture-wallet",
};

describe("durable Computer template names", () => {
  it("uses the owner's exact readable channel/version scheme", () => {
    const name = computerTemplateSnapshotName(input);
    expect(name).toBe("example-org-alpha-computer-v7");
    expect(computerTemplateSnapshotName({ ...input })).toBe(name);
  });

  it.each(["development", "alpha", "beta", "production"] as const)("fits Boat names for %s and a maximum safe version", channel => {
    const name = computerTemplateSnapshotName({ ...input, channel, organizationSlug: "Long name ".repeat(30), version: Number.MAX_SAFE_INTEGER });
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
    expect(name.endsWith(`-${channel}-computer-v${Number.MAX_SAFE_INTEGER}`)).toBe(true);
  });

  it("gives a non-ASCII slug a readable fallback and rejects unsafe identities", () => {
    expect(computerTemplateSnapshotName({ ...input, organizationSlug: "组织" })).toMatch(/^org-alpha-/);
    expect(() => computerTemplateSnapshotName({ ...input, version: 0 })).toThrow();
  });

  it("preserves the full bigint allocation without rounding or wrapping", () => {
    expect(computerTemplateSnapshotName({ ...input, version: "9223372036854775807" })).toBe("example-org-alpha-computer-v9223372036854775807");
    for (const version of ["01", "-1", "0", "9223372036854775808", Number.MAX_SAFE_INTEGER + 1])
      expect(() => computerTemplateSnapshotName({ ...input, version })).toThrow();
  });
});
