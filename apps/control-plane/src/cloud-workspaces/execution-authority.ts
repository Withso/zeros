import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { ProviderSessionProofUnavailable, type AuthSessionProofService } from "../auth-session-proof.js";
import { assertCloudActorSession, type CloudActorEngineScope } from "./actor-sessions.js";
import { authorizeCloudWorkspaceActor } from "./actors.js";
import { readCurrentCloudAgentBootBinding } from "./agent-boot-credentials.js";
import { readCloudAgentFundingConsent } from "./agent-funding-consent.js";
import { CloudBootCustomizationBindingSchema } from "./mcp-contract.js";
import { lockCustomization, readCustomizationRows } from "./customization-store.js";
import { assertCurrentCloudEngineAuthority, assertCloudEngineAuthorityDeadline, readCurrentCloudEngineAuthority,
  CloudWorkspaceEngineAuthorityError } from "./engine-authority.js";
import { CloudExecutionEnrollRequestSchema, CloudExecutionAuthorityReceiptSchema, CloudExecutionAuthorityOperationSchema,
  type CloudExecutionEnrollRequest, type CloudExecutionAuthorityReceipt, type CloudExecutionAuthorityOperation } from "./execution-authority-contract.js";

type Engine = Omit<CloudActorEngineScope, "actorSessionId">;
type NativeEngine = Omit<Engine, "heartbeatToken">;
type Stored = { receipt: unknown; closed_at: Date | null };
const same = isDeepStrictEqual;
function refused(): never { throw new HttpError(403, "execution_authority_rejected", "Execution authority was rejected"); }
function matches(engine: NativeEngine, scope: CloudExecutionEnrollRequest["scope"]): boolean {
  return (["workspaceId", "organizationId", "generation", "engineInstanceId"] as const).every(key => engine[key] === scope[key]);
}
function denial(error: unknown): boolean {
  return error instanceof CloudWorkspaceEngineAuthorityError || error instanceof HttpError && [403, 404, 409].includes(error.status);
}
function safeRefusal(error: unknown): never {
  if (error instanceof HttpError && error.code === "execution_authority_rejected") throw error;
  if (denial(error)) refused();
  if (error instanceof ProviderSessionProofUnavailable) throw new HttpError(503, "execution_authority_unavailable", "Execution authority is unavailable");
  throw error;
}
async function readStored(tx: Tx, engine: NativeEngine, input: CloudExecutionAuthorityOperation): Promise<{ row: Stored; receipt: CloudExecutionAuthorityReceipt }> {
  if (!matches(engine, input.scope)) refused();
  const row = (await tx.query<Stored>(`SELECT receipt,closed_at FROM cloud_accepted_work_enrollments
    WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4 AND engine_instance_id=$5`,
  [input.acceptedWorkId, engine.workspaceId, engine.organizationId, engine.generation, engine.engineInstanceId])).rows[0];
  const parsed = CloudExecutionAuthorityReceiptSchema.safeParse(row?.receipt);
  if (!row || !parsed.success || !same(parsed.data.scope, input.scope) || parsed.data.command.commandId !== input.commandId ||
    parsed.data.command.executionId !== input.executionId || parsed.data.claimId !== input.claimId) refused();
  return { row, receipt: parsed.data };
}
type Context = { binding: unknown; expires_at: Date; context_revision: string; organization_revision: string; member_revision: string;
  credential_id: string; credential_revision: string };
