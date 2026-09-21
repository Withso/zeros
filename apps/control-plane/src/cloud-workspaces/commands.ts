import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withSystemTx, type Tx } from "../db.js";
import { assertCurrentCloudEngineAuthority } from "./engine-authority.js";
import { HttpError } from "../authz.js";
import { assertCloudRequestActor, assertRecordedCloudActor, type CloudRecordedActor } from "./actor-sessions.js";

const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const revision = z.number().int().safe().nonnegative();
const uuid = z.string().uuid();
export const CloudQueuedPromptSchema = z.object({
  agentId: identity,
  userMessageId: identity,
  prompt: z.array(z.record(z.unknown())).min(1).max(128),
  bubble: z.record(z.unknown()).optional(),
  modeRevision: revision,
  agentCredentialGrantId:uuid.optional(),
  model:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/).optional(),
  effort:z.enum(["low","medium","high","xhigh"]).optional(),
  fast:z.boolean().optional(),
}).strict().superRefine((value,context)=>{
  if(value.agentCredentialGrantId&&(!value.model||!["claude","cursor","codex"].includes(value.agentId)))
    context.addIssue({code:"custom",message:"Personal credential execution requires an explicit provider and model"});
});
export const CloudCommandMutationSchema = z.object({
  conversationId: identity,
  operationId: uuid,
  expectedRevision: revision,
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("enqueue"), commandId: uuid, payload: CloudQueuedPromptSchema }).strict(),
    z.object({ kind: z.literal("edit"), commandId: uuid, payload: CloudQueuedPromptSchema }).strict(),
    z.object({ kind: z.literal("remove"), commandId: uuid }).strict(),
    z.object({ kind: z.literal("pause") }).strict(),
    z.object({ kind: z.literal("resume") }).strict(),
  ]),
}).strict();
export const CloudCommandSettleSchema = z.object({
  commandId: uuid, claimId: uuid, state: z.enum(["succeeded", "failed", "cancelled"]),
  resultCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
}).strict();
const admissionErrorSchema = z.enum(["command_context_changed", "command_not_found"]).nullable();
export const CloudCommandRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), conversationId: identity }).strict(),
  z.object({ kind: z.literal("read"), commandId: uuid }).strict(),
  z.object({ kind: z.literal("mutate"), mutation: CloudCommandMutationSchema,
    admissionError: admissionErrorSchema.optional() }).strict(),
  z.object({ kind: z.literal("stop"), conversationId: identity, operationId: uuid }).strict(),
  z.object({ kind: z.literal("claim"), conversationId: identity, executionId: identity, claimId: uuid.optional() }).strict(),
  z.object({ kind: z.literal("settle"), result: CloudCommandSettleSchema }).strict(),
]);
export type CloudCommandMutation = z.infer<typeof CloudCommandMutationSchema>;
export type CloudQueuedPrompt = z.infer<typeof CloudQueuedPromptSchema>;
export type CloudCommandEngineScope = {
  workspaceId: string; organizationId: string; generation: number;
  engineInstanceId: string; heartbeatToken: string;
  actorSessionId?: string;
};
export type CloudCommandState = "queued" | "dispatching" | "succeeded" | "failed" | "cancelled" | "uncertain";
export class CloudCommandError extends Error {
  constructor(readonly code: "invalid_command" | "command_conflict" | "command_context_changed" | "command_limit" | "command_not_found", message: string) {
    super(message); this.name = "CloudCommandError";
  }
}
type Control = { revision: string; paused: boolean; next_position: string };
type Command = { id: string; position: string; state: CloudCommandState; payload: CloudQueuedPrompt | null;
  generation: number; engine_instance_id: string | null; execution_id: string | null; claim_id: string | null;
  result_code: string | null; created_at: Date; updated_at: Date;
  actor_user_id: string | null; actor_device_id: string | null;
  actor_device_key_version: string | null; actor_fingerprint: string | null;actor_source_session_id:string|null };
