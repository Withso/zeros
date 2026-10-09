import { createHash, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withSystemTx, type Tx } from "../db.js";
import { assertCurrentCloudEngineAuthority } from "./engine-authority.js";
import type { CloudCommandEngineScope } from "./commands.js";
import { CloudActorProvenanceSchema } from "./agent-boot-contract.js";

const sequence = z.number().int().safe().nonnegative();
const frameSchema = z.object({
  id: z.string().min(1).max(128), source: z.literal("engine"), timestamp: z.number().finite(),
  cloudStream: z.object({ streamId: z.string().uuid(), sequence: sequence.refine(n => n > 0), requiresSnapshot: z.literal(true).optional() }).strict(),
  type: z.enum(["AGENT_SESSION_UPDATE", "AGENT_PERMISSION_REQUEST", "AGENT_PERMISSION_SETTLED",
    "AGENT_QUESTION_REQUEST", "AGENT_QUESTION_SETTLED", "AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED", "DB_CHANGED"]),
}).passthrough();
export const CloudEventRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("append"), batchId: z.string().uuid(), events: z.array(z.object({
    sequence: sequence.refine(n => n > 0), frame: frameSchema,
  }).strict()).min(1).max(128) }).strict(),
  z.object({ kind: z.literal("replay"), streamId: z.string().uuid(), after: sequence }).strict(),
]);
export type CloudEventRequest = z.infer<typeof CloudEventRequestSchema>;
export class CloudEventError extends Error {
  constructor(readonly code: "invalid_event" | "event_conflict" | "event_cursor_expired" | "event_stream_changed") {
    super(code); this.name = "CloudEventError";
  }
}
type Stream = { engine_instance_id: string; head: string; first_retained: string; last_batch_id: string | null; last_batch_sha256: Buffer | null };
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;
const RETAINED_BYTES = 16 * 1024 * 1024;
const RETAINED_EVENTS = 10000;

/** Engine-fenced, ordered batches. Only the last batch can be retried: the
 * producer has one in-flight batch and never retries a native agent prompt. */
export class DatabaseCloudWorkspaceEventService {
  constructor(private readonly options: { pool: pg.Pool; workosEnabled?: boolean }) {}

  private async stream(tx: Tx, scope: CloudCommandEngineScope, readOnly: boolean): Promise<Stream> {
    // The stream row lock orders appends; appends write no workspace or
    // engine row, so they share the revocation fence with other engine work.
    await assertCurrentCloudEngineAuthority(tx, { ...scope, workosEnabled: this.options.workosEnabled === true, lock: "share" });
    const old = (await tx.query<Stream>(`SELECT engine_instance_id,head,first_retained,last_batch_id,last_batch_sha256
      FROM cloud_workspace_event_streams WHERE workspace_id=$1 FOR ${readOnly ? "SHARE" : "UPDATE"}`, [scope.workspaceId])).rows[0];
    if (old?.engine_instance_id === scope.engineInstanceId) return old;
    // A new generation has no replay until its first append. Never expose the
    // previous engine's frames or mutate stream state while holding read locks.
    if (readOnly) return { engine_instance_id: scope.engineInstanceId, head: "0", first_retained: "1", last_batch_id: null, last_batch_sha256: null };
    // Shared authority does not order two first appends from this engine (a
    // retried batch) or a replacement racing its predecessor's DELETE: create
    // idempotently, then lock whichever row this engine's stream now is.
    if (old) await tx.query(`DELETE FROM cloud_workspace_event_streams WHERE workspace_id=$1 AND engine_instance_id<>$2`,
      [scope.workspaceId, scope.engineInstanceId]);
    const created = (await tx.query<Stream>(`INSERT INTO cloud_workspace_event_streams(workspace_id,org_id,generation,engine_instance_id)
      VALUES($1,$2,$3,$4) ON CONFLICT (workspace_id) DO NOTHING
      RETURNING engine_instance_id,head,first_retained,last_batch_id,last_batch_sha256`,
    [scope.workspaceId, scope.organizationId, scope.generation, scope.engineInstanceId])).rows[0];
    if (created) return created;
    const current = (await tx.query<Stream>(`SELECT engine_instance_id,head,first_retained,last_batch_id,last_batch_sha256
      FROM cloud_workspace_event_streams WHERE workspace_id=$1 FOR UPDATE`, [scope.workspaceId])).rows[0];
    if (current?.engine_instance_id !== scope.engineInstanceId) throw new CloudEventError("event_conflict");
    return current;
  }

