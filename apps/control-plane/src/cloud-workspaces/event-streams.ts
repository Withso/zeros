import { createHash, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withSystemTx, type Tx } from "../db.js";
import { assertCurrentCloudEngineAuthority } from "./engine-authority.js";
import type { CloudCommandEngineScope } from "./commands.js";

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
    await assertCurrentCloudEngineAuthority(tx, { ...scope, workosEnabled: this.options.workosEnabled === true,
      ...(readOnly ? { lock: "share" as const } : {}) });
    const old = (await tx.query<Stream>(`SELECT engine_instance_id,head,first_retained,last_batch_id,last_batch_sha256
      FROM cloud_workspace_event_streams WHERE workspace_id=$1 FOR ${readOnly ? "SHARE" : "UPDATE"}`, [scope.workspaceId])).rows[0];
    if (old?.engine_instance_id === scope.engineInstanceId) return old;
    // A new generation has no replay until its first append. Never expose the
    // previous engine's frames or mutate stream state while holding read locks.
    if (readOnly) return { engine_instance_id: scope.engineInstanceId, head: "0", first_retained: "1", last_batch_id: null, last_batch_sha256: null };
    if (old) await tx.query(`DELETE FROM cloud_workspace_event_streams WHERE workspace_id=$1`, [scope.workspaceId]);
    return (await tx.query<Stream>(`INSERT INTO cloud_workspace_event_streams(workspace_id,org_id,generation,engine_instance_id)
      VALUES($1,$2,$3,$4) RETURNING engine_instance_id,head,first_retained,last_batch_id,last_batch_sha256`,
    [scope.workspaceId, scope.organizationId, scope.generation, scope.engineInstanceId])).rows[0]!;
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
        await tx.query(`INSERT INTO cloud_workspace_stream_events(workspace_id,org_id,sequence,frame,encoded_bytes)
          SELECT $1,$2,e.sequence,e.frame,e.bytes FROM jsonb_to_recordset($3::jsonb)
          AS e(sequence bigint,frame jsonb,bytes integer)`, [scope.workspaceId, scope.organizationId,
          JSON.stringify(request.events.map(e => ({ ...e, bytes: Buffer.byteLength(JSON.stringify(e.frame)) })))]);
        const next = request.events.at(-1)!.sequence;
        // Prune from the oldest end by BOTH event count and encoded bytes.
        const boundary = await tx.query<{ first: string }>(`SELECT min(sequence) AS first FROM (
          SELECT sequence,row_number() OVER(ORDER BY sequence DESC) AS n,
            sum(encoded_bytes) OVER(ORDER BY sequence DESC) AS bytes
          FROM cloud_workspace_stream_events WHERE workspace_id=$1
        ) retained WHERE n<=$2 AND bytes<=$3`, [scope.workspaceId, RETAINED_EVENTS, RETAINED_BYTES]);
        const firstRetained = Number(boundary.rows[0]!.first);
        await tx.query(`DELETE FROM cloud_workspace_stream_events WHERE workspace_id=$1 AND sequence<$2`, [scope.workspaceId, firstRetained]);
        await tx.query(`UPDATE cloud_workspace_event_streams SET head=$2,first_retained=$3,last_batch_id=$4,last_batch_sha256=$5,updated_at=now()
          WHERE workspace_id=$1`, [scope.workspaceId, next, firstRetained, request.batchId, hash]);
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
