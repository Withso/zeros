import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { CloudAgentBootCredentialResponse, CloudAgentBootProviderReady, CloudAgentWarmActorResponse } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudActorAuthorityRegistry } from "../../../../cloud-actor-authority";
import { CloudAgentCredentialCache } from "../../../../cloud-agent-credential-cache";
import { CloudAgentContextCache, cloudProviderExecution, createCloudBootAgentExecutionFactory } from "../../../../cloud-provider-execution";
import { CloudNativeBoundary, cloudNativeProviderEnvironment } from "../../../../containment/cloud-native-boundary";
import type { PreparedBoundary } from "../../../../containment/types";
import * as repositoryMcp from "../../../../cloud-mcp";

/** Real private cache/registry/context/factory identities; only native
 * filesystem/process preparation is mocked. No provider or namespace starts. */
export async function bootClaudeExecutionFixture() {
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 7, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 2 };
  const registry = new CloudActorAuthorityRegistry({ scope, engineLive: () => true });
  const provenance = { scope, actorSessionId: randomUUID(), authorityEpoch: 3, confirmedUntilMs: Date.now() + 8000,
    fundingConsentVersion: 1 as const, fundingGrant: { kind: "owner" as const },
    actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 2,
      role: "owner" as const, fingerprint: "a".repeat(64) } };
  const actor = registry.confirm(provenance);
  const nativeCapabilities = { version: 1 as const, goals: false, nativeFork: false, transcriptFork: false,
    nativeReview: false, connectedApps: false, multiAgent: false };
  const provider: CloudAgentBootProviderReady = { status: "ready", provider: "claude", credentialId: randomUUID(), credentialRevision: 2,
    connectionRevision: 3, adoptionId: randomUUID(), displayName: "Test account", kind: "claude-api-key", models: ["claude-haiku-4-5"],
    nativeCapabilities, materialVersion: 1, expiresAt: null, refreshAfter: null, authorityExpiresAt: null,
    material: { kind: "claude-api-key", apiKey: "synthetic-selected-provider" } };
  const response: CloudAgentBootCredentialResponse = { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
    authorityEpoch: 3, cacheRevision: 1, desiredCacheRevision: 1,
    initialAdoptions: [{ provider: "claude", status: "known", adoptionId: provider.adoptionId },
      { provider: "cursor", status: "missing" }, { provider: "codex", status: "missing" }],
    providers: [provider, { status: "unavailable", provider: "cursor", code: "cloud_agent_credential_required" },
      { status: "unavailable", provider: "codex", code: "cloud_agent_credential_required" }] };
  const request = { bootstrap: vi.fn(async () => response), sync: vi.fn(async () => response) };
  const credentials = new CloudAgentCredentialCache({ scope, engineLive: () => true, request }); await credentials.initialize();
  const history = { owner: "c".repeat(64), currentKeyVersion: 1, keys: { 1: "a".repeat(43) } };
  const contextResponse: CloudAgentWarmActorResponse = { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
    authorityEpoch: 3, contextId: randomUUID(), contextRevision: "b".repeat(64), actor: provenance, provider: "claude", model: provider.models[0]!,
    cwd: "/srv/zeros/workspace", conversationId: "conversation", customization: null, nativeCapabilities,
    gitAuthor: { name: "Sending member", email: "1234+sender@users.noreply.github.com" },
    environment: { version: 1, revision: "d".repeat(64), values: { ACTOR_PRIVATE: "synthetic-actor-context" }, history } };
  const contexts = new CloudAgentContextCache({ scope, registry, engineLive: () => true, isAdmittedCwd: () => true,
    request: vi.fn(async () => contextResponse) });
  const base = { actor, provider: "claude" as const, model: contextResponse.model, cwd: contextResponse.cwd, conversationId: contextResponse.conversationId };
  const mcp = vi.spyOn(repositoryMcp,"readCloudRepositoryMcp").mockResolvedValue([]);
  const context = await contexts.warm(base);
  const input = { ...base, context, executionId: randomUUID() }, canStart = vi.fn(() => true);
  const factory = createCloudBootAgentExecutionFactory({ credentials, registry, contexts, engineLive: () => true, canStart,
    legacy: { prepare: vi.fn(async () => { throw new Error("Legacy path was selected"); }) }, supervisor: { onRetirementFailure: vi.fn() } });
  const stop = vi.fn(async () => {});
  const workload = { generation: "fixture", status: { version: 1, actor: "agent-code", backend: "cloud-worker", state: "ready",
    designProtection: { required: true, enforced: true, protectedDirectoryCount: 1 }, parity: { level: "restricted", restrictions: [] }, checkedAt: Date.now() },
    attestation: Promise.resolve(), stopAndProve: stop, revoke: stop,
    activePorts: () => [], onPortsChanged: () => () => {}, portDiscoveryStatus: () => ({ state: "idle" }) } as unknown as PreparedBoundary;
  const native = vi.spyOn(CloudNativeBoundary, "prepareBoot").mockImplementation(async authority => ({ ...workload,
    environment: () => cloudNativeProviderEnvironment(authority.takeMaterial(), authority.model, undefined, authority.environment?.values),
    providerHomePath: "/srv/zeros/home/agent", hasBackgroundServers: async () => false,
  }) as unknown as CloudNativeBoundary);
  const selection = factory.selectBoot(input); await factory.launchBootSelection(selection, async () => workload);
  const result = await factory.prepareBoot({ selection, workload, signal: new AbortController().signal });
  const execution = cloudProviderExecution(result.boundary)!;
  return { input, factory, selection, execution, boundary: result.boundary, env: result.env, request, canStart,
    dispose: async () => { try { await factory.disposeBoot(); } finally { native.mockRestore(); mcp.mockRestore(); contexts.dispose(); credentials.dispose(); registry.dispose(); } } };
}