  async request(scope: CloudCommandEngineScope, value: unknown) {
    const parsed = CloudEventRequestSchema.safeParse(value);
    if (!parsed.success) throw new CloudEventError("invalid_event");
    const request = parsed.data;
    const encoded = request.kind === "append" ? JSON.stringify(request.events) : "";
    if (Buffer.byteLength(encoded) > MAX_BATCH_BYTES || (request.kind === "append" && request.events.some((event, index) =>
      Buffer.byteLength(JSON.stringify(event.frame)) > MAX_FRAME_BYTES || event.sequence !== request.events[0]!.sequence + index)))
      throw new CloudEventError("invalid_event");
    return withSystemTx(this.options.pool, async tx => {
      const stream = await this.stream(tx, scope, request.kind === "replay");
      if (request.kind === "replay" && request.streamId !== scope.engineInstanceId) throw new CloudEventError("event_stream_changed");
      const head = Number(stream.head), first = Number(stream.first_retained);
      if (!Number.isSafeInteger(head) || head >= Number.MAX_SAFE_INTEGER - 128) throw new CloudEventError("event_conflict");
      if (request.kind === "append") {
        if (request.events.some(event => event.frame.cloudStream.streamId !== scope.engineInstanceId || event.frame.cloudStream.sequence !== event.sequence))
          throw new CloudEventError("invalid_event");
        const hash = createHash("sha256").update(encoded).digest();
        if (stream.last_batch_id === request.batchId) {
          if (!stream.last_batch_sha256 || !timingSafeEqual(hash, stream.last_batch_sha256)) throw new CloudEventError("event_conflict");
          return { streamId: scope.engineInstanceId, head, replayed: true };
        }
        if (request.events[0]!.sequence !== head + 1) throw new CloudEventError("event_conflict");
        const next = request.events.at(-1)!.sequence;
        const rows = request.events.map(e => ({ ...e, bytes: Buffer.byteLength(JSON.stringify(e.frame)) }));
        // One round trip inside the workspace lock inserts the batch, prunes
        // from the oldest end by BOTH event count and encoded bytes, and
        // advances the stream. Sub-statements share one snapshot, so stored
        // rows are ranked in index order behind the batch's own count and
        // bytes. The batch itself always fits the bounds; if it ever did not,
        // retention would keep it whole rather than record a boundary inside
        // rows this statement cannot yet delete.
        await tx.query(`WITH inserted AS (
            INSERT INTO cloud_workspace_stream_events(workspace_id,org_id,sequence,frame,encoded_bytes)
            SELECT $1,$2,e.sequence,e.frame,e.bytes FROM jsonb_to_recordset($3::jsonb)
            AS e(sequence bigint,frame jsonb,bytes integer)
          ), boundary AS (
            SELECT coalesce(min(sequence),$6) AS first FROM (
              SELECT sequence,row_number() OVER newest AS n,sum(encoded_bytes) OVER newest AS bytes
              FROM cloud_workspace_stream_events WHERE workspace_id=$1
              WINDOW newest AS (ORDER BY sequence DESC)
            ) stored WHERE n+$7<=$4 AND bytes+$8<=$5
          ), pruned AS (
            DELETE FROM cloud_workspace_stream_events WHERE workspace_id=$1 AND sequence<(SELECT first FROM boundary)
          )
          UPDATE cloud_workspace_event_streams SET head=$9,first_retained=(SELECT first FROM boundary),
            last_batch_id=$10,last_batch_sha256=$11,updated_at=now()
          WHERE workspace_id=$1`, [scope.workspaceId, scope.organizationId, JSON.stringify(rows),
          RETAINED_EVENTS, RETAINED_BYTES, request.events[0]!.sequence, rows.length,
          rows.reduce((total, row) => total + row.bytes, 0), next, request.batchId, hash]);
        return { streamId: scope.engineInstanceId, head: next, replayed: false };
      }
      if (request.after < first - 1) throw new CloudEventError("event_cursor_expired");
      if (request.after > head) throw new CloudEventError("event_conflict");
      if (head === 0) return { streamId: scope.engineInstanceId, head, firstRetained: first, cursor: 0, events: [] };
      const rows = await tx.query<{ sequence: string; frame: Record<string, unknown>; bytes: string }>(`SELECT sequence,frame,
        sum(encoded_bytes) OVER(ORDER BY sequence) AS bytes FROM cloud_workspace_stream_events
        WHERE workspace_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 128`, [scope.workspaceId, request.after]);
      const events = rows.rows.filter(row => Number(row.bytes) <= MAX_BATCH_BYTES)
        .map(row => ({ sequence: Number(row.sequence), frame: row.frame }));
      return { streamId: scope.engineInstanceId, head, firstRetained: first,
        cursor: events.at(-1)?.sequence ?? request.after, events };
    });
  }
}

