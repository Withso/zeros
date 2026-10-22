import { describe, expect, it } from "vitest";
import { recordCloudSeed, cloudSeedMessage, cloudSeedNeeded } from "../dev-environment/cloud-local-seed-state.mjs";

describe("electron:cloud seed state", () => {
  it("seeds once per instance and records only non-secret identifiers", () => {
    const state: any = {};
    expect(cloudSeedNeeded(state)).toBe(true);
    recordCloudSeed(state, { seeded: true, userId: "u", organizationId: "o", providers: ["claude", "codex"], staffRole: "developer", token: "secret-sentinel" }, new Date("2026-10-22T10:00:00Z"));
    expect(state.cloudSeed).toEqual({ seeded: true, organizationId: "o", staffRole: "developer", at: "2026-10-22T10:00:00.000Z" });
    expect(JSON.stringify(state)).not.toContain("secret-sentinel");
    expect(cloudSeedNeeded(state)).toBe(false);
  });

  it("upgrades an existing fixture receipt once to grant Internal access", () => {
    const state = { cloudSeed: { seeded: true, organizationId: "o", at: "previous" } };
    expect(cloudSeedNeeded(state)).toBe(true);
    recordCloudSeed(state, { seeded: true, organizationId: "o", staffRole: "developer" });
    expect(cloudSeedNeeded(state)).toBe(false);
  });

  it("keeps a not-yet-seeded instance retryable and says what to do", () => {
    const state: any = {};
    recordCloudSeed(state, { seeded: false, needsSignIn: true });
    expect(cloudSeedNeeded(state)).toBe(true);
    expect(cloudSeedMessage({ seeded: false, needsSignIn: true })).toMatch(/Sign in.*pnpm electron:cloud --seed/);
    expect(cloudSeedMessage({ seeded: true, organizationId: "o", providers: ["claude", "codex", "cursor"] })).toMatch(/claude, codex, cursor/);
    expect(cloudSeedMessage(undefined)).toMatch(/did not complete/);
  });
});
