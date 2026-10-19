import { ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudWorkerSupervisor, CloudEngineExitReporter, CloudEngineExitJournal, parseCloudEngineExitReport }
  from "../cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs";
import { testCloudRuntime } from "../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";
import { CloudEngineExitReportSchema, CLOUD_ENGINE_EXIT_PATH, type CloudEngineExitReport } from "@zeros/protocol/cloud-runtime-lifecycle";
import { CloudEngineExitReportSchema as CpExitSchema } from "../../apps/control-plane/src/cloud-workspaces/engine-exit";
import { cloudEngineViewEnvironment } from "../cloud-workspace-validation/sandbox/cloud-engine-view.mjs";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(options: { fastExit?: boolean; armed?: boolean } = {}) {
  const runtime = testCloudRuntime();
  const environment = { accountAudience: "fixture", accountIssuers: ["https://identity.example.test"],
    accountJwksUrl: "https://identity.example.test/jwks", ownerSubject: "fixture", port: 39393,
    bridgeToken: `zwb_${"B".repeat(43)}`, runtimeB64: "fixture", runtime: {
      execution: { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, setupRunId: randomUUID(), executionFence: 1 },
      engine: { instanceId: randomUUID(), readinessProbeToken: `zwr_${"R".repeat(43)}` },
      registration: { endpoint: "https://control.example.test/internal/v1/cloud-workspaces/engine/register" },
    } };
  const children: ChildProcess[] = [];
  const retire = vi.fn(async () => {});
  const exitReporter = { arm: vi.fn((_report: CloudEngineExitReport, _endpoint: string, _token: string) => options.armed !== false),
    exited: vi.fn(), disarm: vi.fn(), resume: vi.fn(), close: vi.fn() };
  const spawnProcess = vi.fn((_file: string, _args: string[], _options: SpawnOptions) => {
    const child = Object.assign(new ChildProcess(), { pid: 70000 + children.length, unref: vi.fn() });
    children.push(child);
    queueMicrotask(() => {
      child.emit("spawn");
      if (options.fastExit) { child.exitCode = 0; child.emit("exit", 0); }
    });
    return child;
  });
  const supervisor = new CloudWorkerSupervisor({ runtime, spawnProcess, engineScope: { retire }, exitReporter,
    readBirth: pid => ({ pid, parentPid: process.pid, startToken: String(pid * 10) }),
    requestEngineFinalCompletion: async () => { throw new Error("fixture completion unavailable"); } });
  const launch = async () => {
    const prepared = await supervisor.enqueue({ operation: "prepare" });
    return supervisor.enqueue({ operation: "start", session: prepared.session, environment });
  };
  const exit = (child = children[0]!, code = 1) => { child.exitCode = code; child.emit("exit", code); };
  return { runtime, environment, supervisor, children, retire, spawnProcess, exitReporter, launch, exit };
}

