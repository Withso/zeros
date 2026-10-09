import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as bootstrap from "../cloud-agent-bootstrap";
import {
  CloudAgentBootCredentialRequestSchema, CloudAgentBootCredentialResponseSchema,
  CloudAgentBootRefreshResponseSchema, CloudActorProvenanceSchema,
  CloudAgentWarmActorResponseSchema, CloudAgentCredentialRunInfoSchema,
  CloudAgentActorConfirmRequestSchema, CloudAgentActorConfirmResponseSchema,
} from "../cloud-agent-bootstrap";

const capabilities = { version: 1 as const, goals: false, nativeFork: false, transcriptFork: false,
  nativeReview: false, connectedApps: false, multiAgent: false };
function fixture() {
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 7,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(),
    fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 2 };
  const binding = { ...scope, version: 1 as const, mode: "boot-owner-v1" as const,
    fundingScope: "workspace-roles-v1" as const, authorityEpoch: 3 };
  const provider = { status: "ready" as const, provider: "claude" as const,
    credentialId: randomUUID(), credentialRevision: 2, connectionRevision: 3, adoptionId: randomUUID(), displayName: "Test account",
    kind: "claude-api-key" as const, models: ["claude-sonnet-4-5"], nativeCapabilities: capabilities,
    materialVersion: 1, expiresAt: null, refreshAfter: null, authorityExpiresAt: null,
    material: { kind: "claude-api-key" as const, apiKey: "synthetic-private-provider-key" } };
  const initialAdoptions = [{ provider: "claude", status: "known", adoptionId: provider.adoptionId },
    { provider: "cursor", status: "missing" }, { provider: "codex", status: "unknown" }];
  const response = { ...binding, initialAdoptions, cacheRevision: 1, desiredCacheRevision: 1, providers: [provider,
    { status: "unavailable" as const, provider: "cursor" as const, code: "cloud_agent_credential_required" as const },
    { status: "unavailable" as const, provider: "codex" as const, code: "cloud_agent_credential_required" as const }] };
  const actor = { scope, actorSessionId: randomUUID(), authorityEpoch: 3, confirmedUntilMs: 1_791_468_010_000,
    fundingConsentVersion: 1 as const, fundingGrant: { kind: "owner" as const },
    actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 2,
      role: "owner" as const, fingerprint: "a".repeat(64) } };
  return { scope, binding, provider, response, actor, initialAdoptions };
}

