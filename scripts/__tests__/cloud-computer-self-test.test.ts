import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as selfTest from "../cloud-workspace-validation/sandbox/runtime-self-test.mjs";
import { canonicalComputerSelfTest } from "../cloud-workspace-validation/sandbox/cloud-computer-self-test.mjs";

const identityChecks = [
  "engine-no-new-privileges-and-seccomp", "engine-non-root-empty-capabilities", "fixed-engine-user-namespace",
  "readonly-image-authority", "host-authority-absent", "host-root-authority-denied", "global-kernel-control-writes-denied",
  "host-user-namespace-entry-denied", "readonly-mounts-locked", "inherited-unmount-denied",
  "same-engine-child-shared-files", "finite-engine-and-descendant-resources",
];
const actorChecks = [
  "immutable-engine-registration-attestation", "captured-provider-credential-and-engine-identity", "shared-managed-worktree",
  "legacy-workload-bridge-engine-identity", "agent-native-language-tools", "human-typescript-python-tools",
  "independent-device-tool-lifetime", "disk-document-refresh", "symlink-read-denial",
  "original-detached-group-and-non-escaped-descendants-retired", "timeout-original-group-retired",
];
const humanChecks = [
  "ssh-in-admitted-engine-view", "ssh-engine-identity", "shared-engine-attachment-staging",
  "same-mount-atomic-attachment-publication", "ssh-exec-output-and-exit", "ssh-exec-and-pty", "ssh-sftp",
  "ssh-original-group-descendants-retired",
];
const runners = { version: 1, managerIdentity: true, privateMaterial: true, stdio: true, originalRetirement: true,
  descendantsRetired: true, census: true, revocation: true, managerRetired: true };
function fixture(requireRunners = false) {
  const runtime = { runtimeId: `r1-${"a".repeat(64)}`, manifestSha256: "a".repeat(64),
    installerReceiptSha256: "b".repeat(64), baseCompatibilityId: `bc1-${"c".repeat(64)}`,
    bootId: "11111111-1111-4111-8111-111111111111", supervisorSessionId: "22222222-2222-4222-8222-222222222222" };
  const engine: any = { version: 2, boundary: "workspace-vm", qualified: true,
    identity: { qualified: true, hostUid: 10003, namespaceUid: 10003, noNewPrivs: 1, seccompMode: 2,
      capabilities: { effective: 0, permitted: 0, inheritable: 0, bounding: 0, ambient: 0 },
      checks: identityChecks.map(name => ({ name, status: "pass" })),
      resources: { finite: true, cpuMax: "400000 100000", memoryMax: String(7 * 1024 ** 3), pidsMax: "4096",
        memoryBudget: { nominalMemoryBytes: String(8 * 1024 ** 3), measuredMemoryBytes: String(8 * 1024 ** 3),
          hostMemoryMax: String(256 * 1024 ** 2), source: "nominal", capped: false },
        cpuSplit: { engine: { cpuMax: "max 100000", cpuWeight: 100 }, workload: { controllers: ["cpu"], cpuWeight: 100,
          cap: { kind: "applied", effectiveCpus: 4, cpuMax: "300000 100000" } } } },
    },
    execution: { sameEngineIdentity: true, noSandbox: true, ownedProcessGroups: true, originalProcessGroupsRetired: true,
      timeoutRetired: true, workloadCgroup: true, vmWorkloadDrain: true },
    capture: { sameEngineIdentity: true, chromiumSandbox: true },
    actorTools: { sameEngineIdentity: true, noSandbox: true, buildChecks: [...actorChecks] },
    humanServices: { sameEngineIdentity: true, noSandbox: true, buildChecks: [...humanChecks] },
    ...(requireRunners ? { runners: { ...runners } } : {}),
  };
  const calls: string[] = [];
  const checks = Object.fromEntries(selfTest.RUNTIME_SELF_TEST_CHECKS.map(name => [name,
    vi.fn(async () => { calls.push(name); return name === "engine_lifecycle" ? engine : true; })]));
  const setup = vi.fn(async () => { calls.push("setup"); return {
    hostUid: 10003, hostGid: 10003, detachedDescendantsRetired: true, timeoutRetired: true,
  }; });
  const retired = vi.fn(async () => { calls.push("census"); });
  const current = vi.fn(async () => { calls.push("identity"); return { runtime: { ...runtime }, requireRunners }; });
  const options = { runtime, requireRunners, setup, retired, current,
    resourcePolicySha256: "d".repeat(64), now: () => 1_800_000_000_000 };
  const run = () => (selfTest as any).runComputerSelfTestChecks(checks, options);
  return { runtime, engine, checks, setup, retired, current, calls, options, run };
}

