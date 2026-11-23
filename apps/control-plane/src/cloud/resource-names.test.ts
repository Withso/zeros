import { describe, expect, it } from "vitest";
import { cloudV2SnapshotName } from "./computer.js";
import { cloudV2ResourcePrefix, cloudV2SandboxName, cloudV2SharedBaseName, parseCloudV2SharedBaseName } from "./resource-names.js";

const organizationId = "12345678-1234-4123-8123-123456789abc";
const first = "a".repeat(24), second = "b".repeat(24);

describe("local Cloud Computer resource names", () => {
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

describe("shared base names", () => {
  const runtime = "1a2b3c4d5e6f".padEnd(64, "0");
  const boatName = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

  it("names a channel's base by its runtime, a rebuild by -r<n>, and a Local database's by its owner", () => {
    expect(cloudV2SharedBaseName("alpha", runtime)).toBe("zeros-alpha-base-1a2b3c4d5e6f");
    expect(cloudV2SharedBaseName("production", runtime, 2)).toBe("zeros-production-base-1a2b3c4d5e6f-r2");
    expect(cloudV2SharedBaseName("development", runtime, 999, first)).toBe(`zeros-local-${first}-base-1a2b3c4d5e6f-r999`);
    for (const name of [cloudV2SharedBaseName("production", runtime, 999), cloudV2SharedBaseName("development", runtime, 999, first)])
      expect(name).toMatch(boatName);
    expect(() => cloudV2SharedBaseName("alpha", "not-a-runtime")).toThrow();
    expect(() => cloudV2SharedBaseName("alpha", runtime, 1000)).toThrow();
    expect(() => cloudV2SharedBaseName("alpha", runtime, 0, first)).toThrow();
  });

  it("tells shared bases apart from organization snapshots, sandboxes and other deployments, both ways", () => {
    const shared = [cloudV2SharedBaseName("alpha", runtime), cloudV2SharedBaseName("alpha", runtime, 3), cloudV2SharedBaseName("development", runtime, 0, first)];
    for (const name of shared) expect(parseCloudV2SharedBaseName(name)).not.toBeNull();
    expect(parseCloudV2SharedBaseName(shared[1]!)).toEqual({ scope: "alpha", runtime12: "1a2b3c4d5e6f", rebuild: 3 });
    expect(parseCloudV2SharedBaseName(shared[2]!)).toEqual({ scope: `local-${first}`, runtime12: "1a2b3c4d5e6f", rebuild: 0 });
    // An organization whose id begins with hex that spells nothing like "base" still never parses as a base, and no
    // organization snapshot or sandbox name equals a shared base name.
    const others = [
      cloudV2SnapshotName("alpha", organizationId, 1), cloudV2SnapshotName("alpha", "ba5eba5e-0000-4000-8000-000000000000", 12),
      cloudV2SnapshotName("development", organizationId, 1, first), cloudV2SnapshotName("development", organizationId, 1),
      cloudV2SandboxName("alpha", "build", organizationId), cloudV2SandboxName("development", "copy", organizationId, first),
      "zeros-alpha-base-1a2b3c4d5e6f-r0", "zeros-alpha-base-1a2b3c4d5e6", "zeros-beta-base-1a2b3c4d5e6f", "zeros-local-base-1a2b3c4d5e6f",
    ];
    for (const name of others) {
      expect(parseCloudV2SharedBaseName(name)).toBeNull();
      expect(shared).not.toContain(name);
    }
  });

  it("gives each deployment a prefix the others' names never start with", () => {
    expect(cloudV2ResourcePrefix("alpha")).toBe("zeros-alpha-");
    const local = cloudV2ResourcePrefix("development", first);
    expect(cloudV2SharedBaseName("alpha", runtime).startsWith(local)).toBe(false);
    expect(cloudV2SharedBaseName("development", runtime, 0, second).startsWith(local)).toBe(false);
    expect(cloudV2SharedBaseName("development", runtime, 0, first).startsWith(cloudV2ResourcePrefix("development"))).toBe(false);
    expect(cloudV2SnapshotName("development", organizationId, 1, first).startsWith(cloudV2ResourcePrefix("alpha"))).toBe(false);
    expect(cloudV2SharedBaseName("production", runtime).startsWith(cloudV2ResourcePrefix("alpha"))).toBe(false);
  });
});
