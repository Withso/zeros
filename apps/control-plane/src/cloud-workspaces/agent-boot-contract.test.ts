import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as Wire from "../../../../packages/protocol/src/cloud-agent-bootstrap.js";
import * as Standalone from "./agent-boot-contract.js";

type Parser = { safeParse(value: unknown): { success: boolean; data?: unknown } };
const engine = () => ({ organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID() });
const identity = () => ({ ...engine(), version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
  bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1, authorityEpoch: 1 });
const ready = () => ({ status: "ready", provider: "codex", kind: "codex-chatgpt", credentialId: randomUUID(),
  credentialRevision: 1, connectionRevision: 1, adoptionId: randomUUID(), displayName: "Codex test account", models: ["gpt-5.4"],
  nativeCapabilities: { version: 1, goals: false, nativeFork: false, transcriptFork: false, nativeReview: false, connectedApps: false, multiAgent: false },
  materialVersion: 1, expiresAt: "2030-01-01T00:00:00.000Z", refreshAfter: "2029-12-31T23:59:00.000Z", authorityExpiresAt: null,
  material: { kind: "codex-chatgpt", accountId: "synthetic-account", accessToken: "synthetic-positive-access-token", expiresAt: 1893456000 } });
const snapshot = () => ({ ...identity(), cacheRevision: 1, desiredCacheRevision: 1,
  initialAdoptions: [{ provider: "claude", status: "missing" }, { provider: "codex", status: "unknown" }, { provider: "cursor", status: "missing" }],
  providers: [ready(), { status: "unavailable", provider: "claude", code: "cloud_agent_credential_required" },
    { status: "unavailable", provider: "cursor", code: "cloud_agent_credential_required" }] });
const provenance = (boot = identity()) => ({
  scope: { organizationId: boot.organizationId, workspaceId: boot.workspaceId, generation: boot.generation,
    engineInstanceId: boot.engineInstanceId, bootId: boot.bootId, writerEpoch: boot.writerEpoch,
    fundingOwnerUserId: boot.fundingOwnerUserId, fundingOwnerEpoch: boot.fundingOwnerEpoch },
  actor: { userId: boot.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 1, fingerprint: "a".repeat(64), role: "owner" },
  actorSessionId: randomUUID(), authorityEpoch: boot.authorityEpoch, confirmedUntilMs: Date.now() + 10_000,
  fundingConsentVersion: 1, fundingGrant: { kind: "owner" },
});
function parity(backend: Parser, wire: Parser, value: unknown, valid: boolean) {
  const result = backend.safeParse(value), remote = wire.safeParse(value);
  expect(result.success).toBe(valid); expect(remote.success).toBe(valid);
  if (valid) expect(result.data).toEqual(remote.data);
}

