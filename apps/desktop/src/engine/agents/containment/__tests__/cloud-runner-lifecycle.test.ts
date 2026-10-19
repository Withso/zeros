import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudRunnerLifecycle, type CloudRunnerDriver, type CloudRunnerMaterial } from "../cloud-runner-lifecycle";
import { cloudRunnerUnit, cloudRunnerCensusIsQuiet, type CloudRunnerScope, type CloudRunnerProof } from "../cloud-runner-contract";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture() {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "zeros-runner-contract-")); directories.push(directory);
  const scope: CloudRunnerScope = { version: 1, organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(), executionId: randomUUID(),
    runtimeId: `r1-${"a".repeat(64)}`, owner: { pid: 500, startToken: "12345" },
    workload: { directory: "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime/engine-workload-shared/workload",
      dev: "11", ino: "22" } };
  let live = true;
  const proof: CloudRunnerProof = { version: 1, attemptId: "", bootId: scope.bootId,
    unit: cloudRunnerUnit(scope.executionId).unit, invocationId: "b".repeat(32), pid: 501, startToken: "23456",
    cgroup: { directory: `${scope.workload.directory}/app.slice/${cloudRunnerUnit(scope.executionId).unit}`, dev: "11", ino: "33" } };
  const release = vi.fn(async () => {});
  const material: CloudRunnerMaterial = { request: { command: "/qualified/provider", args: ["--private-argument"],
    cwd: "/workspace/repository", env: { PROVIDER_TEST_MATERIAL: "private-test-material" } },
    assertCurrent() { if (!live) throw new Error("credential changed"); }, release };
  const send = vi.fn(async () => ({ ...proof })), close = vi.fn();
  const driver: CloudRunnerDriver = {
    start: vi.fn<CloudRunnerDriver["start"]>(async intent => { proof.attemptId = intent.attemptId; }),
    inspect: vi.fn<CloudRunnerDriver["inspect"]>(async () => ({ state: "running", proof: structuredClone(proof) })),
    connectPrivate: vi.fn<CloudRunnerDriver["connectPrivate"]>(async () => ({ proof: structuredClone(proof), send, close })),
    retire: vi.fn<CloudRunnerDriver["retire"]>(async intent => ({ version: 1, attemptId: intent.attemptId, bootId: scope.bootId, unit: proof.unit,
      invocationId: proof.invocationId, originalStartSettled: true, originalProcessGone: true,
      cgroup: structuredClone(proof.cgroup), complete: true, populated: false })),
  };
  const assertAuthority = vi.fn(() => { if (!live) throw new Error("authority changed"); });
  const acquire = vi.fn(async () => material);
  const options = { scope, journalDirectory: directory, driver, assertAuthority, acquire };
  const owner = new CloudRunnerLifecycle(options);
  const journal = () => readFileSync(path.join(directory, `${scope.executionId}.json`), "utf8");
  return { owner, options, scope, proof, directory, driver, acquire, send, close, release, journal, revoke: () => { live = false; } };
}

