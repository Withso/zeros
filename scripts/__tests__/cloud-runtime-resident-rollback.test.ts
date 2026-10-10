import { ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";
import { CloudResidentWorkload } from "../cloud-workspace-validation/sandbox/cloud-resident-workload.mjs";
import { CloudEngineCgroup } from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import { CloudWorkerSupervisor, parseCloudWorkerSupervisorRequest, CLOUD_WORKER_SUPERVISOR_AUDIENCE }
  from "../cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs";

const adapter = `
import json, runpy, sys
suite = runpy.run_path(sys.argv[1])
update, b, fixture = suite['update'], suite['b'], suite['fixture']
case = suite['UpdateTests']()
case.setUp()
try:
    initial = json.loads(sys.stdin.readline())
    runtime = update.SystemRuntime(b, case.app, None, case.request)
    runtime.resident = initial['detached']
    runtime.resident_enrollment = initial['enrollment']
    runtime.source_retired = True
    root = fixture.cgroup_fixture(case.case.root)
    workload = root / runtime.resident['scope'].rsplit('/', 1)[1]
    workload.mkdir()
    (workload / 'cgroup.events').write_text('populated 1\\nfrozen 0\\n')
    def supervisor(operation, **fields):
        print(json.dumps({'version': 1, 'audience': update.AUDIENCE, 'operation': operation, **fields}), flush=True)
        reply = json.loads(sys.stdin.readline())
        if reply.get('transport') == 'lost':
            raise ConnectionError()
        update.require(reply.get('version') == 1 and reply.get('audience') == update.AUDIENCE)
        return reply
    runtime.supervisor = supervisor
    runtime.retire_resident()
    update.require(runtime.session is not None and runtime.resident_enrollment is None)
    update.require(runtime.resident['engineId'] is None and runtime.resident['fence'] == initial['enrollment']['fence'] + 1)
    update.require(update.populated(workload))
    print(json.dumps({'result': 'retired'}), flush=True)
except Exception:
    print(json.dumps({'result': 'failed'}), flush=True)
    sys.exit(1)
finally:
    case.tearDown()
`;

it("replays the adapter's rollback prepare after a lost root response without retiring the resident twice", async () => {
  const tree = cloudRuntimeFixture();
  try {
    const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
    const hostId = randomUUID(), organizationId = randomUUID(), workspaceId = randomUUID(), engineId = randomUUID();
    // The frozen updater retains an ORIGINAL archived dedicated leaf, rather
    // than treating a modern shared-pool controller as its PTY owner.
    const owner = { pid: 12346, startToken: "123460" };
    const originalScope = { directory: `${runtime.cgroupRoot}/engine-workload-${hostId}`, dev: "0", ino: "21" };
    const originalCustody = { version: 1, episode: randomUUID(),
      runtime: { runtimeId: runtime.runtimeId, bootId: runtime.bootId, supervisorSessionId: runtime.supervisorSessionId },
      owner, scope: originalScope, birth: { kind: "resident", pid: 23456, startToken: "234560" } };
    const residentChild = Object.assign(new ChildProcess(), { pid: owner.pid, exitCode: null,
      signalCode: null, stdin: new PassThrough(), stdout: new PassThrough() });
    const readCustody = vi.fn(() => structuredClone(originalCustody));
    const resident = new CloudResidentWorkload({ runtime, hostId, organizationId, workspaceId,
      spawnProcess: () => residentChild, readBirth: () => ({ ...owner, parentPid: process.pid }), readCustody });
    resident.scope = new CloudEngineCgroup({ runtime, directory: originalScope.directory });
    vi.spyOn(resident.scope, "currentIdentity", "get").mockReturnValue(originalScope);
    // Only process/kernel/IPC observations are substituted; original custody,
    // authority, descriptor, detach and the Python retry remain real code.
    vi.spyOn(resident, "request").mockResolvedValue(undefined);
    await resident.start("synthetic-runtime-identity");
    expect(resident.rootCustody()).toEqual(originalCustody);
    expect(readCustody).toHaveBeenCalledWith(expect.objectContaining({ owner, scope: originalScope }));
    await resident.enroll({ organizationId, workspaceId, engineId, generation: 2, fence: 3, token: "test-only-resident-grant" });
    const detach = vi.spyOn(resident, "detach"), stop = vi.spyOn(resident, "stop").mockResolvedValue(undefined);
    const retire = vi.fn(async () => {}), setupRetire = vi.fn(async () => {});
    const supervisor = new CloudWorkerSupervisor({ runtime, engineScope: { retire }, setupScope: { retire: setupRetire } });
    supervisor.resident = resident;
    const child = spawn("python3", ["-I", "-c", adapter, path.resolve(import.meta.dirname,
      "../cloud-workspace-validation/runtime-update/tests/test_update.py")], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<number | null>(resolve => { child.once("close", resolve); child.once("error", () => resolve(null)); });
    child.stdin.on("error", () => undefined);
    // Keep private responses off assertion output, including on child failure.
    let stderrBytes = 0;
    child.stderr.on("data", chunk => { stderrBytes += chunk.length; });
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const requests: string[] = [];
    let firstSession: string | undefined, replayedSession = false, result: string | null = null, parsed = true;
    try {
      child.stdin.write(JSON.stringify({ detached: { ...resident.descriptor(), engineId: null, generation: null, fence: 2 },
        enrollment: { engineId, generation: 2, fence: 3 } }) + "\n");
      for await (const line of lines) {
        const frame = JSON.parse(line);
        if (frame.result) { result = frame.result; continue; }
        const request = parseCloudWorkerSupervisorRequest(frame);
        if (!request) { parsed = false; child.kill("SIGKILL"); break; }
        if (request.operation === "prepare") requests.push(JSON.stringify(request));
        const reply = await supervisor.apply(request).catch(() => ({ version: 1,
          audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE, outcome: "failed" }));
        if (request.operation === "prepare" && requests.length === 1 && reply.outcome === "prepared") {
          firstSession = reply.session;
          child.stdin.write('{"transport":"lost"}\n');
        } else {
          if (request.operation === "prepare") replayedSession = firstSession !== undefined && reply.session === firstSession;
          child.stdin.write(JSON.stringify(reply) + "\n");
        }
      }
      const exitCode = await closed;
      expect(parsed).toBe(true);
      expect(requests.length).toBe(2);
      expect(requests[0] === requests[1]).toBe(true);
      expect(firstSession !== undefined).toBe(true);
      expect(replayedSession).toBe(true);
      expect(exitCode).toBe(0);
      expect(result).toBe("retired");
      expect(stderrBytes).toBe(0);
      expect(detach.mock.calls.length).toBe(1);
      expect(retire).toHaveBeenCalledExactlyOnceWith({ preserveWorkload: hostId });
      expect(setupRetire.mock.calls.length).toBe(1);
      expect(stop.mock.calls.length).toBe(0);
      expect(supervisor.resident === resident).toBe(true);
    } finally {
      clearTimeout(timeout); lines.close(); child.kill("SIGKILL"); child.stdin.destroy();
      await closed;
    }
  } finally { tree.dispose(); }
}, 15_000);
