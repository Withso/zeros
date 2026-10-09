import { randomUUID } from "node:crypto";
import path from "node:path";
import { vi } from "vitest";
import type { CloudCustomizationSnapshot, CloudMcpServer } from "@zeros/protocol/cloud-customization";
import { cloudMcpDigest } from "../../../../cloud-mcp";
import { cloudProviderExecution, createCloudAgentExecutionFactory } from "../../../../cloud-provider-execution";
import { CloudNativeBoundary } from "../../../../containment/cloud-native-boundary";
import * as runtimeRoot from "../../../../containment/cloud-runtime-root.mjs";
import { testCloudRuntime } from "../../../../__tests__/helpers/test-cloud-runtime";
import { testExecutionBoundary } from "../../../../__tests__/helpers/test-execution-boundary";

/** Real legacy admission and factory-minted common metadata. Only native
 * boundary preparation is simulated; the policy suite separately launches
 * the pinned CLI in its private network namespace with actual marker guards. */
export async function legacyClaudePolicyFixture(root: string, servers: CloudMcpServer[] = [], kind: "api" | "setup" = "api") {
  const cwd = path.join(root, "project"), executionId = randomUUID(), leaseId = randomUUID();
  const workload = await testExecutionBoundary().prepare({ executionId, actor: "agent-code", cwd, workspaceRoot: cwd });
  const runtime = vi.spyOn(runtimeRoot, "resolveCloudRuntime").mockReturnValue(testCloudRuntime());
  const native = vi.spyOn(CloudNativeBoundary, "prepare").mockResolvedValueOnce({ ...workload,
    providerHomePath: path.join(root, "home"), environment: () => ({}), hasBackgroundServers: async () => false,
  } as unknown as CloudNativeBoundary);
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
      source: { kind: "session", actorSessionId: randomUUID() } }, conversationId: randomUUID(), workload, cwd,
      signal: new AbortController().signal, customization: true });
    const execution = cloudProviderExecution(result.boundary);
    if (!execution || execution.mode !== "actor-grant-v1" || !execution.customization || execution.customization !== execution.lease.customization)
      throw new Error("Expected factory-minted normalized legacy customization");
    return { execution, close: async () => {
      try { await result.boundary.stopAndProve(); } finally { native.mockRestore(); runtime.mockRestore(); }
    } };
  } catch (error) {
    native.mockRestore(); runtime.mockRestore(); await workload.stopAndProve(); throw error;
  }
}