describe("dormant cloud runner ownership contract", () => {
  it("lost_unit_start_ack_never_duplicates_provider_turn", async () => {
    const f = fixture();
    vi.mocked(f.driver.start).mockImplementation(async intent => {
      f.proof.attemptId = intent.attemptId;
      expect(JSON.parse(f.journal()).phase).toBe("starting");
      throw new Error("lost systemd reply");
    });
    const [a, b] = await Promise.all([f.owner.launch(), f.owner.launch()]);
    expect(a).toEqual(b); expect(f.driver.start).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce();
    await expect(new CloudRunnerLifecycle(f.options).launch()).rejects.toThrow("cloud_runner_recovery_required");
    expect(f.driver.start).toHaveBeenCalledOnce(); await f.owner.stop();
  });

  it.each(["boot", "pid", "cgroup", "invocation"])("pid_reuse_and_foreign_boot_unit_are_refused (%s)", async changed => {
    const f = fixture();
    vi.mocked(f.driver.connectPrivate).mockImplementation(async () => {
      const proof = structuredClone(f.proof);
      if (changed === "boot") proof.bootId = randomUUID();
      if (changed === "pid") proof.startToken = "99999";
      if (changed === "cgroup") proof.cgroup.ino = "99999";
      if (changed === "invocation") proof.invocationId = "c".repeat(32);
      return { proof, send: f.send, close: f.close };
    });
    await expect(f.owner.launch()).rejects.toThrow("cloud_runner_authority_unavailable");
    expect(f.acquire).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    expect(f.driver.retire).toHaveBeenCalledOnce();
  });

  it("runner_death_is_interrupted_not_restarted", async () => {
    const f = fixture(); await f.owner.launch();
    vi.mocked(f.driver.inspect).mockResolvedValue({ state: "exited", proof: f.proof });
    expect(await f.owner.observe()).toBe("interrupted");
    expect(JSON.parse(f.journal()).phase).toBe("interrupted");
    expect(f.owner.busy()).toBe(false);
    await expect(f.owner.launch()).rejects.toThrow("cloud_runner_interrupted");
    expect(f.driver.start).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce();
  });

  it("stop_waits_for_all_members_of_the_original_unit_cgroup", async () => {
    const f = fixture(); await f.owner.launch();
    const original = f.driver.retire;
    f.driver.retire = vi.fn<CloudRunnerDriver["retire"]>(async (...args) => ({ ...await original(...args), populated: true }));
    await expect(f.owner.stop()).rejects.toThrow("cloud_runner_retirement_unproven");
    expect(f.owner.busy()).toBe(true); expect(f.release).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
    f.driver.retire = original; await f.owner.stop();
    expect(f.owner.busy()).toBe(false); expect(f.release).toHaveBeenCalledOnce();
  });

  it("synchronous_native_retirement_errors_keep_custody_and_closed_diagnostics", async () => {
    const f = fixture(); await f.owner.launch();
    const original = f.driver.retire;
    f.driver.retire = vi.fn(() => { throw new Error("private native retirement diagnostics"); });
    await expect(f.owner.stop()).rejects.toThrow("cloud_runner_retirement_unproven");
    expect(f.owner.busy()).toBe(true); expect(f.release).not.toHaveBeenCalled();
    f.driver.retire = original; await f.owner.stop();
  });

  it.each(["identity", "unsettled", "partial"])("unknown retirement cannot clear custody (%s)", async changed => {
    const f = fixture(); await f.owner.launch(); const original = f.driver.retire;
    f.driver.retire = vi.fn<CloudRunnerDriver["retire"]>(async (...args) => {
      const result = await original(...args);
      if (changed === "identity") return { ...result, attemptId: randomUUID() };
      if (changed === "unsettled") return { ...result, originalStartSettled: false };
      return { ...result, complete: false };
    });
    await expect(f.owner.stop()).rejects.toThrow("cloud_runner_retirement_unproven");
    expect(f.owner.busy()).toBe(true); expect(f.release).not.toHaveBeenCalled();
    f.driver.retire = original; await f.owner.stop();
  });

  it("unknown_census_vetoes_idle_and_seal", () => {
    const f = fixture(); const { executionId, ...scope } = f.scope;
    expect(executionId).toBeDefined();
    const expected = { scope, challengeId: randomUUID(), revision: 1 };
    const quiet = { version: 1, ...expected, complete: true, activeUnits: 0, pendingStarts: 0, failedRetirements: 0, outsideUnitPids: [] };
    expect(cloudRunnerCensusIsQuiet(quiet, expected)).toBe(true);
    for (const change of [{ complete: false }, { activeUnits: 1 }, { pendingStarts: 1 },
      { failedRetirements: 1 }, { outsideUnitPids: [999] }, { activeUnits: -1 }, { extra: true },
      { scope: { ...scope, bootId: randomUUID() } }, { scope: { ...scope, writerEpoch: randomUUID() } },
      { challengeId: randomUUID() }, { revision: 0 }])
      expect(cloudRunnerCensusIsQuiet({ ...quiet, ...change }, expected)).toBe(false);
  });

  it("an_unkeyed_quiet_census_is_not_current_owner_proof", () => {
    expect(cloudRunnerCensusIsQuiet({ version: 1, complete: true, activeUnits: 0,
      pendingStarts: 0, failedRetirements: 0, outsideUnitPids: [] })).toBe(false);
  });

  it("credential_material_absent_from_argv_unit_logs_and_journal", async () => {
    const f = fixture(); await f.owner.launch();
    const publicMetadata = JSON.stringify({ unit: cloudRunnerUnit(f.scope.executionId),
      startCalls: vi.mocked(f.driver.start).mock.calls, journal: JSON.parse(f.journal()) });
    for (const value of ["private-test-material", "--private-argument", "/qualified/provider", "/workspace/repository"])
      expect(publicMetadata).not.toContain(value);
    expect(f.send).toHaveBeenCalledWith((await f.acquire.mock.results[0]!.value).request, expect.any(AbortSignal));
    expect(cloudRunnerUnit(f.scope.executionId).properties).toMatchObject({ Restart: "no", KillMode: "control-group",
      User: "10003", Group: "10003", StandardInput: "null", StandardOutput: "null", StandardError: "null" });
    await f.owner.stop();
  });

  it("revocation_during_start_retires_late_child", async () => {
    const f = fixture(), started = deferred<void>(), entered = deferred<void>();
    vi.mocked(f.driver.start).mockImplementation(async intent => {
      f.proof.attemptId = intent.attemptId; entered.resolve(); await started.promise;
    });
    const result = f.owner.launch(); await entered.promise;
    f.revoke(); const stopping = f.owner.stop();
    expect(f.driver.retire).not.toHaveBeenCalled(); started.resolve();
    await expect(result).rejects.toThrow("cloud_runner_authority_unavailable"); await stopping;
    expect(f.send).not.toHaveBeenCalled(); expect(f.driver.start).toHaveBeenCalledOnce();
    expect(f.driver.retire).toHaveBeenCalledOnce(); expect(f.owner.busy()).toBe(false);
  });

  it("lost_private_ack_never_resends_material_or_releases_it_before_retirement", async () => {
    const f = fixture(), retired = deferred<Awaited<ReturnType<CloudRunnerDriver["retire"]>>>();
    const original = f.driver.retire;
    f.send.mockRejectedValue(new Error("lost private ACK"));
    f.driver.retire = vi.fn(() => retired.promise);
    const started = f.owner.launch();
    await vi.waitFor(() => expect(f.driver.retire).toHaveBeenCalledOnce());
    expect(f.release).not.toHaveBeenCalled(); expect(f.owner.busy()).toBe(true);
    const intent = vi.mocked(f.driver.start).mock.calls[0]![0];
    retired.resolve(await original(intent, f.proof));
    await expect(started).rejects.toThrow("cloud_runner_authority_unavailable");
    await expect(f.owner.launch()).rejects.toThrow();
    expect(f.send).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
  });

  it("late_private_ack_cannot_restore_authority", async () => {
    const f = fixture(), ack = deferred<CloudRunnerProof>(), entered = deferred<void>();
    f.send.mockImplementation(async () => { entered.resolve(); return ack.promise; });
    const starting = f.owner.launch(); await entered.promise;
    f.revoke(); ack.resolve(f.proof);
    await expect(starting).rejects.toThrow("cloud_runner_authority_unavailable");
    expect(f.driver.retire).toHaveBeenCalledOnce(); expect(f.owner.busy()).toBe(false);
  });

  it("requires a private physical journal directory and closed scope", async () => {
    const f = fixture(); chmodSync(f.directory, 0o750);
    expect(() => new CloudRunnerLifecycle(f.options)).toThrow("cloud_runner_journal_unavailable");
    expect(() => cloudRunnerUnit("../foreign.service")).toThrow();
    expect(() => new CloudRunnerLifecycle({ ...f.options, scope: { ...f.scope, unexpected: true } as CloudRunnerScope })).toThrow();
    expect(readdirSync(f.directory)).toHaveLength(0); expect(f.driver.start).not.toHaveBeenCalled();
  });

  it("stop_before_native_submission_creates_no_unit", async () => {
    const f = fixture();
    const starting = f.owner.launch(), stopping = f.owner.stop();
    await expect(starting).rejects.toThrow("cloud_runner_authority_unavailable"); await stopping;
    expect(f.driver.start).not.toHaveBeenCalled(); expect(readdirSync(f.directory)).toHaveLength(0);
  });

  it("a_queued_launch_is_busy_before_its_first_await", async () => {
    const f = fixture();
    const starting = f.owner.launch();
    const busyBeforeAwait = f.owner.busy();
    await starting; await f.owner.stop();
    expect(busyBeforeAwait).toBe(true); expect(f.owner.busy()).toBe(false);
  });

  it("stop_after_reservation_but_before_submission_never_starts_a_unit", async () => {
    const f = fixture();
    let stopping: Promise<void> | undefined;
    f.options.assertAuthority.mockImplementationOnce(() => {
      queueMicrotask(() => { stopping = f.owner.stop(); });
    });
    await expect(f.owner.launch()).rejects.toThrow("cloud_runner_authority_unavailable");
    await stopping;
    expect(f.driver.start).not.toHaveBeenCalled(); expect(f.driver.retire).not.toHaveBeenCalled();
    expect(f.acquire).not.toHaveBeenCalled(); expect(f.owner.busy()).toBe(false);
    expect(JSON.parse(f.journal()).phase).toBe("retired");
  });

  it("native_unit_liveness_does_not_report_running_before_private_handoff", async () => {
    const f = fixture(), ack = deferred<CloudRunnerProof>(), entered = deferred<void>();
    f.send.mockImplementation(async () => { entered.resolve(); return ack.promise; });
    const starting = f.owner.launch(); await entered.promise;
    const beforeHandoff = await f.owner.observe();
    ack.resolve(f.proof); await starting;
    expect(await f.owner.observe()).toBe("running"); await f.owner.stop();
    expect(beforeHandoff).toBe("starting");
  });

  it("authority_failure_is_closed_before_any_persistent_or_native_effect", async () => {
    const f = fixture(); f.options.assertAuthority.mockImplementation(() => { throw new Error("private source diagnostics"); });
    await expect(f.owner.launch()).rejects.toThrow("cloud_runner_authority_unavailable");
    expect(f.driver.start).not.toHaveBeenCalled(); expect(readdirSync(f.directory)).toHaveLength(0);
  });

  it("journal_failure_cannot_prevent_native_retirement", async () => {
    const f = fixture(); await f.owner.launch();
    writeFileSync(path.join(f.directory, `${f.scope.executionId}.json`), "changed receipt", { mode: 0o600 });
    await expect(f.owner.stop()).rejects.toThrow("cloud_runner_journal_unavailable");
    expect(f.driver.retire).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
    expect(f.owner.busy()).toBe(true);
  });

  it.runIf(process.platform !== "win32")("a_fifo_receipt_cannot_block_native_retirement", () => {
    const f = fixture(), script = path.join(f.directory, "fifo-probe.mjs");
    // Exercise the real blocking-file hazard in a disposable process so the
    // regression can time out without hanging the test runner's event loop.
    writeFileSync(script, `
      import { CloudRunnerLifecycle } from ${JSON.stringify(fileURLToPath(new URL("../cloud-runner-lifecycle.ts", import.meta.url)))};
      import { unlinkSync, writeSync } from "node:fs";
      import { execFileSync } from "node:child_process";
      const scope = ${JSON.stringify(f.scope)}, proof = ${JSON.stringify(f.proof)};
      let retired = false, code = null;
      const owner = new CloudRunnerLifecycle({ scope, journalDirectory: ${JSON.stringify(f.directory)},
        assertAuthority() {},
        async acquire() { return { request: { command: process.execPath, args: [], cwd: process.cwd(), env: {} },
          assertCurrent() {}, async release() {} }; },
        driver: {
          async start(intent) { proof.attemptId = intent.attemptId; },
          async inspect() { return { state: "running", proof }; },
          async connectPrivate() { return { proof, async send() { return proof; }, close() {} }; },
          async retire() { retired = true; const { pid, startToken, ...identity } = proof;
            return { ...identity, originalStartSettled: true, originalProcessGone: true, complete: true, populated: false }; }
        }
      });
      await owner.launch();
      const receipt = ${JSON.stringify(path.join(f.directory, `${f.scope.executionId}.json`))};
      unlinkSync(receipt); execFileSync("mkfifo", [receipt]);
      writeSync(1, "retiring\\n");
      try { await owner.stop(); } catch (error) { code = error.message; }
      process.stdout.write(JSON.stringify({ retired, busy: owner.busy(), code }));
    `);
    const result = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", timeout: 5000 });
    expect(result.stdout).toMatch(/^retiring\n/);
    expect(result.status, "FIFO receipt must not block retirement").toBe(0);
    expect(JSON.parse(result.stdout.slice("retiring\n".length))).toEqual({ retired: true, busy: true, code: "cloud_runner_journal_unavailable" });
  }, 10000);

  it("late_credential_capture_is_released_only_after_original_retirement", async () => {
    const f = fixture(), captured = deferred<CloudRunnerMaterial>(), entered = deferred<void>();
    const material = await f.acquire(); f.acquire.mockClear();
    f.acquire.mockImplementation(async () => { entered.resolve(); return captured.promise; });
    const starting = f.owner.launch(); await entered.promise;
    f.revoke(); const stopping = f.owner.stop();
    await vi.waitFor(() => expect(f.driver.retire).toHaveBeenCalledOnce());
    expect(f.release).not.toHaveBeenCalled(); captured.resolve(material);
    await expect(starting).rejects.toThrow("cloud_runner_authority_unavailable"); await stopping;
    expect(f.send).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce(); expect(f.owner.busy()).toBe(false);
  });

  it("refuses an asynchronous authority check instead of treating its Promise as proof", async () => {
    const f = fixture(); f.options.assertAuthority.mockImplementation(async () => {});
    await expect(f.owner.launch()).rejects.toThrow("cloud_runner_authority_unavailable");
    expect(f.driver.start).not.toHaveBeenCalled(); expect(readdirSync(f.directory)).toHaveLength(0);
  });
});
