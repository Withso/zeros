import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Sqlite from "better-sqlite3";
import { z } from "zod";
import { CloudAgentBootScopeSchema, type CloudAgentBootScope } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudBootCommandEntrySchema } from "@zeros/protocol/cloud-commands";
import { canonicalCloudLocalCommandHistoryJson as canonical, CloudLocalCommandHistorySchema, CloudLocalCommandHistoryHeadSchema,
  CloudLocalCommandHistoryManifestSchema, CloudLocalCommandHistoryRecordSchema, CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES } from "@zeros/protocol/cloud-local-mirror";
import { HarnessFailure } from "./assertions";

const digest = z.string().regex(/^[a-f0-9]{64}$/), count = z.number().int().safe().nonnegative();
export const LocalMirrorProofSchema = z.object({ version: z.literal(1), commandId: z.uuid(), conversationId: z.uuid(),
  scopeSha256: digest, receiptSha256: digest, auditSha256: digest, headSha256: digest,
  history: z.enum(["complete", "incomplete"]), incompleteReason: z.enum(["capture_unavailable", "capture_conflict", "history_limit", "recovery_uncertain"]).nullable(),
  recordCount: count.max(16_384), recordBytes: count.max(CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES), recordsSha256: digest.nullable(),
  outboxPending: z.boolean() }).strict().superRefine((value, context) => {
  if (value.history === "complete" ? value.incompleteReason !== null || value.recordsSha256 === null
    : value.incompleteReason === null || value.recordsSha256 !== null || value.recordCount !== 0 || value.recordBytes !== 0)
    context.addIssue({ code: "custom", message: "Local mirror coverage is inconsistent" });
});
export type LocalMirrorProof = z.infer<typeof LocalMirrorProofSchema>;
export const mirrorProofSha256 = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

/** Read only from the caller's private fixture SQLite handle. Namespace entry
 * owns the fixed canonical path/read-only open AFTER its mount/PID/root guards.
 * Receipt/CAS prose never leaves this function; only strict hashes and counts. */