// Standalone Zod3 mirror: CP deploys independently of the desktop protocol.
type CompactJson = null | boolean | number | string | CompactJson[] | { [key: string]: CompactJson };
// Check native JSON without reconstructing objects or discarding own keys.
const compactJson = z.custom<CompactJson>(value => {
  const pending = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 20_000 || item.depth > 32) return false;
    if (item.value === null || typeof item.value === "string" || typeof item.value === "boolean") continue;
    if (typeof item.value === "number") { if (!Number.isFinite(item.value)) return false; continue; }
    if (!item.value || typeof item.value !== "object" || (!Array.isArray(item.value) && ![Object.prototype, null].includes(Object.getPrototypeOf(item.value)))) return false;
    if (Array.isArray(item.value) && Object.keys(item.value).length !== item.value.length) return false;
    const children = Object.values(item.value);
    if (pending.length + nodes + children.length > 20_000) return false;
    for (const value of children) pending.push({ value, depth: item.depth + 1 });
  }
  return true;
}, { message: "Compact native content is not bounded JSON" });
const compactSequence = z.number().int().safe().nonnegative();
const identity = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const amount = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const CloudEventCursorSchema = z.object({ streamId: z.string().uuid(), sequence: compactSequence }).strict();
const controlText = z.string().max(256 * 1024);
const controlId = z.string().min(1).max(8192);
const controlIdentity = z.string().min(1).max(128);
const permissionKind = z.enum(["allow_once", "allow_always", "reject_once", "reject_always", "allow_always_project"]);
const compactTool = z.object({
  toolCallId: controlIdentity, title: controlText, nativeToolCallId: controlId.nullable().optional(),
  kind: z.enum(["read", "edit", "delete", "move", "search", "list", "web_search", "execute", "think", "fetch", "switch_mode",
    "subagent", "task", "mcp", "question", "skill", "tool_search", "task_create", "task_update", "background_task", "compaction",
    "model_switch", "budget_stop", "other"]).nullable().optional(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]).nullable().optional(),
  content: z.array(compactJson).max(128).nullable().optional(),
  locations: z.array(z.object({ path: controlText, line: amount.optional() }).strict()).max(128).nullable().optional(),
  rawInput: compactJson.optional(), rawOutput: compactJson.optional(), mergeKey: controlId.nullable().optional(),
  parentToolId: controlId.nullable().optional(), at: amount.nullable().optional(),
}).strict();
const compactPermission = z.object({
  sessionId: controlIdentity, executionId: controlIdentity.optional(), toolCall: compactTool,
  options: z.array(z.object({ optionId: controlId, name: controlText, kind: permissionKind }).strict()).min(1).max(128),
  autoResolution: permissionKind.optional(), title: controlText.optional(), contextItems: z.array(controlText).max(128).optional(),
  useOptionNames: z.boolean().optional(), allowLocalPolicies: z.boolean().optional(), requiresExplicitApproval: z.boolean().optional(),
  nativeRequestId: controlId.optional(),
}).strict();
const compactQuestionOption = z.object({
  id: controlId, label: controlText, description: controlText.optional(), preview: controlText.optional(), exclusive: z.boolean().optional(),
  externalAction: z.object({ kind: z.literal("open-url"), url: controlId }).strict().optional(),
}).strict();
const compactQuestion = z.object({
  sessionId: controlIdentity, executionId: controlIdentity.optional(), questionId: controlIdentity, nativeRequestId: controlId,
  toolCallId: controlId.optional(), source: z.enum(["native_dialog", "native_rpc", "inferred_from_text"]), blocking: z.boolean(),
  allowDecline: z.boolean().optional(), expiresAt: amount.optional(),
  questions: z.array(z.object({
    id: controlId, prompt: controlText, header: controlText.optional(), multiSelect: z.boolean().optional(),
    options: z.array(compactQuestionOption).max(128), allowOther: z.boolean(), defaultOptionIds: z.array(controlId).max(128).optional(),
    defaultFreeText: controlText.optional(), allowEmptyFreeText: z.boolean().optional(), preserveFreeText: z.boolean().optional(),
    secret: z.boolean().optional(), presentation: z.literal("one_click_approval").optional(), approvalPrompt: controlText.optional(),
    approvalKind: z.enum(["browser_origin", "tool"]).optional(), approvalTarget: controlId.optional(),
  }).strict()).min(1).max(128),
}).strict();
const compactQuestionOutcome = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("answered"), answers: z.array(z.object({ questionId: controlId,
    selectedOptionIds: z.array(controlId).max(128), freeText: controlText.optional() }).strict()).max(128) }).strict(),
  z.object({ outcome: z.literal("declined") }).strict(), z.object({ outcome: z.literal("dismissed") }).strict(),
]);
const compactBase = { id: controlIdentity, timestamp: z.number().finite(), source: z.literal("engine"), agentId: z.string().min(1).max(64),
  chatId: identity.optional(), cloudStream: CloudEventCursorSchema.extend({ sequence: compactSequence.positive(), requiresSnapshot: z.literal(true).optional() }).optional() };