describe("supervisor positive engine exit", () => {
  it("coordinator_exit_still_invokes_r1_and_interrupts_work", async () => {
    const f = fixture();
    let running = true;
    f.retire.mockImplementation(async () => { running = false; });
    const pid = await f.launch();
    const report = f.exitReporter.arm.mock.calls[0]![0];
    const environment = f.spawnProcess.mock.calls[0]![2]!.env!;
    expect.soft(environment.ZEROS_CLOUD_COORDINATOR_OWNER).toBe(report.reportId);
    expect(pid).toMatchObject({ pid: f.children[0]!.pid });
    running = true;
    f.exit();
    await f.supervisor.operation;
    expect(f.exitReporter.exited).toHaveBeenCalledExactlyOnceWith(report.reportId);
    expect(running).toBe(false);
    expect(f.spawnProcess).toHaveBeenCalledOnce();
  });
  it.each([0, 1])("reports unexpected exit code %s once without restarting the engine", async code => {
    const f = fixture();
    await f.launch();
    f.retire.mockClear();
    f.exit(undefined, code);
    f.exit(undefined, code);
    await f.supervisor.operation;
    expect(f.exitReporter.exited).toHaveBeenCalledOnce();
    expect(f.spawnProcess).toHaveBeenCalledOnce();
    expect(f.retire).toHaveBeenCalledOnce();
    expect(f.supervisor.child).toBeNull();
    expect(f.supervisor.lastRetirement).toMatchObject({ kind: "crash", checkpoint: null, retired: true });
    const report = f.exitReporter.arm.mock.calls[0]![0];
    expect(report).toMatchObject({ ...f.environment.runtime.execution, engineInstanceId: f.environment.runtime.engine.instanceId,
      runtimeId: f.runtime.runtimeId, bootId: f.runtime.bootId, supervisorSessionId: f.runtime.supervisorSessionId, reason: "unexpected_exit" });
  });
  it("observes an exit before the launch ACK", async () => {
    const f = fixture({ fastExit: true });
    await f.launch().catch(() => undefined);
    await f.supervisor.operation;
    expect(f.exitReporter.exited).toHaveBeenCalledOnce();
    expect(f.supervisor.child).toBeNull();
    expect(f.spawnProcess).toHaveBeenCalledOnce();
  });
  it("failed prepare cannot mask a later unexpected exit", async () => {
    const f = fixture();
    await f.launch();
    await expect(f.supervisor.enqueue({ operation: "prepare" })).rejects.toThrow();
    expect(f.exitReporter.disarm).not.toHaveBeenCalled();
    f.exit();
    await f.supervisor.operation;
    expect(f.exitReporter.exited).toHaveBeenCalledOnce();
  });
  it("marks committed retirement before the first signal and does not report it", async () => {
    const f = fixture();
    await f.launch();
    vi.spyOn(process, "kill").mockImplementation(() => {
      f.exit(undefined, 0);
      return true;
    });
    await f.supervisor.stopChild({ force: true });
    await f.supervisor.operation;
    expect(f.exitReporter.disarm).toHaveBeenCalledOnce();
    expect(f.exitReporter.exited).not.toHaveBeenCalled();
  });
  it.each(["custody", "signal"])("failed %s retirement cannot suppress a later crash", async failure => {
    const f = fixture();
    await f.launch();
    if (failure === "custody") f.supervisor.readBirth = pid => ({ pid, parentPid: process.pid, startToken: "1" });
    else vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("fixture signal refused"), { code: "EPERM" }); });
    await expect(f.supervisor.stopChild({ force: true })).rejects.toThrow();
    expect(f.exitReporter.disarm).not.toHaveBeenCalled();
    f.exit();
    await f.supervisor.operation;
    expect(f.exitReporter.exited).toHaveBeenCalledOnce();
  });
  it("a delayed old-child exit cannot clear or drain its replacement", async () => {
    const f = fixture();
    await f.launch();
    vi.spyOn(process, "kill").mockImplementation(() => { f.exit(undefined, 0); return true; });
    await f.supervisor.stopChild({ force: true });
    await f.launch();
    const replacement = f.supervisor.child;
    f.retire.mockClear();
    f.exit(undefined, 0);
    await f.supervisor.operation;
    expect(f.supervisor.child).toBe(replacement);
    expect(f.retire).not.toHaveBeenCalled();
    expect(f.exitReporter.exited).not.toHaveBeenCalled();
    f.exit(f.children[1]);
    await f.supervisor.operation;
  });
  it("advertises the exact episode only when its private retry journal is armed", async () => {
    const f = fixture();
    await f.launch();
    const env = f.spawnProcess.mock.calls[0]![2]!.env!;
    const marker = JSON.parse(Buffer.from(env.ZEROS_CLOUD_ENGINE_EXIT_REPORT_B64!, "base64url").toString("utf8"));
    expect(marker).toEqual(f.exitReporter.arm.mock.calls[0]![0]);
    f.exit();
    await f.supervisor.operation;
    const unavailable = fixture({ armed: false });
    await unavailable.launch();
    expect(unavailable.spawnProcess.mock.calls[0]![2]!.env).not.toHaveProperty("ZEROS_CLOUD_ENGINE_EXIT_REPORT_B64");
    unavailable.exit();
    await unavailable.supervisor.operation;
    expect(unavailable.exitReporter.exited).not.toHaveBeenCalled();
  });
});