export function readFixtureLocalMirrorProof(db: Sqlite.Database, input: {
  scope: CloudAgentBootScope; commandId: string; conversationId: string;
}): LocalMirrorProof {
  try {
    const scope = CloudAgentBootScopeSchema.parse(input.scope);
    z.uuid().parse(input.commandId); z.uuid().parse(input.conversationId);
    return db.transaction(() => {
      const writer = db.prepare("SELECT value FROM local_command_metadata WHERE key='writer'").get() as { value: string } | undefined;
      if (!writer || !isDeepStrictEqual(CloudAgentBootScopeSchema.parse(JSON.parse(writer.value)), scope)) throw new Error();
      const row = db.prepare(`SELECT id,conversation_id,writer_epoch,position,state,payload,execution_id,generation,
        result_code,result,created_at,updated_at,history,user_message_id,agent_id FROM local_commands WHERE id=? AND conversation_id=?`)
        .get(input.commandId, input.conversationId) as Record<string, string | number | null> | undefined;
      if (!row || row.writer_epoch !== scope.writerEpoch || row.generation !== scope.generation ||
          !["succeeded", "failed", "cancelled", "uncertain"].includes(String(row.state)) || row.payload !== null) throw new Error();
      const entry = CloudBootCommandEntrySchema.parse({ commandId: row.id, position: row.position, state: row.state, payload: null,
        executionId: row.execution_id, generation: row.generation, resultCode: row.result_code, createdAt: row.created_at, updatedAt: row.updated_at,
        ...(row.result === null ? {} : { result: JSON.parse(String(row.result)) }) });
      const audit = CloudLocalCommandHistorySchema.parse(JSON.parse(String(row.history)));
      const storedHead = db.prepare("SELECT document FROM local_command_history_heads WHERE conversation_id=?").get(input.conversationId) as { document: string } | undefined;
      if (!storedHead) throw new Error();
      const head = CloudLocalCommandHistoryHeadSchema.parse(JSON.parse(storedHead.document));
      if (head.originWriterEpoch !== scope.writerEpoch || head.source.kind !== "command" || head.source.commandId !== entry.commandId ||
          head.source.executionId !== entry.executionId || head.source.intent.agentId !== row.agent_id || head.source.intent.userMessageId !== row.user_message_id ||
          head.source.nativeResultSha256 !== (entry.result == null ? null : mirrorProofSha256(entry.result))) throw new Error();
      const records: z.infer<typeof CloudLocalCommandHistoryRecordSchema>[] = [];
      let recordBytes = 0;
      const document = (sha256: string, kind: "record" | "manifest") => {
        const stored = db.prepare("SELECT kind,document,bytes FROM local_command_history_documents WHERE sha256=?").get(sha256) as
          { kind: string; document: string; bytes: number } | undefined;
        if (!stored || stored.kind !== kind || Buffer.byteLength(stored.document) !== stored.bytes ||
            stored.bytes > CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES) throw new Error();
        const parsed: unknown = JSON.parse(stored.document);
        if (canonical(parsed) !== stored.document || mirrorProofSha256(parsed) !== sha256) throw new Error();
        return parsed;
      };
      if ("manifestSha256" in head.history) {
        const manifest = CloudLocalCommandHistoryManifestSchema.parse(document(head.history.manifestSha256, "manifest"));
        if (!isDeepStrictEqual(manifest.scope, scope) || manifest.conversationId !== input.conversationId || manifest.restoreRevision !== head.history.restoreRevision ||
            manifest.recordSequence !== head.history.recordSequence || manifest.eventSequence !== head.history.eventSequence ||
            manifest.deleted !== head.deleted || !isDeepStrictEqual(manifest.source, head.source) || manifest.records.length > 16_384) throw new Error();
        for (const reference of manifest.records) {
          const record = CloudLocalCommandHistoryRecordSchema.parse(document(reference.sha256, "record"));
          if (record.conversationId !== input.conversationId || ["entityKind", "entityId", "schemaVersion", "sourceRevision"].some(key =>
            record[key as keyof typeof record] !== reference[key as keyof typeof reference])) throw new Error();
          recordBytes += Buffer.byteLength(canonical(record));
          if (recordBytes > CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES) throw new Error();
          records.push(record);
        }
      }
      const cursor = (key: "mirrorHead" | "journalHead") => {
        const stored = db.prepare("SELECT value FROM local_command_metadata WHERE key=?").get(key) as { value: string } | undefined;
        if (!stored || !/^(0|[1-9][0-9]*)$/.test(stored.value) || !Number.isSafeInteger(Number(stored.value))) throw new Error();
        return Number(stored.value);
      };
      const mirrored = cursor("mirrorHead"), journaled = cursor("journalHead");
      if (mirrored > journaled) throw new Error();
      const outboxPending = mirrored !== journaled || !!db.prepare("SELECT 1 FROM local_command_mirror_batches LIMIT 1").get() ||
        !!db.prepare("SELECT 1 FROM local_command_journal LIMIT 1").get() ||
        !!db.prepare("SELECT 1 FROM local_command_outbox_jobs LIMIT 1").get() ||
        !!db.prepare("SELECT 1 FROM local_commands WHERE mirror_dirty=1 LIMIT 1").get() ||
        !!db.prepare("SELECT 1 FROM local_command_controls WHERE mirror_dirty=1 LIMIT 1").get();
      return LocalMirrorProofSchema.parse({ version: 1, commandId: input.commandId, conversationId: input.conversationId,
        scopeSha256: mirrorProofSha256(scope), receiptSha256: mirrorProofSha256(entry), auditSha256: mirrorProofSha256(audit),
        headSha256: mirrorProofSha256(head), history: "manifestSha256" in head.history ? "complete" : "incomplete",
        incompleteReason: "incompleteReason" in head.history ? head.history.incompleteReason : null, recordCount: records.length, recordBytes,
        recordsSha256: "manifestSha256" in head.history ? mirrorProofSha256(records) : null, outboxPending });
    }).deferred();
  } catch { throw new HarnessFailure("fixture_inspection_failed"); }
}
