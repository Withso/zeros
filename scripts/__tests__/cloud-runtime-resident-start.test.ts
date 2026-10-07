import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, it, vi } from "vitest";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";
import { CloudResidentWorkload } from "../cloud-workspace-validation/sandbox/cloud-resident-workload.mjs";
import { CloudWorkerSupervisor, parseCloudWorkerSupervisorRequest, CLOUD_WORKER_SUPERVISOR_AUDIENCE }
  from "../cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs";

// Attestation uses a real selectable pipe. Only process creation is replaced;
// launch_and_health, enrollment parsing, retirement and rollback remain real.
const adapter = `
import json, os, runpy, sys, time
suite = runpy.run_path(sys.argv[1])
update, b = suite['update'], suite['b']
case = suite['UpdateTests']()
case.setUp()
try:
    initial = json.loads(sys.stdin.readline())
    class Pipe:
        phases = []
        def exchange(self, request, phase, **fields):
            self.phases.append(phase)
            if phase in ('enroll', 'rollback_enroll'):
                return {'allow': True, 'environment': initial['rollbackEnvironment' if phase == 'rollback_enroll' else 'targetEnvironment']}
            return {'allow': True}
    pipe = Pipe()
    runtime = update.SystemRuntime(b, case.app, pipe, initial['request'])
    runtime.controller = initial['source']
    def supervisor(operation, **fields):
        print(json.dumps({'version': 1, 'audience': update.AUDIENCE, 'operation': operation, **fields}), flush=True)
        reply = json.loads(sys.stdin.readline())
        if reply.get('transport') == 'timeout':
            raise TimeoutError()
        update.require(reply.get('version') == 1 and reply.get('audience') == update.AUDIENCE)
        return reply
    runtime.supervisor = supervisor
    runtime.resident = update.resident_document(b, supervisor('resident-status')['resident'])
    root = suite['fixture'].cgroup_fixture(case.case.root)
    workload = root / runtime.resident['scope'].rsplit('/', 1)[1]
    workload.mkdir()
    (workload / 'cgroup.events').write_text('populated 1\\nfrozen 0\\n')
    update.require(supervisor('runtime-handoff', action='prepare', handoff=initial['request']['handoff'])['outcome'] == 'fenced')
    runtime.retire_resident()
    class Attester:
        def __init__(self, argv, **kwargs):
            active = next(value for value in (initial['source'], initial['target']) if argv[0] == value['root'] + '/bin/node')
            read, write = os.pipe()
            self.stdout = os.fdopen(read, 'rb')
            report = {'profile': 'zeros-cloud-worker-v4', 'qualified': True, 'runtime': active}
            diagnostic = {'schema': 'zeros.diagnostic/v1', 'component': 'attester', 'ok': True,
                          'stage': 'done', 'exitCode': 0, 'failedChecks': []}
            os.write(write, (json.dumps(report) + '\\n' + json.dumps(diagnostic) + '\\n').encode())
            os.close(write)
        def wait(self, timeout=None):
            return 0
    update.subprocess.Popen = Attester
    runtime.selected(initial['target'])
    try:
        update.require(not runtime.launch_and_health(initial['target'], False, time.monotonic() + 10))
    except Exception:
        pass
    try:
        runtime.retire_resident()
        runtime.selected(initial['source'])
        healthy = runtime.launch_and_health(initial['source'], True, time.monotonic() + 10)
        outcome = 'rolled_back' if healthy else 'recovery_required'
    except Exception:
        outcome = 'recovery_required'
    update.require(update.populated(workload))
    print(json.dumps({'result': outcome, 'rollbackEnrolled': 'rollback_enroll' in pipe.phases}), flush=True)
except Exception:
    print(json.dumps({'result': 'setup_failed'}), flush=True)
    sys.exit(1)
finally:
    case.tearDown()
`;

const scenarios = [
  ["rejected", "rolled_back"],
  ["failed_after_attach", "rolled_back"],
  ["failed_while_detached", "recovery_required"],
  ["timeout_while_detached", "recovery_required"],
  ["rejected_changed_session", "recovery_required"],
  ["rejected_spent_session", "recovery_required"],
  ["rejected_changed_witness", "recovery_required"],
  ["rejected_wrong_replay_session", "recovery_required"],
  ["rejected_changed_replay_witness", "recovery_required"],
] as const;

