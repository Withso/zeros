import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

async function schemas() {
  const modulePath = "../cloud-local-mirror";
  return await import(modulePath) as typeof import("../cloud-local-mirror");
}
function fixture() {
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 7,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 2 };
  const actor = { scope, actorSessionId: randomUUID(), authorityEpoch: 3, confirmedUntilMs: 1_791_468_010_000,
    actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 1, role: "owner", fingerprint: "a".repeat(64) },
    fundingConsentVersion: 1, fundingGrant: { kind: "owner" } };
  const commandId = randomUUID(), executionId = "execution", conversationId = "conversation", intent = { userMessageId: "turn", agentId: "claude" };
  const entry = { commandId, position: 1, state: "succeeded", payload: null, executionId, generation: 7, resultCode: null,
    createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:01Z",
    result: { version: 1, terminal: { commandId, executionId, conversationId, turnId: intent.userMessageId,
      agentId: intent.agentId, status: "completed", stopReason: "end_turn" } } };
  const history = { restoreRevision: 4, recordSequence: 9, eventSequence: 27, manifestSha256: "b".repeat(64) };
  const change = { sequence: 1, conversationId, revision: 4, paused: false, entry, intent,
    originWriterEpoch: scope.writerEpoch, actor, history };
  const batch = { version: 1, bootId: scope.bootId, writerEpoch: scope.writerEpoch, batchId: randomUUID(), after: 0, through: 1, changes: [change] };
  const frame = { id: randomUUID(), timestamp: 123, source: "engine", chatId: conversationId, agentId: intent.agentId,
    type: "AGENT_PERMISSION_REQUEST", permissionId: "permission", request: { sessionId: "native-session", executionId,
      toolCall: { toolCallId: "tool", title: "Synthetic tool", kind: "execute" }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] } };
  const event = { version: 1, eventSequence: 25, executionId, commandId, turnId: intent.userMessageId, frame };
  return { scope, actor, batch, change, entry, intent, commandId, executionId, conversationId, frame, event, history };
}

