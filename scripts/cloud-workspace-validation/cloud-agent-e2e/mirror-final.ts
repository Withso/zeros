import { z } from "zod";
import { CloudAgentBootScopeSchema, type CloudAgentBootScope } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudBootCommandEntrySchema } from "@zeros/protocol/cloud-commands";
import { CloudLocalCommandHistoryHeadSchema, CloudLocalCommandHistoryRecordSchema, CloudLocalCommandHistorySchema,
  canonicalCloudLocalCommandHistoryJson as canonical, CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES } from "@zeros/protocol/cloud-local-mirror";
import { HarnessFailure } from "./assertions";
import { LocalMirrorProofSchema, mirrorProofSha256 as hash } from "./local-mirror-proof";

type Input = { scope: CloudAgentBootScope; conversationId: string; commandId: string; entry: unknown;
  fixture: { readMirrorCommand(commandId: string): unknown; readMirrorHistory(conversationId: string): unknown;
    assertMirrorTerminalConsistency(commandId: string, observed: { conversationId: string; entry: unknown }): void };
  localProof(commandId: string, conversationId: string): Promise<unknown>; signal: AbortSignal; timeoutMs?: number };

const HeadProjection = z.object({ complete: z.boolean(), historyHead: CloudLocalCommandHistoryHeadSchema,
  records: z.array(CloudLocalCommandHistoryRecordSchema).max(16_384) }).strict();
const PendingProjection = z.object({ complete: z.literal(false), historyHead: z.null(), records: z.array(z.never()).length(0) }).strict();
const CommandProjection = z.object({ conversationId: z.uuid(), entry: CloudBootCommandEntrySchema }).passthrough();

/** Compare independently read VM FULL receipt/CAS hashes to the eventual CP
 * compact projection. This is post-interval work and never supplies VM replay.
 * Native prose is parsed only in memory; the returned evidence has closed fields. */
export async function awaitFixtureMirrorFinal(input: Input) {
  const timeoutMs = input.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new HarnessFailure("operator_input_invalid");
  if (input.signal.aborted) throw new HarnessFailure("turn_timeout");
  const scope = CloudAgentBootScopeSchema.safeParse(input.scope), entry = CloudBootCommandEntrySchema.safeParse(input.entry);
  if (!scope.success || !entry.success || !z.uuid().safeParse(input.conversationId).success ||
      !z.uuid().safeParse(input.commandId).success || entry.data.commandId !== input.commandId ||
      entry.data.generation !== scope.data.generation || !["succeeded", "failed", "cancelled", "uncertain"].includes(entry.data.state))
    throw new HarnessFailure("receipt_mismatch");
  const deadline = performance.now() + timeoutMs;
  const bounded = <T>(work: () => Promise<T>): Promise<T> => {
    if (input.signal.aborted) return Promise.reject(new HarnessFailure("turn_timeout"));
    const remaining = deadline - performance.now();
    if (remaining <= 0) return Promise.reject(new HarnessFailure("receipt_mismatch"));
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(new HarnessFailure("turn_timeout")); };
      const timer = setTimeout(() => { cleanup(); reject(new HarnessFailure("receipt_mismatch")); }, remaining);
      const cleanup = () => { clearTimeout(timer); input.signal.removeEventListener("abort", abort); };
      input.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(work).then(value => { cleanup(); resolve(value); }, () => { cleanup(); reject(new HarnessFailure("fixture_inspection_failed")); });
    });
  };
  for (;;) {
    if (input.signal.aborted) throw new HarnessFailure("turn_timeout");
    let observed: unknown, projected: unknown;
    try { observed = input.fixture.readMirrorCommand(input.commandId); projected = input.fixture.readMirrorHistory(input.conversationId); }
    catch { throw new HarnessFailure("fixture_inspection_failed"); }
    const current = observed === null ? null : CommandProjection.safeParse(observed);
    if (current && (!current.success || current.data.conversationId !== input.conversationId || current.data.entry.commandId !== input.commandId))
      throw new HarnessFailure("receipt_mismatch");
    if (current?.success && !["queued", "dispatching"].includes(current.data.entry.state) && projected !== null && !PendingProjection.safeParse(projected).success) {
      const candidateRow = z.object({ conversationId: z.uuid(), entry: CloudBootCommandEntrySchema, history: CloudLocalCommandHistorySchema })
        .passthrough().safeParse(observed);
      if (!candidateRow.success || !HeadProjection.safeParse(projected).success) throw new HarnessFailure("receipt_mismatch");
      const proof = LocalMirrorProofSchema.safeParse(await bounded(() => input.localProof(input.commandId, input.conversationId)));
      if (!proof.success) throw new HarnessFailure("fixture_inspection_failed");
      if (!proof.data.outboxPending) {
        // An ACK/verified head may commit while the actual namespace proof is
        // awaited. Sample CP after that boundary, then keep exact equality;
        // old R-1 inspection cannot stand in for the current final projection.
        try { observed = input.fixture.readMirrorCommand(input.commandId); projected = input.fixture.readMirrorHistory(input.conversationId); }
        catch { throw new HarnessFailure("fixture_inspection_failed"); }
        const row = z.object({ conversationId: z.uuid(), entry: CloudBootCommandEntrySchema, history: CloudLocalCommandHistorySchema })
          .passthrough().safeParse(observed), projection = HeadProjection.safeParse(projected);
        if (!row.success || !projection.success) throw new HarnessFailure("receipt_mismatch");
        const head = projection.data.historyHead, complete = "manifestSha256" in head.history;
        if (proof.data.scopeSha256 !== hash(scope.data) || proof.data.commandId !== input.commandId || proof.data.conversationId !== input.conversationId ||
            row.data.conversationId !== input.conversationId || hash(entry.data) !== proof.data.receiptSha256 || hash(row.data.entry) !== proof.data.receiptSha256 ||
            hash(row.data.history) !== proof.data.auditSha256 || hash(head) !== proof.data.headSha256 || head.originWriterEpoch !== scope.data.writerEpoch ||
            head.source.kind !== "command" || head.source.commandId !== input.commandId || head.source.executionId !== entry.data.executionId ||
            projection.data.complete !== complete || proof.data.history !== (complete ? "complete" : "incomplete") ||
            proof.data.incompleteReason !== ("incompleteReason" in head.history ? head.history.incompleteReason : null))
          throw new HarnessFailure("receipt_mismatch");
        let recordBytes = 0;
        for (const record of projection.data.records) {
          recordBytes += Buffer.byteLength(canonical(record));
          if (record.conversationId !== input.conversationId || recordBytes > CLOUD_LOCAL_COMMAND_HISTORY_BUNDLE_MAX_BYTES)
            throw new HarnessFailure("receipt_mismatch");
        }
        if (proof.data.recordCount !== projection.data.records.length || proof.data.recordBytes !== recordBytes ||
            (complete ? proof.data.recordsSha256 !== hash(projection.data.records) : projection.data.records.length !== 0))
          throw new HarnessFailure("receipt_mismatch");
        try { input.fixture.assertMirrorTerminalConsistency(input.commandId, { conversationId: input.conversationId, entry: entry.data }); }
        catch { throw new HarnessFailure("receipt_mismatch"); }
        return { version: 1 as const, receiptMatchesVM: true as const, currentHeadMatchesVM: true as const,
          canonicalRecordsCompared: complete, historyCoverage: complete ? "complete" as const : "incomplete" as const,
          incompleteReason: proof.data.incompleteReason, recordCount: proof.data.recordCount, recordBytes: proof.data.recordBytes };
      }
    }
    await bounded(() => new Promise<void>(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - performance.now())))));
  }
}