const MAX_OPERATION_RECEIPTS = 200000;
const MAX_RETAINED_PROMPT_BYTES = 64 * 1024 * 1024;

function safeInteger(value: string | number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n >= Number.MAX_SAFE_INTEGER)
    throw new CloudCommandError("command_limit", "Command revision is exhausted");
  return n;
}
function canonical(value: unknown, state = { nodes: 0 }, depth = 0): string {
  if (++state.nodes > 20000 || depth > 24) throw new CloudCommandError("invalid_command", "Command is too complex");
  if (value === null || typeof value === "boolean" || typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => canonical(v, state, depth + 1)).join(",")}]`;
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new CloudCommandError("invalid_command", "Command contains unsupported data");
  return `{${Object.keys(value).sort().map(key => {
    if (["__proto__", "prototype", "constructor"].includes(key) || key.length > 256)
      throw new CloudCommandError("invalid_command", "Command contains an invalid key");
    return `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], state, depth + 1)}`;
  }).join(",")}}`;
}
function parseMutation(value: unknown): { mutation: CloudCommandMutation; hash: Buffer } {
  const parsed = CloudCommandMutationSchema.safeParse(value);
  if (!parsed.success) throw new CloudCommandError("invalid_command", "Invalid cloud command");
  const serialized = canonical(parsed.data);
  // Leave headroom for jsonb formatting and the bounded queue snapshot.
  if (Buffer.byteLength(serialized) > 192 * 1024)
    throw new CloudCommandError("command_limit", "Command is too large; use artifact references");
  return { mutation: parsed.data, hash: createHash("sha256").update(serialized).digest() };
}
function commandView(row: Command) {
  return { commandId: row.id, position: safeInteger(row.position), state: row.state,
    payload: row.payload, executionId: row.execution_id, generation: row.generation,
    resultCode: row.result_code, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

type OperationActor = { actor_user_id: string | null; actor_device_id: string | null };
function sameOperationActor(row:OperationActor,actor:CloudRecordedActor|null):boolean {
  return row.actor_user_id===(actor?.actorUserId??null) && row.actor_device_id===(actor?.deviceId??null);
}

/** All methods take the live engine fence and lock workspace → engine → queue.
 * Client disconnects do not own queue state; old engines cannot claim or settle.
 * There is deliberately no timed lease that could replay a dispatched prompt. */
export class DatabaseCloudWorkspaceCommandService {
  constructor(private readonly options: { pool: pg.Pool; workosEnabled?: boolean }) {}

  private async authorize(tx: Tx, scope: CloudCommandEngineScope) {
    return assertCurrentCloudEngineAuthority(tx, { ...scope, workosEnabled: this.options.workosEnabled === true });
  }
  private async dispatchAuthority(tx:Tx,scope:CloudCommandEngineScope,row:Command) {
    try {
      if (!row.actor_fingerprint) {
        const {actorSessionId:_session,...engineScope}=scope;
        await assertCloudRequestActor(tx,engineScope,"run");
        return {};
      }
      if (!row.actor_user_id || !row.actor_device_id || !row.actor_device_key_version || !row.actor_source_session_id)
        return {dispatchAllowed:false as const};
      const actor={actorUserId:row.actor_user_id,deviceId:row.actor_device_id,
        deviceKeyVersion:Number(row.actor_device_key_version),fingerprint:row.actor_fingerprint,sourceSessionId:row.actor_source_session_id};
      const authority=await assertRecordedCloudActor(tx,{...scope,actorUserId:actor.actorUserId,actor,capability:"run"});
      return {dispatchAllowed:true as const,actor:{userId:actor.actorUserId,deviceId:actor.deviceId,
        deviceKeyVersion:actor.deviceKeyVersion,fingerprint:actor.fingerprint,role:authority.role}};
    } catch(error) {
      if (error instanceof HttpError) return {dispatchAllowed:false as const};
      throw error;
    }
  }
  private async control(tx: Tx, scope: CloudCommandEngineScope, conversationId: string): Promise<Control> {
    if (!identity.safeParse(conversationId).success) throw new CloudCommandError("invalid_command", "Invalid conversation identity");
    const existing = await tx.query<Control>(`SELECT revision, paused, next_position
      FROM cloud_workspace_conversation_controls WHERE workspace_id=$1 AND conversation_id=$2 FOR UPDATE`, [scope.workspaceId, conversationId]);
    if (existing.rows[0]) return existing.rows[0];
    const count = await tx.query<{ count: string }>(`SELECT count(*) FROM cloud_workspace_conversation_controls WHERE workspace_id=$1`, [scope.workspaceId]);
    if (Number(count.rows[0]!.count) >= 10000) throw new CloudCommandError("command_limit", "Workspace conversation limit reached");
    return (await tx.query<Control>(`INSERT INTO cloud_workspace_conversation_controls(workspace_id,org_id,conversation_id)
      VALUES($1,$2,$3) RETURNING revision,paused,next_position`, [scope.workspaceId, scope.organizationId, conversationId])).rows[0]!;
  }
  private async bump(tx: Tx, scope: CloudCommandEngineScope, conversationId: string) {
    await tx.query(`UPDATE cloud_workspace_conversation_controls SET revision=revision+1,updated_at=now()
      WHERE workspace_id=$1 AND conversation_id=$2`, [scope.workspaceId, conversationId]);
  }
  private async recover(tx: Tx, scope: CloudCommandEngineScope, conversationId: string) {
    const interrupted = await tx.query(`UPDATE cloud_workspace_commands SET state='uncertain',
      result_code='engine_interrupted',updated_at=now() WHERE workspace_id=$1 AND conversation_id=$2
      AND state='dispatching' AND (engine_instance_id<>$3 OR generation<>$4) RETURNING id`,
    [scope.workspaceId, conversationId, scope.engineInstanceId, scope.generation]);
    const staleQueue = await tx.query(`SELECT 1 FROM cloud_workspace_commands WHERE workspace_id=$1 AND conversation_id=$2
      AND state='queued' AND (generation<>$3 OR engine_instance_id IS DISTINCT FROM $4::uuid) LIMIT 1`,
    [scope.workspaceId, conversationId, scope.generation, scope.engineInstanceId]);
    if (interrupted.rowCount || staleQueue.rowCount) {
      await tx.query(`UPDATE cloud_workspace_conversation_controls SET paused=true,revision=revision+1,updated_at=now()
        WHERE workspace_id=$1 AND conversation_id=$2 AND (NOT paused OR $3::boolean)`,
      [scope.workspaceId, conversationId, Boolean(interrupted.rowCount)]);
      // Once marked paused, an explicit Resume accepts these still-undispatched
      // entries for the new engine. Their conversation identity stays stable.
      await tx.query(`UPDATE cloud_workspace_commands SET generation=$3,engine_instance_id=$4 WHERE workspace_id=$1 AND conversation_id=$2
        AND state='queued'`, [scope.workspaceId, conversationId, scope.generation, scope.engineInstanceId]);
    }
  }
  private async view(tx: Tx, scope: CloudCommandEngineScope, conversationId: string) {
    const control = await this.control(tx, scope, conversationId);
    const pending = await tx.query<Command>(`SELECT * FROM cloud_workspace_commands WHERE workspace_id=$1 AND conversation_id=$2
      AND state IN ('queued','dispatching') ORDER BY position LIMIT 33`, [scope.workspaceId, conversationId]);
    const receipts = await tx.query<Command>(`SELECT id,position,state,NULL::jsonb AS payload,generation,engine_instance_id,
      execution_id,claim_id,result_code,created_at,updated_at FROM cloud_workspace_commands WHERE workspace_id=$1 AND conversation_id=$2
      AND state NOT IN ('queued','dispatching') ORDER BY updated_at DESC,id LIMIT 50`, [scope.workspaceId, conversationId]);
    return { version: 1 as const, conversationId, revision: safeInteger(control.revision), paused: control.paused,
      pending: pending.rows.map(commandView), receipts: receipts.rows.map(row => commandView({ ...row, payload: null })) };
  }
  async snapshot(scope: CloudCommandEngineScope, conversationId: string) {
    return withSystemTx(this.options.pool, async tx => {
      await this.authorize(tx, scope); await assertCloudRequestActor(tx,scope,"read");
      await this.control(tx, scope, conversationId);
      await this.recover(tx, scope, conversationId);
      return this.view(tx, scope, conversationId);
    });
  }
  /** Uncertain prompts are retained for explicit inspection, never replayed.
   * Read one exact command so a receipt list cannot amplify large payloads. */
  async read(scope: CloudCommandEngineScope, commandId: string) {
    if (!uuid.safeParse(commandId).success) throw new CloudCommandError("invalid_command", "Invalid command identity");
    return withSystemTx(this.options.pool, async tx => {
      await this.authorize(tx, scope);
      await assertCloudRequestActor(tx,scope,"read");
      const row = (await tx.query<Command & { conversation_id: string }>(`SELECT * FROM cloud_workspace_commands
        WHERE workspace_id=$1 AND id=$2`, [scope.workspaceId, commandId])).rows[0];
      if (!row) throw new CloudCommandError("command_not_found", "Command is unavailable");
      await this.control(tx, scope, row.conversation_id);
      await this.recover(tx, scope, row.conversation_id);
      const current = (await tx.query<Command>(`SELECT * FROM cloud_workspace_commands WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId, commandId])).rows[0]!;
      return { ...commandView(current), conversationId: row.conversation_id };
    });
  }
  async mutate(scope: CloudCommandEngineScope, value: unknown,
    admissionError: "command_context_changed" | "command_not_found" | null = null) {
    const { mutation: m, hash: contentHash } = parseMutation(value);
    if (!admissionErrorSchema.safeParse(admissionError).success)
      throw new CloudCommandError("invalid_command", "Invalid command admission result");
    return withSystemTx(this.options.pool, async tx => {
      await this.authorize(tx, scope);
      const actor=await assertCloudRequestActor(tx,scope,m.action.kind==="edit"?"edit":"run");
      const hash=actor?createHash("sha256").update(contentHash).update(canonical({actorUserId:actor.actorUserId,deviceId:actor.deviceId,
        deviceKeyVersion:actor.deviceKeyVersion,fingerprint:actor.fingerprint})).digest():contentHash;
      await this.control(tx, scope, m.conversationId);
      await this.recover(tx, scope, m.conversationId);
      const replay = (await tx.query<OperationActor & { request_sha256: Buffer; conversation_id: string }>(`SELECT request_sha256,conversation_id,actor_user_id,actor_device_id
        FROM cloud_workspace_command_operations WHERE workspace_id=$1 AND operation_id=$2`, [scope.workspaceId, m.operationId])).rows[0];
      if (replay) {
        if (!sameOperationActor(replay,actor) || replay.conversation_id !== m.conversationId || !timingSafeEqual(replay.request_sha256, hash))
          throw new CloudCommandError("command_conflict", "Command identity was already used with different content");
        return { ...(await this.view(tx, scope, m.conversationId)), replayed: true };
      }
      // The engine checks current mode/ownership, but a historical retry must
      // resolve its committed receipt before consulting today's authoring state.
      if (admissionError) throw new CloudCommandError(admissionError, "Conversation context changed");
      const control = await this.control(tx, scope, m.conversationId);
      if (safeInteger(control.revision) !== m.expectedRevision)
        throw new CloudCommandError("command_conflict", "Conversation control changed; read its current revision");
      const receiptCount = await tx.query<{ count: string }>(`SELECT count(*) FROM cloud_workspace_command_operations WHERE workspace_id=$1`, [scope.workspaceId]);
      if (Number(receiptCount.rows[0]!.count) >= MAX_OPERATION_RECEIPTS)
        throw new CloudCommandError("command_limit", "Workspace command history capacity reached");
      const action = m.action;
      if (action.kind === "enqueue" || action.kind === "edit") {
        const retained = await tx.query<{ bytes: string }>(`SELECT coalesce(sum(octet_length(payload::text)),0) AS bytes
          FROM cloud_workspace_commands WHERE workspace_id=$1 AND payload IS NOT NULL`, [scope.workspaceId]);
        if (Number(retained.rows[0]!.bytes) + Buffer.byteLength(JSON.stringify(action.payload)) > MAX_RETAINED_PROMPT_BYTES)
          throw new CloudCommandError("command_limit", "Retained prompt capacity reached");
      }
      if (action.kind === "enqueue") {
        const count = (await tx.query<{ pending: string; total: string }>(`SELECT count(*) FILTER(WHERE state IN ('queued','dispatching')) AS pending,
          count(*) AS total FROM cloud_workspace_commands WHERE workspace_id=$1`, [scope.workspaceId])).rows[0]!;
        if (Number(count.pending) >= 32 || Number(count.total) >= 100000)
          throw new CloudCommandError("command_limit", "Workspace command limit reached");
        const inserted = await tx.query(`INSERT INTO cloud_workspace_commands(workspace_id,org_id,id,conversation_id,position,state,payload,generation,engine_instance_id,user_message_id,
          actor_user_id,actor_device_id,actor_device_key_version,actor_fingerprint,actor_source_session_id)
          VALUES($1,$2,$3,$4,$5,'queued',$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING RETURNING id`,
        [scope.workspaceId, scope.organizationId, action.commandId, m.conversationId, safeInteger(control.next_position), JSON.stringify(action.payload), scope.generation, scope.engineInstanceId, action.payload.userMessageId,
          actor?.actorUserId??null,actor?.deviceId??null,actor?.deviceKeyVersion??null,actor?.fingerprint??null,actor?.sourceSessionId??null]);
        if (!inserted.rowCount) throw new CloudCommandError("command_conflict", "Command already exists");
        await tx.query(`UPDATE cloud_workspace_conversation_controls SET next_position=next_position+1 WHERE workspace_id=$1 AND conversation_id=$2`, [scope.workspaceId, m.conversationId]);
      } else if (action.kind === "pause" || action.kind === "resume") {
        await tx.query(`UPDATE cloud_workspace_conversation_controls SET paused=$3 WHERE workspace_id=$1 AND conversation_id=$2`,
        [scope.workspaceId, m.conversationId, action.kind === "pause"]);
      } else {
        const updated = await tx.query(`UPDATE cloud_workspace_commands SET
          state=$4,payload=$5::jsonb,result_code=$6,updated_at=now() WHERE workspace_id=$1 AND conversation_id=$2 AND id=$3 AND state='queued'
          AND ($7::text IS NULL OR user_message_id=$7) RETURNING id`,
        [scope.workspaceId, m.conversationId, action.commandId, action.kind === "edit" ? "queued" : "cancelled",
          action.kind === "edit" ? JSON.stringify(action.payload) : null, action.kind === "remove" ? "removed_before_dispatch" : null,
          action.kind === "edit" ? action.payload.userMessageId : null]);
        if (!updated.rowCount) throw new CloudCommandError("command_conflict", "Only a queued command can be edited or removed");
        if (action.kind==="edit") await tx.query(`UPDATE cloud_workspace_commands SET actor_user_id=$3,actor_device_id=$4,
          actor_device_key_version=$5,actor_fingerprint=$6,actor_source_session_id=$7 WHERE workspace_id=$1 AND id=$2`,
        [scope.workspaceId,action.commandId,actor?.actorUserId??null,actor?.deviceId??null,actor?.deviceKeyVersion??null,actor?.fingerprint??null,actor?.sourceSessionId??null]);
      }
      await this.bump(tx, scope, m.conversationId);
      const snapshot = await this.view(tx, scope, m.conversationId);
      await tx.query(`INSERT INTO cloud_workspace_command_operations(workspace_id,org_id,operation_id,conversation_id,request_sha256,revision,actor_user_id,actor_device_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [scope.workspaceId, scope.organizationId, m.operationId, m.conversationId, hash, snapshot.revision,actor?.actorUserId??null,actor?.deviceId??null]);
      return { ...snapshot, replayed: false };
    });
  }
  /** Stop is monotonic and must not lose a race with completion or enqueue.
   * Unlike edit/resume it does not require the device's last queue revision. */
  async stop(scope: CloudCommandEngineScope, conversationId: string, operationId: string) {
    if (!identity.safeParse(conversationId).success || !uuid.safeParse(operationId).success)
      throw new CloudCommandError("invalid_command", "Invalid stop identity");
    const contentHash = createHash("sha256").update(canonical({ kind: "stop", conversationId })).digest();
    return withSystemTx(this.options.pool, async tx => {
      await this.authorize(tx, scope); const actor=await assertCloudRequestActor(tx,scope,"run");
      const hash=actor?createHash("sha256").update(contentHash).update(canonical({actorUserId:actor.actorUserId,deviceId:actor.deviceId,
        deviceKeyVersion:actor.deviceKeyVersion,fingerprint:actor.fingerprint})).digest():contentHash;
      await this.control(tx, scope, conversationId);
      await this.recover(tx, scope, conversationId);
      const replay = (await tx.query<OperationActor & { request_sha256: Buffer }>(`SELECT request_sha256,actor_user_id,actor_device_id
        FROM cloud_workspace_command_operations WHERE workspace_id=$1 AND operation_id=$2`, [scope.workspaceId, operationId])).rows[0];
      if (replay) {
        if (!sameOperationActor(replay,actor) || !timingSafeEqual(hash, replay.request_sha256)) throw new CloudCommandError("command_conflict", "Stop identity was already used");
        return { ...(await this.view(tx, scope, conversationId)), replayed: true };
      }
      const count = await tx.query<{ count: string }>(`SELECT count(*) FROM cloud_workspace_command_operations WHERE workspace_id=$1`, [scope.workspaceId]);
      if (Number(count.rows[0]!.count) >= MAX_OPERATION_RECEIPTS) {
        // Receipt exhaustion permanently rejects Resume/new mutations. Stop
        // can still monotonically pause work without unbounded receipt growth.
        await tx.query(`UPDATE cloud_workspace_conversation_controls SET paused=true,revision=revision+1,updated_at=now()
          WHERE workspace_id=$1 AND conversation_id=$2 AND NOT paused`, [scope.workspaceId, conversationId]);
        return { ...(await this.view(tx, scope, conversationId)), replayed: false };
      }
      await tx.query(`UPDATE cloud_workspace_conversation_controls SET paused=true,revision=revision+1,updated_at=now()
        WHERE workspace_id=$1 AND conversation_id=$2`, [scope.workspaceId, conversationId]);
      const snapshot = await this.view(tx, scope, conversationId);
      await tx.query(`INSERT INTO cloud_workspace_command_operations(workspace_id,org_id,operation_id,conversation_id,request_sha256,revision,actor_user_id,actor_device_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [scope.workspaceId, scope.organizationId, operationId, conversationId, hash, snapshot.revision,actor?.actorUserId??null,actor?.deviceId??null]);
      return { ...snapshot, replayed: false };
    });
  }
  async claim(scope: CloudCommandEngineScope, conversationId: string, executionId: string, requestClaimId?: string) {
    if (!identity.safeParse(executionId).success || (requestClaimId !== undefined && !uuid.safeParse(requestClaimId).success))
      throw new CloudCommandError("invalid_command", "Invalid execution or claim identity");
    return withSystemTx(this.options.pool, async tx => {
      await this.authorize(tx, scope); await this.control(tx, scope, conversationId);
      await this.recover(tx, scope, conversationId);
      if (requestClaimId) {
        const previous = (await tx.query<Command & { conversation_id: string }>(`SELECT * FROM cloud_workspace_commands
          WHERE workspace_id=$1 AND claim_id=$2`, [scope.workspaceId, requestClaimId])).rows[0];
        if (previous) {
          if (previous.conversation_id !== conversationId || previous.execution_id !== executionId ||
            previous.engine_instance_id !== scope.engineInstanceId || previous.generation !== scope.generation)
            throw new CloudCommandError("command_conflict", "Claim identity belongs to another dispatch");
          // Resolve an accepted claim even when Stop arrived after its commit.
          // The engine then settles it cancelled before entering the provider.
          if (previous.state !== "dispatching") return null;
          return { commandId: previous.id, claimId: requestClaimId, conversationId, executionId, payload: previous.payload!,
            ...await this.dispatchAuthority(tx,scope,previous) };
        }
      }
      const control = await this.control(tx, scope, conversationId);
      if (control.paused) return null;
      const active = await tx.query(`SELECT 1 FROM cloud_workspace_commands WHERE workspace_id=$1 AND conversation_id=$2 AND state='dispatching'`, [scope.workspaceId, conversationId]);
      if (active.rowCount) return null;
      const row = (await tx.query<Command>(`SELECT * FROM cloud_workspace_commands WHERE workspace_id=$1 AND conversation_id=$2
        AND state='queued' ORDER BY position LIMIT 1 FOR UPDATE`, [scope.workspaceId, conversationId])).rows[0];
      if (!row) return null;
      const claimId = requestClaimId ?? randomUUID();
      await tx.query(`UPDATE cloud_workspace_commands SET state='dispatching',engine_instance_id=$3,generation=$4,execution_id=$5,claim_id=$6,updated_at=now()
        WHERE workspace_id=$1 AND id=$2`, [scope.workspaceId, row.id, scope.engineInstanceId, scope.generation, executionId, claimId]);
      await this.bump(tx, scope, conversationId);
      return { commandId: row.id, claimId, conversationId, executionId, payload: row.payload!,
        ...await this.dispatchAuthority(tx,scope,row) };
    });
  }
  async settle(scope: CloudCommandEngineScope, input: { commandId: string; claimId: string; state: "succeeded" | "failed" | "cancelled"; resultCode: string | null }) {
    const valid = CloudCommandSettleSchema.safeParse(input);
    if (!valid.success) throw new CloudCommandError("invalid_command", "Invalid command result");
    return withSystemTx(this.options.pool, async tx => {
      await this.authorize(tx, scope);
      const row = (await tx.query<Command & { conversation_id: string }>(`SELECT * FROM cloud_workspace_commands WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [scope.workspaceId, input.commandId])).rows[0];
      if (!row || row.claim_id !== input.claimId || row.engine_instance_id !== scope.engineInstanceId || row.generation !== scope.generation)
        throw new CloudCommandError("command_conflict", "Command dispatch authority changed");
      if (row.state !== "dispatching") {
        if (row.state !== input.state || row.result_code !== input.resultCode)
          throw new CloudCommandError("command_conflict", "Command result already settled");
        return { ...(await this.view(tx, scope, row.conversation_id)), replayed: true };
      }
      await this.control(tx, scope, row.conversation_id);
      await tx.query(`UPDATE cloud_workspace_commands SET state=$3,result_code=$4,payload=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, input.commandId, input.state, input.resultCode]);
      await this.bump(tx, scope, row.conversation_id);
      return { ...(await this.view(tx, scope, row.conversation_id)), replayed: false };
    });
  }
}