describe("negotiated current boot credential contract", () => {
  it("publishes strict nonsecret conversation metadata without provider material", () => {
    const f = fixture(), { providers: _providers, ...metadata } = f.response;
    expect(bootstrap.CloudAgentBootConversationSchema.parse(metadata)).toEqual(metadata);
    expect(bootstrap.CloudAgentBootConversationSchema.parse({ ...metadata, desiredCacheRevision: 2 }).desiredCacheRevision).toBe(2);
    for (const changed of [f.response, { ...metadata, material: f.provider.material },
      { ...metadata, providers: undefined }, { ...metadata, cacheRevision: 2 }, { ...metadata, heartbeatToken: "synthetic-private-source" }])
      expect(bootstrap.CloudAgentBootConversationSchema.safeParse(changed).success).toBe(false);
  });

  it("separates exact writer activation from bootstrap material and caller identities", () => {
    const f = fixture(), { fundingOwnerUserId: _owner, fundingOwnerEpoch: _epoch, ...reference } = f.scope;
    const request = { ...reference, version: 1, mode: "boot-owner-v1", expectedCacheRevision: 1 };
    const response = { ...f.binding, cacheRevision: 1, activated: true };
    expect(bootstrap.CloudAgentBootActivateRequestSchema.parse(request)).toEqual(request);
    expect(bootstrap.CloudAgentBootActivateResponseSchema.parse(response)).toEqual(response);
    for (const changed of [{ ...request, actorSessionId: randomUUID() }, { ...request, fundingOwnerUserId: _owner },
      { ...request, expectedCacheRevision: 0 }, { ...request, providers: f.response.providers }])
      expect(bootstrap.CloudAgentBootActivateRequestSchema.safeParse(changed).success).toBe(false);
    for (const changed of [{ ...response, activated: false }, { ...response, cacheRevision: 0 },
      { ...response, providers: f.response.providers }, { ...response, material: f.provider.material }])
      expect(bootstrap.CloudAgentBootActivateResponseSchema.safeParse(changed).success).toBe(false);
  });

  it("exports the separately owned direct connection contract through the protocol package", async () => {
    const connection = await import("@zeros/protocol/cloud-runtime-connection");
    expect(connection.isCloudDirectProviderUrl("wss://test-resource-50000.on.boat.dev/ws", 50000)).toBe(true);
    expect(connection.isCloudDirectProviderUrl("https://test-resource-50000.on.boat.dev/ws", 50000)).toBe(false);
  });
  it("accepts only engine scope on bootstrap input; CP selects all funding identity", () => {
    const f = fixture();
    const request = { version: 1, mode: "boot-owner-v1", organizationId: f.scope.organizationId,
      workspaceId: f.scope.workspaceId, generation: f.scope.generation, engineInstanceId: f.scope.engineInstanceId };
    expect(CloudAgentBootCredentialRequestSchema.parse(request)).toEqual(request);
    for (const field of ["fundingOwnerUserId", "bootId", "writerEpoch", "credentialId", "actorSessionId"])
      expect(CloudAgentBootCredentialRequestSchema.safeParse({ ...request, [field]: randomUUID() }).success).toBe(false);
  });

  it("roundtrips exact owner/boot/writer and three independent ready/unavailable slots", () => {
    const f = fixture();
    expect(CloudAgentBootCredentialResponseSchema.parse(JSON.parse(JSON.stringify(f.response)))).toEqual(f.response);
    expect(CloudAgentBootCredentialResponseSchema.safeParse({ ...f.response, providers: f.response.providers.slice(0, 2) }).success).toBe(false);
    expect(CloudAgentBootCredentialResponseSchema.safeParse({ ...f.response, providers: [f.provider, f.provider, f.response.providers[2]] }).success).toBe(false);
    expect(CloudAgentBootCredentialResponseSchema.safeParse({ ...f.response, providers: [...f.response.providers, f.provider] }).success).toBe(false);
  });

  it("dirty bootstrap responses cannot replay old ready secrets or lower the ready epoch", () => {
    const f = fixture();
    expect(CloudAgentBootCredentialResponseSchema.safeParse({ ...f.response, desiredCacheRevision: 2 }).success).toBe(false);
    expect(CloudAgentBootCredentialResponseSchema.safeParse({ ...f.response, cacheRevision: 2 }).success).toBe(false);
    const pending = { ...f.response, desiredCacheRevision: 2, providers: ["claude", "cursor", "codex"].map(provider => ({
      provider, status: "unavailable", code: "cloud_agent_credential_refresh_required" })) };
    expect(CloudAgentBootCredentialResponseSchema.parse(pending)).toEqual(pending);
  });

  it("retains three exact nonsecret initial adoptions without conflating unknown and missing", () => {
    const f = fixture(), response = CloudAgentBootCredentialResponseSchema.parse(f.response);
    expect(response.initialAdoptions).toEqual(f.initialAdoptions);
    for (const initialAdoptions of [f.initialAdoptions.slice(0, 2), [f.initialAdoptions[0], f.initialAdoptions[0], f.initialAdoptions[2]],
      [{ provider: "claude", status: "known" }, ...f.initialAdoptions.slice(1)],
      [{ ...f.initialAdoptions[0], status: "unknown" }, ...f.initialAdoptions.slice(1)]])
      expect(CloudAgentBootCredentialResponseSchema.safeParse({ ...f.response, initialAdoptions }).success).toBe(false);
  });

  it("retry readiness may change without erasing the initial known account or explicit absence", () => {
    const f = fixture(), replacement = { ...f.provider, adoptionId: randomUUID(), credentialRevision: 3 };
    const current = { ...f.response, cacheRevision: 2, desiredCacheRevision: 2, providers: [replacement, ...f.response.providers.slice(1)] };
    expect(CloudAgentBootCredentialResponseSchema.parse(current).initialAdoptions).toEqual(f.initialAdoptions);
    const { initialAdoptions: _baseline, ...missing } = current;
    expect(CloudAgentBootCredentialResponseSchema.safeParse(missing).success).toBe(false);
  });

  it.each(["refreshToken", "idToken", "heartbeatToken", "adminToken"])("rejects unprojected %s from native material", field => {
    const f = fixture();
    const provider = { ...f.provider, material: { ...f.provider.material, [field]: "synthetic-private-source-value" } };
    expect(CloudAgentBootCredentialResponseSchema.safeParse({ ...f.response, providers: [provider, ...f.response.providers.slice(1)] }).success).toBe(false);
  });

  it("does not authorize a mismatched provider/kind or duplicate/unbounded model set", () => {
    const f = fixture();
    for (const change of [{ kind: "cursor-api-key" }, { models: ["same", "same"] },
      { models: Array.from({ length: 129 }, (_, index) => `model-${index}`) }, { models: [] }, { displayName: "untrusted\naccount" }])
      expect(CloudAgentBootCredentialResponseSchema.safeParse({ ...f.response,
        providers: [{ ...f.provider, ...change }, ...f.response.providers.slice(1)] }).success).toBe(false);
  });

  it("keeps upstream source authorization expiry independently of native material expiry", () => {
    const f = fixture(), authorityExpiresAt = "2026-10-08T13:25:00.000Z";
    const provider = { ...f.provider, authorityExpiresAt };
    const result = CloudAgentBootCredentialResponseSchema.parse({ ...f.response, providers: [provider, ...f.response.providers.slice(1)] });
    expect(result.providers[0]).toEqual(provider);
    expect(CloudAgentBootCredentialResponseSchema.safeParse({ ...f.response,
      providers: [{ ...provider, authorityExpiresAt: "never" }, ...f.response.providers.slice(1)] }).success).toBe(false);
  });

  it("Codex refresh requires current selection and matching actual positive-access expiry", () => {
    const f = fixture(), expiresAt = 1_791_471_000;
    const provider = { ...f.provider, provider: "codex", kind: "codex-chatgpt", models: ["gpt-5.4"],
      material: { kind: "codex-chatgpt", accessToken: "synthetic-private-provider-key", accountId: "test-account", expiresAt },
      expiresAt: new Date(expiresAt * 1000).toISOString(), refreshAfter: new Date((expiresAt - 60) * 1000).toISOString() };
    const response = { ...f.binding, cacheRevision: 2, desiredCacheRevision: 2, provider };
    expect(CloudAgentBootRefreshResponseSchema.parse(response)).toEqual(response);
    for (const changed of [{ ...response, desiredCacheRevision: 3 },
      { ...response, provider: f.provider }, { ...response, provider: { ...provider, expiresAt: f.provider.expiresAt } },
      { ...response, provider: { ...provider, refreshAfter: new Date((expiresAt + 1) * 1000).toISOString() } }])
      expect(CloudAgentBootRefreshResponseSchema.safeParse(changed).success).toBe(false);
  });
});

