import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import * as root from "../cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs";
import { CloudEngineCgroup } from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import { CloudResidentWorkload } from "../cloud-workspace-validation/sandbox/cloud-resident-workload.mjs";
import { CloudLegacyResidentControl } from "../cloud-workspace-validation/sandbox/cloud-resident-control.mjs";
import { testCloudRuntime } from "../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";

const engineId = "32345678-1234-4234-8234-123456789abc";
const hostId = "42345678-1234-4234-8234-123456789abc";
const organizationId = "52345678-1234-4234-8234-123456789abc";
const workspaceId = "62345678-1234-4234-8234-123456789abc";
const checkpointId = "72345678-1234-4234-8234-123456789abc";
const scope = { organizationId, workspaceId, generation: 2, engineInstanceId: engineId };
const hash = "a".repeat(64);
function completion(challenge: string, mode = "legacy") {
  return { version: 1, challenge, phase: "committed", scope, mode,
    checkpoint: { requestId: checkpointId, checkpointId, contentRevision: 4, manifestSha256: hash, reason: "before_stop" },
    seal: mode === "legacy" ? null : { writerEpoch: hostId, sealId: checkpointId, sha256: hash, inventorySha256: hash,
      sequence: 6, recordSequence: 4, eventSequence: 5 } };
}
async function fixture(legacy = false) {
  const runtime = testCloudRuntime(), order: string[] = [];
  const owner = { pid: 70001, startToken: "700010" };
  const child = Object.assign(new ChildProcess(), { ...owner, exitCode: null as number | null,
    signalCode: null as string | null, unref: vi.fn() });
  const record = { version: 1, episode: checkpointId,
    runtime: { runtimeId: runtime.runtimeId, bootId: runtime.bootId, supervisorSessionId: runtime.supervisorSessionId },
    owner, scope: { directory: `${runtime.cgroupRoot}/engine-runtime/engine-${engineId}`, dev: "0", ino: "31" },
    birth: { kind: "engine", pid: 70003, startToken: "700030" } };
  const readBirth = vi.fn((pid: number) => ({ pid, parentPid: process.pid, startToken: owner.startToken }));
  const readEngineCustody = vi.fn(() => structuredClone(record));
  const residentStub = { identity: { hostId, organizationId, workspaceId }, runtime,
    scope: new CloudEngineCgroup({ runtime, directory: `${runtime.cgroupRoot}/engine-workload-${hostId}` }),
    rootCustody: vi.fn(() => ({ ...structuredClone(record), birth: { kind: "resident", pid: 70004, startToken: "700040" } })),
    start: vi.fn(async () => {}), enroll: vi.fn(async (_authority: unknown) => {}),
    stop: vi.fn(async () => { order.push("resident-stop"); }) };
  const resident = legacy ? new CloudResidentWorkload({ runtime, hostId, organizationId, workspaceId,
    readBirth: () => ({ pid: 70004, parentPid: process.pid, startToken: "700040" }), removeServices: vi.fn() }) : residentStub;
  let present = true, populated = true;
  const directory = `${runtime.cgroupRoot}/engine-workload-${hostId}`;
  const legacyIo = { exists: vi.fn(() => present), identity: vi.fn(() => ({ directory, dev: "0", ino: "32" })),
    read: vi.fn(() => `populated ${populated ? 1 : 0}\nfrozen 0`),
    write: vi.fn((_directory: string, name: string) => { if (name === "cgroup.kill") populated = false; }),
    children: vi.fn(() => []), remove: vi.fn(() => { present = false; }) };
  if (resident instanceof CloudResidentWorkload) {
    const residentChild = Object.assign(new ChildProcess(), { pid: 70004, stdin: new PassThrough(), stdout: new PassThrough() });
    residentChild.stdin.on("finish", () => { Object.assign(residentChild, { exitCode: 0 }); residentChild.emit("exit", 0); });
    resident.scope = new CloudEngineCgroup({ runtime, directory, io: legacyIo });
    Object.assign(resident, { child: residentChild, ownerBirth: { pid: 70004, startToken: "700040" }, healthy: true });
    vi.spyOn(resident, "start").mockResolvedValue(undefined);
    vi.spyOn(resident, "request").mockResolvedValue(undefined);
    vi.spyOn(resident, "rootCustody").mockReturnValue({ ...structuredClone(record), birth: { kind: "resident", pid: 70004, startToken: "700040" } });
  }
  const retire = vi.fn(async () => { order.push("tree-kill-empty"); return { populated: 0, pruned: true }; });
  const requestEngineFinalCompletion = vi.fn(async (_endpoint: unknown, challenge: string) => {
    order.push("completion"); return completion(challenge);
  });
  const spawnProcess = vi.fn(() => { setImmediate(() => child.emit("spawn")); return child; });
  const supervisor = new root.CloudWorkerSupervisor({ runtime, spawnProcess, engineScope: { retire },
    createResident: async () => resident, verifySelectedRuntime: value => value,
    readBirth, readEngineCustody, requestEngineFinalCompletion });
  const prepared = await supervisor.apply({ operation: "prepare" });
  await supervisor.apply({ operation: "start", session: prepared.session, resident: { hostId, fence: 3 }, environment: {
    accountAudience: "fixture-audience", accountContract: null, accountClientId: null,
    accountIssuers: ["https://account.invalid"], accountJwksUrl: "https://account.invalid/jwks",
    ownerSubject: "fixture-owner", bridgeToken: `zwb_${"B".repeat(43)}`,
    port: 43001, runtimeB64: "fixture", runtime: { execution: { organizationId, workspaceId, generation: 2 },
      engine: { instanceId: engineId, readinessProbeToken: `zwr_${"R".repeat(43)}` } },
  } });
  vi.spyOn(process, "kill").mockImplementation((pid, _signal) => {
    expect(supervisor.lastRetirement?.retired).toBe(false);
    expect(pid).toBe(-child.pid); order.push("signal"); child.exitCode = 0; child.emit("exit", 0); return true;
  });
  order.length = 0; retire.mockClear(); residentStub.stop.mockClear();
  return { supervisor, resident, order, child, record, readBirth, readEngineCustody, requestEngineFinalCompletion, retire, spawnProcess, legacyIo };
}
afterEach(() => vi.restoreAllMocks());

