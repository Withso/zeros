import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalCloudLocalCommandHistoryJson, type CloudLocalCommandMirrorChange, type CloudLocalCommandMirrorBatch } from "@zeros/protocol/cloud-local-mirror";
import { FixtureMirrorProjection } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/mirror";

function setup(maxHistoryBytes?: number) {
  let live = true;
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(),
    fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const projection = new FixtureMirrorProjection({ activeScope: () => { if (!live) throw new Error("fixture-private-authority"); return scope; }, maxHistoryBytes });
  const actor = { scope, actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 1, role: "developer" as const,
    fingerprint: "a".repeat(64) }, actorSessionId: randomUUID(), authorityEpoch: 1, confirmedUntilMs: Date.now() + 30_000,
  fundingConsentVersion: 1 as const, fundingGrant: { kind: "owner" as const } };
  const entry = { commandId: randomUUID(), position: 1, state: "failed" as const, payload: null, executionId: "execution", generation: 1,
    resultCode: "cloud_provider_prompt_auth_required", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    result: { version: 1 as const } };
  const intent = { userMessageId: "turn", agentId: "claude" };
  const source = { kind: "command" as const, commandId: entry.commandId, intent, executionId: "execution", nativeResultSha256: hash(entry.result) };
  const history = { restoreRevision: 1, recordSequence: 1, eventSequence: 10, incompleteReason: "capture_unavailable" as const };
  const change: CloudLocalCommandMirrorChange = { sequence: 1, conversationId: "chat", revision: 1, paused: false, entry, intent, originWriterEpoch: scope.writerEpoch, actor,
    history, historyHead: { originWriterEpoch: scope.writerEpoch, source, deleted: false, history } };
  const flight = (changes = [change], after = 0): CloudLocalCommandMirrorBatch => ({ version: 1, bootId: scope.bootId, writerEpoch: scope.writerEpoch,
    batchId: randomUUID(), after, through: after + changes.length, changes: changes.map((row, index) => ({ ...row, sequence: after + index + 1 })) });
  return { scope, projection, change, flight, retire: () => { live = false; } };
}
function hash(value: unknown) { return createHash("sha256").update(canonicalCloudLocalCommandHistoryJson(value)).digest("hex"); }
function part(kind: "record" | "manifest", value: unknown) {
  const bytes = Buffer.from(canonicalCloudLocalCommandHistoryJson(value)); return { version: 1 as const, kind, sha256: hash(value), index: 0, count: 1, bytes: bytes.length, data: bytes.toString("base64") };
}
function canonical(f: ReturnType<typeof setup>) {
  const record = { version: 1 as const, conversationId: "chat", entityKind: "message" as const, entityId: "message", schemaVersion: 1 as const,
    sourceRevision: 1, document: { msgId: "message", value: "fixture-transcript-private" } };
  const manifest = { version: 1 as const, snapshot: "full" as const, scope: f.scope, conversationId: "chat", restoreRevision: 1, deleted: false,
    tombstones: [], recordSequence: 1, eventSequence: 10, source: f.change.historyHead!.source,
    records: [{ entityKind: record.entityKind, entityId: record.entityId, schemaVersion: 1 as const, sourceRevision: 1, sha256: hash(record) }] };
  const history = { restoreRevision: 1, recordSequence: 1, eventSequence: 10, manifestSha256: hash(manifest) };
  const changes: CloudLocalCommandMirrorChange[] = [
    { sequence: 1, conversationId: "chat", revision: 1, paused: false, historyPart: part("record", record) },
    { sequence: 2, conversationId: "chat", revision: 1, paused: false, historyPart: part("manifest", manifest) },
    { ...f.change, history, historyHead: { ...f.change.historyHead!, history } },
  ];
  return { record, manifest, history, changes };
}
function staged(f: ReturnType<typeof setup>) {
  const c = canonical(f), manifest = { ...c.manifest, restoreRevision: 3 };
  const history = { ...c.history, restoreRevision: 3, manifestSha256: hash(manifest) };
  const receipt: CloudLocalCommandMirrorChange = { ...f.change, revision: 2, history };
  delete receipt.historyHead;
  const interim: CloudLocalCommandMirrorChange = { sequence: 2, conversationId: "chat", revision: 2, paused: false,
    historyHead: { ...f.change.historyHead!, history: { restoreRevision: 2, recordSequence: 1, eventSequence: 10, incompleteReason: "capture_unavailable" } } };
  const complete: CloudLocalCommandMirrorChange[] = [
    { sequence: 3, conversationId: "chat", revision: 2, paused: false, historyPart: part("record", c.record) },
    { sequence: 4, conversationId: "chat", revision: 2, paused: false, historyPart: part("manifest", manifest) },
    { sequence: 5, conversationId: "chat", revision: 2, paused: false, historyHead: { ...f.change.historyHead!, history } },
  ];
  return { receipt, interim, complete, history, record: c.record };
}
function writerSeal(f: ReturnType<typeof setup>, sequence: number, recordSequence = 0, eventSequence = 0) {
  const fields = { version: 1 as const, scope: f.scope, sealId: randomUUID(), sequence, recordSequence, eventSequence, inventorySha256: "a".repeat(64) };
  return { ...fields, sha256: hash(fields) };
}
describe("honest in-memory FULL mirror projection", () => {
  it("retains an immutable exact seal/ACK after projected drain and refuses later mirrors without claiming source retirement", () => {
    const f = setup(), batch = f.flight(); f.projection.handle(batch);
    const seal = writerSeal(f, 1, 1, 10), ack = f.projection.seal(seal);
    expect(ack).toEqual({ version: 1, sealId: seal.sealId, writerEpoch: f.scope.writerEpoch, sequence: 1,
      recordSequence: 1, eventSequence: 10, inventorySha256: seal.inventorySha256, sha256: seal.sha256 });
    expect(f.projection.seal(seal)).toEqual(ack);
    expect(() => f.projection.handle(batch)).toThrow("command_context_changed");
    expect(() => f.projection.handle(f.flight([{ sequence: 2, conversationId: "chat", revision: 2, paused: false }], 1))).toThrow("command_context_changed");
    expect(f.projection.inspect()).toMatchObject({ sealed: true, mirroredSequence: 1 });
  });
  it("seals a truly empty projected writer at zero", () => {
    const f = setup(); expect(f.projection.seal(writerSeal(f, 0))).toMatchObject({ sequence: 0, recordSequence: 0, eventSequence: 0 });
    f.retire(); expect(() => f.projection.seal(writerSeal(f, 0))).toThrow("engine_authority_rejected");
  });
  it.each(["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch", "fundingOwnerUserId", "fundingOwnerEpoch"] as const)("refuses foreign seal %s", field => {
    const f = setup(), seal = writerSeal(f, 0); seal.scope = { ...seal.scope };
    if (field === "generation" || field === "fundingOwnerEpoch") seal.scope[field] = 2;
    else seal.scope[field] = randomUUID();
    const { sha256: _hash, ...fields } = seal; seal.sha256 = hash(fields);
    expect(() => f.projection.seal(seal)).toThrow("command_context_changed");
    expect(f.projection.inspect()).toMatchObject({ sealed: false });
  });
  it.each(["gap", "stale", "record-watermark", "event-watermark", "hash"])("refuses unsafe seal %s without advancing", kind => {
    const f = setup(); f.projection.handle(f.flight());
    const seal = writerSeal(f, kind === "gap" ? 2 : kind === "stale" ? 0 : 1, kind === "record-watermark" ? 0 : 1, kind === "event-watermark" ? 9 : 10);
    if (kind === "hash") seal.sha256 = "f".repeat(64);
    expect(() => f.projection.seal(seal)).toThrow("command_conflict"); expect(f.projection.inspect()).toMatchObject({ sealed: false, mirroredSequence: 1 });
  });
  it.each(["queued", "dispatching"] as const)("refuses a seal while %s is mirrored", state => {
    const f = setup(); f.change.entry = { ...f.change.entry!, state, resultCode: null,
      executionId: state === "queued" ? null : "execution", payload: { agentId: "claude", userMessageId: "turn", model: "fixture-model",
        modeRevision: 0, prompt: [{ type: "text", text: "Synthetic pending seal" }] } };
    delete f.change.history; delete f.change.historyHead; delete f.change.entry.result;
    f.projection.handle(f.flight()); expect(() => f.projection.seal(writerSeal(f, 1))).toThrow("command_conflict");
  });
  it.each(["same-id", "different-id", "inventory"])("refuses changed seal retry %s", kind => {
    const f = setup(), seal = writerSeal(f, 0); f.projection.seal(seal);
    const changed = { ...seal, ...(kind === "same-id" ? { recordSequence: 1 } : kind === "different-id" ? { sealId: randomUUID() } : { inventorySha256: "f".repeat(64) }) };
    const { sha256: _hash, ...fields } = changed; changed.sha256 = hash(fields);
    expect(() => f.projection.seal(changed)).toThrow("command_conflict"); expect(f.projection.seal(seal)).toMatchObject({ sha256: seal.sha256 });
  });
  it("keeps the receipt audit R separate from exact adjacent current fence R-1 through lost ACK and complete R", () => {
    const f = setup(), s = staged(f), batch = f.flight([s.receipt, s.interim]), ack = f.projection.handle(batch);
    expect(f.projection.readCommand(f.change.entry!.commandId)?.history).toEqual(s.history);
    expect(f.projection.readHistory("chat")).toMatchObject({ complete: false, historyHead: s.interim.historyHead });
    expect(f.projection.handle(batch)).toEqual(ack);
    f.projection.handle(f.flight(s.complete, batch.through));
    expect(f.projection.readHistory("chat")).toMatchObject({ complete: true, records: [s.record], historyHead: { history: s.history } });
    expect(f.projection.readCommand(f.change.entry!.commandId)?.history).toEqual(s.history);
    expect(() => f.projection.handle(f.flight([{ ...s.interim, historyHead: { ...s.interim.historyHead!, history: {
      restoreRevision: 3, recordSequence: 1, eventSequence: 10, incompleteReason: "capture_unavailable" } } }], 5))).toThrow("command_conflict");
    expect(f.projection.inspect().mirroredSequence).toBe(5);
  });
  it.each(["missing", "nonadjacent", "revision", "record-watermark", "event-watermark", "conversation", "writer",
    "command", "intent-provider", "intent-turn", "execution", "native-result", "deleted", "reason", "paused", "control-revision"])("atomically refuses a complete receipt with changed %s pair", kind => {
    const f = setup(), s = staged(f), head = s.interim.historyHead!, source = head.source;
    if (source.kind !== "command") throw new Error("fixture_source");
    if (kind === "revision") head.history.restoreRevision = 4;
    if (kind === "record-watermark") head.history.recordSequence = 2;
    if (kind === "event-watermark") head.history.eventSequence = 11;
    if (kind === "conversation") s.interim.conversationId = "foreign";
    if (kind === "writer") head.originWriterEpoch = randomUUID();
    if (kind === "command") source.commandId = randomUUID();
    if (kind === "intent-provider") source.intent = { ...source.intent, agentId: "cursor" };
    if (kind === "intent-turn") source.intent = { ...source.intent, userMessageId: "foreign" };
    if (kind === "execution") source.executionId = "foreign";
    if (kind === "native-result") source.nativeResultSha256 = "f".repeat(64);
    if (kind === "deleted") head.deleted = true;
    if (kind === "reason") head.history = { restoreRevision: 2, recordSequence: 1, eventSequence: 10, incompleteReason: "history_limit" };
    if (kind === "paused") s.interim.paused = true;
    if (kind === "control-revision") s.interim.revision = 3;
    const gap: CloudLocalCommandMirrorChange = { sequence: 2, conversationId: "chat", revision: 2, paused: false };
    const changes = kind === "missing" ? [s.receipt] : kind === "nonadjacent" ? [s.receipt, gap, s.interim] : [s.receipt, s.interim];
    expect(() => f.projection.handle(f.flight(changes))).toThrow("command_conflict");
    expect(f.projection.inspect()).toMatchObject({ commandCount: 0, headCount: 0, mirroredSequence: 0, batchCount: 0 });
  });
  it("retains exact terminal audit and stable ACK while refusing changed replay/range/boot", () => {
    const f = setup(), batch = f.flight(), ack = f.projection.handle(batch);
    expect(ack).toEqual({ version: 1, writerEpoch: f.scope.writerEpoch, batchId: batch.batchId, through: 1 });
    expect(f.projection.handle(batch)).toEqual(ack);
    f.projection.assertTerminalConsistency(f.change.entry!.commandId, { conversationId: "chat", entry: f.change.entry! });
    expect(() => f.projection.handle({ ...batch, changes: [{ ...f.change, paused: true }] })).toThrow("command_conflict");
    expect(() => f.projection.handle({ ...batch, batchId: randomUUID() })).toThrow("command_conflict");
    expect(() => f.projection.handle({ ...batch, bootId: randomUUID() })).toThrow("command_context_changed");
    expect(() => f.projection.assertTerminalConsistency(f.change.entry!.commandId, { conversationId: "chat", entry: { ...f.change.entry!, resultCode: "wrong" } })).toThrow("fixture_terminal_mismatch");
    f.retire(); expect(() => f.projection.handle(batch)).toThrow("engine_authority_rejected");
  });
  it("requires independently verified full canonical bytes and returns them only for the current complete head", () => {
    const f = setup(), c = canonical(f); f.projection.handle(f.flight(c.changes));
    expect(f.projection.readHistory("chat")).toMatchObject({ complete: true, records: [c.record] });
    expect(f.projection.readCommand(f.change.entry!.commandId)?.entry).toEqual(f.change.entry);
    const source = { kind: "mutation" as const, mutationId: randomUUID(), operation: "delete" as const };
    f.projection.handle(f.flight([{ sequence: 4, conversationId: "chat", revision: 2, paused: false,
      historyHead: { originWriterEpoch: f.scope.writerEpoch, source, deleted: true,
        history: { restoreRevision: 2, recordSequence: null, eventSequence: null, incompleteReason: "capture_unavailable" } } }], 3));
    expect(f.projection.readHistory("chat")).toMatchObject({ complete: false, records: [] });
    expect(f.projection.readCommand(f.change.entry!.commandId)?.entry).toEqual(f.change.entry);
  });
  it.each(["digest", "record", "source", "actor", "foreign", "changed-terminal"])("rejects %s and commits no cursor/receipt/ACK", kind => {
    const f = setup(), c = canonical(f);
    if (kind === "digest") c.changes[0]!.historyPart!.sha256 = "b".repeat(64);
    if (kind === "record") c.changes.splice(0, 1);
    if (kind === "source") {
      c.manifest.source = { kind: "mutation", mutationId: randomUUID(), operation: "repair" };
      c.changes[1]!.historyPart = part("manifest", c.manifest);
      c.changes[2]!.history = { ...c.history, manifestSha256: hash(c.manifest) };
      c.changes[2]!.historyHead!.history = c.changes[2]!.history!;
    }
    if (kind === "actor") c.changes[2]!.actor!.scope = { ...f.scope, generation: 2 };
    if (kind === "foreign") c.changes[0]!.conversationId = "foreign";
    if (kind === "changed-terminal") { f.projection.handle(f.flight()); c.changes[2]!.entry = { ...f.change.entry!, resultCode: "changed" }; }
    expect(() => f.projection.handle(f.flight(c.changes, kind === "changed-terminal" ? 1 : 0))).toThrow();
    expect(f.projection.inspect()).toMatchObject({ mirroredSequence: kind === "changed-terminal" ? 1 : 0, commandCount: kind === "changed-terminal" ? 1 : 0 });
  });
  it("ACKs quota feedback exactly while keeping original audit and publishing separate incomplete restore authority", () => {
    const f = setup(0), c = canonical(f), batch = f.flight(c.changes), ack = f.projection.handle(batch);
    expect(ack.historyLimits).toEqual([{ conversationId: "chat", sha256: hash(c.record) }, { conversationId: "chat", sha256: hash(c.manifest) }]);
    expect(f.projection.handle(batch)).toEqual(ack); expect(f.projection.readHistory("chat")).toMatchObject({ complete: false, records: [],
      historyHead: { history: { incompleteReason: "history_limit" } } });
    expect(f.projection.readCommand(f.change.entry!.commandId)?.history).toEqual(c.history);
  });
  it("keeps metadata inspection/close bounded and does not expose canonical records or native result prose", () => {
    const f = setup(), c = canonical(f); f.projection.handle(f.flight(c.changes));
    expect(JSON.stringify(f.projection.inspect())).not.toContain("fixture-transcript-private");
    f.projection.close(); f.projection.close(); expect(f.projection.inspect()).toMatchObject({ commandCount: 0, partCount: 0, mirroredSequence: 0 });
    expect(() => f.projection.handle(f.flight())).toThrow("engine_authority_rejected");
  });
  it.each(["bytes", "kind", "conversation"])("refuses changed %s even after the same digest is already verified", kind => {
    const f = setup(), c = canonical(f); f.projection.handle(f.flight(c.changes));
    const historyPart = part("record", c.record);
    if (kind === "bytes") { const bytes = Buffer.from(historyPart.data, "base64"); bytes[0] = 91; historyPart.data = bytes.toString("base64"); }
    if (kind === "kind") historyPart.kind = "manifest";
    expect(() => f.projection.handle(f.flight([{ sequence: 4, conversationId: kind === "conversation" ? "foreign" : "chat",
      revision: 2, paused: false, historyPart }], 3))).toThrow("command_conflict");
    expect(f.projection.inspect().mirroredSequence).toBe(3);
  });
});
