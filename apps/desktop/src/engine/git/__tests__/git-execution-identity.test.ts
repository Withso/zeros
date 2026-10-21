import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => { vi.resetModules(); });
afterEach(() => vi.restoreAllMocks());

describe("Git execution placement", () => {
  it.each(["Personal Local", "organization-local"])("preserves explicit identity and ordinary Git options for %s", async () => {
    const { gitExecutionIdentity, gitProcessOptions } = await import("../git-execution-identity");
    const explicit = { uid: 42, gid: 43 };
    expect(gitExecutionIdentity(explicit)).toBe(explicit);
    expect(gitExecutionIdentity()).toBeUndefined();
    expect(gitProcessOptions({ PATH: "/usr/bin", SAFE: "fixture" }, explicit)).toEqual({ ...explicit, env: { PATH: "/usr/bin", SAFE: "fixture" } });
  });
});
