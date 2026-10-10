import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudAgentLease } from "../../../../cloud-agent-lease";
import * as executions from "../../../../cloud-provider-execution";
import { CloudNativeBoundary, cloudNativeProviderEnvironment } from "../../../../containment/cloud-native-boundary";
import { createCloudNativeHome } from "../../../../containment/cloud-native-home";
import { CloudExecutionBoundary } from "../../../../containment/cloud-execution-boundary";
import { portableCloudWorkloads } from "../../../../containment/__tests__/helpers/portable-cloud-custody";
import { cloudCursorRequest } from "../cloud-policy";
import { createCursorHostRuntime } from "../host-client";

const runtime = vi.hoisted(() => ({ workerRoot: "", node: process.execPath,
  binRoot: process.execPath.slice(0, process.execPath.lastIndexOf("/")) }));
const configuration = vi.hoisted(() => ({ version: 4 as const, backend: "cloud-worker" as const,
  profile: "zeros-cloud-worker-v4" as const, uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
  toolchain: { node: process.execPath,
    supervisor: `${process.cwd()}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } }));
vi.mock("../../../../containment/cloud-runtime-root.mjs", async original => {
  const { testCloudRuntime } = await import("../../../../__tests__/helpers/test-cloud-runtime");
  return {
    ...await original<typeof import("../../../../containment/cloud-runtime-root.mjs")>(),
    resolveCloudRuntime: () => ({ ...testCloudRuntime(), ...runtime, profile: "v4" }),
  };
});
vi.mock("../../../../containment/cloud-worker-config", async original => ({
  ...await original<typeof import("../../../../containment/cloud-worker-config")>(),
  isCloudWorkerConfiguration: (value: unknown) => value === configuration,
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const admission = () => ({ executionId: randomUUID(), delegationId: randomUUID(), provider: "cursor" as const,
  model: "qualified-model", source: { kind: "session" as const, actorSessionId: randomUUID() } });
const key = "synthetic-admitted-cursor-key";
const grant = () => ({ leaseId: randomUUID(), authorityId: "a".repeat(64),
  expiresAt: new Date(Date.now() + 45000).toISOString(), credentialVersion: 1,
  credentialKind: "cursor-api-key", provider: "cursor", model: "qualified-model", material: { kind: "cursor-api-key", apiKey: key } });

describe("Cursor delegated credential delivery", () => {
  it.each(["cloud_agent_credential_required", "cloud_agent_credential_expired", "cloud_agent_credential_revoked"])(
    "preserves the typed %s grant denial before any host can launch", async code => {
      const denied = Object.assign(new Error("Delegated credential unavailable"), { code });
      const request = vi.fn(async () => { throw denied; });
      await expect(CloudAgentLease.admit(admission(), request, new AbortController().signal, { onRetirementFailure: vi.fn() }))
        .rejects.toMatchObject({ code });
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("fails with a typed missing credential instead of falling back to caller env", async () => {
    const lease = await CloudAgentLease.admit(admission(), async input => input.kind === "release" ? { released: true } : grant(), new AbortController().signal, { onRetirementFailure: vi.fn() });
    try {
      const execution = { cwd: "/srv/zeros/workspace", lease, model: lease.admission.model, lifetime: lease, customization: lease.customization, coordinator: { environment: () => ({}) }, productServers: [] } as unknown as executions.CloudProviderExecution;
      expect(() => cloudCursorRequest(execution, "agent.create", { apiKey: "synthetic-caller-key" }))
        .toThrow(expect.objectContaining({ code: "cloud_agent_credential_required" }));
    } finally { await lease.close(); }
  });

  it.each(["cloud_agent_credential_expired", "cloud_agent_credential_revoked"])("retains %s after validation retires the host authority", async code => {
    const request = vi.fn(async (input: { kind: string }) => {
      if (input.kind === "release") return { released: true };
      if (input.kind === "validate") throw Object.assign(new Error("Credential unavailable"), { code });
      return grant();
    });
    const lease = await CloudAgentLease.admit(admission(), request, new AbortController().signal, { onRetirementFailure: vi.fn() });
    try {
      await expect(lease.validate()).rejects.toMatchObject({ code });
      const execution = { cwd: "/srv/zeros/workspace", lease } as executions.CloudProviderExecution;
      expect(() => cloudCursorRequest(execution, "agent.create", {})).toThrow(expect.objectContaining({ code }));
    } finally { await lease.close(); }
  });

  it("distinguishes monotonic execution expiry from expired provider credentials", async () => {
    let monotonic = 0;
    const lease = await CloudAgentLease.admit(admission(), async input => input.kind === "release" ? { released: true } : grant(),
      new AbortController().signal, { onRetirementFailure: vi.fn() }, { wall: () => Date.now(), monotonic: () => monotonic });
    try {
      monotonic = 45000;
      expect(() => cloudCursorRequest({ cwd: "/srv/zeros/workspace", lease } as executions.CloudProviderExecution, "agent.create", {}))
        .toThrow(expect.objectContaining({ code: "cloud_validation_lease_expired" }));
    } finally { await lease.close(); }
  });

  it("carries one-shot lease material through the native env and real SDK host protocol", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "zeros-cursor-delivery-"));
    const ambient = process.env.CURSOR_API_KEY;
    const lease = await CloudAgentLease.admit(admission(), async input => input.kind === "release" ? { released: true } : grant(),
      new AbortController().signal, { onRetirementFailure: vi.fn() });
    let host: ReturnType<typeof createCursorHostRuntime> | undefined;
    const workloads = portableCloudWorkloads(configuration);
    try {
      runtime.workerRoot = temporary;
      vi.stubEnv("ZEROS_DATA_DIR", path.join(temporary, "engine"));
      const hostFile = path.join(temporary, "apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs");
      await mkdir(path.dirname(hostFile), { recursive: true });
      await copyFile(fileURLToPath(new URL("../cursor-host.cjs", import.meta.url)), hostFile);
      const sdkDirectory = path.join(temporary, "node_modules/@cursor/sdk");
      await mkdir(sdkDirectory, { recursive: true });
      await writeFile(path.join(sdkDirectory, "index.js"), `
        class JsonlLocalAgentStore { constructor(rootDir) { this.rootDir = rootDir; } }
        const describe = opts => ({ agentId: JSON.stringify({
          admittedKey: opts.apiKey === ${JSON.stringify(key)},
          environmentKey: process.env.CURSOR_API_KEY === ${JSON.stringify(key)},
          callerKeyAbsent: process.env.OPENAI_API_KEY === undefined,
          engineIdentity: process.getuid() === ${process.getuid?.()} && process.geteuid() === ${process.geteuid?.()} &&
            process.getgid() === ${process.getgid?.()} && process.getegid() === ${process.getegid?.()},
          model: opts.model.id, cwd: opts.cwd, localCwd: opts.local.cwd,
          store: opts.local.store instanceof JsonlLocalAgentStore,
          sources: opts.local.settingSources, autoReview: opts.local.autoReview
        }), close() {} });
        module.exports = { JsonlLocalAgentStore, getDefaultSdkStateRoot: () => process.env.ZEROS_CURSOR_STATE_ROOT,
          Agent: { create: async opts => describe(opts), resume: async (_id, opts) => describe(opts) } };
      `);
      const nativeHome = await createCloudNativeHome({ dataRoot: temporary, conversationId: "credential-delivery",
        provider: "cursor", executionId: lease.admission.executionId });
      const env = cloudNativeProviderEnvironment(lease.takeMaterial(), lease.admission.model, undefined, undefined, nativeHome);
      expect(env.CURSOR_API_KEY === key).toBe(true);
      expect(() => lease.takeMaterial()).toThrow(/consumed/);
      // The deployment resolver, cgroup membership and SDK response are fixtures. The real lease,
      // original cloud/Host scope, physical HOME, native environment, transport
      // and CJS host execute as the engine identity without agent namespaces.
      const admittedCwd = path.join(temporary, "managed-worktree");
      await mkdir(admittedCwd);
      const workload = await new CloudExecutionBoundary({ configuration, workloads }).prepare({
        executionId: lease.admission.executionId, actor: "agent-code", cwd: admittedCwd, workspaceRoot: admittedCwd });
      const launches = vi.spyOn(workload, "wrapSpawn");
      const Constructor = CloudNativeBoundary as unknown as new (...args: unknown[]) => CloudNativeBoundary;
      const boundary = new Constructor(lease, workload, nativeHome, env, { capture: async () => {}, release: async () => {} });
      lease.attach(boundary);
      const execution = { cwd: admittedCwd, lease, model: lease.admission.model, lifetime: lease, customization: lease.customization, coordinator: boundary, productServers: [] } as unknown as executions.CloudProviderExecution;
      vi.spyOn(executions, "cloudProviderExecution").mockImplementation(input => input === boundary ? execution : null);
      host = createCursorHostRuntime({ executionBoundary: boundary, cwd: admittedCwd,
        env: { CURSOR_API_KEY: "synthetic-caller-key", OPENAI_API_KEY: "synthetic-other-provider-key",
          ZEROS_CURSOR_SDK_ENTRY: "/untrusted/sdk.js", ZEROS_LOCAL_WS_TOKEN: "synthetic-engine-authority" } });
      const options = { apiKey: "synthetic-caller-key", cwd: "/untrusted-root", model: { id: "qualified-model" }, local: { autoReview: true } };
      const created = await host.module.Agent.create(options);
      const resumed = await host.module.Agent.resume(created.agentId, options);
      for (const result of [created, resumed]) expect(JSON.parse(result.agentId)).toEqual({ admittedKey: true, environmentKey: true,
        callerKeyAbsent: true, engineIdentity: true, model: "qualified-model", cwd: execution.cwd, localCwd: execution.cwd, store: true, sources: [], autoReview: true });
      expect(launches).toHaveBeenCalledOnce();
      expect(launches.mock.calls[0]![0].env.CURSOR_API_KEY === key).toBe(true);
      expect(launches.mock.calls[0]![0].env.HOME).toBe(nativeHome.paths.home);
      expect(launches.mock.calls[0]![0].env.ZEROS_CURSOR_STATE_ROOT).toBe(path.join(nativeHome.paths.cursorHome, "zeros-store"));
      for (const name of ["OPENAI_API_KEY", "ZEROS_CURSOR_SDK_ENTRY", "ZEROS_LOCAL_WS_TOKEN"]) expect(launches.mock.calls[0]![0].env).not.toHaveProperty(name);
      expect(process.env.CURSOR_API_KEY === ambient).toBe(true);
    } finally {
      await host?.dispose(); await lease.close(); await workloads.drain(workloads.fence());
      expect(await workloads.inspect()).toMatchObject({ complete: true, pendingLaunches: 0, workloadPids: [] });
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
