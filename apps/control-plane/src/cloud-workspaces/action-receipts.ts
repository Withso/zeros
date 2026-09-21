import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withSystemTx, type Tx } from "../db.js";
import { assertCurrentCloudEngineAuthority } from "./engine-authority.js";
import { CloudCommandError, type CloudCommandEngineScope } from "./commands.js";
import { assertCloudRequestActor } from "./actor-sessions.js";
import {assertCloudAgentExecutionActor,withCloudAgentCredentialRetry} from "./agent-executions.js";

const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const outcome = z.enum(["delivered", "queued", "interrupted"]);
export const CloudActionInputSchema = z.object({
  operationId: z.string().uuid(), conversationId: identity, executionId: identity,
  kind: z.enum(["permission", "question", "steer"]), requestId: identity,
  payload: z.record(z.unknown()),
}).strict().refine(action => action.kind !== "steer" || action.requestId === action.payload.userMessageId,
  { message: "Steering identity must match its user message" });
export const CloudActionEngineRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), operationId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("begin"), action: CloudActionInputSchema, admissible: z.boolean() }).strict(),
  z.object({ kind: z.literal("settle"), operationId: z.string().uuid(), claimId: z.string().uuid(),
    outcome, turnId: identity.nullable() }).strict(),
]);
type Action = z.infer<typeof CloudActionInputSchema>;
type Row = {
  operation_id: string; conversation_id: string; execution_id: string;
  kind: Action["kind"]; request_id: string; request_sha256: Buffer;
  generation: number; engine_instance_id: string; claim_id: string;
  state: "dispatching" | "settled" | "uncertain";
  outcome: z.infer<typeof outcome> | null; turn_id: string | null;
  actor_user_id:string|null;actor_device_id:string|null;
};

