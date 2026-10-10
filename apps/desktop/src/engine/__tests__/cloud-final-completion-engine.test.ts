import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import { CloudOwnedWorkloadRegistry } from "../agents/containment/cloud-owned-workloads";
import { createCloudWorkloadCustody } from "../agents/containment/cloud-workload-custody";
import { cloudWorkloadKernelFixture, kernelProcess, workload } from "../agents/containment/__tests__/helpers/cloud-workload-kernel";
import type { CloudDurabilityAuthority } from "../cloud-durability-runtime";
import { CloudWorkspaceDurabilityRuntime } from "../cloud-durability-runtime";
import { CloudTransport } from "../transport/cloud";
import type { CloudEngineFinalCompletion, CloudFinalCheckpointReceipt } from "../cloud-final-completion";

const configuration = vi.hoisted(() => ({ version: 4 as const, backend: "cloud-worker" as const,
  profile: "zeros-cloud-worker-v4" as const, uid: 10003, gid: 10003,
  toolchain: { node: "/opt/zeros/node", supervisor: "/opt/zeros/host-process-supervisor.mjs" } }));
vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
vi.mock("../agents/containment/cloud-worker-config", async original => ({ ...await original<object>(),
  isCloudWorkerConfiguration: (value: unknown) => value === configuration }));