const compactFrame = z.discriminatedUnion("type", [
  z.object({ ...compactBase, type: z.literal("AGENT_PERMISSION_REQUEST"), permissionId: controlIdentity, request: compactPermission }).strict(),
  z.object({ ...compactBase, type: z.literal("AGENT_PERMISSION_SETTLED"), permissionId: controlIdentity,
    sessionId: controlIdentity, executionId: controlIdentity.optional() }).strict(),
  z.object({ ...compactBase, type: z.literal("AGENT_QUESTION_REQUEST"), questionId: controlIdentity, request: compactQuestion }).strict(),
  z.object({ ...compactBase, type: z.literal("AGENT_QUESTION_SETTLED"), questionId: controlIdentity, outcome: compactQuestionOutcome }).strict(),
]);
export const CloudCompactControlFrameSchema = z.preprocess((value, context) => {
  // Bound complexity before recursive JSON parsing. Native/tool data is still
  // untrusted; invalid/oversized controls require an explicit failure/snapshot.
  const pending = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 20_000 || current.depth > 32) {
      context.addIssue({ code: "custom", message: "Compact control is too complex" }); return z.NEVER;
    }
    if (current.value && typeof current.value === "object") {
      if (!Array.isArray(current.value) && ![Object.prototype, null].includes(Object.getPrototypeOf(current.value))) {
        context.addIssue({ code: "custom", message: "Compact control is not JSON" }); return z.NEVER;
      }
      for (const item of Object.values(current.value)) pending.push({ value: item, depth: current.depth + 1 });
    } else if (typeof current.value === "function" || typeof current.value === "symbol" || typeof current.value === "bigint") {
      context.addIssue({ code: "custom", message: "Compact control is not JSON" }); return z.NEVER;
    }
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024) {
      context.addIssue({ code: "custom", message: "Compact control exceeds byte limit" }); return z.NEVER;
    }
  } catch { context.addIssue({ code: "custom", message: "Compact control is not JSON" }); return z.NEVER; }
  return value;
}, compactFrame);
export type CloudCompactControlFrame = z.infer<typeof CloudCompactControlFrameSchema>;


const positiveCompactSequence = z.number().int().safe().positive();
const parentSchema = z.object({ organizationId: z.string().uuid(), workspaceId: z.string().uuid(),
  writerEpoch: z.string().uuid(), outboxSequence: positiveCompactSequence, conversationId: identity, commandId: z.string().uuid() }).strict();
