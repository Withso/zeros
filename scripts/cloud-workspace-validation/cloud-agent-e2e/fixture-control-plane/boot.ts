import { randomBytes, randomUUID } from "node:crypto";
import {
  CloudAgentActorConfirmRequestSchema, CloudAgentActorConfirmResponseSchema,
  CloudAgentBootActivateRequestSchema, CloudAgentBootActivateResponseSchema,
  CloudAgentBootCredentialRequestSchema, CloudAgentBootCredentialResponseSchema,
  CloudAgentBootRefreshRequestSchema, CloudAgentBootSyncRequestSchema,
  CloudAgentFundingGrantSchema, CloudAgentWarmActorRequestSchema, CloudAgentWarmActorResponseSchema,
  type CloudActorProvenance, type CloudAgentBootCredentialResponse, type CloudAgentBootProviderReady,
  type CloudAgentBootScope, type CloudAgentWarmActorResponse,
} from "@zeros/protocol/cloud-agent-bootstrap";
import { cloudActorCan, type CloudCommandActor } from "@zeros/protocol/cloud-actors";
import { CloudAgentAccessMaterialSchema, type CloudAgentAccessMaterial } from "@zeros/protocol/cloud-agent-execution";
import { z } from "zod";
import { cloudAgentModels } from "../../../../apps/control-plane/src/cloud-workspaces/agent-models";
import { canonical, clone, FixtureRefusal, parse, ScopeSchema, sha256 } from "./contracts";

export type FixtureBootOperation = "bootstrap" | "sync" | "activate" | "refresh" | "actor-confirm" | "warm-context";
export const FIXTURE_BOOT_REQUEST_SCHEMAS = Object.freeze({
  bootstrap: CloudAgentBootCredentialRequestSchema, sync: CloudAgentBootSyncRequestSchema,
  activate: CloudAgentBootActivateRequestSchema, refresh: CloudAgentBootRefreshRequestSchema,
  "actor-confirm": CloudAgentActorConfirmRequestSchema, "warm-context": CloudAgentWarmActorRequestSchema,
});
type Provider = "claude" | "codex" | "cursor";
const providers: readonly Provider[] = ["claude", "codex", "cursor"];
const capabilities = { version: 1 as const, goals: false, nativeFork: false, transcriptFork: false,
  nativeReview: false, connectedApps: false, multiAgent: false };
const ConfigurationSchema = z.object({ fundingOwnerUserId: z.uuid(), fundingOwnerEpoch: z.number().int().positive().safe(),
  actorFundingGrant: CloudAgentFundingGrantSchema.nullable() }).strict();
export type FixtureBootConfiguration = z.infer<typeof ConfigurationSchema>;
export const fixtureCustomizationDigest = (value: unknown) => sha256(JSON.stringify(value,
  (key, entry) => (key === "env" || key === "headers") && entry ? Object.keys(entry).sort() : entry));

/** Synthetic CP authority for a private source harness. It is never an engine
 * bootstrap bypass: registration negotiates first, bootstrap reserves a writer,
 * and activation is a separate authenticated transition. Native material is
 * private; no diagnostic, renderer route or inspect() result contains it. */
export class FixtureBootAuthority {
  private registration: { bootId: string; negotiated: boolean } | null = null;
  private scope: CloudAgentBootScope | null = null;
  private activated = false;
  private closed = false;
  private cacheRevision = 1;
  private desiredCacheRevision = 1;
  private readonly slots = new Map<Provider, CloudAgentBootProviderReady>();
  private initialAdoptions: CloudAgentBootCredentialResponse["initialAdoptions"] | null = null;
  private readonly contexts = new Map<string, CloudAgentWarmActorResponse>();
  private readonly historyKey = randomBytes(32).toString("base64url");
  private readonly configuration: FixtureBootConfiguration;
  constructor(private readonly dependencies: {
    scope: z.infer<typeof ScopeSchema>; now(): number; engineLive(): boolean; engineDeadline(): number;
    actorSessionExpiresAt(): number; configuration: FixtureBootConfiguration; actorSessionId: string;
    recordedActor(sessionId: string): CloudCommandActor;
    credentials?: { mode: "synthetic" | "environment"; env?: Record<string, string | undefined> };
    allowedModels?: Partial<Record<Provider, readonly string[]>>;
  }) {
    parse(ScopeSchema, dependencies.scope, "fixture_boot_scope_invalid");
    this.configuration = clone(parse(ConfigurationSchema, dependencies.configuration, "fixture_boot_configuration_invalid"));
  }