describe("engine-local command mirror", () => {
  it("roundtrips a separate exact writer seal and ACK without inventing a mirror batch", async () => {
    const s = await schemas(), f = fixture();
    const seal = { version: 1 as const, scope: f.scope, sealId: randomUUID(), sequence: 0, recordSequence: 9, eventSequence: 27,
      inventorySha256: "d".repeat(64), sha256: "b".repeat(64) };
    const ack = { version: 1 as const, writerEpoch: f.scope.writerEpoch, sealId: seal.sealId, sequence: 0, recordSequence: 9, eventSequence: 27,
      inventorySha256: seal.inventorySha256, sha256: seal.sha256 };
    expect(s.CloudLocalCommandWriterSealSchema.parse(seal)).toEqual(seal);
    expect(s.CloudLocalCommandWriterSealAckSchema.parse(ack)).toEqual(ack);
    expect(s.cloudLocalCommandWriterSealAckMatchesSeal(ack,seal)).toBe(true);
    expect(s.CloudLocalCommandMirrorBatchSchema.safeParse(seal).success).toBe(false);
    expect(s.CloudLocalCommandWriterSealSchema.safeParse(f.batch).success).toBe(false);
    for (const changed of [{ ...ack, writerEpoch: randomUUID() }, { ...ack, sealId: randomUUID() }, { ...ack, sequence: 1 },
      { ...ack, recordSequence: 10 }, { ...ack, eventSequence: 28 }, { ...ack, sha256: "c".repeat(64) }, { ...ack, inventorySha256: "e".repeat(64) }])
      expect(s.cloudLocalCommandWriterSealAckMatchesSeal(changed,seal)).toBe(false);
  });
  it.each(["sequence", "recordSequence", "eventSequence"])("bounds writer seal %s independently", async field => {
    const s = await schemas(), f = fixture(), common = { version: 1, sealId: randomUUID(), sequence: 0, recordSequence: 0, eventSequence: 0,
      sha256: "a".repeat(64), inventorySha256: "b".repeat(64) };
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, "0"])
      expect(s.CloudLocalCommandWriterSealSchema.safeParse({ ...common, scope: f.scope, [field]: invalid }).success).toBe(false);
    expect(s.CloudLocalCommandWriterSealSchema.safeParse({ ...common, scope: f.scope, [field]: Number.MAX_SAFE_INTEGER }).success).toBe(true);
  });
  it("rejects unknown seal state, funding selectors, upper-case digest and mixed ACK scope", async () => {
    const s = await schemas(), f = fixture(), common = { version: 1, sealId: randomUUID(), sequence: 0, recordSequence: 0, eventSequence: 0,
      sha256: "a".repeat(64), inventorySha256: "b".repeat(64) };
    for (const changed of [{ ...common, version: 2 }, { ...common, sha256: "A".repeat(64) }, { ...common, sealId: "invalid" },
      { ...common, activated: true }, { ...common, sourceRetired: true }, { ...common, credentialId: randomUUID() }])
      expect(s.CloudLocalCommandWriterSealSchema.safeParse({ ...changed, scope: f.scope }).success).toBe(false);
    expect(s.CloudLocalCommandWriterSealAckSchema.safeParse({ ...common, writerEpoch: f.scope.writerEpoch, scope: f.scope }).success).toBe(false);
    expect(s.CloudLocalCommandWriterSealSchema.safeParse({ ...common, scope: f.scope, inventorySha256: "B".repeat(64) }).success).toBe(false);
    const { inventorySha256: _inventory, ...missing } = common;
    expect(s.CloudLocalCommandWriterSealSchema.safeParse({ ...missing, scope: f.scope }).success).toBe(false);
  });
  it("canonically binds only the exact public seal descriptor, including the private inventory digest", async () => {
    const s = await schemas(), f = fixture(), descriptor = { version: 1 as const, scope: f.scope, sealId: randomUUID(), sequence: 0,
      recordSequence: 9, eventSequence: 27, inventorySha256: "d".repeat(64) };
    const canonical = s.canonicalCloudLocalCommandWriterSealDescriptor(descriptor);
    const sha256 = createHash("sha256").update(canonical).digest("hex");
    expect(s.canonicalCloudLocalCommandWriterSealDescriptor({ ...descriptor, sha256 })).toBe(canonical);
    expect(JSON.parse(canonical)).toEqual(descriptor);
    for (const [field, value] of Object.entries(f.scope)) {
      const changedScope = { ...f.scope, [field]: typeof value === "number" ? value + 1 : randomUUID() };
      expect(createHash("sha256").update(s.canonicalCloudLocalCommandWriterSealDescriptor({ ...descriptor, scope: changedScope })).digest("hex")).not.toBe(sha256);
    }
    expect(createHash("sha256").update(s.canonicalCloudLocalCommandWriterSealDescriptor({ ...descriptor, inventorySha256: "e".repeat(64) })).digest("hex")).not.toBe(sha256);
    expect(() => s.canonicalCloudLocalCommandWriterSealDescriptor({ ...descriptor, extra: true })).toThrow();
  });
  it("roundtrips terminal-first intent with immutable origin and exact manifest watermark", async () => {
    const s = await schemas(), f = fixture();
    expect(s.CloudLocalCommandMirrorBatchSchema.parse(f.batch)).toEqual(f.batch);
    expect(s.CloudLocalCommandMirrorAckSchema.parse({ version: 1, writerEpoch: f.scope.writerEpoch, batchId: f.batch.batchId, through: 1 })).toEqual({ version: 1, writerEpoch: f.scope.writerEpoch, batchId: f.batch.batchId, through: 1 });
  });
  it.each(["intent", "originWriterEpoch", "history"])("requires %s even when terminal is the first mirrored state", async field => {
    const s = await schemas(), f = fixture(), value = { ...f.change } as Record<string, unknown>;
    delete value[field]; expect(s.CloudLocalCommandMirrorChangeSchema.safeParse(value).success).toBe(false);
  });
  it("requires retained manifest identity rather than watermarks alone", async () => {
    const s = await schemas(), f = fixture();
    expect(s.CloudLocalCommandMirrorChangeSchema.safeParse({ ...f.change, history: { recordSequence: 9, eventSequence: 27 } }).success).toBe(false);
    expect(s.CloudLocalCommandMirrorChangeSchema.safeParse({ ...f.change, entry: { ...f.entry, payload: { prompt: [] } } }).success).toBe(false);
  });
  it("retains the known native terminal with an explicit incomplete-history reason and unknown heads", async () => {
    const s = await schemas(), f = fixture();
    const history = { restoreRevision: 5, recordSequence: null, eventSequence: 27, incompleteReason: "history_limit" };
    expect(s.CloudLocalCommandMirrorChangeSchema.parse({ ...f.change, history }).entry?.result?.terminal).toEqual(f.entry.result.terminal);
    for (const invalid of [{ ...history, incompleteReason: "raw diagnostic" }, { ...history, manifestSha256: "b".repeat(64) },
      { ...history, recordSequence: -1 }, { recordSequence: null, eventSequence: null }])
      expect(s.CloudLocalCommandMirrorChangeSchema.safeParse({ ...f.change, history: invalid }).success).toBe(false);
  });
  it("rejects mismatched terminal ownership and absent exact command identity", async () => {
    const s = await schemas(), f = fixture();
    for (const field of ["commandId", "executionId", "conversationId", "turnId", "agentId"]) {
      const terminal = { ...f.entry.result.terminal, [field]: field === "commandId" ? randomUUID() : "foreign" };
      expect(s.CloudLocalCommandMirrorChangeSchema.safeParse({ ...f.change, entry: { ...f.entry, result: { version: 1, terminal } } }).success).toBe(false);
    }
    const { commandId: _id, ...terminal } = f.entry.result.terminal;
    expect(s.CloudLocalCommandMirrorChangeSchema.safeParse({ ...f.change, entry: { ...f.entry, result: { version: 1, terminal } } }).success).toBe(false);
  });
  it("preserves pending payload/provenance but rejects foreign active-writer intent", async () => {
    const s = await schemas(), f = fixture();
    const pending = { ...f.change, entry: { ...f.entry, state: "queued", executionId: null, result: null,
      payload: { agentId: "claude", userMessageId: "turn", prompt: [{ type: "text", text: "Synthetic prompt" }], modeRevision: 0,
        model: "qualified-model" } } };
    expect(s.CloudLocalCommandMirrorBatchSchema.safeParse({ ...f.batch, changes: [pending] }).success).toBe(true);
    expect(s.CloudLocalCommandMirrorBatchSchema.safeParse({ ...f.batch, writerEpoch: randomUUID(), changes: [pending] }).success).toBe(false);
    expect(s.CloudLocalCommandMirrorChangeSchema.safeParse({ ...pending, actor: undefined }).success).toBe(false);
  });
  it.each(["userMessageId", "agentId"])("rejects pending payload %s that disagrees with durable intent", async field => {
    const s = await schemas(), f = fixture();
    const payload = { agentId: "claude", userMessageId: f.intent.userMessageId,
      prompt: [{ type: "text", text: "Synthetic prompt" }], modeRevision: 0, model: "qualified-model" };
    const pending = { ...f.change, entry: { ...f.entry, state: "queued", payload, executionId: null, result: null } };
    expect(s.CloudLocalCommandMirrorChangeSchema.safeParse(pending).success).toBe(true);
    const changed = { ...pending, entry: { ...pending.entry, payload: { ...payload, [field]: field === "agentId" ? "cursor" : "foreign-turn" } } };
    expect(s.CloudLocalCommandMirrorChangeSchema.safeParse(changed).success).toBe(false);
  });
  it("requires dispatch credential provider to match durable intent", async () => {
    const s = await schemas(), f = fixture();
    const payload = { agentId: "claude", userMessageId: f.intent.userMessageId,
      prompt: [{ type: "text", text: "Synthetic prompt" }], modeRevision: 0, model: "qualified-model" };
    const credentialRun = { version: 1, bootId: f.scope.bootId, writerEpoch: f.scope.writerEpoch, cacheRevision: 1,
      provider: "claude", fundingOwnerUserId: f.scope.fundingOwnerUserId, fundingOwnerEpoch: f.scope.fundingOwnerEpoch,
      credentialId: randomUUID(), credentialRevision: 1, connectionRevision: 1, adoptionId: randomUUID(),
      materialVersion: 1, displayName: "Synthetic account" };
    const dispatching = { ...f.change, entry: { ...f.entry, state: "dispatching", payload, result: null }, credentialRun };
    expect(s.CloudLocalCommandMirrorChangeSchema.safeParse(dispatching).success).toBe(true);
    expect(s.CloudLocalCommandMirrorChangeSchema.safeParse({ ...dispatching, credentialRun: { ...credentialRun, provider: "cursor" } }).success).toBe(false);
  });
  it("requires contiguous bounded outbox order and strict ACKs", async () => {
    const s = await schemas(), f = fixture();
    for (const value of [{ ...f.batch, through: 2 }, { ...f.batch, changes: [{ ...f.change, sequence: 2 }] },
      { ...f.batch, changes: [] }, { ...f.batch, changes: Array.from({ length: 33 }, (_, i) => ({ ...f.change, sequence: i + 1 })), through: 33 }])
      expect(s.CloudLocalCommandMirrorBatchSchema.safeParse(value).success).toBe(false);
    expect(s.CloudLocalCommandMirrorAckSchema.safeParse({ version: 1, writerEpoch: f.scope.writerEpoch, batchId: f.batch.batchId, through: 1, actor: f.actor }).success).toBe(false);
  });
  it("accepts bounded unique history-limit feedback only for exact immutable-flight documents", async () => {
    const s = await schemas(), f = fixture(), sha256 = "c".repeat(64), bytes = Buffer.from("{}");
    const batch = s.CloudLocalCommandMirrorBatchSchema.parse({ ...f.batch, changes: [{ sequence: 1,
      conversationId: f.conversationId, revision: 4, paused: false,
      historyPart: { version: 1, kind: "record", sha256, index: 0, count: 1, bytes: bytes.byteLength, data: bytes.toString("base64") } }] });
    const plain = { version: 1, writerEpoch: f.scope.writerEpoch, batchId: batch.batchId, through: 1 };
    const ack = s.CloudLocalCommandMirrorAckSchema.parse({ ...plain, historyLimits: [{ conversationId: f.conversationId, sha256 }] });
    expect(s.cloudLocalCommandMirrorAckMatchesBatch(ack, batch)).toBe(true);
    expect(s.cloudLocalCommandMirrorAckMatchesBatch(s.CloudLocalCommandMirrorAckSchema.parse(plain), batch)).toBe(true);
    for (const historyLimits of [[{ conversationId: "foreign", sha256 }], [{ conversationId: f.conversationId, sha256: "d".repeat(64) }]])
      expect(s.cloudLocalCommandMirrorAckMatchesBatch(s.CloudLocalCommandMirrorAckSchema.parse({ ...plain, historyLimits }), batch)).toBe(false);
    for (const change of [{ writerEpoch: randomUUID() }, { batchId: randomUUID() }, { through: 2 }])
      expect(s.cloudLocalCommandMirrorAckMatchesBatch(s.CloudLocalCommandMirrorAckSchema.parse({ ...ack, ...change }), batch)).toBe(false);
    const pair = { conversationId: f.conversationId, sha256 };
    for (const historyLimits of [[pair, pair], Array.from({ length: 33 }, (_, index) => ({ ...pair, conversationId: `conversation-${index}` })),
      [{ ...pair, reason: "private" }], [{ ...pair, sha256: "invalid" }]])
      expect(s.CloudLocalCommandMirrorAckSchema.safeParse({ ...plain, historyLimits }).success).toBe(false);
    expect(s.CloudLocalCommandMirrorAckSchema.parse({ ...plain, historyLimits: [] }).historyLimits).toEqual([]);
  });
  it.each(["AGENT_PERMISSION_REQUEST", "AGENT_QUESTION_REQUEST"])("rejects mismatched nested native execution in %s", async type => {
    const s = await schemas(), f = fixture();
    const frame = type === "AGENT_PERMISSION_REQUEST" ? f.frame : { ...f.frame, type, permissionId: undefined,
      questionId: "question", request: { sessionId: "native-session", executionId: f.executionId, questionId: "question", nativeRequestId: "native-request",
        source: "native_rpc", blocking: true, allowDecline: true, questions: [{ id: "q0", prompt: "Synthetic question", options: [], allowOther: true, allowEmptyFreeText: true, preserveFreeText: true }] } };
    if (type === "AGENT_QUESTION_REQUEST") delete (frame as Record<string, unknown>).permissionId;
    expect(s.CloudCompactControlEventSchema.safeParse({ ...f.event, frame }).success).toBe(true);
    expect(s.CloudCompactControlEventSchema.safeParse({ ...f.event, frame: { ...frame, request: { ...frame.request, executionId: "foreign" } } }).success).toBe(false);
  });
  it("retains sparse local event cursor and requires parent conversation/command/turn ownership", async () => {
    const s = await schemas(), f = fixture();
    expect(s.CloudLocalCommandMirrorChangeSchema.parse({ ...f.change, event: f.event }).event?.eventSequence).toBe(25);
    for (const event of [{ ...f.event, executionId: "foreign" }, { ...f.event, turnId: "foreign" },
      { ...f.event, commandId: randomUUID() }, { ...f.event, frame: { ...f.frame, chatId: "foreign" } }])
      expect(s.CloudLocalCommandMirrorChangeSchema.safeParse({ ...f.change, event }).success).toBe(false);
  });
});