it("binds legacy callbacks to the privately admitted authority and original live controller episode", async () => {
  const f = await fixture(), callbacks = f.supervisor.legacyResidentControlOptions();
  const captured = callbacks.current()!;
  expect(captured.resident).toBe(f.resident);
  expect(captured.authority).toMatchObject({ organizationId, workspaceId, engineId, generation: 2, fence: 3 });
  await expect(callbacks.assertEngine(captured.authority)).resolves.toBeUndefined();
  expect(f.readEngineCustody).toHaveBeenCalledWith(expect.objectContaining({ engineId, owner: { pid: f.child.pid, startToken: "700010" } }));
  f.readBirth.mockReturnValue({ pid: f.child.pid, parentPid: process.pid, startToken: "reused" });
  await expect(callbacks.assertEngine(captured.authority)).rejects.toThrow(/custody|authority/);
});
it("refuses changed authority or controller episode before granting legacy retirement", async () => {
  const f = await fixture(), callbacks = f.supervisor.legacyResidentControlOptions(), captured = callbacks.current()!;
  for (const fields of [{ engineId: hostId }, { generation: 3 }, { fence: 4 }, { token: "wrong" }])
    await expect(callbacks.assertEngine({ ...captured.authority, ...fields })).rejects.toThrow(/custody|authority/);
  await callbacks.assertEngine(captured.authority);
  f.readEngineCustody.mockImplementation(() => ({ ...structuredClone(f.record), episode: hostId }));
  await expect(callbacks.assertEngine(captured.authority)).rejects.toThrow(/custody|authority/);
  expect(f.retire).not.toHaveBeenCalled();
});
it("does not lend an admitted resident token to a replacement pointer", async () => {
  const f = await fixture(), callbacks = f.supervisor.legacyResidentControlOptions();
  const receipt = legacyReceipt(f), replacement = { ...f.resident,
    start: f.resident.start, stop: f.resident.stop, enroll: f.resident.enroll };
  f.supervisor.resident = replacement;
  expect(callbacks.current()).toBeNull();
  await expect(callbacks.clearResident(replacement, receipt)).rejects.toThrow(/proof|authority/);
  expect(f.supervisor.resident).toBe(replacement);
  expect(f.retire).not.toHaveBeenCalled();
});
it("requires exact completion before signal and outside-root tree retirement", async () => {
  const f = await fixture();
  await f.supervisor.stopChild();
  expect(f.order).toEqual(["completion", "signal", "resident-stop", "tree-kill-empty"]);
  expect(f.supervisor.lastRetirement).toMatchObject({ kind: "normal", completion: { scope, phase: "committed" }, retired: true });
});
it.each([null, { qualified: true }, { ...completion(checkpointId), scope: { ...scope, generation: 1 } }])(
  "never substitutes CLI exit zero for missing or mismatched completion (%#)", async value => {
    const f = await fixture(); f.requestEngineFinalCompletion.mockResolvedValue(value as ReturnType<typeof completion>);
    await expect(f.supervisor.stopChild()).rejects.toThrow(/completion/);
    expect(f.order).not.toContain("signal"); expect(f.retire).not.toHaveBeenCalled();
  },
);
it("rechecks original controller custody after the asynchronous completion read", async () => {
  const f = await fixture();
  f.requestEngineFinalCompletion.mockImplementation(async (_endpoint, challenge) => {
    f.readBirth.mockReturnValue({ pid: f.child.pid, parentPid: process.pid, startToken: "changed" }); return completion(challenge);
  });
  await expect(f.supervisor.stopChild()).rejects.toThrow(/custody|authority/);
  expect(f.retire).not.toHaveBeenCalled(); expect(f.order).not.toContain("signal");
});
it("labels forced retirement without inventing a checkpoint or reading completion", async () => {
  const f = await fixture(); await f.supervisor.stopChild({ force: true });
  expect(f.requestEngineFinalCompletion).not.toHaveBeenCalled();
  expect(f.supervisor.lastRetirement).toMatchObject({ kind: "force", completion: null, checkpoint: null, retired: true });
});
it("records an exited launcher as crash, never a committed checkpoint", async () => {
  const f = await fixture(); f.child.exitCode = 0; f.child.emit("exit", 0);
  await f.supervisor.stopChild();
  expect(f.requestEngineFinalCompletion).not.toHaveBeenCalled();
  expect(f.order).toEqual(["resident-stop", "tree-kill-empty"]);
  expect(f.supervisor.lastRetirement).toMatchObject({ kind: "crash", completion: null, checkpoint: null, retired: true });
});
it("refuses normal retirement without its root-owned whole-tree custody port", async () => {
  const f = await fixture(); f.supervisor.engineScope = null;
  await expect(f.supervisor.stopChild()).rejects.toThrow(/custody|scope/);
  expect(f.order).not.toContain("signal");
});
function legacyReceipt(f: Awaited<ReturnType<typeof fixture>>) {
  const original = f.supervisor.legacyResidentControlOptions().current()!.authority;
  const { token: _token, ...authority } = original;
  return { version: 1, operation: "retire-legacy-resident", requestId: checkpointId,
    source: { hostId, authority,
      runtime: { runtimeId: f.resident.runtime.runtimeId, bootId: f.resident.runtime.bootId, supervisorSessionId: f.resident.runtime.supervisorSessionId },
      scope: { directory: f.resident.scope.directory, dev: "0", ino: "32" } },
    phase: "retired", proof: { kind: "dedicated-resident-cgroup", populated: 0 }, replacement: "fresh-view-required" };
}
it("keeps retired source/fence floor after clear and admits only a fresh host at a higher fence", async () => {
  const f = await fixture(), options = f.supervisor.legacyResidentControlOptions(), captured = options.current()!;
  const receipt = legacyReceipt(f);
  await options.clearResident(f.resident, receipt);
  expect(options.current()).toBeNull();
  // Lost-reply authentication remains exact while this original engine lives.
  await options.assertEngine(captured.authority);
  receipt.source.authority.fence = 1;
  const prepared = await f.supervisor.apply({ operation: "prepare" });
  const environment = { runtime: { execution: { organizationId, workspaceId, generation: 3 },
    engine: { instanceId: checkpointId, readinessProbeToken: `zwr_${"R".repeat(43)}` } } };
  for (const resident of [{ hostId, fence: 4 }, { hostId: checkpointId, fence: 3 }, { hostId: checkpointId, fence: 2 }])
    expect(await f.supervisor.apply({ operation: "start", session: prepared.session, resident, environment })).toMatchObject({ outcome: "rejected" });
  const replacement = { ...f.resident, start: f.resident.start, stop: f.resident.stop,
    identity: { hostId: checkpointId, organizationId, workspaceId }, enroll: vi.fn(async () => {}) };
  f.supervisor.createResident = async () => replacement;
  vi.spyOn(f.supervisor, "launch").mockResolvedValue(70005);
  expect(await f.supervisor.apply({ operation: "start", session: prepared.session,
    resident: { hostId: checkpointId, fence: 4 }, environment })).toMatchObject({ outcome: "started" });
  expect(replacement.enroll).toHaveBeenCalledWith(expect.objectContaining({ fence: 4, engineId: checkpointId }));
  expect(f.supervisor.legacyResidentControlOptions().current()!.resident).toBe(replacement);
  await expect(options.clearResident(f.resident, legacyReceipt(f))).rejects.toThrow(/proof|authority/);
  expect(f.supervisor.resident).toBe(replacement);
});
it("never clears the original on a foreign or shared-pool retirement receipt", async () => {
  const f = await fixture(), options = f.supervisor.legacyResidentControlOptions();
  const receipt = legacyReceipt(f);
  for (const source of [{ ...receipt.source, hostId: checkpointId },
    { ...receipt.source, authority: { ...receipt.source.authority, fence: 2 } },
    { ...receipt.source, scope: { ...receipt.source.scope, directory: f.record.scope.directory } }])
    await expect(options.clearResident(f.resident, { ...receipt, source })).rejects.toThrow(/proof|authority/);
  expect(f.supervisor.resident).toBe(f.resident);
  expect(f.retire).not.toHaveBeenCalled();
});
it("serializes legacy effects with supervisor start/stop work", async () => {
  const f = await fixture(), options = f.supervisor.legacyResidentControlOptions();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const first = options.serialize(async () => { f.order.push("legacy-begin"); await barrier; f.order.push("legacy-end"); });
  const second = f.supervisor.enqueue({ operation: "prepare" });
  await Promise.resolve();
  expect(f.order).toEqual(["legacy-begin"]);
  release(); await first; await second;
  expect(f.order.slice(0, 3)).toEqual(["legacy-begin", "legacy-end", "completion"]);
});
it("pairs actual root callbacks with original dedicated-leaf retirement and durable replay (fake kernel IO)", async () => {
  const f = await fixture(true), options = f.supervisor.legacyResidentControlOptions();
  const control = new CloudLegacyResidentControl(options), authority = options.current()!.authority;
  const body = { version: 1, operation: "retire-legacy-resident", requestId: checkpointId, hostId, authority };
  try {
    const receipt = await options.serialize(() => control.request(body));
    expect(receipt).toMatchObject({ source: { hostId, scope: { directory: f.resident.scope.directory, dev: "0", ino: "32" } },
      proof: { kind: "dedicated-resident-cgroup", populated: 0 }, replacement: "fresh-view-required" });
    expect(f.supervisor.resident).toBeNull();
    expect(await options.serialize(() => control.request(structuredClone(body)))).toEqual(receipt);
    expect(f.legacyIo.write).toHaveBeenCalledExactlyOnceWith(f.resident.scope.directory, "cgroup.kill", "1");
    expect(f.retire).not.toHaveBeenCalled();
    await expect(options.serialize(() => control.request({ ...body, authority: { ...authority, fence: authority.fence + 1 } })))
      .rejects.toThrow("legacy_resident_control_refused");
  } finally { await control.close(); }
});
it("uses only a bounded passive authenticated loopback GET for final completion", async () => {
  const value = completion(checkpointId), fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(value)));
  const endpoint = { port: 43001, token: `zwr_${"R".repeat(43)}` };
  expect(await root.requestCloudEngineFinalCompletion(endpoint, checkpointId)).toEqual(value);
  expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:43001/internal/final-completion", expect.objectContaining({
    method: "GET", redirect: "error", cache: "no-store", headers: {
      "x-zeros-readiness-token": endpoint.token, "x-zeros-final-challenge": checkpointId,
    },
  }));
  for (const response of [new Response("x".repeat(4097)), new Response("null", { status: 409 }), new Response("broken")]) {
    fetch.mockResolvedValueOnce(response);
    await expect(root.requestCloudEngineFinalCompletion(endpoint, checkpointId)).rejects.toThrow("Cloud engine final completion unavailable");
  }
});
it("does not report retirement success when the outside-root kernel proof fails", async () => {
  const f = await fixture(); f.retire.mockRejectedValue(new Error("tree remains populated"));
  await expect(f.supervisor.stopChild()).rejects.toThrow(/populated/);
  expect(f.supervisor.lastRetirement?.retired).not.toBe(true);
});
it("keeps the standalone completion parser strict and binds the challenge/current scope", () => {
  for (const mode of ["legacy", "boot-owner-v1"]) {
    const value = completion(checkpointId, mode);
    expect(root.parseCloudEngineFinalCompletion(value, { challenge: checkpointId, scope })).toEqual(value);
    for (const changed of [{ ...value, challenge: hostId }, { ...value, mode: "unknown" }, { ...value, privateData: "rejected" },
      { ...value, seal: mode === "legacy" ? completion(checkpointId, "boot-owner-v1").seal : null },
      { ...value, checkpoint: { ...value.checkpoint, reason: "periodic" } }])
      expect(root.parseCloudEngineFinalCompletion(changed, { challenge: checkpointId, scope })).toBeNull();
  }
});
