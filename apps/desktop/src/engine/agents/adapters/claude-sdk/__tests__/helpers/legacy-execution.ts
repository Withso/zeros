import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import { vi } from "vitest";
import type { CloudCustomizationSnapshot, CloudMcpServer } from "@zeros/protocol/cloud-customization";
import { cloudMcpDigest } from "../../../../cloud-mcp";
import { cloudProviderExecution, createCloudAgentExecutionFactory } from "../../../../cloud-provider-execution";
import { CloudNativeBoundary, cloudNativeProviderEnvironment } from "../../../../containment/cloud-native-boundary";
import { CloudExecutionBoundary } from "../../../../containment/cloud-execution-boundary";
import { portableCloudWorkloads } from "../../../../containment/__tests__/helpers/portable-cloud-custody";
import { createCloudNativeHome } from "../../../../containment/cloud-native-home";
import * as workerConfiguration from "../../../../containment/cloud-worker-config";
import * as runtimeRoot from "../../../../containment/cloud-runtime-root.mjs";
import { testCloudRuntime } from "../../../../__tests__/helpers/test-cloud-runtime";

/** Original Host-backed cloud scope and physical state. Deployment admission
 * and cgroup IO are explicit fixtures; Host/proc births are real. This does not
 * qualify native kernel entry. No namespace or provider is started. */
export async function prepareClaudeCloudWorkload(input: { cwd: string; executionId: string;
  conversationId: string; provider: "claude" | "codex" | "cursor"; dataRoot?: string }) {
  const ownRoot = input.dataRoot === undefined;
  const dataRoot = await realpath(input.dataRoot ?? await mkdtemp(path.join(os.tmpdir(), "zeros-claude-consumer-")));
  const configuration = { version: 4 as const, backend: "cloud-worker" as const, profile: "zeros-cloud-worker-v4" as const,
    uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
    toolchain: { node: process.execPath, supervisor: path.resolve("apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs") } };
  const guard = vi.spyOn(workerConfiguration, "isCloudWorkerConfiguration").mockImplementation(
    (value: unknown): value is workerConfiguration.CloudWorkerConfiguration => value === configuration);
  // Keep the caller's resolver authority (including deliberate legacy-profile
  // refusals). A nested spy would reset that original fixture on restoration.
  let restoreRuntime: (() => void) | undefined;
  try { runtimeRoot.resolveCloudRuntime(); }
  catch {
    const runtime = vi.spyOn(runtimeRoot, "resolveCloudRuntime").mockReturnValue(testCloudRuntime());
    restoreRuntime = () => { runtime.mockRestore(); };
  }
  let workloads: ReturnType<typeof portableCloudWorkloads>;
  let boundary: CloudExecutionBoundary;
  try {
    workloads = portableCloudWorkloads(configuration);
    boundary = new CloudExecutionBoundary({ configuration, workloads });
  } finally { guard.mockRestore(); restoreRuntime?.(); }
  try {
    const nativeHome = await createCloudNativeHome({ ...input, dataRoot });
    const workload = await boundary.prepare({ executionId: input.executionId, actor: "agent-code",
      cwd: input.cwd, workspaceRoot: input.cwd, providerId: input.provider });
    vi.spyOn(workload, "stopAndProve");
    return { workload, workloads, nativeHome, dispose: async () => {
      await workloads.drain(workloads.fence());
      if (ownRoot) await rm(dataRoot, { recursive: true, force: true });
    } };
  } catch (error) {
    await workloads.drain(workloads.fence());
    if (ownRoot) await rm(dataRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Real legacy admission and factory-minted common metadata. Only native
 * boundary preparation is simulated; the policy suite separately launches
 * the pinned CLI in its private network namespace with actual marker guards. */
export async function legacyClaudePolicyFixture(root: string, servers: CloudMcpServer[] = [], kind: "api" | "setup" = "api") {
  const cwd = path.join(root, "project"), executionId = randomUUID(), leaseId = randomUUID(), conversationId = randomUUID();
  const physical = await prepareClaudeCloudWorkload({ cwd, executionId, conversationId, provider: "claude", dataRoot: root });
  const { workload, nativeHome } = physical;
  const runtime = vi.spyOn(runtimeRoot, "resolveCloudRuntime").mockReturnValue(testCloudRuntime());
  const native = vi.spyOn(CloudNativeBoundary, "prepare").mockImplementationOnce(async lease => ({ ...workload, nativeHome,
    providerHomePath: nativeHome.paths.home, environment: () => cloudNativeProviderEnvironment(lease.takeMaterial(), lease.admission.model,
      undefined, lease.environment?.values, nativeHome), hasBackgroundServers: async () => false,
  }) as unknown as CloudNativeBoundary);
  const snapshot = { version: 1 as const, repositoryDigest: cloudMcpDigest([]),
    servers: servers.map(server => ({ server, scope: "member" as const, secretRef: null, revision: 0 })),
    skills: [], cursorTeamSettings: "disabled" as const };
  const customization = { ...snapshot, digest: cloudMcpDigest(snapshot) } satisfies CloudCustomizationSnapshot;
  const credentialKind = kind === "setup" ? "claude-setup-token" : "claude-api-key";
  const factory = createCloudAgentExecutionFactory({ supervisor: { onRetirementFailure: vi.fn() }, request: async request => {
    if (request.kind === "release") return { released: true };
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    if (request.kind !== "admit") return { leaseId, credentialVersion: 1, expiresAt };
    return { leaseId, authorityId: "a".repeat(64), credentialVersion: 1, expiresAt, credentialKind, provider: "claude",
      model: "claude-haiku-4-5", customization, material: kind === "setup" ?
        { kind: "claude-setup-token", accessToken: "synthetic-native-policy-setup" } :
        { kind: "claude-api-key", apiKey: "synthetic-native-policy-key" } };
  } });
  try {
    const result = await factory.prepare({ admission: { executionId, delegationId: randomUUID(), provider: "claude", model: "claude-haiku-4-5",
      source: { kind: "session", actorSessionId: randomUUID() } }, conversationId, workload, cwd,
      signal: new AbortController().signal, customization: true });
    const execution = cloudProviderExecution(result.boundary);
    if (!execution || execution.mode !== "actor-grant-v1" || !execution.customization || execution.customization !== execution.lease.customization)
      throw new Error("Expected factory-minted normalized legacy customization");
    return { execution, close: async () => {
      try { await result.boundary.stopAndProve(); await physical.dispose(); } finally { native.mockRestore(); runtime.mockRestore(); }
    } };
  } catch (error) {
    native.mockRestore(); runtime.mockRestore(); await physical.dispose(); throw error;
  }
}