export const CloudCompactControlEventSchema = z.object({ version: z.literal(1), eventSequence: positiveCompactSequence,
  executionId: identity, turnId: identity.optional(), commandId: z.string().uuid().optional(), frame: CloudCompactControlFrameSchema,
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024 ||
      ("executionId" in value.frame && value.frame.executionId !== undefined && value.frame.executionId !== value.executionId) ||
      ("request" in value.frame && value.frame.request.executionId !== undefined && value.frame.request.executionId !== value.executionId))
    context.addIssue({ code: "custom", message: "Compact event bounds or ownership are inconsistent" });
});
type Parent = {
  id: string; workspace_id: string; org_id: string; conversation_id: string; writer_epoch: string; projection_epoch: string;
  execution_id: string | null; user_message_id: string; agent_id: string; generation: number;
  projection_state: string; origin_engine_instance_id: string; origin_boot_id: string; origin_generation: number;
  origin_funding_owner_user_id: string; origin_funding_owner_epoch: string; actor_provenance: unknown;
};
type Stored = { command_id: string; execution_id: string; user_message_id: string; agent_id: string; conversation_id: string;
  local_stream_id: string; local_sequence: string; resolver_id: string; type: string; frame: unknown };
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

/** Only called in the authenticated exact-bound mirror transaction. No new
 * authority, claim, native dispatch, HTTP call or nested transaction. */
