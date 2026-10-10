import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalCloudLocalCommandHistoryJson as canonicalJson } from "@zeros/protocol/cloud-local-mirror";
import { awaitFixtureMirrorFinal } from "../cloud-workspace-validation/cloud-agent-e2e/mirror-final";
import { mirrorProofSha256 as hash } from "../cloud-workspace-validation/cloud-agent-e2e/local-mirror-proof";

function fixture() {
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const conversationId = randomUUID(), commandId = randomUUID();
  const entry = { commandId, position: 1, state: "failed", payload: null, executionId: "execution", generation: 1,
    resultCode: "cloud_provider_prompt_auth_required", createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" };
  const history = { restoreRevision: 1, recordSequence: 2, eventSequence: 10, manifestSha256: "a".repeat(64) };
  const head = { originWriterEpoch: scope.writerEpoch, source: { kind: "command", commandId, executionId: "execution",
    intent: { agentId: "claude", userMessageId: "turn" }, nativeResultSha256: null }, deleted: false, history };
  const records = [{ version: 1, conversationId, entityKind: "message", entityId: "message", schemaVersion: 1,
    sourceRevision: 2, document: { text: "private-control-prose" } }];
  const row = { conversationId, entry, history }, canonical = { complete: true, historyHead: head, records };
  const proof = { version: 1, commandId, conversationId, scopeSha256: hash(scope), receiptSha256: hash(entry),
    auditSha256: hash(history), headSha256: hash(head), history: "complete", incompleteReason: null,
    recordCount: 1, recordBytes: Buffer.byteLength(canonicalJson(records[0])),
    recordsSha256: hash(records), outboxPending: false };
  const inspect = { readMirrorCommand: vi.fn<() => unknown>(() => row), readMirrorHistory: vi.fn<() => unknown>(() => canonical),
    assertMirrorTerminalConsistency: vi.fn() };
  const localProof = vi.fn(async () => proof);
  return { scope, conversationId, commandId, entry, row, canonical, proof, inspect, localProof,
    input: { scope, conversationId, commandId, entry, fixture: inspect, localProof, signal: new AbortController().signal, timeoutMs: 50 } };
}
describe("independent compact final versus actual local SQLite proof", () => {
  it("joins exact VM receipt and full current canonical bytes without retaining prose", async () => {
    const f = fixture(), result = await awaitFixtureMirrorFinal(f.input);
    expect(result).toMatchObject({ receiptMatchesVM: true, currentHeadMatchesVM: true, canonicalRecordsCompared: true,
      historyCoverage: "complete", recordCount: 1 });
    expect(f.inspect.assertMirrorTerminalConsistency).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("private-control-prose");
  });
  it.each(["scope", "command", "receipt", "audit", "head", "bytes", "missing", "extra-proof"])("refuses %s comparison", async kind => {
    const f = fixture();
    if (kind === "scope") f.proof.scopeSha256 = "b".repeat(64);
    if (kind === "command") f.proof.commandId = randomUUID();
    if (kind === "receipt") f.proof.receiptSha256 = "b".repeat(64);
    if (kind === "audit") f.proof.auditSha256 = "b".repeat(64);
    if (kind === "head") f.proof.headSha256 = "b".repeat(64);
    if (kind === "bytes") f.canonical.records[0]!.document.text = "changed-control-prose";
    if (kind === "missing") f.canonical.records = [];
    if (kind === "extra-proof") Object.assign(f.proof, { nativeProse: "private-control-prose" });
    await expect(awaitFixtureMirrorFinal(f.input)).rejects.toThrow(kind === "extra-proof" ? "fixture_inspection_failed" : "receipt_mismatch");
  });
  it("keeps incomplete current coverage explicit and never certifies stale complete bytes", async () => {
    const f = fixture(), history = { restoreRevision: 2, recordSequence: 2, eventSequence: 10, incompleteReason: "history_limit" };
    const head = { ...f.canonical.historyHead, history };
    const result = await awaitFixtureMirrorFinal({ ...f.input, fixture: { ...f.inspect,
      readMirrorHistory: () => ({ complete: false, historyHead: head, records: [] }) },
      localProof: async () => ({ ...f.proof, headSha256: hash(head), history: "incomplete", incompleteReason: "history_limit",
        recordsSha256: null, recordCount: 0, recordBytes: 0 }) });
    expect(result).toMatchObject({ historyCoverage: "incomplete", canonicalRecordsCompared: false, incompleteReason: "history_limit", recordCount: 0 });
  });
  it("waits for a pending durable outbox and then compares the exact same final state", async () => {
    const f = fixture(); f.localProof.mockResolvedValueOnce({ ...f.proof, outboxPending: true });
    await expect(awaitFixtureMirrorFinal({ ...f.input, timeoutMs: 250 })).resolves.toMatchObject({ receiptMatchesVM: true });
    expect(f.localProof).toHaveBeenCalledTimes(2);
  });
  it("samples CP again after the awaited VM proof crosses the final ACK and current-head publication", async () => {
    const f = fixture(); f.row.history.restoreRevision = 2;
    f.proof.auditSha256 = hash(f.row.history); f.proof.headSha256 = hash(f.canonical.historyHead);
    const before = { complete: false, records: [], historyHead: { ...f.canonical.historyHead,
      history: { restoreRevision: 1, recordSequence: 2, eventSequence: 10, incompleteReason: "capture_unavailable" } } };
    let committed = false;
    f.inspect.readMirrorHistory.mockImplementation(() => committed ? f.canonical : before);
    f.localProof.mockImplementation(async () => { await Promise.resolve(); committed = true; return f.proof; });
    await expect(awaitFixtureMirrorFinal(f.input)).resolves.toMatchObject({ currentHeadMatchesVM: true, canonicalRecordsCompared: true });
    expect(f.inspect.readMirrorHistory).toHaveBeenCalledTimes(2);
    expect(f.inspect.assertMirrorTerminalConsistency).toHaveBeenCalledOnce();
  });
  it("still refuses a stable different CP head after the awaited local proof", async () => {
    const f = fixture(), different = { ...f.canonical, historyHead: { ...f.canonical.historyHead,
      history: { ...f.canonical.historyHead.history, restoreRevision: 2 } } };
    f.inspect.readMirrorHistory.mockReturnValue(different);
    await expect(awaitFixtureMirrorFinal(f.input)).rejects.toThrow("receipt_mismatch");
    expect(f.inspect.assertMirrorTerminalConsistency).not.toHaveBeenCalled();
  });
  it("waits for an earlier mirrored queued entry before comparing the actual terminal", async () => {
    const f = fixture(); f.inspect.readMirrorCommand.mockReturnValueOnce({ ...f.row, entry: { ...f.entry, state: "queued", executionId: null,
      resultCode: null, payload: { agentId: "claude", userMessageId: "turn", model: "fixture-model", modeRevision: 0,
        prompt: [{ type: "text", text: "private-prompt-sentinel" }] } }, history: null });
    await expect(awaitFixtureMirrorFinal({ ...f.input, timeoutMs: 250 })).resolves.toMatchObject({ receiptMatchesVM: true });
    expect(f.localProof).toHaveBeenCalledOnce();
  });
  it("bounds an absent current head and awaits actual publication rather than accepting empty history", async () => {
    const f = fixture(); f.inspect.readMirrorHistory.mockReturnValueOnce({ complete: false, historyHead: null, records: [] });
    await expect(awaitFixtureMirrorFinal({ ...f.input, timeoutMs: 250 })).resolves.toMatchObject({ currentHeadMatchesVM: true });
  });
  it("bounds missing projection and abort without an empty-success result", async () => {
    const f = fixture();
    await expect(awaitFixtureMirrorFinal({ ...f.input, fixture: { ...f.inspect, readMirrorCommand: () => null }, timeoutMs: 1 }))
      .rejects.toThrow("receipt_mismatch");
    const controller = new AbortController(); controller.abort();
    await expect(awaitFixtureMirrorFinal({ ...f.input, signal: controller.signal })).rejects.toThrow("turn_timeout");
    expect(f.localProof).not.toHaveBeenCalled();
  });
});