describe("immutable canonical terminal history", () => {
  function record() { return { version: 1, conversationId: "conversation", entityKind: "message", entityId: "message", schemaVersion: 1,
    sourceRevision: 9, document: { content: [{ type: "text", text: "Synthetic finalized text" }] } }; }
  it("preserves final normalized documents with explicit identity and schema revision", async () => {
    const s = await schemas(), value = record();
    expect(s.CloudLocalCommandHistoryRecordSchema.parse(value)).toEqual(value);
    expect(s.CloudLocalCommandHistoryRecordSchema.safeParse({ ...value, entityKind: "credentials" }).success).toBe(false);
    expect(s.CloudLocalCommandHistoryRecordSchema.safeParse({ ...value, document: [] }).success).toBe(false);
    expect(s.CloudLocalCommandHistoryRecordSchema.safeParse({ ...value, document: { value: Infinity } }).success).toBe(false);
  });
  it.each([
    '{"__proto__":{"marker":"synthetic-proto-value"}}',
    '{"content":{"nested":{"__proto__":{"marker":"synthetic-proto-value"},"text":"kept"}}}',
    '{"content":[{"__proto__":{"marker":"synthetic-proto-value"}},"kept"]}',
    '{"constructor":{"prototype":{"marker":"synthetic-safe-key"}},"prototype":"kept"}',
  ])("preserves all finite plain JSON data in the verified canonical representation: %s", async documentJson => {
    const s = await schemas(), value = { ...record(), document: JSON.parse(documentJson) };
    const canonical = s.canonicalCloudLocalCommandHistoryJson(value);
    const parsed = s.CloudLocalCommandHistoryRecordSchema.parse(value);
    expect(s.canonicalCloudLocalCommandHistoryJson(parsed)).toBe(canonical);
    expect(JSON.stringify(parsed.document)).toBe(documentJson);
    expect(Object.getPrototypeOf(parsed.document)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("marker");
  });
  it("bounds record bytes and JSON complexity before recursive parsing", async () => {
    const s = await schemas(), value = record();
    expect(s.CloudLocalCommandHistoryRecordSchema.safeParse({ ...value, document: { text: "x".repeat(512 * 1024) } }).success).toBe(false);
    let nested: Record<string, unknown> = {}; for (let i = 0; i < 64; i++) nested = { nested };
    expect(s.CloudLocalCommandHistoryRecordSchema.safeParse({ ...value, document: nested }).success).toBe(false);
  });
  it("binds manifest references and local heads to actual boot/command/intent/execution", async () => {
    const s = await schemas(), f = fixture();
    const ref = { entityKind: "message", entityId: "message", schemaVersion: 1, sourceRevision: 9, sha256: "c".repeat(64) };
    const value = { version: 1, snapshot: "full", scope: f.scope, conversationId: f.conversationId,
      source: { kind: "command", commandId: f.commandId, intent: f.intent, executionId: f.executionId, nativeResultSha256: "a".repeat(64) },
      recordSequence: 9, eventSequence: 27, records: [ref],
      restoreRevision: 4, deleted: false, tombstones: [] };
    expect(s.CloudLocalCommandHistoryManifestSchema.parse(value)).toEqual(value);
    expect(s.CloudLocalCommandHistoryManifestSchema.safeParse({ ...value, records: [ref, ref] }).success).toBe(false);
    expect(s.CloudLocalCommandHistoryManifestSchema.safeParse({ ...value, records: Array.from({ length: 16_384 }, (_, i) => ({ ...ref, entityId: String(i) })) }).success).toBe(true);
    expect(s.CloudLocalCommandHistoryManifestSchema.safeParse({ ...value, records: Array.from({ length: 16_385 }, (_, i) => ({ ...ref, entityId: String(i) })) }).success).toBe(false);
    expect(s.CloudLocalCommandHistoryManifestSchema.safeParse({ ...value, restoreRevision: undefined }).success).toBe(false);
    expect(s.CloudLocalCommandHistoryManifestSchema.safeParse({ ...value, tombstones: [{ entityKind: ref.entityKind, entityId: ref.entityId, sourceRevision: 10 }] }).success).toBe(false);
    expect(s.CloudLocalCommandHistoryManifestSchema.parse({ ...value, records: [], deleted: true,
      tombstones: [{ entityKind: "message", entityId: "deleted", sourceRevision: 10 }] }).deleted).toBe(true);
    const mutation = { ...value, source: { kind: "mutation", mutationId: randomUUID(), operation: "repair" } };
    expect(s.CloudLocalCommandHistoryManifestSchema.parse(mutation)).toEqual(mutation);
    expect(s.CloudLocalCommandHistoryManifestSchema.safeParse({ ...mutation, source: { ...mutation.source, intent: f.intent } }).success).toBe(false);
  });
  it("accepts canonical bounded chunks but rejects missing/oversized/noncanonical parts", async () => {
    const s = await schemas(), bytes = Buffer.from(JSON.stringify(record()));
    const part = { version: 1, kind: "record", sha256: "c".repeat(64), index: 0, count: 1, bytes: bytes.byteLength, data: bytes.toString("base64") };
    expect(s.CloudLocalCommandHistoryPartSchema.parse(part)).toEqual(part);
    for (const value of [{ ...part, index: 1 }, { ...part, count: 33 }, { ...part, count: 2 }, { ...part, bytes: 4 * 1024 * 1024 + 1 },
      { ...part, data: "YR==", bytes: 1 }, { ...part, data: "a" }, { ...part, data: Buffer.alloc(128 * 1024 + 1).toString("base64") }])
      expect(s.CloudLocalCommandHistoryPartSchema.safeParse(value).success).toBe(false);
    const f = fixture();
    const change = { sequence: 1, conversationId: f.conversationId, revision: 4, paused: false, historyPart: part };
    expect(s.CloudLocalCommandMirrorBatchSchema.parse({ ...f.batch, changes: [change] }).changes[0]?.historyPart).toEqual(part);
  });
});

describe("authoritative current history head", () => {
  it.each(["delete", "repair"])("retains an incomplete %s without fabricating command intent or manifest bytes", async operation => {
    const s = await schemas(), f = fixture();
    const historyHead = { originWriterEpoch: f.scope.writerEpoch, deleted: operation === "delete",
      source: { kind: "mutation", mutationId: randomUUID(), operation },
      history: { restoreRevision: 8, recordSequence: null, eventSequence: null, incompleteReason: "capture_unavailable" } };
    const change = { sequence: 1, conversationId: f.conversationId, revision: 8, paused: false, historyHead };
    expect(s.CloudLocalCommandMirrorChangeSchema.parse(change)).toEqual(change);
    expect(s.CloudLocalCommandHistoryHeadSchema.parse(historyHead)).toEqual(historyHead);
    expect(s.CloudLocalCommandMirrorChangeSchema.safeParse({ ...change, history: historyHead.history, historyHead: undefined }).success).toBe(false);
  });
  it("requires exact source, deletion and origin even when capture is incomplete", async () => {
    const s = await schemas(), f = fixture();
    const value = { originWriterEpoch: f.scope.writerEpoch, deleted: true,
      source: { kind: "mutation", mutationId: randomUUID(), operation: "delete" },
      history: { restoreRevision: 8, recordSequence: null, eventSequence: null, incompleteReason: "capture_unavailable" } };
    for (const field of ["originWriterEpoch", "source", "deleted"]) {
      const invalid: Record<string, unknown> = { ...value }; delete invalid[field];
      expect(s.CloudLocalCommandHistoryHeadSchema.safeParse(invalid).success).toBe(false);
    }
    expect(s.CloudLocalCommandHistoryHeadSchema.safeParse({ ...value, source: { ...value.source, intent: f.intent } }).success).toBe(false);
    expect(s.CloudLocalCommandHistoryHeadSchema.safeParse({ ...value, source: { ...value.source, operation: "native_run" } }).success).toBe(false);
  });
  it("binds a command head to the exact entry intent and native execution", async () => {
    const s = await schemas(), f = fixture();
    const source = { kind: "command", commandId: f.commandId, intent: f.intent, executionId: f.executionId, nativeResultSha256: "a".repeat(64) };
    const historyHead = { originWriterEpoch: f.scope.writerEpoch, deleted: false, source, history: f.history };
    expect(s.CloudLocalCommandMirrorChangeSchema.safeParse({ ...f.change, historyHead }).success).toBe(true);
    for (const invalidSource of [{ ...source, commandId: randomUUID() }, { ...source, executionId: "foreign" },
      { ...source, intent: { ...f.intent, agentId: "foreign" } }, { ...source, intent: { ...f.intent, userMessageId: "foreign" } }])
      expect(s.CloudLocalCommandMirrorChangeSchema.safeParse({ ...f.change, historyHead: { ...historyHead, source: invalidSource } }).success).toBe(false);
    expect(s.CloudLocalCommandMirrorChangeSchema.safeParse({ ...f.change, historyHead: { ...historyHead, originWriterEpoch: randomUUID() } }).success).toBe(false);
  });
  it("requires a complete current head to agree with the verified full manifest", async () => {
    const s = await schemas(), f = fixture();
    const source = { kind: "mutation", mutationId: randomUUID(), operation: "repair" } as const;
    const manifest = s.CloudLocalCommandHistoryManifestSchema.parse({ version: 1, snapshot: "full", scope: f.scope,
      conversationId: f.conversationId, source, restoreRevision: 8, deleted: false, tombstones: [], records: [], recordSequence: 9, eventSequence: 27 });
    const head = s.CloudLocalCommandHistoryHeadSchema.parse({ originWriterEpoch: f.scope.writerEpoch, source,
      deleted: false, history: { ...f.history, restoreRevision: 8 } });
    expect(s.cloudLocalCommandHistoryHeadMatchesManifest(head, manifest, f.history.manifestSha256)).toBe(true);
    for (const invalid of [{ ...manifest, scope: { ...manifest.scope, writerEpoch: randomUUID() } },
      { ...manifest, source: { ...source, mutationId: randomUUID() } }, { ...manifest, deleted: true },
      { ...manifest, restoreRevision: 7 }, { ...manifest, recordSequence: 8 }, { ...manifest, eventSequence: 26 }])
      expect(s.cloudLocalCommandHistoryHeadMatchesManifest(head, invalid, f.history.manifestSha256)).toBe(false);
    expect(s.cloudLocalCommandHistoryHeadMatchesManifest(head, manifest, "c".repeat(64))).toBe(false);
    const incomplete = s.CloudLocalCommandHistoryHeadSchema.parse({ ...head,
      history: { restoreRevision: 9, recordSequence: null, eventSequence: null, incompleteReason: "capture_conflict" } });
    expect(s.cloudLocalCommandHistoryHeadMatchesManifest(incomplete, manifest, f.history.manifestSha256)).toBe(false);
  });
});