async function context(tx: Tx, request: CloudExecutionEnrollRequest, fresh: boolean): Promise<Context> {
  const row = (await tx.query<Context>(`SELECT context.binding,context.expires_at,context.context_revision,
    context.organization_revision,context.member_revision,
    credential.metadata->>'credentialId' AS credential_id,credential.metadata->>'credentialRevision' AS credential_revision
    FROM cloud_agent_boot_contexts context JOIN cloud_agent_boot_bindings boot ON boot.id=context.binding_id
    JOIN cloud_agent_boot_credentials credential ON credential.binding_id=boot.id AND credential.provider=context.provider
    WHERE context.context_id=$1 AND boot.workspace_id=$2 AND boot.org_id=$3 AND boot.engine_instance_id=$4
      AND boot.generation=$5 AND boot.boot_id=$6 AND boot.writer_epoch=$7 AND boot.retired_at IS NULL
      AND context.retired_at IS NULL AND (NOT $8::boolean OR context.expires_at>clock_timestamp())
      AND context.actor_session_id=$9 AND context.provider=$10 AND context.conversation_id=$11 AND context.model=$12 AND context.cwd=$13
      AND context.context_revision=$14 FOR SHARE OF context,boot`,
  [request.contextId, request.scope.workspaceId, request.scope.organizationId, request.scope.engineInstanceId,
    request.scope.generation, request.scope.bootId, request.scope.writerEpoch, fresh, request.actorSessionId,
    request.command.provider, request.command.conversationId, request.command.model, request.command.cwd, request.contextRevision])).rows[0];
  const parsed = CloudBootCustomizationBindingSchema.safeParse(row?.binding);
  if (!row || !parsed.success || parsed.data.acceptedWorkId || parsed.data.contextId !== request.contextId ||
    parsed.data.actorSessionId !== request.actorSessionId || Object.entries(request.scope).some(([key, value]) => parsed.data[key as keyof typeof parsed.data] !== value) ||
    (["provider", "conversationId", "model", "cwd"] as const).some(key => parsed.data[key] !== request.command[key])) refused();
  return row;
}

/** Rechecks the immutable sender, source, device, funding and writer. The
 * transport actor and its last client token are not execution deadlines.
 * Native callers already hold workspace locks, so they use NOWAIT for the
 * earlier account/source fences instead of reversing that lock order. */
