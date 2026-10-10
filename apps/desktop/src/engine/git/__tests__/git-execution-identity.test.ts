import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const load = vi.hoisted(() => vi.fn());
vi.mock("../../agents/containment/cloud-worker-config", () => ({ loadCloudWorkerConfiguration: load }));
beforeEach(() => { vi.resetModules(); load.mockReset().mockReturnValue(null); });
afterEach(() => vi.restoreAllMocks());

describe("Git execution placement", () => {
  it("runs qualified cloud Git as the actual engine, ignoring archived worker account fields", async () => {
    load.mockReturnValue({ version: 4, uid: 10001, gid: 10001 });
    const { gitExecutionIdentity, gitProcessOptions } = await import("../git-execution-identity");
    const engine = { uid: process.geteuid!(), gid: process.getegid!() };
    expect(gitExecutionIdentity()).toEqual(engine);
    expect(gitProcessOptions({ PATH: "/usr/bin", ZEROS_CLOUD_TOKEN: "fixture-authority", SAFE: "fixture" }))
      .toMatchObject({ ...engine, env: { PATH: "/usr/bin", SAFE: "fixture" } });
    expect(gitProcessOptions({ ZEROS_CLOUD_TOKEN: "fixture-authority" }).env).not.toHaveProperty("ZEROS_CLOUD_TOKEN");
    expect(() => gitExecutionIdentity({ uid: engine.uid + 1, gid: engine.gid })).toThrow();
  });

  it.each(["Personal Local", "organization-local"])("preserves explicit identity and ordinary Git options for %s", async () => {
    const { gitExecutionIdentity, gitProcessOptions } = await import("../git-execution-identity");
    const explicit = { uid: 42, gid: 43 };
    expect(gitExecutionIdentity(explicit)).toBe(explicit);
    expect(gitExecutionIdentity()).toBeUndefined();
    expect(gitProcessOptions({ PATH: "/usr/bin", SAFE: "fixture" }, explicit)).toEqual({ ...explicit, env: { PATH: "/usr/bin", SAFE: "fixture" } });
  });
});