vi.mock("../agents/containment/cloud-runtime-root.mjs", async original => ({ ...await original<object>(),
  resolveCloudRuntime: () => ({ cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" }) }));
afterEach(() => vi.restoreAllMocks());
const methods = ZerosEngine.prototype as unknown as {
  captureCloudFinalCompletion(this: unknown, authority: CloudDurabilityAuthority): void;
  readCloudFinalCompletion(this: unknown, challenge: string): Promise<CloudEngineFinalCompletion | null>;
};

function fixture(local = false) {
  const kernel = cloudWorkloadKernelFixture();
  const custody = createCloudWorkloadCustody(configuration, { io: kernel.io });
  const registry = new CloudOwnedWorkloadRegistry({ custody });
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 2, engineInstanceId: randomUUID() };
  const authority = { ...scope, heartbeatEndpoint: "https://control.example.test/internal/heartbeat", heartbeatToken: "test-heartbeat" };
  const checkpoint = { requestId: randomUUID(), checkpointId: randomUUID(), contentRevision: 7,
    manifestSha256: "a".repeat(64), reason: "before_stop" as const };
  const receipt = { scope, checkpoint };
  const writerEpoch = randomUUID();
  const seal = { scope: { ...scope, writerEpoch }, sealId: randomUUID(), sha256: "b".repeat(64),
    inventorySha256: "c".repeat(64), sequence: 9, recordSequence: 11, eventSequence: 13 };
  const lifecycle = { readAcknowledgedSeal: vi.fn(() => seal) };
  const state = { running: true, cloudWorker: configuration,
    cloudRuntimeConfig: { execution: scope, engine: { instanceId: scope.engineInstanceId } },
    cloudRuntimeRegistration: { hasRuntimeHandoffAuthority: () => true, readiness: () => ({ instanceId: scope.engineInstanceId }) },
    cloudDurabilityRuntime: { readFinalCheckpoint: vi.fn<() => CloudFinalCheckpointReceipt | null>(() => receipt) },
    cloudRecordRuntime: { usesLocalAgentJournal: local }, cloudAgentBoot: local ? { authorityActive: true } : null,
    cloudLocalWriterLifecycle: local ? lifecycle : null, cloudLocalHistoryRestored: true,
    cloudWorkloads: registry, cloudWorkloadCheckpointFence: registry.fence(),
    cloudRuntimeCheckpointQuiescing: true, cloudRuntimeHandoffFenced: false, cloudRuntimeAuthorityStopping: false,
    cloudUnresolvedFinalCheckpoint: null, cloudFinalCompletion: null,
  };
  Object.setPrototypeOf(state, ZerosEngine.prototype);
  return { state, registry, kernel, authority, receipt, lifecycle, seal };
}

describe("original final checkpoint exposure (explicit fake kernel IO)", () => {
  it.each([false, true])("exposes actual final CP receipt with current journal proof (local=%s)", async local => {
    const f = fixture(local), challenge = randomUUID();
    methods.captureCloudFinalCompletion.call(f.state, f.authority);
    const result = await methods.readCloudFinalCompletion.call(f.state, challenge);
    expect(result).toMatchObject({ version: 1, challenge, phase: "committed", ...f.receipt,
      mode: local ? "boot-owner-v1" : "legacy" });
    expect(result!.seal).toEqual(local ? { writerEpoch: f.seal.scope.writerEpoch, sealId: f.seal.sealId,
      sha256: f.seal.sha256, inventorySha256: f.seal.inventorySha256, sequence: 9, recordSequence: 11, eventSequence: 13 } : null);
    expect(() => f.registry.assertAccepting()).toThrow();
  });

  it("does not mint completion from upload, unknown ACK or handoff", async () => {
    const f = fixture();
    f.state.cloudDurabilityRuntime.readFinalCheckpoint.mockReturnValue(null);
    methods.captureCloudFinalCompletion.call(f.state, f.authority);
    expect(await methods.readCloudFinalCompletion.call(f.state, randomUUID())).toBeNull();
    f.state.cloudDurabilityRuntime.readFinalCheckpoint.mockReturnValue(f.receipt);
    f.state.cloudRuntimeHandoffFenced = true;
    methods.captureCloudFinalCompletion.call(f.state, f.authority);
    expect(await methods.readCloudFinalCompletion.call(f.state, randomUUID())).toBeNull();
  });

  it("refuses detached work and never drains it during the passive read", async () => {
    const f = fixture(); methods.captureCloudFinalCompletion.call(f.state, f.authority);
    f.kernel.groups.get(workload)!.pids.push(401);
    f.kernel.processes.set(401, kernelProcess(401, workload));
    const drain = vi.spyOn(f.registry, "drain");
    expect(await methods.readCloudFinalCompletion.call(f.state, randomUUID())).toBeNull();
    expect(drain).not.toHaveBeenCalled(); expect(f.kernel.processes.has(401)).toBe(true);
  });

  it("rechecks original scope, admission and fresh census across awaits", async () => {
    for (const change of ["scope", "resume", "work"] as const) {
      const f = fixture(); methods.captureCloudFinalCompletion.call(f.state, f.authority);
      const inspect = f.registry.inspect.bind(f.registry); let reads = 0;
      vi.spyOn(f.registry, "inspect").mockImplementation(async () => {
        const result = await inspect();
        if (++reads === 1) {
          if (change === "scope") f.state.cloudRuntimeConfig.execution = { ...f.authority, generation: 3 };
          if (change === "resume") f.state.cloudRuntimeCheckpointQuiescing = false;
          if (change === "work") {
            f.kernel.groups.get(workload)!.pids.push(402);
            f.kernel.processes.set(402, kernelProcess(402, workload));
          }
        }
        return result;
      });
      expect(await methods.readCloudFinalCompletion.call(f.state, randomUUID())).toBeNull();
    }
  });

  it("requires current acknowledged frozen seal on every read", async () => {
    const f = fixture(true); methods.captureCloudFinalCompletion.call(f.state, f.authority);
    f.lifecycle.readAcknowledgedSeal.mockImplementation(() => { throw new Error("NORMAL head changed"); });
    expect(await methods.readCloudFinalCompletion.call(f.state, randomUUID())).toBeNull();
  });

  it("keeps Local and organization-local without a completion port", async () => {
    const f = fixture(); Object.assign(f.state, { cloudWorker: null, cloudRuntimeConfig: null });
    methods.captureCloudFinalCompletion.call(f.state, f.authority);
    expect(await methods.readCloudFinalCompletion.call(f.state, randomUUID())).toBeNull();
  });

  it.runIf(process.platform === "linux")("pairs the actual CP commit producer, passive GET and outside-root reader without another capture", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-final-receipt-"));
    const f = fixture(), checkpointId = randomUUID(), blobId = randomUUID();
    const exec = promisify(execFile);
    const git = (...args: string[]) => exec("git", args, { cwd: root,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    let revision = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let commit: Record<string, unknown> | undefined;
    const writes: string[] = [];
    const cp = (async (input, init) => {
      const route = new URL(String(input)).pathname;
      if (route.endsWith("/content/head")) return Response.json({ checkpointId: null, currentRevision: revision,
        durableRevision: revision, entries: [], nextAfterPath: null });
      writes.push(route);
      if (route.endsWith("/content/append")) return Response.json({ revision: ++revision });
      if (route.endsWith("/blobs/batch")) {
        const body = JSON.parse(String(init?.body));
        return Response.json({ blobs: body.entries.map((entry: { bytesBase64: string }, index: number) => {
          const bytes = Buffer.from(entry.bytesBase64, "base64");
          return { index, id: blobId, plaintextSha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
        }) });
      }
      if (route.endsWith("/blobs")) {
        if (!(init?.body instanceof Uint8Array)) throw new Error("fixture requires binary upload");
        return Response.json({ id: blobId, plaintextSha256: createHash("sha256").update(init.body).digest("hex"), sizeBytes: init.body.length });
      }
      if (route.endsWith("/checkpoints/commit")) {
        commit = JSON.parse(String(init?.body)); await gate; return Response.json({ checkpointId });
      }
      throw new Error("unexpected fixture CP route");
    }) as typeof fetch;
    const runtime = new CloudWorkspaceDurabilityRuntime(root, { fetch: cp });
    Object.assign(f.state, { cloudDurabilityRuntime: runtime });
    const token = `zwr_${"R".repeat(43)}`;
    const transport = new CloudTransport({ port: 0, token: `zws_${"T".repeat(43)}`,
      internalReadiness: { token, read: () => ({ version: 1, instanceId: f.authority.engineInstanceId,
        protocolVersion: 1, health: "ready", durableRecordConnected: true }),
      readFinalCompletion: challenge => methods.readCloudFinalCompletion.call(f.state, challenge) } });
    // Load the actual root-only consumer without executing a root launcher.
    const outside = await import(path.resolve("scripts/cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs"));
    let capture: Promise<void> | undefined;
    try {
      await git("init", "--quiet"); await git("config", "user.email", "cloud@example.test");
      await git("config", "user.name", "Cloud Test"); await writeFile(path.join(root, "README.md"), "checkpoint\n");
      await git("add", "README.md"); await git("commit", "--quiet", "-m", "base");
      await f.registry.drain(f.state.cloudWorkloadCheckpointFence);
      await transport.start();
      const endpoint = { port: transport.boundPort, token }, challenge = randomUUID();
      const directive = { id: randomUUID(), reason: "before_stop" as const, deadlineAtMs: Date.now() + 60_000 };
      capture = runtime.checkpoint(directive, f.authority);
      await expect.poll(() => commit !== undefined).toBe(true);
      methods.captureCloudFinalCompletion.call(f.state, f.authority);
      await expect(outside.requestCloudEngineFinalCompletion(endpoint, challenge)).rejects.toThrow("unavailable");
      release(); await capture;
      methods.captureCloudFinalCompletion.call(f.state, f.authority);
      const count = writes.length, drain = vi.spyOn(f.registry, "drain");
      const value = await outside.requestCloudEngineFinalCompletion(endpoint, challenge);
      const receipt = outside.parseCloudEngineFinalCompletion(value, { challenge, scope: f.receipt.scope });
      expect(receipt).toMatchObject({ challenge, phase: "committed", mode: "legacy", seal: null,
        checkpoint: { requestId: directive.id, checkpointId, contentRevision: commit!.contentRevision,
          manifestSha256: commit!.integritySha256, reason: directive.reason } });
      expect(Object.isFrozen(receipt)).toBe(true); expect(writes).toHaveLength(count); expect(drain).not.toHaveBeenCalled();
      expect(outside.parseCloudEngineFinalCompletion(value, { challenge, scope: { ...f.receipt.scope, generation: 3 } })).toBeNull();
      f.kernel.groups.get(workload)!.pids.push(401); f.kernel.processes.set(401, kernelProcess(401, workload));
      await expect(outside.requestCloudEngineFinalCompletion(endpoint, randomUUID())).rejects.toThrow("unavailable");
      expect(writes).toHaveLength(count); expect(drain).not.toHaveBeenCalled();
      expect(() => f.registry.assertAccepting()).toThrow();
    } finally {
      release(); await capture?.catch(() => undefined); await transport.stop(); await rm(root, { recursive: true, force: true });
    }
  });
});