type ExitRecord = { report: CloudEngineExitReport; endpoint: string; token: string; state: "armed" | "exited" };
function reportFixture(): CloudEngineExitReport {
  const runtime = testCloudRuntime();
  return { version: 1, audience: "zeros-cloud-engine-exit-v1", reason: "unexpected_exit", reportId: randomUUID(),
    organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(), setupRunId: randomUUID(),
    executionFence: 1, runtimeId: runtime.runtimeId, bootId: runtime.bootId, supervisorSessionId: runtime.supervisorSessionId };
}
function reporterFixture() {
  vi.useFakeTimers();
  const report = reportFixture();
  let persisted: ExitRecord[] = [];
  let writable = true;
  const journal = { read: () => structuredClone(persisted), write: (records: ExitRecord[]) => {
    if (!writable) throw new Error("fixture journal failure");
    persisted = structuredClone(records);
  } };
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as CloudEngineExitReport;
    return Response.json({ version: 1, audience: "zeros-cloud-engine-exit-v1", accepted: true,
      reportId: body.reportId, engineInstanceId: body.engineInstanceId });
  });
  const make = () => new CloudEngineExitReporter({ journal, fetch: request, random: () => 1 });
  const reporter = make();
  const arm = (value = report) => reporter.arm(value, `https://control.example.test${CLOUD_ENGINE_EXIT_PATH}`, `zwb_${"B".repeat(43)}`);
  return { report, journal, request, reporter, make, arm, persisted: () => persisted, setWritable: (value: boolean) => { writable = value; } };
}

