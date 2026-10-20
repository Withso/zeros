import { createPublicKey, randomUUID, verify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import { ProviderSessionProofUnavailable, type AuthSessionProofService } from "../auth-session-proof.js";
import { HttpError } from "../authz.js";
import { DatabaseCloudExecutionAuthorityService } from "./execution-authority.js";
import { withSystemTx, type Tx } from "../db.js";
import type { RolloutFlagReader } from "../rollout-flags.js";
import type { CapabilityClaims } from "./capability-contract.js";
import type { CloudBootCustomizationBinding } from "./mcp-contract.js";
import type { ServiceCapabilityVerifier } from "./capability-service-verifier.js";
import { assertCloudActorSession, type CloudActorEngineScope } from "./actor-sessions.js";
import { authorizeCloudWorkspaceActor } from "./actors.js";
import { readCurrentCloudAgentBootBinding } from "./agent-boot-credentials.js";
import { readCloudAgentFundingConsent } from "./agent-funding-consent.js";
import { assertCloudEngineAuthorityDeadline, assertCurrentCloudEngineAuthority, CloudWorkspaceEngineAuthorityError } from "./engine-authority.js";
import { CloudAcceptedWorkEnrollRequestSchema, CloudAcceptedWorkOperationSchema, CloudAcceptedWorkReceiptSchema, CloudAcceptedWorkCloseRequestSchema, cloudAcceptedWorkProofMessage,
  type CloudAcceptedWorkReceipt } from "./accepted-work-contract.js";

export type AcceptedWorkEngine = Omit<CloudActorEngineScope, "actorSessionId">;
/** Heartbeat-free scopes come only from an already authenticated native
 * Git consumer. Public engine endpoints require AcceptedWorkEngine. */
type AcceptedWorkOperationEngine = Omit<AcceptedWorkEngine, "heartbeatToken"> & { heartbeatToken?: string };
export type AcceptedWorkOptions = { pool: pg.Pool; proof: Pick<AuthSessionProofService, "prove">;
  /** Share this exact verifier with capability admission/renewal: a consumed
   * proof must not become fresh again by moving to another endpoint. */
  verifier: ServiceCapabilityVerifier; flags: RolloutFlagReader; workosEnabled: boolean;
  now?: () => number; monotonicNow?: () => number; maxActive?: number };

type Binding = Pick<CloudAcceptedWorkReceipt, "scope" | "runtimeId" | "sourceSessionId" | "kid" | "epochs" | "devicePublicKey">
  & { userId: string; deviceId: string; role: string; fingerprint?: string; clientClaims?: CapabilityClaims; route?: string };
type Facts = { access_revision: string; authority_epoch: string; member_epoch: string; auth_revision: string;
  device_key_version: string; device_public_key: Buffer; provider_session_proof_version: string;
  provider_session_proved_at: Date | null; provider_session_expires_at: Date | null; db_now: Date };
type Stored = { receipt: unknown; closed_at: Date | null };
function rejected(): never { throw new HttpError(403, "accepted_work_rejected", "Accepted work authority was rejected"); }
function conflict(): never { throw new HttpError(409, "accepted_work_conflict", "Accepted work identity conflicts"); }
const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
function engineMatches(engine: AcceptedWorkOperationEngine, scope: Binding["scope"]): boolean {
  return (["workspaceId", "organizationId", "generation", "engineInstanceId"] as const).every(key => engine[key] === scope[key]);
}
function fromReceipt(receipt: CloudAcceptedWorkReceipt): Binding {
  return { ...receipt, userId: receipt.actor.userId, deviceId: receipt.actor.deviceId, role: receipt.actor.role,
    fingerprint: receipt.actor.fingerprint };
}
function knownRefusal(error: unknown): never {
  if (error instanceof HttpError && (error.code === "accepted_work_conflict" || error.status === 429)) throw error;
  if (error instanceof HttpError || error instanceof ProviderSessionProofUnavailable || error instanceof CloudWorkspaceEngineAuthorityError) rejected();
  throw error;
}

/** Exact operation authority is injected only into enrolled context/native
 * consumers. It cannot admit a client, issue a grant or refresh push health. */
export class CloudAcceptedWorkOperationAuthority {
  protected readonly now: () => number;
  constructor(protected readonly authorityOptions: Pick<AcceptedWorkOptions, "flags" | "workosEnabled" | "now">) {
    this.now = authorityOptions.now ?? Date.now;
  }
  protected enabled(organizationId: string): boolean {
    return (["detached_turns", "capabilities", "realtime_uplink", "credential_push", "turn_journal"] as const)
      .every(flag => this.authorityOptions.flags.enabled(organizationId, flag));
  }
  protected live(deadline: number, signal?: AbortSignal): void {
    if (signal?.aborted || this.now() >= deadline) rejected();
  }
  async authorizeInTx(tx: Tx, engine: AcceptedWorkOperationEngine, raw: unknown): Promise<CloudAcceptedWorkReceipt> {
    const parsed = CloudAcceptedWorkOperationSchema.safeParse(raw);
    if (!parsed.success || !engineMatches(engine, parsed.data.scope)) rejected();
    const request = parsed.data;
    const row = (await tx.query<Stored>(`SELECT receipt,closed_at FROM cloud_accepted_work_enrollments
      WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4 AND engine_instance_id=$5`,
    [request.acceptedWorkId, engine.workspaceId, engine.organizationId, engine.generation, engine.engineInstanceId])).rows[0];
    if (!row) rejected();
    const parsedReceipt = CloudAcceptedWorkReceiptSchema.safeParse(row.receipt);
    if (!parsedReceipt.success) rejected();
    const receipt = parsedReceipt.data;
    if (!same(receipt.scope, request.scope) || receipt.runtimeId !== request.runtimeId || !same(receipt.command, request.command) ||
      !receipt.scopes.includes(request.operation === "native-git" ? "ws:edit" : "ws:prompt")) rejected();
    await this.currentReceipt(tx, engine, receipt, row.closed_at);
    return receipt;
  }

  /** The context row is read and fenced by the native Git consumer. Its
   * accepted ID names one immutable command, not the desktop's expired actor. */
  async authorizeContextInTx(tx: Tx, engine: AcceptedWorkOperationEngine, binding: CloudBootCustomizationBinding): Promise<CloudAcceptedWorkReceipt> {
    if (!binding.acceptedWorkId) rejected();
    const row = (await tx.query<Stored>(`SELECT receipt,closed_at FROM cloud_accepted_work_enrollments
      WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4 AND engine_instance_id=$5`,
    [binding.acceptedWorkId, engine.workspaceId, engine.organizationId, engine.generation, engine.engineInstanceId])).rows[0];
    const parsed = CloudAcceptedWorkReceiptSchema.safeParse(row?.receipt);
    if (!row || !parsed.success) rejected();
    const receipt = parsed.data;
    if (Object.entries(receipt.scope).some(([key, value]) => binding[key as keyof typeof binding] !== value) ||
      receipt.actorSessionId !== binding.actorSessionId || receipt.actor.userId !== binding.actorUserId ||
      receipt.actor.deviceId !== binding.actorDeviceId || receipt.actor.deviceKeyVersion !== binding.actorDeviceKeyVersion ||
      receipt.actor.fingerprint !== binding.actorFingerprint || receipt.epochs.wa !== binding.authorityEpoch || binding.fundingGrant.kind !== "owner" ||
      (["provider", "model", "cwd", "conversationId"] as const).some(key => receipt.command[key] !== binding[key]) ||
      !receipt.scopes.includes("ws:edit")) rejected();
    // Native callers already hold the workspace fence. Account lifecycle
    // takes the account/source first, so refuse contention instead of waiting
    // backward while blocking retirement. A successful check retains every
    // source lock through the native operation.
    await this.currentReceipt(tx, engine, receipt, row.closed_at, true);
    return receipt;
  }

  protected async currentReceipt(tx: Tx, engine: AcceptedWorkOperationEngine, receipt: CloudAcceptedWorkReceipt, closedAt: Date | null,
    sourceNowait = false): Promise<void> {
    if (closedAt || !this.enabled(engine.organizationId)) rejected();
    this.live(receipt.providerExpiresAtMs);
    const current = await this.current(tx, engine, fromReceipt(receipt), undefined, sourceNowait);
    const stored = (await tx.query<{ closed_at: Date | null }>("SELECT closed_at FROM cloud_accepted_work_enrollments WHERE id=$1 FOR SHARE",
      [receipt.acceptedWorkId])).rows[0];
    if (!stored || stored.closed_at) rejected();
    if (Number(current.facts.provider_session_proof_version) < receipt.providerProofVersion ||
      !current.facts.provider_session_expires_at || current.facts.provider_session_expires_at.getTime() <= current.facts.db_now.getTime() ||
      receipt.providerExpiresAtMs <= current.facts.db_now.getTime()) rejected();
    await assertCloudEngineAuthorityDeadline(tx, engine.engineInstanceId, this.authorityOptions.workosEnabled);
    const now = (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.getTime();
    if (!this.enabled(engine.organizationId) ||
      now >= Math.min(receipt.providerExpiresAtMs, current.facts.provider_session_expires_at.getTime())) rejected();
    this.live(receipt.providerExpiresAtMs);
  }

  private async currentNativeEngine(tx: Tx, engine: AcceptedWorkOperationEngine): Promise<number> {
    const row = (await tx.query<{ live: boolean; fenced: boolean; authority_epoch: string }>(
      "SELECT live,fenced,authority_epoch FROM cloud_workspace_engine_authority_current($1,$2,$3,$4,$5,true)",
      [engine.workspaceId, engine.organizationId, engine.generation, engine.engineInstanceId, this.authorityOptions.workosEnabled])).rows[0];
    if (!row?.live || row.fenced) rejected();
    return Number(row.authority_epoch);
  }

  protected async current(tx: Tx, engine: AcceptedWorkOperationEngine, binding: Binding, newActorSessionId?: string, sourceNowait = false) {
    if (!engineMatches(engine, binding.scope) || binding.userId !== binding.scope.fundingOwnerUserId || binding.role !== "owner") rejected();
    // Match source proof/account lifecycle ordering; no external I/O below.
    const sourceLock = sourceNowait ? "FOR SHARE NOWAIT" : "FOR SHARE";
    await tx.query(`SELECT id FROM users WHERE id=$1 ${sourceLock}`, [binding.userId]);
    await tx.query(`SELECT id FROM user_identities WHERE user_id=$1 AND provider='workos' ORDER BY id ${sourceLock}`, [binding.userId]);
    await tx.query(`SELECT id FROM auth_sessions WHERE id=$1 ${sourceLock}`, [binding.sourceSessionId]);
    const authorityEpoch = engine.heartbeatToken
      ? (await assertCurrentCloudEngineAuthority(tx, { ...engine, heartbeatToken: engine.heartbeatToken,
        workosEnabled: this.authorityOptions.workosEnabled })).authorityEpoch
      : await this.currentNativeEngine(tx, engine);
    if (authorityEpoch !== binding.epochs.wa) rejected();
    await tx.query("SELECT id FROM devices WHERE id=$1 FOR SHARE", [binding.deviceId]);
    await tx.query("SELECT user_id FROM organization_members WHERE org_id=$1 AND user_id=$2 FOR SHARE", [engine.organizationId, binding.userId]);
    await tx.query("SELECT id FROM cloud_agent_boot_bindings WHERE workspace_id=$1 AND org_id=$2 AND engine_instance_id=$3 AND writer_epoch=$4 FOR SHARE",
      [engine.workspaceId, engine.organizationId, engine.engineInstanceId, binding.scope.writerEpoch]);
    await tx.query("SELECT writer_epoch FROM cloud_workspace_local_command_writers WHERE workspace_id=$1 AND writer_epoch=$2 FOR SHARE",
      [engine.workspaceId, binding.scope.writerEpoch]);
    const mode = await readCurrentCloudAgentBootBinding(tx, { workspaceId: engine.workspaceId, organizationId: engine.organizationId });
    if (mode.mode !== "boot-owner-v1" || mode.binding.status !== "current" || mode.binding.writerState !== "active" ||
      Object.entries(binding.scope).some(([key, value]) => mode.binding[key as keyof typeof mode.binding] !== value)) rejected();
    // Key rotation can wait. Acquire its fence before reading clock-bound
    // facts or confirming the new actor, so that wait cannot age admission.
    if (!(await tx.query<{ live: boolean }>("SELECT cloud_accepted_work_key_live($1) AS live", [binding.kid])).rows[0]?.live) rejected();
    const facts = (await tx.query<Facts>(`SELECT workspace.access_revision,workspace.authority_epoch,
      coalesce((SELECT epoch FROM cloud_capability_member_epochs WHERE org_id=workspace.org_id AND user_id=$3),1) AS member_epoch,
      account.auth_revision,device.key_version AS device_key_version,device.public_key AS device_public_key,
      source.provider_session_proof_version,source.provider_session_proved_at,source.provider_session_expires_at,clock_timestamp() AS db_now
      FROM cloud_workspaces workspace
      JOIN cloud_workspace_engine_instances engine ON engine.id=$4 AND engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id
        AND engine.generation=$5 AND engine.runtime_id=$6 AND engine.accepted_work_version=1 AND engine.actor_protocol_version=2
      JOIN users account ON account.id=$3 AND account.auth_status='active' AND account.deleted_at IS NULL
      JOIN devices device ON device.id=$7 AND device.user_id=account.id AND device.trust_state='trusted' AND device.revoked_at IS NULL
      JOIN auth_sessions source ON source.id=$8 AND source.user_id=account.id AND source.provider='workos'
        AND source.status='active' AND source.revoked_at IS NULL
      JOIN user_identities identity ON identity.user_id=account.id AND identity.provider='workos'
        AND identity.provider_sub=source.provider_sub AND identity.status='active'
      WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.owner_user_id=$3 AND workspace.deleted_at IS NULL`,
    [engine.workspaceId, engine.organizationId, binding.userId, engine.engineInstanceId, engine.generation, binding.runtimeId,
      binding.deviceId, binding.sourceSessionId])).rows[0];
    if (!facts || ([[facts.authority_epoch, binding.epochs.wa], [facts.access_revision, binding.epochs.wr],
      [facts.member_epoch, binding.epochs.me], [facts.auth_revision, binding.epochs.ac], [facts.device_key_version, binding.epochs.dk]] as const)
      .some(([actual, expected]) => Number(actual) !== expected) || facts.device_public_key.toString("base64url") !== binding.devicePublicKey) rejected();
    const actor = await authorizeCloudWorkspaceActor(tx, { ...engine, actorUserId: binding.userId, capability: "run" });
    if (actor.role !== "owner" || binding.fingerprint !== undefined && actor.fingerprint !== binding.fingerprint ||
      (await readCloudAgentFundingConsent(tx, binding.scope, { userId: binding.userId, role: actor.role }))?.kind !== "owner") rejected();
    if (newActorSessionId) {
      await tx.query("SELECT id FROM cloud_workspace_actor_sessions WHERE id=$1 FOR SHARE", [newActorSessionId]);
      const recorded = await assertCloudActorSession(tx, engine, newActorSessionId, "run");
      const source = await tx.query(`SELECT 1 FROM cloud_workspace_actor_sessions actor JOIN auth_sessions source ON source.id=$2
        WHERE actor.id=$1 AND ((actor.session_kind='legacy' AND actor.auth_provider=source.provider AND actor.auth_subject=source.provider_sub
          AND actor.auth_session_id=source.provider_session_id AND actor.auth_session_created_at=source.created_at)
          OR (actor.session_kind='capability-v1' AND actor.capability_source_session_id=source.id
            AND actor.capability_claims-ARRAY['iat','nbf','exp','jti'] = $3::jsonb-ARRAY['iat','nbf','exp','jti']
            AND actor.capability_route=$4))`, [newActorSessionId, binding.sourceSessionId, binding.clientClaims, binding.route]);
      if (recorded.actorUserId !== binding.userId || recorded.deviceId !== binding.deviceId || recorded.deviceKeyVersion !== binding.epochs.dk ||
        recorded.role !== actor.role || recorded.fingerprint !== actor.fingerprint || source.rowCount !== 1) rejected();
    }
    return { facts, actor };
  }
}

/** Only enrolled operations outlive client observation; the engine retains
 * the original provider/runtime deadlines and explicit revocation fences. */
export class DatabaseCloudAcceptedWorkService extends CloudAcceptedWorkOperationAuthority {
  readonly execution: DatabaseCloudExecutionAuthorityService;
  private readonly monotonic: () => number;
  private readonly maxActive: number;
  constructor(private readonly options: AcceptedWorkOptions) {
    super(options);
    this.execution = new DatabaseCloudExecutionAuthorityService(options);
    this.monotonic = options.monotonicNow ?? (() => performance.now());
    this.maxActive = options.maxActive ?? 256;
    if (!Number.isInteger(this.maxActive) || this.maxActive < 1 || this.maxActive > 256) throw new Error("accepted_work_options_invalid");
  }
  async enroll(engine: AcceptedWorkEngine, raw: unknown, signal?: AbortSignal): Promise<CloudAcceptedWorkReceipt> {
    const parsed = CloudAcceptedWorkEnrollRequestSchema.safeParse(raw);
    if (!parsed.success || !engineMatches(engine, parsed.data.scope) || !this.enabled(engine.organizationId)) rejected();
    const request = parsed.data;
    try {
      const verified = await this.options.verifier.verify(request.capability, { workspaceId: engine.workspaceId,
        organizationId: engine.organizationId, route: request.route, proof: request.proof, scope: "ws:prompt" });
      if (!verified.ok) rejected();
      const { claims, header } = verified;
      if (claims.knd !== "client" || claims.aud !== "zeros:engine" || !claims.sid || !claims.did || !claims.cnf ||
        claims.role !== "owner" || claims.sub !== `user:${request.scope.fundingOwnerUserId}` ||
        !["wa", "wr", "me", "ac", "dk"].every(key => Number.isSafeInteger(claims.ep[key]))) rejected();
      if (!verify(null, Buffer.from(cloudAcceptedWorkProofMessage({ aud: claims.aud, wsp: claims.wsp, jti: claims.jti,
        scope: request.scope, commandId: request.command.commandId, conversationId: request.command.conversationId,
        payloadSha256: request.command.payloadSha256, timestampMs: request.proof.timestampMs, nonce: request.proof.nonce, route: request.route })),
      createPublicKey({ key: claims.cnf.jwk, format: "jwk" }), Buffer.from(request.commandSignature, "base64url"))) rejected();
      const expires = claims.exp * 1000;
      this.live(expires, signal);
      const binding: Binding = { scope: request.scope, runtimeId: request.runtimeId, sourceSessionId: claims.sid,
        userId: claims.sub.slice(5), deviceId: claims.did, role: claims.role, kid: header.kid, devicePublicKey: claims.cnf.jwk.x,
        clientClaims: { ...claims, scp: [...claims.scp].sort() }, route: request.route,
        epochs: { wa: claims.ep.wa!, wr: claims.ep.wr!, me: claims.ep.me!, ac: claims.ep.ac!, dk: claims.ep.dk! } };
      // Reject unsupported/currently unauthorized work before provider I/O.
      await withSystemTx(this.options.pool, tx => this.current(tx, engine, binding, request.actorSessionId));
      this.live(expires, signal);
      // No pool connection or authority lock is held during this bounded read.
      const proof = await this.options.proof.prove({ rowId: binding.sourceSessionId, userId: binding.userId,
        accountRevision: binding.epochs.ac }, signal);
      const proofAge = this.now() - proof.observedAtMs;
      const proofDeadline = this.monotonic() + Math.max(0, 10_000 - proofAge);
      if (proofAge < 0 || proofAge >= 10_000) rejected();
      return await withSystemTx(this.options.pool, async tx => {
        this.live(expires, signal);
        if (!this.enabled(engine.organizationId) || this.monotonic() >= proofDeadline) rejected();
        const current = await this.current(tx, engine, binding, request.actorSessionId);
        if (proof.rowId !== binding.sourceSessionId || proof.userId !== binding.userId || proof.accountRevision !== binding.epochs.ac ||
          Number(current.facts.provider_session_proof_version) !== proof.proofVersion ||
          current.facts.provider_session_expires_at?.getTime() !== proof.expiresAtMs ||
          current.facts.provider_session_proved_at?.getTime() !== proof.observedAtMs ||
          Math.min(expires, proof.expiresAtMs) <= Math.max(this.now(), current.facts.db_now.getTime())) rejected();
        const existing = (await tx.query<Stored>(`SELECT receipt,closed_at FROM cloud_accepted_work_enrollments
          WHERE workspace_id=$1 AND generation=$2 AND writer_epoch=$3 AND command_id=$4`,
        [engine.workspaceId, engine.generation, request.scope.writerEpoch, request.command.commandId])).rows[0];
        if (existing) {
          const receipt = CloudAcceptedWorkReceiptSchema.parse(existing.receipt);
          if (!same(receipt.command, request.command) || !same(receipt.scope, request.scope) || receipt.runtimeId !== request.runtimeId ||
            receipt.actorSessionId !== request.actorSessionId || receipt.sourceSessionId !== claims.sid ||
            receipt.actor.userId !== binding.userId || receipt.actor.deviceId !== binding.deviceId || !same(receipt.epochs, binding.epochs) ||
            !same([...receipt.scopes].sort(), [...claims.scp].sort())) conflict();
          await this.currentReceipt(tx, engine, receipt, existing.closed_at);
          this.live(expires, signal);
          return receipt;
        }
        const count = (await tx.query<{ active: number; total: number }>(`SELECT count(*)::int AS total,
          count(*) FILTER (WHERE closed_at IS NULL AND provider_expires_at>clock_timestamp())::int AS active
          FROM cloud_accepted_work_enrollments
          WHERE workspace_id=$1 AND writer_epoch=$2`, [engine.workspaceId, request.scope.writerEpoch])).rows[0]!;
        if (count.active >= this.maxActive || count.total >= 100_000) throw new HttpError(429, "accepted_work_limit", "Accepted work limit reached");
        const receipt = CloudAcceptedWorkReceiptSchema.parse({ version: 1, acceptedWorkId: randomUUID(), revision: 1,
          scope: request.scope, runtimeId: request.runtimeId, actorSessionId: request.actorSessionId,
          actor: { userId: binding.userId, deviceId: binding.deviceId, deviceKeyVersion: binding.epochs.dk,
            role: current.actor.role, fingerprint: current.actor.fingerprint }, sourceSessionId: claims.sid, kid: header.kid,
          capabilityId: claims.jti, devicePublicKey: binding.devicePublicKey, epochs: binding.epochs, scopes: claims.scp,
          command: request.command, acceptedAtMs: Math.max(this.now(), current.facts.db_now.getTime()),
          capabilityExpiresAtMs: expires, providerExpiresAtMs: proof.expiresAtMs, providerProofVersion: proof.proofVersion });
        await tx.query(`INSERT INTO cloud_accepted_work_enrollments(id,workspace_id,org_id,generation,engine_instance_id,
          writer_epoch,command_id,receipt,capability_expires_at,provider_expires_at,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [receipt.acceptedWorkId, engine.workspaceId, engine.organizationId,
          engine.generation, engine.engineInstanceId, request.scope.writerEpoch, request.command.commandId, receipt,
          new Date(expires), new Date(proof.expiresAtMs), new Date(receipt.acceptedAtMs)]);
        await assertCloudEngineAuthorityDeadline(tx, engine.engineInstanceId, this.options.workosEnabled);
        // The receipt write can wait after current() confirmed the actor.
        // New acceptance still requires its expiry and renewal window to stand.
        await assertCloudActorSession(tx, engine, request.actorSessionId, "run");
        const now = (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.getTime();
        if (!this.enabled(engine.organizationId) || this.monotonic() >= proofDeadline || now >= Math.min(expires, proof.expiresAtMs)) rejected();
        this.live(Math.min(expires, proof.expiresAtMs), signal);
        return receipt;
      });
    } catch (error) { return knownRefusal(error); }
  }

  async authorize(engine: AcceptedWorkEngine, request: unknown): Promise<CloudAcceptedWorkReceipt> {
    try { return await withSystemTx(this.options.pool, tx => this.authorizeInTx(tx, engine, request)); }
    catch (error) { return knownRefusal(error); }
  }

  async close(engine: AcceptedWorkEngine, raw: unknown): Promise<void> {
    const parsed = CloudAcceptedWorkCloseRequestSchema.safeParse(raw);
    if (!parsed.success || !engineMatches(engine, parsed.data.scope)) rejected();
    const request = parsed.data;
    await withSystemTx(this.options.pool, async tx => {
      await assertCurrentCloudEngineAuthority(tx, { ...engine, workosEnabled: this.options.workosEnabled });
      const row = (await tx.query<Stored>(`SELECT receipt,closed_at FROM cloud_accepted_work_enrollments
        WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4 AND engine_instance_id=$5 FOR UPDATE`,
      [request.acceptedWorkId, engine.workspaceId, engine.organizationId, engine.generation, engine.engineInstanceId])).rows[0];
      const receipt = CloudAcceptedWorkReceiptSchema.safeParse(row?.receipt);
      if (!row || !receipt.success || !same(receipt.data.scope, request.scope) || receipt.data.command.commandId !== request.commandId) rejected();
      await tx.query("UPDATE cloud_accepted_work_enrollments SET closed_at=coalesce(closed_at,clock_timestamp()) WHERE id=$1", [request.acceptedWorkId]);
    });
  }
}