function canonical(value: unknown, budget = { nodes: 0 }, depth = 0): string {
  if (++budget.nodes > 20000 || depth > 24) throw new CloudCommandError("invalid_command", "Action is too complex");
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => canonical(v, budget, depth + 1)).join(",")}]`;
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new CloudCommandError("invalid_command", "Invalid action data");
  return `{${Object.keys(value).sort().map(key => {
    if (["__proto__", "prototype", "constructor"].includes(key) || key.length > 256)
      throw new CloudCommandError("invalid_command", "Invalid action key");
    return `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], budget, depth + 1)}`;
  }).join(",")}}`;
}
function view(row: Row, replayed: boolean) {
  return { operationId: row.operation_id, conversationId: row.conversation_id, executionId: row.execution_id,
    kind: row.kind, requestId: row.request_id, state: row.state, outcome: row.outcome,
    turnId: row.turn_id, claimId: row.claim_id, replayed };
}

/** No answer or prompt content is retained. A hash binds retries; the receipt
 * survives execution teardown and replacement. Old dispatches become uncertain. */
export class DatabaseCloudWorkspaceActionService {
  constructor(private readonly options: { pool: pg.Pool; workosEnabled?: boolean }) {}

  private async authorize(tx: Tx, scope: CloudCommandEngineScope) {
    await assertCurrentCloudEngineAuthority(tx, { ...scope, workosEnabled: this.options.workosEnabled === true });
    await tx.query(`UPDATE cloud_workspace_action_receipts SET state='uncertain',outcome='interrupted',updated_at=now()
      WHERE workspace_id=$1 AND state='dispatching' AND (generation<>$2 OR engine_instance_id<>$3)`,
    [scope.workspaceId, scope.generation, scope.engineInstanceId]);
  }
  async request(scope: CloudCommandEngineScope, input: unknown) {
    // Validate the original object before Zod can normalize record keys.
    if (Buffer.byteLength(canonical(input)) > 200 * 1024)
      throw new CloudCommandError("command_limit", "Action is too large");
    const parsed = CloudActionEngineRequestSchema.safeParse(input);
    if (!parsed.success) throw new CloudCommandError("invalid_command", "Invalid action request");
    const request = parsed.data;
    let contentHash: Buffer | null = null;
    if (request.kind === "begin") {
      const bytes = canonical(request.action);
      if (Buffer.byteLength(bytes) > 192 * 1024) throw new CloudCommandError("command_limit", "Action is too large");
      contentHash = createHash("sha256").update(bytes).digest();
    }
    return withCloudAgentCredentialRetry(()=>withSystemTx(this.options.pool, async tx => {
      await this.authorize(tx, scope);
      const actor=request.kind==="settle"?null:await assertCloudRequestActor(tx,scope,request.kind==="read"?"read":"run");
      const hash=contentHash && actor?createHash("sha256").update(contentHash).update(canonical({actorUserId:actor.actorUserId,
        deviceId:actor.deviceId,deviceKeyVersion:actor.deviceKeyVersion,fingerprint:actor.fingerprint})).digest():contentHash;
      const operationId = request.kind === "begin" ? request.action.operationId : request.operationId;
      const row = (await tx.query<Row>(`SELECT * FROM cloud_workspace_action_receipts
        WHERE workspace_id=$1 AND operation_id=$2 FOR UPDATE`, [scope.workspaceId, operationId])).rows[0];
      if (request.kind === "read") {
        if (!row) throw new CloudCommandError("command_not_found", "Action is unavailable");
        return view(row, true);
      }
      if (request.kind === "begin") {
        if (row) {
          if (row.actor_user_id!==(actor?.actorUserId??null) || row.actor_device_id!==(actor?.deviceId??null) ||
              !timingSafeEqual(row.request_sha256, hash!)) throw new CloudCommandError("command_conflict", "Action identity conflicts");
          return view(row, true);
        }
        if (!request.admissible) throw new CloudCommandError("command_context_changed", "Action no longer has a live target");
        if(actor)await assertCloudAgentExecutionActor(tx,scope,request.action.executionId,actor.sourceSessionId);
        const count = (await tx.query<{ count: string }>(`SELECT count(*) FROM cloud_workspace_action_receipts WHERE workspace_id=$1`, [scope.workspaceId])).rows[0]!;
        if (Number(count.count) >= 100000) throw new CloudCommandError("command_limit", "Action history capacity reached");
        const a = request.action;
        const inserted = (await tx.query<Row>(`INSERT INTO cloud_workspace_action_receipts
          (workspace_id,org_id,operation_id,conversation_id,execution_id,kind,request_id,request_sha256,generation,engine_instance_id,claim_id,state,turn_id,actor_user_id,actor_device_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'dispatching',$12,$13,$14) ON CONFLICT DO NOTHING RETURNING *`,
        [scope.workspaceId, scope.organizationId, operationId, a.conversationId, a.executionId, a.kind, a.requestId,
          hash, scope.generation, scope.engineInstanceId, randomUUID(),
          a.kind === "steer" && identity.safeParse(a.payload.turnId).success ? a.payload.turnId : null,
          actor?.actorUserId??null,actor?.deviceId??null])).rows[0];
        if (!inserted) throw new CloudCommandError("command_conflict", "Another device already answered this request");
        return view(inserted, false);
      }
      if (!row) throw new CloudCommandError("command_not_found", "Action is unavailable");
      if (row.claim_id !== request.claimId || row.generation !== scope.generation || row.engine_instance_id !== scope.engineInstanceId)
        throw new CloudCommandError("command_conflict", "Action claim changed");
      if (row.state !== "dispatching") {
        if (row.state !== "settled" || row.outcome !== request.outcome || row.turn_id !== request.turnId)
          throw new CloudCommandError("command_conflict", "Action result conflicts");
        return view(row, true);
      }
      const updated = (await tx.query<Row>(`UPDATE cloud_workspace_action_receipts SET state='settled',outcome=$3,turn_id=$4,updated_at=now()
        WHERE workspace_id=$1 AND operation_id=$2 RETURNING *`, [scope.workspaceId, operationId, request.outcome, request.turnId])).rows[0]!;
      return view(updated, false);
    }));
  }
}