it.each(scenarios)("handles actual supervisor start %s with %s and retains the workload", async (scenario, expected) => {
  const tree = cloudRuntimeFixture();
  try {
    const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
    const source = tree.descriptor;
    const target = { ...source, runtimeId: `r1-${"d".repeat(64)}`, manifestSha256: "d".repeat(64),
      root: `/opt/zeros-infra/r1-${"d".repeat(64)}`, installerReceiptSha256: "e".repeat(64), supervisorSessionId: randomUUID() };
    const hostId = randomUUID(), organizationId = randomUUID(), workspaceId = randomUUID();
    const sourceId = randomUUID(), targetId = randomUUID(), rollbackId = randomUUID();
    const environment = (engineId: string, generation: number) => ({
      accountAudience: "resident-start-test", accountClientId: null, accountContract: null,
      accountIssuers: ["https://issuer.example.test/"], accountJwksUrl: "https://issuer.example.test/jwks",
      bridgeToken: `zwb_${randomBytes(32).toString("base64url")}`, ownerSubject: "resident-start-test", port: 43001,
      runtimeB64: Buffer.from(JSON.stringify({ version: 1, audience: "zeros-cloud-engine-runtime-v1",
        execution: { organizationId, workspaceId, generation, executionFence: 1, setupRunId: randomUUID() },
        engine: { instanceId: engineId, protocolVersion: 20, readinessProbeToken: `zwr_${randomBytes(32).toString("base64url")}` },
        registration: { endpoint: "https://control.example.test/register", expiresAtMs: Date.now() + 60_000,
          token: `zws_${randomBytes(32).toString("base64url")}` } })).toString("base64url"),
    });
    const resident = new CloudResidentWorkload({ runtime, hostId, organizationId, workspaceId });
    let failTargetAttach = scenario === "failed_while_detached";
    vi.spyOn(resident, "request").mockImplementation(async command => {
      if (failTargetAttach && command.op === "authorize" && command.authority.engineId === targetId) {
        failTargetAttach = false;
        throw new Error("Injected attach failure");
      }
    });
    vi.spyOn(resident, "start").mockResolvedValue(undefined);
    const enroll = vi.spyOn(resident, "enroll"), detach = vi.spyOn(resident, "detach");
    const stop = vi.spyOn(resident, "stop").mockResolvedValue(undefined);
    const retire = vi.fn(async () => {});
    const supervisor = new CloudWorkerSupervisor({ runtime, engineScope: { retire },
      verifySelectedRuntime: value => value, createResident: async () => resident,
      requestEngineHandoff: async (_endpoint, command) => ({ version: 1, ...command, accepted: true,
        ...(command.action === "prepare" ? { receipt: { version: 1, ...command.request, phase: "fenced", activityRevision: 1 } } : {}) }) });
    const launch = vi.spyOn(supervisor, "launch").mockResolvedValue(12345);
    const envelope = (operation: string, fields = {}) => ({ version: 1, audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE, operation, ...fields });
    const initialPrepare = await supervisor.apply(parseCloudWorkerSupervisorRequest(envelope("prepare")));
    const initialStart = await supervisor.apply(parseCloudWorkerSupervisorRequest(envelope("start", {
      session: initialPrepare.session, environment: environment(sourceId, 1), resident: { hostId, fence: 1 },
    })));
    expect(initialStart.outcome).toBe("started");
    enroll.mockClear(); detach.mockClear(); retire.mockClear(); launch.mockClear();
    if (scenario === "failed_after_attach") launch.mockRejectedValueOnce(new Error("Injected launch failure"));
    const handoff = { challenge: randomUUID(), organizationId, workspaceId, generation: 1,
      engineInstanceId: sourceId, hostId, fence: 1, expiresAtMs: Date.now() + 60_000 };
    const request = { schema: "zeros.runtime-update/v1", operation: "activate", transitionId: randomUUID(), fence: randomUUID(),
      scope: { organizationId, workspaceId, sourceGeneration: 1, candidateGeneration: 2, sourceEngineInstanceId: sourceId },
      expiresAt: new Date(Date.now() + 60_000).toISOString(), source, target, mode: "engine", handoff };
    const child = spawn("python3", ["-I", "-c", adapter, path.resolve(import.meta.dirname,
      "../cloud-workspace-validation/runtime-update/tests/test_update.py")], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<number | null>(resolve => { child.once("close", resolve); child.once("error", () => resolve(null)); });
    child.stdin.on("error", () => undefined);
    let stderrBytes = 0;
    child.stderr.on("data", chunk => { stderrBytes += chunk.length; });
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    let result: string | null = null, rollbackEnrolled = false, parsed = true, targetStarts = 0, rollbackStarts = 0;
    let rejected = false, attachedFailure = false, rollbackFresh = false, rollbackFence: number | null = null;
    try {
      child.stdin.write(JSON.stringify({ request, source, target, targetEnvironment: environment(targetId, 2),
        rollbackEnvironment: environment(rollbackId, 1) }) + "\n");
      for await (const line of lines) {
        const frame = JSON.parse(line);
        if (frame.result) { result = frame.result; rollbackEnrolled = frame.rollbackEnrolled === true; continue; }
        const input = parseCloudWorkerSupervisorRequest(frame);
        if (!input) { parsed = false; child.kill("SIGKILL"); break; }
        const isTargetStart = input.operation === "start" && input.environment.runtime.engine.instanceId === targetId;
        if (isTargetStart) {
          targetStarts++;
          if (scenario === "timeout_while_detached") { child.stdin.write('{"transport":"timeout"}\n'); continue; }
          if (scenario === "rejected_changed_session") supervisor.session = `zsp_${randomBytes(32).toString("base64url")}`;
          if (scenario === "rejected_spent_session") {
            failTargetAttach = true;
            await supervisor.apply(input).catch(() => undefined);
          }
          if (scenario === "rejected_changed_witness") await resident.enroll({ organizationId, workspaceId,
            engineId: randomUUID(), generation: 2, fence: 9, token: "test-only-resident-grant" });
          if (scenario.startsWith("rejected")) supervisor.stopping = true;
        }
        if (input.operation === "start" && !isTargetStart) {
          rollbackStarts++;
          rollbackFresh = input.environment.runtime.engine.instanceId === rollbackId &&
            input.environment.runtime.execution.generation === 1 && rollbackId !== sourceId && rollbackId !== targetId;
          rollbackFence = input.resident.fence;
        }
        // This is the socket handler's real error mapping: exceptions are
        // failed, never an affirmative pre-attachment rejected response.
        let reply = await supervisor.apply(input).catch(() => ({ version: 1,
          audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE, outcome: "failed" }));
        supervisor.stopping = false;
        if (isTargetStart) {
          rejected = reply.outcome === "rejected";
          attachedFailure = reply.outcome === "failed" && resident.descriptor().engineId === targetId;
        }
        if (input.operation === "prepare" && targetStarts > 0 && reply.outcome === "prepared") {
          if (scenario === "rejected_wrong_replay_session") reply = { ...reply, session: `zsp_${randomBytes(32).toString("base64url")}` };
          if (scenario === "rejected_changed_replay_witness") reply = { ...reply, resident: { ...reply.resident, fence: reply.resident.fence + 1 } };
        }
        child.stdin.write(JSON.stringify(reply) + "\n");
      }
      expect(await closed).toBe(0);
      expect(parsed).toBe(true);
      expect(stderrBytes).toBe(0);
      expect(targetStarts).toBe(1);
      expect(rejected).toBe(scenario.startsWith("rejected"));
      expect(attachedFailure).toBe(scenario === "failed_after_attach");
      expect(result).toBe(expected);
      expect(rollbackEnrolled).toBe(expected === "rolled_back");
      expect(rollbackStarts).toBe(expected === "rolled_back" ? 1 : 0);
      if (expected === "rolled_back") {
        expect(rollbackFresh).toBe(true);
        expect(rollbackFence).toBe(scenario === "failed_after_attach" ? 5 : 3);
        expect(detach.mock.calls.length).toBe(scenario === "failed_after_attach" ? 2 : 1);
        if (scenario === "failed_after_attach") {
          expect(detach.mock.calls[1][0].engineId === targetId).toBe(true);
          expect(detach.mock.calls[1][0].fence).toBe(3);
        }
      }
      expect(stop.mock.calls.length).toBe(0);
      expect(supervisor.resident === resident).toBe(true);
    } finally {
      clearTimeout(timeout); lines.close(); child.kill("SIGKILL"); child.stdin.destroy();
      await closed;
    }
  } finally { tree.dispose(); }
}, 15_000);
