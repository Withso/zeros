import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { CloudAgentBootCredentialResponse, CloudAgentWarmActorRequest, CloudAgentWarmActorResponse } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudActorAuthorityRegistry } from "../../cloud-actor-authority";
import { CloudAgentCredentialCache } from "../../cloud-agent-credential-cache";
import { CloudAgentContextCache, createCloudBootAgentExecutionFactory, cloudBootNativeAuthority } from "../../cloud-provider-execution";

/** Real private registry/cache/factory identity with synthetic admitted data.
 * Native containment, CP endpoints and provider qualification are not proven. */
export async function testCloudBootFixture(cwd = "/srv/zeros/workspace", provider: "cursor" | "codex" | "claude" = "cursor") {
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  let live = true;
  const engineLive = () => live, registry = new CloudActorAuthorityRegistry({ scope, engineLive });
  const provenance = { scope, actorSessionId: randomUUID(), authorityEpoch: 1, confirmedUntilMs: Date.now() + 8_000,
    fundingConsentVersion: 1 as const, fundingGrant: { kind: "owner" as const }, actor: { userId: scope.fundingOwnerUserId,
      deviceId: randomUUID(), deviceKeyVersion: 1, role: "owner" as const, fingerprint: "a".repeat(64) } };
  const actor = registry.confirm(provenance);
  const nativeCapabilities = { version: 1 as const, goals: false, nativeFork: provider === "codex", transcriptFork: false,
    nativeReview: false, connectedApps: false, multiAgent: false };
  const response: CloudAgentBootCredentialResponse = { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
    authorityEpoch: 1, cacheRevision: 1, desiredCacheRevision: 1,
    initialAdoptions: [{ provider: "cursor", status: "missing" }, { provider: "claude", status: "missing" }, { provider: "codex", status: "missing" }],
    providers: [{ provider, status: "ready", credentialId: randomUUID(), credentialRevision: 1, connectionRevision: 1,
      adoptionId: randomUUID(), displayName: "Synthetic account", kind: provider === "cursor" ? "cursor-api-key" : provider === "claude" ? "claude-api-key" : "codex-api-key", models: ["test-model"],
      nativeCapabilities, materialVersion: 1, expiresAt: null, refreshAfter: null, authorityExpiresAt: null,
      material: { kind: provider === "cursor" ? "cursor-api-key" : provider === "claude" ? "claude-api-key" : "codex-api-key", apiKey: "synthetic-cursor-private-key" } },
      { provider: provider === "claude" ? "codex" : "claude", status: "unavailable", code: "cloud_agent_credential_required" },
      { provider: provider === "cursor" ? "codex" : "cursor", status: "unavailable", code: "cloud_agent_credential_required" }] };
  const request = { bootstrap: vi.fn(async () => response), sync: vi.fn(async () => response) };
  const credentials = new CloudAgentCredentialCache({ scope, engineLive, request });
  await credentials.initialize();
  const contextRequest = vi.fn(async (input: CloudAgentWarmActorRequest) => ({ ...scope, version: 1, mode: "boot-owner-v1",
    fundingScope: "workspace-roles-v1", authorityEpoch: 1, contextId: randomUUID(), contextRevision: "b".repeat(64), actor: provenance,
    provider: input.provider, model: input.model, conversationId: input.conversationId, cwd: input.cwd, customization: null,
    nativeCapabilities, gitAuthor: { name: "Test member", email: "1234+test@users.noreply.github.com" },
    environment: { version: 1, revision: "c".repeat(64), values: { TEST_ADMITTED: "synthetic-actor-setting" },
      history: { owner: "d".repeat(64), currentKeyVersion: 1, keys: { 1: "a".repeat(43) } } },
  } satisfies CloudAgentWarmActorResponse));
  const contexts = new CloudAgentContextCache({ scope, registry, engineLive, isAdmittedCwd: root => root === cwd, request: contextRequest });
  const base = { actor, provider, conversationId: "conversation", model: "test-model", cwd };
  const context = await contexts.warm(base), input = { ...base, context, executionId: randomUUID() };
  const canStart = vi.fn(() => true), legacy = { prepare: vi.fn(async () => { throw new Error("Unexpected legacy admission"); }) };
  const factory = createCloudBootAgentExecutionFactory({ legacy, credentials, contexts, registry, engineLive, canStart,
    supervisor: { onRetirementFailure: vi.fn() } });
  const selection = factory.selectBoot(input), authority = cloudBootNativeAuthority(selection);
  return { scope, actor, provenance, response, credentials, contexts, input, selection, authority, factory, request, contextRequest, canStart, legacy,
    close: async () => { await factory.disposeBoot(); contexts.dispose(); credentials.dispose(); registry.dispose(); live = false; } };
}