  negotiateRegistration(bootId: string, requested: boolean, qualified: boolean): boolean {
    if (this.closed || !z.uuid().safeParse(bootId).success) throw new FixtureRefusal("engine_authority_rejected", 403);
    if (this.registration && this.registration.bootId !== bootId) throw new FixtureRefusal("command_context_changed");
    this.registration ??= { bootId, negotiated: requested && qualified };
    return this.registration.negotiated;
  }
  private live(): void {
    if (this.closed || !this.dependencies.engineLive() || this.dependencies.engineDeadline() <= this.dependencies.now())
      throw new FixtureRefusal("engine_authority_rejected", 403);
    if (!this.registration?.negotiated) throw new FixtureRefusal("cloud_runtime_upgrade_required");
  }
  private current(value: z.infer<typeof ScopeSchema> & { bootId?: string; writerEpoch?: string }): void {
    this.live();
    for (const [key, expected] of Object.entries(this.dependencies.scope))
      if (value[key as keyof typeof value] !== expected) throw new FixtureRefusal("engine_authority_rejected", 403);
    if (value.bootId !== undefined && (!this.scope || value.bootId !== this.scope.bootId || value.writerEpoch !== this.scope.writerEpoch))
      throw new FixtureRefusal("command_context_changed");
  }
  private reserve(): CloudAgentBootScope {
    if (this.scope) return this.scope;
    const slots = this.projectSlots(); // Validate all private inputs before publishing any slot.
    this.scope = { ...this.dependencies.scope, bootId: this.registration!.bootId, writerEpoch: randomUUID(),
      fundingOwnerUserId: this.configuration.fundingOwnerUserId, fundingOwnerEpoch: this.configuration.fundingOwnerEpoch };
    for (const slot of slots) this.slots.set(slot.provider, slot);
    this.initialAdoptions = providers.map(provider => {
      const slot = this.slots.get(provider);
      return slot ? { provider, status: "known" as const, adoptionId: slot.adoptionId } : { provider, status: "missing" as const };
    });
    return this.scope;
  }
  private projectSlots(): CloudAgentBootProviderReady[] {
    // Environment mode consumes only explicitly supplied private projection;
    // ambient process.env is deliberately never consulted by this fixture.
    const env = this.dependencies.credentials?.mode === "environment" ? this.dependencies.credentials.env ?? {} : null;
    const invalidKey = () => `fixture-invalid-key-${randomBytes(24).toString("hex")}`;
    const candidates: Array<[Provider, unknown]> = env ? [
      ["claude", env.ANTHROPIC_API_KEY ? { kind: "claude-api-key", apiKey: env.ANTHROPIC_API_KEY } :
        env.CLAUDE_CODE_OAUTH_TOKEN ? { kind: "claude-setup-token", accessToken: env.CLAUDE_CODE_OAUTH_TOKEN } : null],
      ["codex", env.OPENAI_API_KEY ? { kind: "codex-api-key", apiKey: env.OPENAI_API_KEY } : null],
      ["cursor", env.CURSOR_API_KEY ? { kind: "cursor-api-key", apiKey: env.CURSOR_API_KEY } : null],
    ] : providers.map(provider => [provider, { kind: `${provider}-api-key`, apiKey: invalidKey() }]);
    const slots: CloudAgentBootProviderReady[] = [];
    for (const [provider, raw] of candidates) {
      if (raw === null) continue;
      const material = parse<CloudAgentAccessMaterial>(CloudAgentAccessMaterialSchema, raw, "fixture_credential_invalid");
      const slot = { status: "ready" as const, provider, credentialId: randomUUID(), credentialRevision: 1, connectionRevision: 1,
        adoptionId: randomUUID(), displayName: `Fixture ${provider}`, kind: material.kind,
        models: [...(this.dependencies.allowedModels?.[provider] ?? cloudAgentModels(provider))], nativeCapabilities: clone(capabilities),
        materialVersion: 1, expiresAt: null, refreshAfter: null, authorityExpiresAt: null, material: clone(material) };
      const parsed = CloudAgentBootCredentialResponseSchema.shape.providers.element.safeParse(slot);
      if (!parsed.success || parsed.data.status !== "ready") throw new FixtureRefusal("fixture_credential_invalid", 422);
      slots.push(parsed.data);
    }
    return slots;
  }
  private identity() {
    return { ...this.reserve(), version: 1 as const, mode: "boot-owner-v1" as const,
      fundingScope: "workspace-roles-v1" as const, authorityEpoch: 1 };
  }
  private snapshot(): CloudAgentBootCredentialResponse {
    const identity = this.identity();
    return parse(CloudAgentBootCredentialResponseSchema, { ...identity, cacheRevision: this.cacheRevision,
      desiredCacheRevision: this.desiredCacheRevision, initialAdoptions: clone(this.initialAdoptions),
      providers: providers.map(provider => this.desiredCacheRevision > this.cacheRevision ?
        { status: "unavailable", provider, code: "cloud_agent_credential_refresh_required" } :
        clone(this.slots.get(provider) ?? { status: "unavailable", provider, code: "cloud_agent_credential_required" })) }, "fixture_boot_response_invalid");
  }
  private readyRevision(expected: number): void {
    if (expected > this.cacheRevision || this.cacheRevision !== this.desiredCacheRevision)
      throw new FixtureRefusal("cloud_agent_credential_refresh_required");
  }
  private actor(sessionId: string): CloudActorProvenance {
    if (!this.activated || !this.scope) throw new FixtureRefusal("command_context_changed");
    const actor = this.dependencies.recordedActor(sessionId);
    // Production confirmDetachedCloudActor caps the detached proof at 10s.
    // The recorded actor session's separate renewal lifetime stays unchanged.
    const confirmedUntilMs = Math.min(this.dependencies.now() + 10_000, this.dependencies.engineDeadline(), this.dependencies.actorSessionExpiresAt());
    if (sessionId !== this.dependencies.actorSessionId || confirmedUntilMs <= this.dependencies.now() ||
        (this.configuration.actorFundingGrant?.kind === "owner" && actor.userId !== this.scope.fundingOwnerUserId))
      throw new FixtureRefusal("cloud_actor_authority_rejected", 403);
    return { scope: clone(this.scope), actor: clone(actor), actorSessionId: sessionId, authorityEpoch: 1, confirmedUntilMs,
      fundingConsentVersion: this.configuration.actorFundingGrant ? 1 : null, fundingGrant: clone(this.configuration.actorFundingGrant) };
  }
  handle(operation: FixtureBootOperation, raw: unknown): unknown {
    switch (operation) {
      case "bootstrap": {
        const body = parse(CloudAgentBootCredentialRequestSchema, raw, "invalid_request");
        this.current(body); return this.snapshot();
      }
      case "sync": {
        const body = parse(CloudAgentBootSyncRequestSchema, raw, "invalid_request");
        this.current(body);
        if (body.expectedCacheRevision > this.cacheRevision) throw new FixtureRefusal("cloud_agent_credential_refresh_required");
        return this.snapshot();
      }
      case "activate": {
        const body = parse(CloudAgentBootActivateRequestSchema, raw, "invalid_request");
        this.current(body); this.readyRevision(body.expectedCacheRevision); this.activated = true;
        return parse(CloudAgentBootActivateResponseSchema, { ...this.identity(), cacheRevision: this.cacheRevision, activated: true }, "fixture_boot_response_invalid");
      }
      case "refresh": {
        const body = parse(CloudAgentBootRefreshRequestSchema, raw, "invalid_request"); this.current(body);
        // Fixture API keys have no subscription broker/refresh source.
        throw new FixtureRefusal("cloud_agent_credential_refresh_required");
      }
      case "actor-confirm": {
        const body = parse(CloudAgentActorConfirmRequestSchema, raw, "invalid_request"); this.current(body);
        return parse(CloudAgentActorConfirmResponseSchema, { version: 1, mode: "boot-owner-v1", provenance: this.actor(body.actorSessionId) }, "fixture_boot_response_invalid");
      }
      case "warm-context": {
        const body = parse(CloudAgentWarmActorRequestSchema, raw, "invalid_request"); this.current(body); this.readyRevision(this.cacheRevision);
        const actor = this.actor(body.actorSessionId);
        if (!cloudActorCan(actor.actor.role, "run") || actor.fundingConsentVersion !== 1 || !actor.fundingGrant)
          throw new FixtureRefusal("cloud_agent_authority_rejected", 403);
        const slot = this.slots.get(body.provider);
        if (!slot) throw new FixtureRefusal("cloud_agent_credential_required");
        if (!slot.models.includes(body.model)) throw new FixtureRefusal("cloud_agent_model_not_authorized");
        const key = sha256(canonical([body, actor.actor, actor.fundingGrant, this.cacheRevision]));
        const existing = this.contexts.get(key);
        if (existing && existing.actor.confirmedUntilMs > this.dependencies.now()) {
          // Production renews a still-live context with freshly confirmed actor
          // authority. Keeping its old deadline would retire native work even
          // while background warm-context requests continue to succeed.
          const renewed = { ...existing, actor };
          this.contexts.set(key, clone(renewed));
          return clone(renewed);
        }
        const history = { owner: sha256(canonical([this.scope!.organizationId, this.scope!.workspaceId, actor.actor.userId])),
          currentKeyVersion: 1, keys: { "1": this.historyKey } };
        const content = { version: 1 as const, repositoryDigest: fixtureCustomizationDigest(body.repositoryServers), history,
          servers: body.repositoryServers.map(server => ({ server: clone(server), scope: "repository" as const, secretRef: null, revision: 0 })),
          skills: [], cursorTeamSettings: "disabled" as const };
        const response = parse(CloudAgentWarmActorResponseSchema, { ...this.identity(), contextId: randomUUID(), contextRevision: key,
          actor, conversationId: body.conversationId, provider: body.provider, model: body.model, cwd: body.cwd, gitAuthor: null,
          customization: { ...content, digest: fixtureCustomizationDigest(content) },
          environment: { version: 1, revision: sha256(canonical([history.owner, {}])), values: {}, history },
          nativeCapabilities: clone(capabilities) }, "fixture_boot_response_invalid");
        if (this.contexts.size >= 128) this.contexts.delete(this.contexts.keys().next().value!);
        this.contexts.set(key, clone(response)); return response;
      }
    }
  }
  activeScope(): CloudAgentBootScope {
    this.live(); if (!this.activated || !this.scope) throw new FixtureRefusal("command_context_changed");
    return clone(this.scope);
  }
  markDesiredRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision <= this.desiredCacheRevision) throw new FixtureRefusal("fixture_cache_revision_invalid");
    this.desiredCacheRevision = revision; this.contexts.clear();
  }
  publishDesiredRevision(): void { this.live(); this.cacheRevision = this.desiredCacheRevision; this.contexts.clear(); }
  inspect() { return { negotiated: this.registration?.negotiated ?? false, activated: this.activated && !this.closed,
    providerCount: this.slots.size, contextCount: this.contexts.size, cacheRevision: this.cacheRevision, desiredCacheRevision: this.desiredCacheRevision }; }
  close(): void { this.closed = true; this.slots.clear(); this.contexts.clear(); this.initialAdoptions = null; }
}
