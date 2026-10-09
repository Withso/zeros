import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { CloudAgentAccessMaterialSchema, CloudAgentExecutionAdmissionSchema, CloudAgentExecutionAuthoritySchema, CloudAgentExecutionLeaseSchema,
  CloudBackgroundSnapshotSchema, CloudBackgroundStateSchema, CloudComputerExecutionEnvironmentSchema,
  CloudNativeCapabilitiesSchema,
  type CloudAgentAccessMaterial, type CloudAgentExecutionAuthority, type CloudAgentExecutionAdmission } from "@zeros/protocol/cloud-agent-execution";
import { CloudCustomizationSnapshotSchema } from "@zeros/protocol/cloud-customization";
import { cloudAgentModels } from "../../../../apps/control-plane/src/cloud-workspaces/agent-models";
import { canonical, clone, FixtureRefusal, parse, ScopeSchema, sha256 } from "./contracts";
import type { FixtureCommands } from "./commands";

const BackgroundOperationSchema = z.union([
  z.object({ kind: z.enum(["retain", "sync"]), conversationId: z.string().min(1).max(128), revision: z.number().int().safe().nonnegative(), snapshot: CloudBackgroundSnapshotSchema }).strict(),
  z.object({ kind: z.literal("read"), conversationId: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("resume"), conversationId: z.string().min(1).max(128), admission: CloudAgentExecutionAdmissionSchema }).strict(),
]);
const RequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("admit"), admission: CloudAgentExecutionAdmissionSchema, includeGitAuthor: z.boolean().optional(),
    nativeCapabilitiesVersion: z.literal(1).optional(), backgroundTasksVersion: z.literal(1).optional(), computerToolsVersion: z.literal(1).optional(), environmentVersion: z.literal(1).optional() }).strict(),
  z.object({ kind: z.literal("validate"), leaseId: z.uuid(), renew: z.boolean().optional(), credentialVersion: z.number().int().safe().positive().optional(), nativeCapabilitiesVersion: z.literal(1).optional() }).strict(),
  z.object({ kind: z.literal("release"), leaseId: z.uuid() }).strict(),
  z.object({ kind: z.literal("refresh-codex"), leaseId: z.uuid(), credentialVersion: z.number().int().safe().positive(), nativeCapabilitiesVersion: z.literal(1).optional() }).strict(),
  z.object({ kind: z.literal("background"), leaseId: z.uuid(), operation: BackgroundOperationSchema }).strict(),
  z.object({ kind: z.literal("authorize-action"), executionId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), actorSessionId: z.uuid() }).strict(),
  z.object({ kind: z.literal("customization"), actorSessionId: z.uuid(), operation: z.enum(["extensions.list", "skills.listZeros", "skills.saveZeros", "skills.removeZeros"]), params: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal("terminal-environment"), actorSessionId: z.uuid() }).strict(),
]);
export const ExecutionBodySchema = ScopeSchema.extend({ request: RequestSchema }).strict();
type Provider = CloudAgentExecutionAdmission["provider"];
type Lease = { admission: CloudAgentExecutionAdmission; response: CloudAgentExecutionAuthority; released: boolean; conversationId: string | null };
const denied = (): never => { throw new FixtureRefusal("cloud_agent_authority_rejected", 403); };
const nativeCapabilities = CloudNativeCapabilitiesSchema.parse({ version: 1, goals: false, nativeFork: false,
  transcriptFork: false, nativeReview: false, connectedApps: false, multiAgent: false });

// Exactly the CP/engine public digest algorithm: env/header key names are
// included; their private literal values are intentionally omitted.
function customizationDigest(value: unknown): string {
  return sha256(JSON.stringify(value, (key, entry) => (key === "env" || key === "headers") && entry ? Object.keys(entry).sort() : entry));
}

