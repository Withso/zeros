import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FakeBoat } from "./__fixtures__/boat-fake.js";
import { asZeros, GIT_LFS_INSTALL_COMMAND, type CloudV2Build } from "./computer.js";
import { installRuntimeCommand } from "./runtime.js";
import { CloudV2SharedBaseResolver, foldSharedRepoints, installBase, sharedBaseRetryDelay, sharedBaseState, type CloudV2SharedBases, type SharedBaseState } from "./shared-base.js";

const sha256 = "1a2b3c4d5e6f".padEnd(64, "0");
const url = "https://r2.example.test/runtime.tar.gz?sig=1";
const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
const hooks = () => ({ log: vi.fn(async (_text: string) => {}), assertHeld: vi.fn(), runtimeInstalled: vi.fn(async (_sha: string) => {}) });

describe("installBase", () => {
  it("installs the runtime and Git LFS, bounded at 300 s each, and no script when there is none", async () => {
    const boat = new FakeBoat(), exec = vi.spyOn(boat, "exec"), execLong = vi.spyOn(boat, "execLong");
    const { sandboxId } = await boat.create({ key: "k", name: "zeros-alpha-build-00000000", env: {} });
    const steps = hooks();
    expect(await installBase(boat, sandboxId, { runtime: { sha256, url }, publicKeys: [publicKey] }, steps)).toBe(true);
    expect(exec.mock.calls).toEqual([
      [sandboxId, installRuntimeCommand({ sha256, url, publicKeys: [publicKey] }), 300],
      [sandboxId, GIT_LFS_INSTALL_COMMAND, 300],
    ]);
    expect(execLong).not.toHaveBeenCalled();
    expect(steps.runtimeInstalled).toHaveBeenCalledWith(sha256);
    expect(steps.log.mock.calls.map(([text]) => text)).toEqual([`[zeros] runtime ${sha256.slice(0, 12)} installed\n`, "[zeros] git-lfs installed\n"]);
  });

  it("fails on the runtime, tolerates Git LFS, and runs an organization's script last as the workspace user", async () => {
    const boat = new FakeBoat();
    const { sandboxId } = await boat.create({ key: "k", name: "b", env: {} });
    boat.script = (_machine, command) => command === GIT_LFS_INSTALL_COMMAND ? { exitCode: 100, stdout: "", timedOut: false } : undefined;
    const steps = hooks();
    expect(await installBase(boat, sandboxId, { runtime: { sha256, url }, installScript: "sudo -n apt-get install -y jq" }, steps)).toBe(true);
    expect(boat.commands.at(-1)?.command).toBe(`${asZeros(["cd /home/user", "sudo -n apt-get install -y jq"])} 2>&1`);
    expect(steps.log.mock.calls.map(([text]) => text)).toContain("[zeros] git-lfs could not be installed; Git LFS files stay placeholders until a later build adds it\n");

    boat.script = (_machine, command) => command.includes(sha256) ? { exitCode: 1, stdout: "", timedOut: false } : undefined;
    await expect(installBase(boat, sandboxId, { runtime: { sha256, url } }, hooks())).rejects.toMatchObject({ code: "worker_runtime_install_failed" });
    boat.script = (_machine, command) => command.includes("apt-get install -y jq") ? { exitCode: 2, stdout: "", timedOut: false } : undefined;
    await expect(installBase(boat, sandboxId, { runtime: { sha256, url }, installScript: "sudo -n apt-get install -y jq" }, hooks()))
      .rejects.toMatchObject({ code: "computer_install_script_failed" });
    boat.script = null;
    // A build cancelled before its script stops there.
    expect(await installBase(boat, sandboxId, { runtime: { sha256, url }, installScript: "true" }, { ...hooks(), running: async () => false })).toBe(false);
  });
});

describe("shared base backoff", () => {
  it("waits 15 minutes after a failure, doubling, at most 6 hours", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 40].map(failures => sharedBaseRetryDelay(failures) / 60_000)).toEqual([15, 30, 60, 120, 240, 360, 360, 360]);
  });
});

describe("shared base resolver", () => {
  const scope = { channel: "alpha", runtimeSha256: sha256 };
  const rows = (value: SharedBaseState) => ({ state: vi.fn(async () => value) }) as unknown as CloudV2SharedBases & { state: ReturnType<typeof vi.fn> };

  it("checks the override first: off disables, a name pins, and neither reads the rows", async () => {
    const bases = rows({ state: "ready", name: "zeros-alpha-base-1a2b3c4d5e6f", source: "database" });
    expect(await sharedBaseState(bases, { ...scope, override: { kind: "off" } })).toEqual({ state: "off" });
    expect(await sharedBaseState(bases, { ...scope, override: { kind: "name", name: "zeros-base-1" } }))
      .toEqual({ state: "ready", name: "zeros-base-1", source: "override" });
    expect(bases.state).not.toHaveBeenCalled();
    expect(await sharedBaseState(bases, { ...scope, override: null })).toMatchObject({ state: "ready", source: "database" });
  });

  it("keeps an answer at most a minute and shares one read", async () => {
    let clock = 0;
    const bases = rows({ state: "building" });
    const resolver = new CloudV2SharedBaseResolver(bases, { ...scope, now: () => clock, ttlMs: 10 * 60_000 });
    await Promise.all([resolver.state(), resolver.state()]);
    expect(bases.state).toHaveBeenCalledTimes(1);
    clock = 59_999; expect(await resolver.current()).toBeNull();
    expect(bases.state).toHaveBeenCalledTimes(1);
    bases.state.mockResolvedValue({ state: "ready", name: "zeros-alpha-base-1a2b3c4d5e6f", source: "database" });
    clock = 60_000; expect(await resolver.current()).toBe("zeros-alpha-base-1a2b3c4d5e6f");
    expect(bases.state).toHaveBeenCalledTimes(2);
  });
});

describe("shared re-point history", () => {
  const build = (id: string, extra: Partial<CloudV2Build> & { automatic?: true } = {}): CloudV2Build & { automatic?: true } => ({
    id, organizationId: "o", version: 1, recipe: { repositories: [] }, state: "succeeded", builderSandboxId: null,
    snapshotId: `zeros-alpha-base-1a2b3c4d5e6f@${id}`, errorCode: null, createdBy: null, createdAt: "", startedAt: null, finishedAt: null,
    reason: "runtime", baseSnapshot: null, runtimeSha256: null, automatic: true, ...extra,
  });

  it("folds consecutive re-points into the newest and keeps every other build where it was", () => {
    const list = [build("r4"), build("r3"), build("r2"), build("m1", { reason: "manual", createdBy: "u", automatic: undefined }), build("r1"), build("r0"),
      build("f", { state: "failed" }), build("own", { snapshotId: "zeros-alpha-abc-v1" })];
    expect(foldSharedRepoints(list).map(row => [row.id, row.repoints ?? 1])).toEqual([["r4", 3], ["m1", 1], ["r1", 2], ["f", 1], ["own", 1]]);
    // The live build is never folded away.
    expect(foldSharedRepoints(list, new Set(["r3"])).map(row => row.id)).toEqual(["r4", "r3", "m1", "r1", "f", "own"]);
    expect(foldSharedRepoints([])).toEqual([]);
  });
});