describe("complete credential-free Computer self-test evidence", () => {
  it.each([false, true])("reuses one full engine exercise and adds setup then final census/identity (runners: %s)", async runner => {
    const f = fixture(runner), result = await f.run();
    expect(result.diagnostic).toMatchObject({ ok: true, exitCode: 0, failedChecks: [] });
    expect(result.report).toMatchObject({ schema: "zeros.computer-self-test/v1", runtime: f.runtime,
      policy: { version: 1, resourcePolicySha256: "d".repeat(64), ...(runner ? { runnerVersion: 1 } : {}) },
      results: { runtime: true, identity: true, resources: true, mounts: true, credentials: true, actorTools: true,
        lsps: true, capture: true, humanServices: true, setupProcess: true, retirement: true, census: true,
        ...(runner ? { runner: true } : {}) },
      checks: { identity: identityChecks, actorTools: actorChecks, humanServices: humanChecks },
      qualifiedAt: "2027-01-15T08:00:00.000Z" });
    expect(f.calls).toEqual([...selfTest.RUNTIME_SELF_TEST_CHECKS, "setup", "census", "identity"]);
    for (const check of Object.values(f.checks)) expect(check).toHaveBeenCalledOnce();
    if (!runner) expect(result.report.results).not.toHaveProperty("runner");
  });

  it("preserves the original self-test diagnostic and does not invoke build-only probes by default", async () => {
    const f = fixture(); f.checks.engine_lifecycle.mockResolvedValue(true);
    const result = await selfTest.runSelfTestChecks(f.checks);
    expect(result).toEqual(selfTest.selfTestDiagnostic(Object.fromEntries(selfTest.RUNTIME_SELF_TEST_CHECKS.map(name => [name, true]))));
    expect(f.setup).not.toHaveBeenCalled(); expect(f.retired).not.toHaveBeenCalled(); expect(f.current).not.toHaveBeenCalled();
  });

  it.each(["coarse-success", "lsp", "credentials", "mounts", "resources", "root-drain", "partial-role", "duplicate-role"])(
    "refuses %s as complete build evidence", async failure => {
      const f = fixture();
      if (failure === "coarse-success") f.checks.engine_lifecycle.mockResolvedValue(true);
      if (failure === "lsp") f.engine.actorTools.buildChecks = actorChecks.filter(name => name !== "human-typescript-python-tools");
      if (failure === "credentials") f.engine.actorTools.buildChecks = actorChecks.filter(name => name !== "captured-provider-credential-and-engine-identity");
      if (failure === "mounts") f.engine.identity.checks[8].status = "fail";
      if (failure === "resources") f.engine.identity.resources.cpuSplit.workload.cap.cpuMax = "max 100000";
      if (failure === "root-drain") f.engine.execution.vmWorkloadDrain = false;
      if (failure === "partial-role") f.engine.humanServices.buildChecks.pop();
      if (failure === "duplicate-role") f.engine.actorTools.buildChecks.push(actorChecks[0]);
      const result = await f.run();
      expect(result.report).toBeNull(); expect(result.diagnostic.ok).toBe(false);
      expect(f.setup).not.toHaveBeenCalled(); expect(f.retired).toHaveBeenCalledOnce();
    });

  it.each(["missing", "incomplete", "unoffered"])("requires exact optional runner results: %s", async failure => {
    const f = fixture(failure !== "unoffered");
    if (failure === "missing") delete f.engine.runners;
    if (failure === "incomplete") f.engine.runners.privateMaterial = false;
    if (failure === "unoffered") f.engine.runners = { ...runners };
    expect((await f.run()).report).toBeNull(); expect(f.setup).not.toHaveBeenCalled();
  });

  it.each(["setup", "setup-throws", "census"])("cannot publish after a failed %s proof", async failure => {
    const f = fixture();
    if (failure === "setup") f.setup.mockResolvedValue({ hostUid: 10003, hostGid: 10003, detachedDescendantsRetired: true, timeoutRetired: false });
    if (failure === "setup-throws") f.setup.mockRejectedValue(new Error("synthetic-private-child-output"));
    if (failure === "census") f.retired.mockRejectedValue(new Error("synthetic-private-child-output"));
    const result = await f.run();
    expect(result.report).toBeNull(); expect(result.diagnostic.ok).toBe(false);
    expect(f.retired).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("synthetic-private-child-output");
  });

  it.each(["runtimeId", "manifestSha256", "installerReceiptSha256", "baseCompatibilityId", "bootId", "supervisorSessionId"])(
    "binds the report to the original %s after all I/O", async field => {
      const f = fixture();
      f.current.mockResolvedValue({ runtime: { ...f.runtime, [field]: "changed" }, requireRunners: false });
      const result = await f.run();
      expect(result.report).toBeNull(); expect(result.diagnostic.failedChecks).toContain("final_identity");
      expect(f.calls.at(-1)).toBe("census"); expect(f.current).toHaveBeenCalledOnce();
    });

  it("keeps the original input immutable across an awaited setup result", async () => {
    const f = fixture(); let release!: () => void;
    const original = f.setup.getMockImplementation()!;
    f.setup.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return original(); });
    const pending = f.run(); await vi.waitFor(() => expect(f.setup).toHaveBeenCalledOnce());
    f.runtime.bootId = "33333333-3333-4333-8333-333333333333";
    release(); const result = await pending;
    expect(result.report).toBeNull(); expect(result.diagnostic.failedChecks).toContain("final_identity");
  });

  it("discards a late setup success after cancellation and still checks retirement", async () => {
    const f = fixture(), controller = new AbortController(); let release!: () => void;
    const original = f.setup.getMockImplementation()!;
    f.setup.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return original(); });
    const pending = selfTest.runComputerSelfTestChecks(f.checks, { ...f.options, signal: controller.signal });
    await vi.waitFor(() => expect(f.setup).toHaveBeenCalledOnce());
    controller.abort(); release();
    const result = await pending;
    expect(result.report).toBeNull(); expect(result.diagnostic.failedChecks).toContain("final_identity");
    expect(f.retired).toHaveBeenCalledOnce(); expect(f.current).not.toHaveBeenCalled();
  });

  it("does not continue setup after an earlier smoke failure, but still checks retirement", async () => {
    const f = fixture(); f.checks.sqlite_query.mockResolvedValue(false);
    const result = await f.run();
    expect(result.report).toBeNull(); expect(result.diagnostic.failedChecks).toContain("sqlite_query");
    expect(f.setup).not.toHaveBeenCalled(); expect(f.retired).toHaveBeenCalledOnce();
  });

  it("projects closed observed fields without retaining raw role output or paths", async () => {
    const f = fixture();
    f.engine.private = "synthetic-private-child-output";
    f.engine.identity.resources.hierarchy = [{ path: "/private-provider-path" }];
    f.engine.humanServices.stderr = "synthetic-private-child-output";
    const result = await f.run();
    expect(result.report).not.toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|private-provider-path|stderr/);
  });

  it("requires the same runner offer at the final identity check", async () => {
    const f = fixture(true); f.current.mockResolvedValue({ runtime: f.runtime, requireRunners: false });
    expect((await f.run()).report).toBeNull();
  });

  it("reads exactly one complete report followed by its closed final diagnostic", async () => {
    const result = await fixture().run();
    const read = (selfTest as any).parseComputerSelfTestOutput;
    const encode = (report: unknown, diagnostic = result.diagnostic) =>
      `${canonicalComputerSelfTest(report)}\n${canonicalComputerSelfTest(diagnostic)}\n`;
    expect(read(encode(result.report), 0)).toEqual(result);
    expect(read(JSON.stringify(result.diagnostic), 0)).toBeNull();
    expect(read(encode({ ...result.report, unexpected: "synthetic-private" }), 0)).toBeNull();
    expect(read(encode({ ...result.report, results: { ...result.report.results, lsps: false } }), 0)).toBeNull();
    expect(read(encode(result.report) + JSON.stringify(result.diagnostic), 0)).toBeNull();
    expect(read(encode(result.report, { ...result.diagnostic, ok: false, exitCode: 1, failedChecks: ["final_census"] }), 1)).toBeNull();
    expect(read("x".repeat(65_537), 0)).toBeNull();
    const failure = { ...result.diagnostic, ok: false, exitCode: 1, failedChecks: ["setup_process"] };
    expect(read(canonicalComputerSelfTest(failure), 1)).toEqual({ diagnostic: failure, report: null });
    for (const failedChecks of [["setup_process", "setup_process"], ["synthetic-private"], []]) {
      expect(read(canonicalComputerSelfTest({ ...failure, failedChecks }), 1)).toBeNull();
    }
    expect(read(canonicalComputerSelfTest({ ...result.diagnostic, timedOut: true }), 0)).toBeNull();
  });

  it("exposes only the opt-in build producer and keeps failed direct invocation closed", () => {
    const result = spawnSync(process.execPath, ["scripts/cloud-workspace-validation/sandbox/runtime-self-test.mjs", "--build-qualification"],
      { encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
    expect(result.status).toBe(1); expect(result.stderr).toBe("");
    const diagnostic = JSON.parse(result.stdout);
    expect(diagnostic).toMatchObject({ ok: false, failedChecks: expect.arrayContaining(["setup_process", "final_census", "final_identity"]) });
  });
});