export class FixtureExecutions {
  private readonly leases = new Map<string, Lease>();
  private readonly historyKey = randomBytes(32).toString("base64url");
  private readonly materials = new Map<Provider, CloudAgentAccessMaterial>();
  private readonly leaseMs: number;
  constructor(private readonly dependencies: {
    now(): number; workspaceId: string; organizationId: string; commands: FixtureCommands;
    requireActor(sessionId: string): void; requireRecordedActor(sessionId: string): void; actorUserId: string; delegationId(provider: Provider): string;
    delegationExpiresAtMs: number;
    credentials?: { mode: "synthetic" | "environment"; env?: Record<string, string | undefined> };
    allowedModels?: Partial<Record<Provider, readonly string[]>>; leaseMs?: number;
  }) {
    this.leaseMs = dependencies.leaseMs ?? 45_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 5_000 || this.leaseMs > 45_000) throw new Error("fixture_execution_lease_invalid");
    const env = dependencies.credentials?.mode === "environment" ? dependencies.credentials.env ?? process.env : null;
    const invalidKey = () => `fixture-invalid-key-${randomBytes(24).toString("hex")}`;
    const candidates: Array<[Provider, unknown]> = env ? [
      ["claude", env.ANTHROPIC_API_KEY ? { kind: "claude-api-key", apiKey: env.ANTHROPIC_API_KEY } : env.CLAUDE_CODE_OAUTH_TOKEN ? { kind: "claude-setup-token", accessToken: env.CLAUDE_CODE_OAUTH_TOKEN } : null],
      ["codex", env.OPENAI_API_KEY ? { kind: "codex-api-key", apiKey: env.OPENAI_API_KEY } : null],
      ["cursor", env.CURSOR_API_KEY ? { kind: "cursor-api-key", apiKey: env.CURSOR_API_KEY } : null],
    ] : [["claude", { kind: "claude-api-key", apiKey: invalidKey() }], ["codex", { kind: "codex-api-key", apiKey: invalidKey() }], ["cursor", { kind: "cursor-api-key", apiKey: invalidKey() }]];
    for (const [provider, material] of candidates) {
      if (material === null) continue;
      const parsed = CloudAgentAccessMaterialSchema.safeParse(material);
      if (!parsed.success) throw new Error("fixture_credential_invalid"); // Never attach Zod issues containing private input.
      this.materials.set(provider, clone(parsed.data));
    }
  }

  rendererDelegations(runtimeQualified: boolean, mcpQualified: boolean) {
    const expiresAtMs = this.dependencies.delegationExpiresAtMs;
    if (expiresAtMs <= this.dependencies.now()) return [];
    return [...this.materials].map(([provider, material]) => ({
      id: this.dependencies.delegationId(provider), ownerUserId: this.dependencies.actorUserId, kind: material.kind,
      models: [...(this.dependencies.allowedModels?.[provider] ?? cloudAgentModels(provider))], allModels: false,
      expiresAt: new Date(expiresAtMs).toISOString(), runtimeQualified, runtimeUpgradeRequired: false, mcpQualified,
      nativeCapabilities: clone(nativeCapabilities),
    }));
  }

  private source(admission: CloudAgentExecutionAdmission, retained = false): string | null {
    if (admission.source.kind === "session") {
      if (retained) this.dependencies.requireRecordedActor(admission.source.actorSessionId);
      else this.dependencies.requireActor(admission.source.actorSessionId);
      return null;
    }
    const row = this.dependencies.commands.claimed(admission.source.commandId, admission.source.claimId, admission.executionId);
    this.dependencies.requireRecordedActor(row.sourceSessionId);
    if (row.entry.payload?.agentId !== admission.provider || row.entry.payload?.model !== admission.model ||
        row.entry.payload?.agentCredentialGrantId !== admission.delegationId || row.actor.userId !== this.dependencies.actorUserId) denied();
    return row.conversationId;
  }
  private live(leaseId: string): Lease {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.released || Date.parse(lease.response.expiresAt) <= this.dependencies.now()) return denied();
    this.source(lease.admission, true);
    this.requireDelegationLive();
    return lease;
  }
  private requireDelegationLive(): void {
    // The real CP binding requires strictly more than five seconds left in
    // the same delegation exposed to the renderer. Retries cannot mint a new
    // deadline, and a renewable execution lease cannot outlive that grant.
    if (this.dependencies.delegationExpiresAtMs <= this.dependencies.now() + 5000) denied();
  }
  private leaseDeadline(): string {
    return new Date(Math.min(this.dependencies.now() + this.leaseMs, this.dependencies.delegationExpiresAtMs)).toISOString();
  }
  private refusal(admission: CloudAgentExecutionAdmission, code: string): never {
    if (admission.source.kind === "command") this.dependencies.commands.recordDenial(admission.source.commandId, code);
    throw new FixtureRefusal(code, 409);
  }
  handle(raw: unknown): unknown {
    const request = parse(RequestSchema, raw, "invalid_agent_execution");
    switch (request.kind) {
      case "admit": {
        const admission = request.admission, conversationId = this.source(admission);
        const previous = [...this.leases.values()].find(lease => lease.admission.executionId === admission.executionId);
        if (previous) {
          this.live(previous.response.leaseId);
          if (canonical(previous.admission) !== canonical(admission)) denied();
          return clone(previous.response);
        }
        if (admission.delegationId !== this.dependencies.delegationId(admission.provider)) this.refusal(admission, "cloud_agent_credential_required");
        const material = this.materials.get(admission.provider);
        if (!material) this.refusal(admission, "cloud_agent_credential_required");
        this.requireDelegationLive();
        const models = this.dependencies.allowedModels?.[admission.provider];
        if (models && !models.includes(admission.model)) this.refusal(admission, "cloud_agent_model_not_authorized");
        if (request.environmentVersion !== 1) throw new FixtureRefusal("computer_environment_runtime_required", 409);
        if ([...this.leases.values()].filter(lease => !lease.released && Date.parse(lease.response.expiresAt) > this.dependencies.now()).length >= 8)
          throw new FixtureRefusal("cloud_agent_authority_rejected", 429);
        const leaseId = randomUUID(), history = { owner: sha256(canonical([this.dependencies.organizationId, this.dependencies.workspaceId, this.dependencies.actorUserId])),
          currentKeyVersion: 1, keys: { "1": this.historyKey } };
        const environment = CloudComputerExecutionEnvironmentSchema.parse({ version: 1, revision: sha256(canonical([history.owner, {}])), values: {}, history });
        let customization;
        if (admission.customization) {
          const repositoryDigest = createHmac("sha256", Buffer.from(this.historyKey, "base64url"))
            .update(canonical([leaseId, history.owner])).update("\0repository\0").update(JSON.stringify(admission.customization.repositoryServers)).digest("hex");
          const content = { version: 1 as const, repositoryDigest,
            ...(admission.customization.version >= 2 ? { history } : {}),
            servers: admission.customization.repositoryServers.map(server => ({ server: clone(server), scope: "repository" as const, secretRef: null, revision: 0 })),
            skills: [], cursorTeamSettings: "disabled" as const };
          customization = CloudCustomizationSnapshotSchema.parse({ ...content, digest: customizationDigest(content) });
        }
        const response = CloudAgentExecutionAuthoritySchema.parse({ leaseId, authorityId: sha256(canonical([admission, leaseId, environment.revision, customization?.digest ?? null])),
          expiresAt: this.leaseDeadline(), credentialVersion: 1,
          credentialKind: material.kind, material: clone(material), provider: admission.provider, model: admission.model, environment,
          ...(customization ? { customization } : {}), ...(request.includeGitAuthor ? { gitAuthor: null } : {}),
          ...(request.backgroundTasksVersion === 1 ? { backgroundTasksVersion: 1 } : {}),
          ...(request.nativeCapabilitiesVersion === 1 ? { nativeCapabilities: clone(nativeCapabilities) } : {}) });
        this.leases.set(leaseId, { admission: clone(admission), response: clone(response), released: false, conversationId });
        return response;
      }
      case "validate": {
        const lease = this.live(request.leaseId);
        if (request.credentialVersion !== undefined && request.credentialVersion !== lease.response.credentialVersion) denied();
        if (request.renew) lease.response.expiresAt = this.leaseDeadline();
        return CloudAgentExecutionLeaseSchema.parse({ leaseId: request.leaseId, expiresAt: lease.response.expiresAt, credentialVersion: lease.response.credentialVersion,
          environmentRevision: lease.response.environment?.revision,
          ...(request.nativeCapabilitiesVersion === 1 && lease.response.nativeCapabilities ? { nativeCapabilities: lease.response.nativeCapabilities } : {}) });
      }
      case "release": {
        const lease = this.leases.get(request.leaseId);
        if (lease) { lease.released = true; } // CP release is safe and idempotent, even after expiry.
        return { released: true };
      }
      case "refresh-codex": this.live(request.leaseId); return denied(); // No keeper/refresh-token fixture.
      case "background": {
        const lease = this.live(request.leaseId);
        if (lease.response.backgroundTasksVersion !== 1 || lease.conversationId !== request.operation.conversationId || request.operation.kind !== "read") denied();
        return CloudBackgroundStateSchema.parse({ version: 1, leaseId: request.leaseId, conversationId: request.operation.conversationId,
          phase: "foreground", deadline: lease.response.expiresAt, revision: 0, snapshot: { tasks: [], waiting: false, processWork: false } });
      }
      case "authorize-action": {
        this.dependencies.requireActor(request.actorSessionId);
        const lease = [...this.leases.values()].find(row => row.admission.executionId === request.executionId);
        if (!lease) return denied(); this.live(lease.response.leaseId);
        return { authorized: true, executionId: request.executionId, actorSessionId: request.actorSessionId };
      }
      case "terminal-environment": this.dependencies.requireActor(request.actorSessionId); return { version: 1, environment: {} };
      case "customization": {
        this.dependencies.requireActor(request.actorSessionId);
        if (request.operation === "extensions.list" || request.operation === "skills.listZeros") return [];
        return denied();
      }
    }
  }
  inspect() { return [...this.leases.entries()].map(([leaseId, lease]) => ({ leaseId, executionId: lease.admission.executionId, provider: lease.admission.provider,
    credentialKind: lease.response.credentialKind, credentialVersion: lease.response.credentialVersion, expiresAt: lease.response.expiresAt,
    released: lease.released, conversationId: lease.conversationId })); }
  close(): void { this.materials.clear(); for (const lease of this.leases.values()) lease.released = true; this.leases.clear(); }
}