describe("standalone CP boot schema parity", () => {
  it("mirrors separate ready-epoch activation without widening native or bootstrap envelopes",()=>{
    const value=identity(),request={version:1,mode:value.mode,organizationId:value.organizationId,workspaceId:value.workspaceId,generation:1,
      engineInstanceId:value.engineInstanceId,bootId:value.bootId,writerEpoch:value.writerEpoch,expectedCacheRevision:1};
    parity(Standalone.CloudAgentBootActivateRequestSchema,Wire.CloudAgentBootActivateRequestSchema,request,true);
    parity(Standalone.CloudAgentBootActivateResponseSchema,Wire.CloudAgentBootActivateResponseSchema,{...value,cacheRevision:1,activated:true},true);
    parity(Standalone.CloudAgentBootActivateResponseSchema,Wire.CloudAgentBootActivateResponseSchema,{...value,cacheRevision:1,activated:true,material:"private"},false);
  });
  it("accepts the engine-only bootstrap body without caller funding selectors", () => {
    parity(Standalone.CloudAgentBootCredentialRequestSchema, Wire.CloudAgentBootCredentialRequestSchema,
      { ...engine(), version: 1, mode: "boot-owner-v1" }, true);
  });

  it.each(["fundingOwnerUserId", "ownerUserId", "credentialId", "actor", "actorUserId", "writerEpoch", "bootId"])(
    "refuses a renderer-selected bootstrap %s", field => {
      parity(Standalone.CloudAgentBootCredentialRequestSchema, Wire.CloudAgentBootCredentialRequestSchema,
        { ...engine(), version: 1, mode: "boot-owner-v1", [field]: randomUUID() }, false);
    });

  it("accepts current ready positive access without any refresh material", () => {
    parity(Standalone.CloudAgentBootProviderReadySchema, Wire.CloudAgentBootProviderReadySchema, ready(), true);
    parity(Standalone.CloudAgentBootCredentialResponseSchema, Wire.CloudAgentBootCredentialResponseSchema, snapshot(), true);
  });

  it.each(["refreshToken", "id_token", "nativeCache", "engineHeartbeatToken", "environment", "tokens"])(
    "rejects private material field %s", field => {
      const value = ready(); value.material = { ...value.material, [field]: "synthetic-private-field" };
      parity(Standalone.CloudAgentBootProviderReadySchema, Wire.CloudAgentBootProviderReadySchema, value, false);
    });

  it.each([
    { provider: "claude" }, { kind: "codex-api-key" }, { expiresAt: null }, { refreshAfter: null },
    { expiresAt: "2030-01-01T00:00:01.000Z" }, { refreshAfter: "2030-01-01T00:00:01.000Z" },
    { models: ["gpt-5.4", "gpt-5.4"] }, { models: [] }, { models: Array.from({ length: 129 }, (_, i) => `model-${i}`) },
    { credentialRevision: 0 }, { connectionRevision: -1 }, { materialVersion: Number.MAX_SAFE_INTEGER + 1 },
    { adoptionId: "missing-account-sentinel" }, { authorityExpiresAt: "unbounded" }, { displayName: "private\nlabel" },
  ])("refuses inconsistent provider metadata %#", patch => {
    parity(Standalone.CloudAgentBootProviderReadySchema, Wire.CloudAgentBootProviderReadySchema, { ...ready(), ...patch }, false);
  });

  it("parks a dirty snapshot with no obsolete positive material", () => {
    const value = snapshot(); value.desiredCacheRevision = 2;
    parity(Standalone.CloudAgentBootCredentialResponseSchema, Wire.CloudAgentBootCredentialResponseSchema, value, false);
    parity(Standalone.CloudAgentBootCredentialResponseSchema, Wire.CloudAgentBootCredentialResponseSchema, {
      ...value, providers: ["claude", "codex", "cursor"].map(provider => ({ status: "unavailable", provider, code: "cloud_agent_credential_refresh_required" })),
    }, true);
  });

  it("rejects regressed revisions and duplicated or missing provider slots", () => {
    const value = snapshot();
    for (const invalid of [{ ...value, cacheRevision: 2 }, { ...value, providers: value.providers.slice(1) },
      { ...value, providers: [value.providers[0], value.providers[0], value.providers[2]] }])
      parity(Standalone.CloudAgentBootCredentialResponseSchema, Wire.CloudAgentBootCredentialResponseSchema, invalid, false);
  });

  it("refreshes only the current ready Codex subscription selection", () => {
    const value = { ...identity(), cacheRevision: 1, desiredCacheRevision: 1, provider: ready() };
    parity(Standalone.CloudAgentBootRefreshResponseSchema, Wire.CloudAgentBootRefreshResponseSchema, value, true);
    parity(Standalone.CloudAgentBootRefreshResponseSchema, Wire.CloudAgentBootRefreshResponseSchema, { ...value, desiredCacheRevision: 2 }, false);
  });

  it("strictly binds background sync and refresh to expected revisions", () => {
    const base = identity(), reference = { version: 1, mode: base.mode, organizationId: base.organizationId, workspaceId: base.workspaceId,
      generation: base.generation, engineInstanceId: base.engineInstanceId, bootId: base.bootId, writerEpoch: base.writerEpoch, expectedCacheRevision: 1 };
    parity(Standalone.CloudAgentBootSyncRequestSchema, Wire.CloudAgentBootSyncRequestSchema, reference, true);
    parity(Standalone.CloudAgentBootSyncRequestSchema, Wire.CloudAgentBootSyncRequestSchema, { ...reference, fundingOwnerUserId: base.fundingOwnerUserId }, false);
    const refresh = { ...reference, provider: "codex", credentialId: randomUUID(), credentialRevision: 1, expectedMaterialVersion: 1 };
    parity(Standalone.CloudAgentBootRefreshRequestSchema, Wire.CloudAgentBootRefreshRequestSchema, refresh, true);
    parity(Standalone.CloudAgentBootRefreshRequestSchema, Wire.CloudAgentBootRefreshRequestSchema, { ...refresh, expectedMaterialVersion: 0 }, false);
  });

  it("preserves actual nonsecret account-use identity separately from token revision", () => {
    const boot = identity(), provider = ready(), value = { version: 1, bootId: boot.bootId, writerEpoch: boot.writerEpoch, cacheRevision: 1,
      provider: provider.provider, fundingOwnerUserId: boot.fundingOwnerUserId, fundingOwnerEpoch: boot.fundingOwnerEpoch,
      credentialId: provider.credentialId, credentialRevision: 1, connectionRevision: 1, adoptionId: provider.adoptionId, materialVersion: 2, displayName: provider.displayName };
    parity(Standalone.CloudAgentCredentialRunInfoSchema, Wire.CloudAgentCredentialRunInfoSchema, value, true);
    parity(Standalone.CloudAgentCredentialRunInfoSchema, Wire.CloudAgentCredentialRunInfoSchema, { ...value, material: provider.material }, false);
  });

  it("requires an exact funding owner or a real versioned share/general grant", () => {
    const value = provenance();
    parity(Standalone.CloudActorProvenanceSchema, Wire.CloudActorProvenanceSchema, value, true);
    parity(Standalone.CloudActorProvenanceSchema, Wire.CloudActorProvenanceSchema,
      { ...value, actor: { ...value.actor, userId: randomUUID() } }, false);
    for (const kind of ["share", "general-access"]) parity(Standalone.CloudActorProvenanceSchema, Wire.CloudActorProvenanceSchema,
      { ...value, actor: { ...value.actor, userId: randomUUID(), role: "developer" }, fundingGrant: { kind, grantId: randomUUID(), grantRevision: 1 } }, true);
    parity(Standalone.CloudActorProvenanceSchema, Wire.CloudActorProvenanceSchema, { ...value, fundingGrant: null }, false);
    parity(Standalone.CloudActorProvenanceSchema, Wire.CloudActorProvenanceSchema, { ...value, fundingConsentVersion: null }, false);
  });

  it("permits a verified viewer inspection with no funding authority", () => {
    const value = provenance();
    parity(Standalone.CloudActorProvenanceSchema, Wire.CloudActorProvenanceSchema,
      { ...value, actor: { ...value.actor, role: "viewer" }, fundingGrant: null, fundingConsentVersion: null }, true);
  });

  it("keeps unknown, explicit absence and known initial identity distinct and nonsecret", () => {
    const value = [{ provider: "claude", status: "missing" }, { provider: "codex", status: "known", adoptionId: randomUUID() },
      { provider: "cursor", status: "unknown" }];
    parity(Standalone.CloudAgentInitialAdoptionsSchema, Wire.CloudAgentInitialAdoptionsSchema, value, true);
    parity(Standalone.CloudAgentInitialAdoptionsSchema, Wire.CloudAgentInitialAdoptionsSchema, value.slice(1), false);
    parity(Standalone.CloudAgentInitialAdoptionsSchema, Wire.CloudAgentInitialAdoptionsSchema, [value[0], value[0], value[2]], false);
    parity(Standalone.CloudAgentInitialAdoptionsSchema, Wire.CloudAgentInitialAdoptionsSchema,
      [value[0], { ...value[1], material: ready().material }, value[2]], false);
  });

  it("confirms the recorded actor through private engine scope without supplied actor/funding fields", () => {
    const boot = identity(), value = { version: 1, mode: "boot-owner-v1", organizationId: boot.organizationId, workspaceId: boot.workspaceId,
      generation: boot.generation, engineInstanceId: boot.engineInstanceId, bootId: boot.bootId, writerEpoch: boot.writerEpoch, actorSessionId: randomUUID() };
    parity(Standalone.CloudAgentActorConfirmRequestSchema, Wire.CloudAgentActorConfirmRequestSchema, value, true);
    for (const field of ["actor", "fundingOwnerUserId", "confirmedUntilMs", "fundingGrant", "deviceKeyVersion"])
      parity(Standalone.CloudAgentActorConfirmRequestSchema, Wire.CloudAgentActorConfirmRequestSchema, { ...value, [field]: randomUUID() }, false);
    const response = { version: 1, mode: "boot-owner-v1", provenance: provenance(boot) };
    parity(Standalone.CloudAgentActorConfirmResponseSchema, Wire.CloudAgentActorConfirmResponseSchema, response, true);
    parity(Standalone.CloudAgentActorConfirmResponseSchema, Wire.CloudAgentActorConfirmResponseSchema, { ...response, material: ready().material }, false);
  });

  it.each([
    { confirmedUntilMs: 0 }, { confirmedUntilMs: Number.MAX_SAFE_INTEGER + 1 }, { authorityEpoch: 0 },
    { fundingGrant: { kind: "share", grantId: "caller-forged", grantRevision: 1 } },
    { fundingGrant: { kind: "share", grantId: randomUUID(), grantRevision: 0 } },
    { engineHeartbeatToken: "synthetic-engine-private-token" },
  ])("refuses incomplete recorded actor provenance %#", patch => {
    parity(Standalone.CloudActorProvenanceSchema, Wire.CloudActorProvenanceSchema, { ...provenance(), ...patch }, false);
  });

  it("requires the warm actor scope to echo the exact admitted boot and run authority", () => {
    const boot = identity(), actor = provenance(boot), history = { owner: "b".repeat(64), currentKeyVersion: 1, keys: { "1": "a".repeat(43) } };
    const value = { ...boot, contextId: randomUUID(), contextRevision: "c".repeat(64), actor, conversationId: "chat", provider: "codex",
      model: "gpt-5.4", cwd: "/srv/zeros/workspace/nested", gitAuthor: null, customization: null,
      environment: { version: 1, revision: "d".repeat(64), values: { APP_VALUE: "synthetic-safe-value" }, history }, nativeCapabilities: ready().nativeCapabilities };
    parity(Standalone.CloudAgentWarmActorResponseSchema, Wire.CloudAgentWarmActorResponseSchema, value, true);
    parity(Standalone.CloudAgentWarmActorResponseSchema, Wire.CloudAgentWarmActorResponseSchema,
      { ...value, actor: { ...actor, authorityEpoch: 2 } }, false);
    parity(Standalone.CloudAgentWarmActorResponseSchema, Wire.CloudAgentWarmActorResponseSchema,
      { ...value, actor: { ...actor, scope: { ...actor.scope, bootId: randomUUID() } } }, false);
    parity(Standalone.CloudAgentWarmActorResponseSchema, Wire.CloudAgentWarmActorResponseSchema,
      { ...value, actor: { ...actor, actor: { ...actor.actor, role: "viewer" } } }, false);
    parity(Standalone.CloudAgentWarmActorResponseSchema, Wire.CloudAgentWarmActorResponseSchema,
      { ...value, environment: { ...value.environment, values: { OPENAI_BASE_URL: "https://synthetic-forbidden.invalid" } } }, false);
  });
});
