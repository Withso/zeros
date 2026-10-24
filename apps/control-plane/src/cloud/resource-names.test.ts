import { describe, expect, it } from "vitest";
import { cloudV2SnapshotName } from "./computer.js";
import { cloudV2RetentionSnapshotName } from "./resource-names.js";

const organizationId = "12345678-1234-4123-8123-123456789abc";
const first = "a".repeat(24), second = "b".repeat(24);

describe("local Cloud Computer resource names", () => {
  it("gives every retention generation a deterministic unique Boat-safe name including local ownership", () => {
    const stopped = "2026-10-01T00:00:00.000Z";
    const names = [cloudV2RetentionSnapshotName("alpha", organizationId, stopped),
      cloudV2RetentionSnapshotName("development", organizationId, stopped, first),
      cloudV2RetentionSnapshotName("development", organizationId, stopped, second),
      cloudV2RetentionSnapshotName("development", organizationId, "2026-10-02T00:00:00.000Z", first)];
    expect(new Set(names).size).toBe(4);
    for (const name of names) expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/);
    expect(names[1]).toBe(cloudV2RetentionSnapshotName("development", organizationId, stopped, first));
    expect(names[1]).toMatch(new RegExp(`^zeros-local-${first}-`));
  });
  it("separates the same WorkOS organization and build version in two local databases", () => {
    const a = cloudV2SnapshotName("development", organizationId, 1, first);
    const b = cloudV2SnapshotName("development", organizationId, 1, second);
    expect(a).not.toBe(b);
    expect(a).toBe(`zeros-local-${first}-123456781234-v1`);
    expect(a).toBe(cloudV2SnapshotName("development", organizationId, 1, first));
    expect(cloudV2SnapshotName("development", organizationId, 2_147_483_647, first)).toMatch(/^[a-z0-9-]{1,63}$/);
  });

  it("preserves hosted snapshot identities and refuses an invalid local namespace", () => {
    expect(cloudV2SnapshotName("alpha", organizationId, 1)).toBe("zeros-alpha-123456781234-v1");
    expect(cloudV2SnapshotName("development", organizationId, 1)).toBe("zeros-development-123456781234-v1");
    expect(() => cloudV2SnapshotName("alpha", organizationId, 1, first)).toThrow();
    expect(() => cloudV2SnapshotName("development", organizationId, 1, "../other")).toThrow();
  });
});