export async function applyCompactCloudAgentEvent(tx: Tx, supplied: unknown, value: unknown): Promise<{ replayed: boolean }> {
  const parsedScope = parentSchema.safeParse(supplied), parsedEvent = CloudCompactControlEventSchema.safeParse(value);
  if (!parsedScope.success || !parsedEvent.success) throw new CloudEventError("invalid_event");
  const scope = parsedScope.data, event = parsedEvent.data, frame = event.frame;
  const row = (await tx.query<Parent>(`SELECT c.id,c.workspace_id,c.org_id,c.conversation_id,c.writer_epoch,c.projection_epoch,
      c.execution_id,c.user_message_id,c.agent_id,c.generation,c.actor_provenance,p.state AS projection_state,
      o.engine_instance_id AS origin_engine_instance_id,o.boot_id AS origin_boot_id,o.generation AS origin_generation,
      o.funding_owner_user_id AS origin_funding_owner_user_id,o.funding_owner_epoch AS origin_funding_owner_epoch
    FROM cloud_workspace_local_commands c
    JOIN cloud_workspace_local_command_writers o ON o.workspace_id=c.workspace_id AND o.org_id=c.org_id AND o.writer_epoch=c.writer_epoch
    JOIN cloud_workspace_local_command_writers p ON p.workspace_id=c.workspace_id AND p.org_id=c.org_id AND p.writer_epoch=c.projection_epoch
    WHERE c.workspace_id=$1 AND c.org_id=$2 AND c.projection_epoch=$3 AND c.conversation_id=$4 AND c.id=$5
    FOR SHARE OF c,o,p`, [scope.workspaceId, scope.organizationId, scope.writerEpoch, scope.conversationId, scope.commandId])).rows[0];
  const actor = CloudActorProvenanceSchema.safeParse(row?.actor_provenance);
  if (!row || !actor.success || actor.data.actor.role === "viewer" || actor.data.fundingConsentVersion !== 1 || !actor.data.fundingGrant || row.id !== scope.commandId || row.workspace_id !== scope.workspaceId || row.org_id !== scope.organizationId ||
      row.projection_epoch !== scope.writerEpoch || row.conversation_id !== scope.conversationId || !["active", "retired"].includes(row.projection_state) ||
      row.execution_id !== event.executionId || frame.agentId !== row.agent_id ||
      (event.commandId !== undefined && event.commandId !== row.id) || (event.turnId !== undefined && event.turnId !== row.user_message_id) ||
      (frame.chatId !== undefined && frame.chatId !== row.conversation_id) ||
      actor.data.scope.organizationId !== row.org_id || actor.data.scope.workspaceId !== row.workspace_id ||
      actor.data.scope.writerEpoch !== row.writer_epoch || actor.data.scope.bootId !== row.origin_boot_id ||
      actor.data.scope.engineInstanceId !== row.origin_engine_instance_id || actor.data.scope.generation !== row.origin_generation ||
      row.generation !== row.origin_generation || actor.data.scope.fundingOwnerUserId !== row.origin_funding_owner_user_id ||
      actor.data.scope.fundingOwnerEpoch !== Number(row.origin_funding_owner_epoch) ||
      (frame.cloudStream && (frame.cloudStream.streamId !== row.origin_engine_instance_id || frame.cloudStream.sequence !== event.eventSequence)) ||
      ("request" in frame && frame.request.sessionId !== row.execution_id) ||
      (frame.type === "AGENT_PERMISSION_SETTLED" && frame.sessionId !== row.execution_id) ||
      (frame.type === "AGENT_QUESTION_REQUEST" && frame.questionId !== frame.request.questionId))
    throw new CloudEventError("event_conflict");

  const resolver = "permissionId" in frame ? frame.permissionId : frame.questionId;
  const streamId = frame.cloudStream?.streamId ?? row.origin_engine_instance_id;
  const previous = (await tx.query<Stored>(`SELECT command_id,execution_id,user_message_id,agent_id,conversation_id,
      local_stream_id,local_sequence,resolver_id,type,frame FROM cloud_workspace_local_agent_controls
    WHERE workspace_id=$1 AND org_id=$2 AND ((projection_epoch=$3 AND outbox_sequence=$4)
      OR (local_stream_id=$5 AND local_sequence=$6)) FOR SHARE`,
  [scope.workspaceId, scope.organizationId, scope.writerEpoch, scope.outboxSequence, streamId, event.eventSequence])).rows;
  if (previous.length > 1) throw new CloudEventError("event_conflict");
  const prior = previous[0];
  if (prior) {
    if (prior.command_id !== row.id || prior.execution_id !== row.execution_id || prior.user_message_id !== row.user_message_id ||
        prior.agent_id !== row.agent_id || prior.conversation_id !== row.conversation_id || prior.local_stream_id !== streamId ||
        Number(prior.local_sequence) !== event.eventSequence || prior.resolver_id !== resolver || prior.type !== frame.type ||
        canonical(prior.frame) !== canonical(frame)) throw new CloudEventError("event_conflict");
    return { replayed: true };
  }
  const requestType = frame.type === "AGENT_PERMISSION_SETTLED" ? "AGENT_PERMISSION_REQUEST" :
    frame.type === "AGENT_QUESTION_SETTLED" ? "AGENT_QUESTION_REQUEST" : null;
  if (requestType) {
    const request = (await tx.query<Stored>(`SELECT command_id,execution_id,user_message_id,agent_id,conversation_id,
        local_stream_id,local_sequence,resolver_id,type,frame FROM cloud_workspace_local_agent_controls
      WHERE workspace_id=$1 AND org_id=$2 AND command_id=$3 AND execution_id=$4 AND user_message_id=$5
        AND agent_id=$6 AND conversation_id=$7 AND local_stream_id=$8 AND resolver_id=$9 AND type=$10
        AND local_sequence<$11 FOR SHARE`, [scope.workspaceId, scope.organizationId, row.id, row.execution_id,
    row.user_message_id, row.agent_id, row.conversation_id, streamId, resolver, requestType, event.eventSequence])).rows[0];
    if (!request || request.type !== requestType || !Number.isSafeInteger(Number(request.local_sequence)) ||
        Number(request.local_sequence) <= 0 || Number(request.local_sequence) >= event.eventSequence ||
        request.command_id !== row.id || request.execution_id !== row.execution_id ||
        request.user_message_id !== row.user_message_id || request.agent_id !== row.agent_id ||
        request.conversation_id !== row.conversation_id || request.local_stream_id !== streamId || request.resolver_id !== resolver)
      throw new CloudEventError("event_conflict");
  }
  await tx.query(`INSERT INTO cloud_workspace_local_agent_controls(workspace_id,org_id,projection_epoch,outbox_sequence,
      local_stream_id,local_sequence,conversation_id,execution_id,command_id,user_message_id,agent_id,resolver_id,type,frame)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`, [scope.workspaceId, scope.organizationId,
  scope.writerEpoch, scope.outboxSequence, streamId, event.eventSequence, row.conversation_id, row.execution_id,
  row.id, row.user_message_id, row.agent_id, resolver, frame.type, JSON.stringify(frame)]);
  return { replayed: false };
}