describe("actual actor funding and native context provenance", () => {
  it("detached confirmation resolves recorded identity privately without caller actor or credentials", () => {
    const f = fixture();
    const request = { version: 1, mode: "boot-owner-v1", organizationId: f.scope.organizationId,
      workspaceId: f.scope.workspaceId, generation: f.scope.generation, engineInstanceId: f.scope.engineInstanceId,
      bootId: f.scope.bootId, writerEpoch: f.scope.writerEpoch, actorSessionId: f.actor.actorSessionId };
    expect(CloudAgentActorConfirmRequestSchema.parse(request)).toEqual(request);
    for (const field of ["actor", "fundingOwnerUserId", "deviceKeyVersion", "grantToken"])
      expect(CloudAgentActorConfirmRequestSchema.safeParse({ ...request, [field]: "untrusted" }).success).toBe(false);
    const response = { version: 1, mode: "boot-owner-v1", provenance: f.actor };
    expect(CloudAgentActorConfirmResponseSchema.parse(response)).toEqual(response);
    expect(CloudAgentActorConfirmResponseSchema.safeParse({ ...response, material: f.provider.material }).success).toBe(false);
    const viewer = { ...f.actor, actor: { ...f.actor.actor, role: "viewer" }, fundingConsentVersion: null, fundingGrant: null };
    expect(CloudAgentActorConfirmResponseSchema.parse({ ...response, provenance: viewer }).provenance).toEqual(viewer);
  });
  it("version alone cannot grant funding; exact owner consent is scoped to the bound owner", () => {
    const f = fixture();
    expect(CloudActorProvenanceSchema.parse(f.actor)).toEqual(f.actor);
    expect(CloudActorProvenanceSchema.safeParse({ ...f.actor, fundingGrant: null }).success).toBe(false);
    expect(CloudActorProvenanceSchema.safeParse({ ...f.actor,
      actor: { ...f.actor.actor, userId: randomUUID(), role: "developer" } }).success).toBe(false);
  });

  it.each(["share", "general-access"])("retains the real %s grant ID and revision for member authorization", kind => {
    const f = fixture(), grant = { kind, grantId: randomUUID(), grantRevision: 2 };
    const member = { ...f.actor, actor: { ...f.actor.actor, userId: randomUUID(), role: "developer" }, fundingGrant: grant };
    expect(CloudActorProvenanceSchema.parse(member)).toEqual(member);
    expect(CloudActorProvenanceSchema.safeParse({ ...member, fundingGrant: { kind, grantRevision: 2 } }).success).toBe(false);
    expect(CloudActorProvenanceSchema.safeParse({ ...member, fundingGrant: { ...grant, grantRevision: 0 } }).success).toBe(false);
  });

  it("viewer inspection has no funding secrets; native warm context requires current run authority", () => {
    const f = fixture(), history = { owner: "c".repeat(64), currentKeyVersion: 1, keys: { 1: "a".repeat(43) } };
    const viewer = { ...f.actor, actor: { ...f.actor.actor, role: "viewer" }, fundingConsentVersion: null, fundingGrant: null };
    expect(CloudActorProvenanceSchema.parse(viewer)).toEqual(viewer);
    const context = { ...f.binding, contextId: randomUUID(), contextRevision: "b".repeat(64), actor: f.actor,
      provider: "claude", model: f.provider.models[0], conversationId: "conversation", cwd: "/srv/zeros/workspace/nested",
      gitAuthor: null, customization: null, environment: { version: 1, revision: "d".repeat(64), values: {}, history }, nativeCapabilities: capabilities };
    expect(CloudAgentWarmActorResponseSchema.parse(context)).toEqual(context);
    for (const change of [{ actor: viewer }, { actor: { ...f.actor, authorityEpoch: 4 } }, { cwd: "/srv/zeros/workspace/../other" },
      { actor: { ...f.actor, scope: { ...f.scope, writerEpoch: randomUUID() } } }])
      expect(CloudAgentWarmActorResponseSchema.safeParse({ ...context, ...change }).success).toBe(false);
  });

  it("credential run info binds actual dispatch identity and contains no native material", () => {
    const f = fixture(), info = { version: 1, bootId: f.scope.bootId, writerEpoch: f.scope.writerEpoch, cacheRevision: 1,
      provider: "claude", fundingOwnerUserId: f.scope.fundingOwnerUserId, fundingOwnerEpoch: f.scope.fundingOwnerEpoch,
      credentialId: f.provider.credentialId, credentialRevision: f.provider.credentialRevision,
      connectionRevision: f.provider.connectionRevision, adoptionId: f.provider.adoptionId,
      materialVersion: f.provider.materialVersion, displayName: f.provider.displayName };
    expect(CloudAgentCredentialRunInfoSchema.parse(info)).toEqual(info);
    expect(CloudAgentCredentialRunInfoSchema.safeParse({ ...info, material: f.provider.material }).success).toBe(false);
    expect(CloudAgentCredentialRunInfoSchema.safeParse({ ...info, adoptionId: "private-material-fingerprint" }).success).toBe(false);
    const { adoptionId: _adoption, ...missing } = info;
    expect(CloudAgentCredentialRunInfoSchema.safeParse(missing).success).toBe(false);
  });
});