async function current(tx: Tx, engine: NativeEngine & { heartbeatToken?: string }, receipt: CloudExecutionAuthorityReceipt,
  workosEnabled: boolean, sourceNowait = false): Promise<void> {
  if (!matches(engine, receipt.scope) || Date.now() >= receipt.providerExpiresAtMs) refused();
  const lock = sourceNowait ? "FOR SHARE NOWAIT" : "FOR SHARE";
  await tx.query(`SELECT id FROM users WHERE id=$1 ${lock}`, [receipt.actor.userId]);
  await tx.query(`SELECT id FROM user_identities WHERE user_id=$1 AND provider='workos' ORDER BY id ${lock}`, [receipt.actor.userId]);
  await tx.query(`SELECT id FROM auth_sessions WHERE id=$1 ${lock}`, [receipt.sourceSessionId]);
  const engineEpoch = engine.heartbeatToken
    ? (await assertCurrentCloudEngineAuthority(tx, { ...engine, heartbeatToken: engine.heartbeatToken, workosEnabled })).authorityEpoch
    : await (async () => {
      const state = (await tx.query<{ live: boolean; fenced: boolean; authority_epoch: string }>(
        "SELECT live,fenced,authority_epoch FROM cloud_workspace_engine_authority_current($1,$2,$3,$4,$5,true)",
        [engine.workspaceId, engine.organizationId, engine.generation, engine.engineInstanceId, workosEnabled])).rows[0];
      if (!state?.live || state.fenced) refused();
      return Number(state.authority_epoch);
    })();
  if (engineEpoch !== receipt.epochs.wa) refused();
  await tx.query("SELECT id FROM devices WHERE id=$1 FOR SHARE", [receipt.actor.deviceId]);
  await tx.query("SELECT id FROM cloud_agent_credentials WHERE id=$1 FOR SHARE", [receipt.credentialId]);
  await tx.query("SELECT user_id FROM organization_members WHERE org_id=$1 AND user_id=$2 FOR SHARE", [engine.organizationId, receipt.actor.userId]);
  await tx.query("SELECT id FROM cloud_agent_boot_bindings WHERE workspace_id=$1 AND org_id=$2 AND engine_instance_id=$3 AND writer_epoch=$4 FOR SHARE",
    [engine.workspaceId, engine.organizationId, engine.engineInstanceId, receipt.scope.writerEpoch]);
  await tx.query("SELECT writer_epoch FROM cloud_workspace_local_command_writers WHERE workspace_id=$1 AND writer_epoch=$2 FOR SHARE",
    [engine.workspaceId, receipt.scope.writerEpoch]);
  const boot = await readCurrentCloudAgentBootBinding(tx, { workspaceId: engine.workspaceId, organizationId: engine.organizationId });
  if (boot.mode !== "boot-owner-v1" || boot.binding.status !== "current" || boot.binding.writerState !== "active" ||
    Object.entries(receipt.scope).some(([key, value]) => boot.binding[key as keyof typeof boot.binding] !== value)) refused();
  const facts = (await tx.query<{ access_revision: string; member_epoch: string; auth_revision: string;
    proof_version: string; source_expiry: Date | null; db_now: Date }>(`SELECT workspace.access_revision,
      coalesce((SELECT epoch FROM cloud_capability_member_epochs WHERE org_id=workspace.org_id AND user_id=$3),1) AS member_epoch,
      account.auth_revision,source.provider_session_proof_version AS proof_version,source.provider_session_expires_at AS source_expiry,
      clock_timestamp() AS db_now
    FROM cloud_workspaces workspace
    JOIN cloud_workspace_engine_instances engine ON engine.id=$4 AND engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id
      AND engine.generation=$5 AND engine.runtime_id=$6 AND engine.cloud_local_commands_version=1 AND engine.actor_protocol_version=2
    JOIN users account ON account.id=$3 AND account.auth_status='active' AND account.deleted_at IS NULL
    JOIN auth_sessions source ON source.id=$7 AND source.user_id=account.id AND source.provider='workos'
      AND source.status='active' AND source.revoked_at IS NULL
    JOIN user_identities identity ON identity.user_id=account.id AND identity.provider='workos'
      AND identity.provider_sub=source.provider_sub AND identity.status='active'
    JOIN devices device ON device.id=$8 AND device.user_id=account.id AND device.key_version=$9
      AND device.trust_state='trusted' AND device.revoked_at IS NULL
    JOIN cloud_agent_credentials credential ON credential.id=$10 AND credential.owner_user_id=$11
      AND credential.revision=$12 AND credential.revoked_at IS NULL
    WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.deleted_at IS NULL`,
  [engine.workspaceId, engine.organizationId, receipt.actor.userId, engine.engineInstanceId, engine.generation, receipt.runtimeId,
    receipt.sourceSessionId, receipt.actor.deviceId, receipt.actor.deviceKeyVersion, receipt.credentialId,
    receipt.scope.fundingOwnerUserId, receipt.credentialRevision])).rows[0];
  if (!facts || Number(facts.access_revision) !== receipt.epochs.wr || Number(facts.member_epoch) !== receipt.epochs.me ||
    Number(facts.auth_revision) !== receipt.epochs.ac || Number(facts.proof_version) < receipt.providerProofVersion ||
    !facts.source_expiry || Math.min(facts.source_expiry.getTime(), receipt.providerExpiresAtMs) <= facts.db_now.getTime()) refused();
  const actor = await authorizeCloudWorkspaceActor(tx, { ...engine, actorUserId: receipt.actor.userId, capability: "run" });
  if (actor.role !== receipt.actor.role || actor.fingerprint !== receipt.actor.fingerprint ||
    !same(await readCloudAgentFundingConsent(tx, receipt.scope, { userId: receipt.actor.userId, role: actor.role }), receipt.fundingGrant)) refused();
  const captured = await context(tx, receipt, false), binding = CloudBootCustomizationBindingSchema.parse(captured.binding);
  if (binding.actorUserId !== receipt.actor.userId || binding.actorDeviceId !== receipt.actor.deviceId ||
    binding.actorDeviceKeyVersion !== receipt.actor.deviceKeyVersion || binding.actorFingerprint !== receipt.actor.fingerprint ||
    binding.authorityEpoch !== receipt.epochs.wa || !same(binding.fundingGrant, receipt.fundingGrant)) refused();
  await lockCustomization(tx, engine.organizationId);
  const customization = await readCustomizationRows(tx, engine.organizationId, receipt.actor.userId);
  if (Number(captured.organization_revision) !== Number(customization.find(row => row.owner_user_id === null)?.revision ?? 0) ||
    Number(captured.member_revision) !== Number(customization.find(row => row.owner_user_id === receipt.actor.userId)?.revision ?? 0)) refused();
  await assertCloudEngineAuthorityDeadline(tx, engine.engineInstanceId, workosEnabled);
  const now = (await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.getTime();
  if (now >= Math.min(receipt.providerExpiresAtMs, facts.source_expiry.getTime()) || Date.now() >= receipt.providerExpiresAtMs) refused();
}

/** Shared by native Git and the private engine observer. A receipt cannot
 * authorize a different command or renew client/actor/context authority. */
export async function authorizeCloudExecutionInTx(tx: Tx, engine: NativeEngine, input: CloudExecutionAuthorityOperation,
  workosEnabled: boolean, sourceNowait = false): Promise<CloudExecutionAuthorityReceipt> {
  const { row, receipt } = await readStored(tx, engine, input);
  if (row.closed_at) refused();
  await current(tx, engine, receipt, workosEnabled, sourceNowait);
  const latest = (await tx.query<{ closed_at: Date | null }>("SELECT closed_at FROM cloud_accepted_work_enrollments WHERE id=$1 FOR SHARE", [receipt.acceptedWorkId])).rows[0];
  if (!latest || latest.closed_at) refused();
  await assertCloudEngineAuthorityDeadline(tx, engine.engineInstanceId, workosEnabled);
  const final = (await tx.query<{ live: boolean }>(`SELECT provider_session_expires_at>clock_timestamp()
    AND $2::timestamptz>clock_timestamp() AS live FROM auth_sessions WHERE id=$1`,
  [receipt.sourceSessionId, new Date(receipt.providerExpiresAtMs)])).rows[0];
  if (!final?.live || Date.now() >= receipt.providerExpiresAtMs) refused();
  return receipt;
}

export async function authorizeCloudExecutionContextInTx(tx: Tx, engine: NativeEngine,
  source: { acceptedWorkId: string; contextId: string; commandId: string; claimId: string; executionId: string }, workosEnabled: boolean) {
  const row = (await tx.query<Stored>(`SELECT receipt,closed_at FROM cloud_accepted_work_enrollments
    WHERE id=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4 AND engine_instance_id=$5`,
  [source.acceptedWorkId, engine.workspaceId, engine.organizationId, engine.generation, engine.engineInstanceId])).rows[0];
  const parsed = CloudExecutionAuthorityReceiptSchema.safeParse(row?.receipt);
  if (!parsed.success || parsed.data.contextId !== source.contextId) refused();
  const receipt = await authorizeCloudExecutionInTx(tx, engine, { version: 1, scope: parsed.data.scope,
    acceptedWorkId: source.acceptedWorkId, commandId: source.commandId, claimId: source.claimId, executionId: source.executionId }, workosEnabled, true);
  // A prompter's run grant is not a repository write grant.
  await authorizeCloudWorkspaceActor(tx, { ...engine, actorUserId: receipt.actor.userId, capability: "edit" });
  return receipt;
}

export class DatabaseCloudExecutionAuthorityService {
  constructor(private readonly options: { pool: pg.Pool; proof: Pick<AuthSessionProofService, "prove">; workosEnabled: boolean }) {}
  private async admission(tx: Tx, engine: Engine, request: CloudExecutionEnrollRequest) {
    if (!matches(engine, request.scope)) refused();
    const actor = await assertCloudActorSession(tx, engine, request.actorSessionId, "run");
    const captured = await context(tx, request, true), binding = CloudBootCustomizationBindingSchema.parse(captured.binding);
    if (actor.actorUserId !== binding.actorUserId || actor.deviceId !== binding.actorDeviceId || actor.deviceKeyVersion !== binding.actorDeviceKeyVersion ||
      actor.fingerprint !== binding.actorFingerprint || !captured.credential_id || !captured.credential_revision) refused();
    const source = (await tx.query<{ id: string; auth_revision: string; access_revision: string; member_epoch: string }>(`SELECT source.id,account.auth_revision,
      workspace.access_revision,coalesce((SELECT epoch FROM cloud_capability_member_epochs WHERE org_id=workspace.org_id AND user_id=account.id),1) AS member_epoch
      FROM cloud_workspace_actor_sessions actor JOIN users account ON account.id=actor.actor_user_id
      JOIN cloud_workspaces workspace ON workspace.id=actor.workspace_id AND workspace.org_id=actor.org_id
      JOIN auth_sessions source ON source.user_id=account.id AND source.provider='workos' AND source.status='active' AND source.revoked_at IS NULL
        AND ((actor.session_kind='legacy' AND actor.auth_provider='workos' AND source.provider_session_id=actor.auth_session_id AND source.provider_sub=actor.auth_subject
          AND source.created_at=actor.auth_session_created_at) OR (actor.session_kind='capability-v1' AND source.id=actor.capability_source_session_id))
      WHERE actor.id=$1`, [request.actorSessionId])).rows;
    if (source.length !== 1) refused();
    await readCurrentCloudEngineAuthority(tx, { ...engine, workosEnabled: this.options.workosEnabled });
    return { actor, captured, binding, source: source[0]! };
  }
  async enroll(engine: Engine, value: unknown, signal?: AbortSignal): Promise<CloudExecutionAuthorityReceipt> {
    const parsed = CloudExecutionEnrollRequestSchema.safeParse(value);
    if (!parsed.success || !matches(engine, parsed.data.scope)) refused();
    const request = parsed.data, start = performance.now(), deadline = Date.now() + 10_000;
    const live = () => { if (signal?.aborted || Date.now() >= deadline || performance.now() - start >= 10_000) refused(); };
    try {
      const replay = await withSystemTx(this.options.pool, async tx => {
        await readCurrentCloudEngineAuthority(tx, { ...engine, workosEnabled: this.options.workosEnabled });
        const stored = (await tx.query<Stored>(`SELECT receipt,closed_at FROM cloud_accepted_work_enrollments
          WHERE workspace_id=$1 AND generation=$2 AND writer_epoch=$3 AND command_id=$4`,
        [engine.workspaceId, engine.generation, request.scope.writerEpoch, request.command.commandId])).rows[0];
        if (!stored) return null;
        const receipt = CloudExecutionAuthorityReceiptSchema.safeParse(stored.receipt);
        if (!receipt.success || !same(CloudExecutionEnrollRequestSchema.parse(Object.fromEntries(Object.keys(request).map(key =>
          [key, receipt.data[key as keyof typeof receipt.data]]))), request) || stored.closed_at) refused();
        await authorizeCloudExecutionInTx(tx, engine, { version: 1, scope: receipt.data.scope,
          acceptedWorkId: receipt.data.acceptedWorkId, commandId: request.command.commandId,
          claimId: request.claimId, executionId: request.command.executionId }, this.options.workosEnabled);
        live(); return receipt.data;
      });
      if (replay) return replay;
      const before = await withSystemTx(this.options.pool, tx => this.admission(tx, engine, request)); live();
      const proof = await this.options.proof.prove({ rowId: before.source.id, userId: before.actor.actorUserId,
        accountRevision: Number(before.source.auth_revision) }, signal); live();
      const proofAge = Date.now() - proof.observedAtMs, proofDeadline = performance.now() + Math.max(0, 10_000 - proofAge);
      if (proofAge < 0 || proofAge >= 10_000) refused();
      return await withSystemTx(this.options.pool, async tx => {
        // Account/source before workspace, matching revocation. The provider
        // proof above owns no DB connection or lock.
        await tx.query("SELECT id FROM users WHERE id=$1 FOR SHARE", [before.actor.actorUserId]);
        await tx.query("SELECT id FROM user_identities WHERE user_id=$1 AND provider='workos' ORDER BY id FOR SHARE", [before.actor.actorUserId]);
        await tx.query("SELECT id FROM auth_sessions WHERE id=$1 FOR SHARE", [before.source.id]);
        await assertCurrentCloudEngineAuthority(tx, { ...engine, workosEnabled: this.options.workosEnabled });
        live();
        if (proof.rowId !== before.source.id || proof.userId !== before.actor.actorUserId || proof.accountRevision !== Number(before.source.auth_revision)) refused();
        const positive = (await tx.query<{ db_now: Date }>(`SELECT clock_timestamp() AS db_now FROM auth_sessions
          WHERE id=$1 AND provider_session_proof_version=$2 AND provider_session_proved_at=$3 AND provider_session_expires_at=$4
            AND status='active' AND revoked_at IS NULL`, [proof.rowId, proof.proofVersion, new Date(proof.observedAtMs), new Date(proof.expiresAtMs)])).rows[0];
        if (!positive || performance.now() >= proofDeadline) refused();
        const receipt = CloudExecutionAuthorityReceiptSchema.parse({ ...request, mode: "boot-execution-v1", acceptedWorkId: randomUUID(), revision: 1,
          actor: { userId: before.actor.actorUserId, deviceId: before.actor.deviceId, deviceKeyVersion: before.actor.deviceKeyVersion,
            role: before.actor.role, fingerprint: before.actor.fingerprint }, fundingGrant: before.binding.fundingGrant, sourceSessionId: before.source.id,
          epochs: { wa: before.binding.authorityEpoch, wr: Number(before.source.access_revision), me: Number(before.source.member_epoch),
            ac: Number(before.source.auth_revision), dk: before.actor.deviceKeyVersion },
          credentialId: before.captured.credential_id, credentialRevision: Number(before.captured.credential_revision),
          acceptedAtMs: positive.db_now.getTime(), admissionExpiresAtMs: Math.min(deadline, before.captured.expires_at.getTime()),
          providerExpiresAtMs: proof.expiresAtMs, providerProofVersion: proof.proofVersion });
        await current(tx, engine, receipt, this.options.workosEnabled);
        await tx.query("SELECT id FROM cloud_workspace_actor_sessions WHERE id=$1 FOR SHARE", [request.actorSessionId]);
        const after = await this.admission(tx, engine, request); live();
        if (!same(before.binding, after.binding) || !same(before.source, after.source) ||
          before.captured.credential_id !== after.captured.credential_id || before.captured.credential_revision !== after.captured.credential_revision) refused();
        const count = (await tx.query<{ total: number; active: number }>(`SELECT count(*)::int AS total,
          count(*) FILTER(WHERE closed_at IS NULL AND provider_expires_at>clock_timestamp())::int AS active
          FROM cloud_accepted_work_enrollments WHERE workspace_id=$1 AND writer_epoch=$2`, [engine.workspaceId, request.scope.writerEpoch])).rows[0]!;
        if (count.active >= 256 || count.total >= 100_000) throw new HttpError(429, "execution_authority_limit", "Execution authority limit reached");
        // The existing immutable enrollment table stores both closed receipt
        // versions. Legacy strict readers refuse this distinct mode.
        const inserted = await tx.query(`INSERT INTO cloud_accepted_work_enrollments(id,workspace_id,org_id,generation,engine_instance_id,
          writer_epoch,command_id,receipt,capability_expires_at,provider_expires_at,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(workspace_id,generation,writer_epoch,command_id) DO NOTHING RETURNING id`,
        [receipt.acceptedWorkId, engine.workspaceId, engine.organizationId, engine.generation, engine.engineInstanceId, request.scope.writerEpoch,
          request.command.commandId, receipt, new Date(receipt.admissionExpiresAtMs), new Date(receipt.providerExpiresAtMs), new Date(receipt.acceptedAtMs)]);
        if (inserted.rowCount !== 1) refused();
        await this.admission(tx, engine, request); await assertCloudEngineAuthorityDeadline(tx, engine.engineInstanceId, this.options.workosEnabled);
        live(); if (performance.now() >= proofDeadline || Date.now() >= Math.min(receipt.admissionExpiresAtMs, receipt.providerExpiresAtMs)) refused();
        return receipt;
      });
    } catch (error) { return safeRefusal(error); }
  }
  async check(engine: Engine, value: unknown) {
    const input = CloudExecutionAuthorityOperationSchema.safeParse(value);
    if (!input.success) refused();
    return withSystemTx(this.options.pool, async tx => {
      // Authenticate before interpreting a policy refusal as retirement.
      await readCurrentCloudEngineAuthority(tx, { ...engine, workosEnabled: this.options.workosEnabled });
      const { row, receipt } = await readStored(tx, engine, input.data);
      let revoked = row.closed_at !== null;
      if (!revoked) try { await authorizeCloudExecutionInTx(tx, engine, input.data, this.options.workosEnabled); }
      catch (error) { if (!denial(error)) throw error; revoked = true; }
      if (revoked) await tx.query("UPDATE cloud_accepted_work_enrollments SET closed_at=coalesce(closed_at,clock_timestamp()) WHERE id=$1", [receipt.acceptedWorkId]);
      return { version: 1 as const, acceptedWorkId: receipt.acceptedWorkId, state: revoked ? "revoked" as const : "current" as const };
    });
  }
  async close(engine: Engine, value: unknown): Promise<void> {
    const input = CloudExecutionAuthorityOperationSchema.safeParse(value);
    if (!input.success) refused();
    await withSystemTx(this.options.pool, async tx => {
      await assertCurrentCloudEngineAuthority(tx, { ...engine, workosEnabled: this.options.workosEnabled });
      const { receipt } = await readStored(tx, engine, input.data);
      await tx.query("UPDATE cloud_accepted_work_enrollments SET closed_at=coalesce(closed_at,clock_timestamp()) WHERE id=$1", [receipt.acceptedWorkId]);
    });
  }
}