describe("private engine exit retry journal", () => {
  it("replays a persisted exit after broker restart without inferring death from missing memory", async () => {
    const f = reporterFixture();
    expect(f.arm()).toBe(true);
    const neverObserved = reportFixture();
    expect(f.arm(neverObserved)).toBe(true);
    f.reporter.exited(f.report.reportId);
    f.reporter.close();
    const restarted = f.make();
    expect(restarted.resume()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).toHaveBeenCalledOnce();
    expect(JSON.parse(String(f.request.mock.calls[0]![1]!.body))).toEqual(f.report);
    expect(f.persisted()).toEqual([]);
    restarted.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retries one exact report after API failure without logging its credential", async () => {
    const f = reporterFixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.request.mockRejectedValue(new Error("fixture transport failure"));
    expect(f.arm()).toBe(true);
    f.reporter.exited(f.report.reportId);
    for (const delay of [0, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) await vi.advanceTimersByTimeAsync(delay);
    expect(f.request).toHaveBeenCalledTimes(8);
    expect(f.request.mock.calls.every(([url, init]) => url === `https://control.example.test${CLOUD_ENGINE_EXIT_PATH}` &&
      init?.redirect === "error" && JSON.stringify(JSON.parse(String(init?.body))) === JSON.stringify(f.report))).toBe(true);
    expect(f.persisted().map(record => record.state)).toEqual(["exited"]);
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
    f.reporter.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps one request in flight and retains an unacknowledged report on shutdown", async () => {
    const f = reporterFixture();
    f.request.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("fixture aborted")), { once: true });
    }));
    f.arm(); f.reporter.exited(f.report.reportId);
    await vi.advanceTimersByTimeAsync(0);
    f.reporter.exited(f.report.reportId);
    f.reporter.schedule(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.request).toHaveBeenCalledOnce();
    f.reporter.close();
    await f.reporter.flight;
    expect(f.persisted().map(record => record.state)).toEqual(["exited"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a refused old report cannot starve the next engine's withdrawal", async () => {
    const f = reporterFixture(), later = reportFixture();
    f.request.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as CloudEngineExitReport;
      if (body.reportId === f.report.reportId) return new Response(null, { status: 403 });
      return Response.json({ version: 1, audience: "zeros-cloud-engine-exit-v1", accepted: true,
        reportId: body.reportId, engineInstanceId: body.engineInstanceId });
    });
    f.arm(); f.reporter.exited(f.report.reportId);
    f.arm(later); f.reporter.exited(later.reportId);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.request.mock.calls.some(([_url, init]) => JSON.parse(String(init?.body)).reportId === later.reportId)).toBe(true);
    expect(f.persisted().map(record => record.report.reportId)).toEqual([f.report.reportId]);
    f.reporter.close();
  });
  it("requires an exact bounded ACK and never evicts unreported exits to arm a launch", async () => {
    const f = reporterFixture();
    f.request.mockResolvedValue(Response.json({ accepted: true }));
    for (let i = 0; i < 16; i += 1) {
      const report = reportFixture(); expect(f.arm(report)).toBe(true); f.reporter.exited(report.reportId);
    }
    const original = f.persisted().map(record => record.report.reportId);
    expect(f.arm()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.persisted().map(record => record.report.reportId)).toEqual(original);
    f.reporter.close();
  });
  it("does not arm an unsafe or unwritable journal and keeps observed exits through a write failure", async () => {
    const f = reporterFixture();
    f.setWritable(false);
    expect(f.arm()).toBe(false);
    f.setWritable(true);
    expect(f.arm()).toBe(true);
    f.setWritable(false);
    f.reporter.exited(f.report.reportId);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).toHaveBeenCalledOnce();
    // A stale armed disk copy is ignored after restart; it cannot recreate a
    // report or grant another launch episode any authority.
    f.reporter.close();
  });
  it("uses atomic private files and refuses symlinks, foreign ownership and broad modes", () => {
    vi.useRealTimers();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-exit-journal-"));
    fs.chmodSync(directory, 0o700);
    let owner = 0;
    const filesystem = { ...fs,
      lstatSync: ((...args: Parameters<typeof fs.lstatSync>) => Object.assign(fs.lstatSync(...args), { uid: owner, gid: 0 })) as typeof fs.lstatSync,
      fstatSync: ((...args: Parameters<typeof fs.fstatSync>) => Object.assign(fs.fstatSync(...args), { uid: owner, gid: 0 })) as typeof fs.fstatSync,
    };
    const journal = new CloudEngineExitJournal({ directory, filesystem });
    try {
      const record: ExitRecord = { report: reportFixture(), state: "exited", token: `zwb_${"B".repeat(43)}`,
        endpoint: `https://control.example.test${CLOUD_ENGINE_EXIT_PATH}` };
      journal.write([record]);
      expect(journal.read().map(value => value.report)).toEqual([record.report]);
      expect(fs.statSync(journal.file).mode & 0o777).toBe(0o600);
      owner = 10003;
      expect(() => journal.read()).toThrow(/unsafe/);
      owner = 0;
      fs.chmodSync(journal.file, 0o640);
      expect(() => journal.write([])).toThrow(/unsafe/);
      fs.unlinkSync(journal.file);
      fs.symlinkSync(path.join(directory, "absent"), journal.file);
      expect(() => journal.write([])).toThrow(/unsafe/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});

it("keeps the supervisor, engine and standalone API exit contracts in parity", () => {
  const report = reportFixture();
  const values = [report, { ...report, generation: 0 }, { ...report, executionFence: "1" },
    { ...report, token: "unexpected" }, { ...report, reason: "missing_uplink" }, { ...report, bootId: report.bootId.toUpperCase() },
    { ...report, runtimeId: "r1-invalid" }, { ...report, stopped: true }];
  for (const value of values) {
    const accepted = CloudEngineExitReportSchema.safeParse(value).success;
    expect(CpExitSchema.safeParse(value).success).toBe(accepted);
    expect(parseCloudEngineExitReport(value) !== null).toBe(accepted);
  }
  const runtime = testCloudRuntime();
  const source = { ZEROS_CLOUD_ENGINE_EXIT_REPORT_B64: Buffer.from(JSON.stringify(report)).toString("base64url") };
  expect(cloudEngineViewEnvironment(source, "serve", runtime).ZEROS_CLOUD_ENGINE_EXIT_REPORT_B64).toBe(source.ZEROS_CLOUD_ENGINE_EXIT_REPORT_B64);
  for (const mode of ["qualify", "resident", "probe-cursor"])
    expect(cloudEngineViewEnvironment(source, mode, runtime)).not.toHaveProperty("ZEROS_CLOUD_ENGINE_EXIT_REPORT_B64");
});
