import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudLocalHistoryHeadSchema, CloudStoppedHistoryMetadataSchema,
  CloudLocalHistoryRecordSchema, CloudLocalHistoryManifestSchema, CloudLocalHistoryPartSchema, CloudMirroredHistoryHeadSchema,
  assembleCloudHistoryDocument, canonicalCloudHistoryJson } from "./history-local-contract.js";
// Test-only parity; CP production never imports the independently deployed protocol.
import { CloudLocalCommandHistoryRecordSchema as WireRecord, CloudLocalCommandHistoryManifestSchema as WireManifest,
  CloudLocalCommandHistoryPartSchema as WirePart, CloudLocalCommandHistoryHeadSchema as WireHead,
  canonicalCloudLocalCommandHistoryJson as wireCanonical } from "../../../../packages/protocol/src/cloud-local-mirror.js";

const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
  bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
const source = { kind: "mutation", mutationId: randomUUID(), operation: "delete" };
const metadata = () => ({ projection: { ...scope, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
  mirroredSequence: 5, sealedSequence: null, complete: false }, historyHeads: [{ conversationId: "chat", originWriterEpoch: scope.writerEpoch,
  source: { ...source }, restoreRevision: 3, deleted: true, recordSequence: null, eventSequence: null, manifestSha256: null, incompleteReason: "capture_unavailable" }] });
function parts(value: unknown, kind: "record" | "manifest" = "record") {
  const bytes = Buffer.from(canonicalCloudHistoryJson(value)), sha256 = createHash("sha256").update(bytes).digest("hex");
  return Array.from({ length: Math.ceil(bytes.length / 131072) }, (_, index) => ({ version: 1, kind, sha256, index,
    count: Math.ceil(bytes.length / 131072), bytes: bytes.length, data: bytes.subarray(index * 131072, (index + 1) * 131072).toString("base64") }));
}
const record = () => ({ version: 1, conversationId: "chat", entityKind: "message", entityId: "message", schemaVersion: 1,
  sourceRevision: 2, document: { version: 1, chatId: "chat", msgId: "message", ord: 1, kind: "text", payload: "界".repeat(50000), createdAt: 1 } });
const manifest = () => ({ version: 1, snapshot: "full", scope, conversationId: "chat", restoreRevision: 3, deleted: true,
  tombstones: [{ entityKind: "chat", entityId: "chat", sourceRevision: 2 }], recordSequence: 2, eventSequence: 9, source,
  records: [] });

describe("independent CP canonical history and current-head wire", () => {
  it("preserves exact canonical JSON property names through validation and assembly", () => {
    const value = { ...record(), document: JSON.parse('{"payload":{"__proto__":{"marker":true},"constructor":{"prototype":"literal"},"kept":true}}') };
    const expected = canonicalCloudHistoryJson(value), parsed = CloudLocalHistoryRecordSchema.parse(value);
    expect(canonicalCloudHistoryJson(parsed)).toBe(expected);
    expect(wireCanonical(WireRecord.parse(value))).toBe(expected);
    const assembled = assembleCloudHistoryDocument(parts(value));
    expect(canonicalCloudHistoryJson(assembled.document)).toBe(assembled.canonicalDocument);
    expect(assembled.canonicalDocument).toBe(expected);
    expect(Object.getPrototypeOf(parsed.document.payload)).toBe(Object.prototype);
    expect(Object.getPrototypeOf({})).not.toHaveProperty("marker");
  });
  it("mirrors canonical UTF8 encoding and all strict protocol document/head variants", () => {
    const current = { originWriterEpoch: scope.writerEpoch, source, deleted: true,
      history: { restoreRevision: 3, recordSequence: null, eventSequence: null, incompleteReason: "capture_unavailable" } };
    const pairs = [
      { cp: CloudLocalHistoryRecordSchema, wire: WireRecord, values: [record(), { ...record(), schemaVersion: 2 }, { ...record(), document: { n: Infinity } }] },
      { cp: CloudLocalHistoryManifestSchema, wire: WireManifest, values: [manifest(), { ...manifest(), source: { kind: "mutation", mutationId: randomUUID() } }] },
      { cp: CloudLocalHistoryPartSchema, wire: WirePart, values: [parts(record())[0], { ...parts(record())[0], data: "invalid" }] },
      { cp: CloudMirroredHistoryHeadSchema, wire: WireHead, values: [current, { ...current, history: { ...current.history, manifestSha256: "a".repeat(64) } }] },
    ];
    for (const pair of pairs) for (const value of pair.values) {
      const cp = pair.cp.safeParse(value), wire = pair.wire.safeParse(value);
      expect(cp.success).toBe(wire.success);
      if (cp.success && wire.success) expect(cp.data).toEqual(wire.data);
    }
    for (const value of [record(), manifest(), { n: 1, z: [false, null, "界"], a: {} }]) expect(canonicalCloudHistoryJson(value)).toBe(wireCanonical(value));
  });
  it("preserves strict full mutation source and nullable unknown local cursors", () => {
    expect(CloudStoppedHistoryMetadataSchema.parse(metadata())).toEqual(metadata());
  });
  it.each(["source", "originWriterEpoch", "restoreRevision"])("refuses a head missing %s rather than inventing legacy/zero authority", field => {
    const head = { ...metadata().historyHeads[0] } as Record<string, unknown>; delete head[field];
    expect(CloudLocalHistoryHeadSchema.safeParse(head).success).toBe(false);
  });
  it.each(["operation", "mutationId"])("keeps full incomplete mutation %s mandatory across restart", field => {
    const value = metadata(); delete (value.historyHeads[0].source as Record<string, unknown>)[field];
    expect(CloudStoppedHistoryMetadataSchema.safeParse(value).success).toBe(false);
  });
  it("rejects duplicate/page-unbounded heads, false complete seal and invalid complete/incomplete unions", () => {
    const duplicate = metadata(); duplicate.historyHeads.push(duplicate.historyHeads[0]);
    expect(CloudStoppedHistoryMetadataSchema.safeParse(duplicate).success).toBe(false);
    const unsafe = metadata(); unsafe.projection.complete = true;
    expect(CloudStoppedHistoryMetadataSchema.safeParse(unsafe).success).toBe(false);
    expect(CloudStoppedHistoryMetadataSchema.safeParse({ ...metadata(), historyHeads: Array.from({ length: 513 }, (_, i) => ({ ...metadata().historyHeads[0], conversationId: `chat-${i}` })) }).success).toBe(false);
    expect(CloudLocalHistoryHeadSchema.safeParse({ ...metadata().historyHeads[0], manifestSha256: "a".repeat(64) }).success).toBe(false);
    expect(CloudLocalHistoryHeadSchema.safeParse({ ...metadata().historyHeads[0], incompleteReason: null }).success).toBe(false);
  });
  it("decodes all deterministic UTF8 parts and verifies canonical bytes/digest before exposing a record", () => {
    const value = record(), staged = parts(value);
    expect(staged).toHaveLength(2);
    expect(assembleCloudHistoryDocument(staged.reverse())).toEqual({ kind: "record", sha256: staged[0].sha256,
      canonicalDocument: canonicalCloudHistoryJson(value), document: value });
  });
  it("retains FULL deletion/tombstones and exact mutation operation in the verified manifest", () => {
    const value = manifest(); expect(assembleCloudHistoryDocument(parts(value, "manifest")).document).toEqual(value);
  });
  it.each(["gap", "duplicate", "foreignDigest", "foreignKind", "changedCount", "changedBytes", "changedData"])(
    "refuses %s in the original immutable part set", kind => {
      const staged = parts(record());
      if (kind === "gap") staged.pop();
      if (kind === "duplicate") staged[1] = { ...staged[0] };
      if (kind === "foreignDigest") staged[1].sha256 = "a".repeat(64);
      if (kind === "foreignKind") staged[1].kind = "manifest";
      if (kind === "changedCount") staged[1].count++;
      if (kind === "changedBytes") staged[1].bytes++;
      if (kind === "changedData") staged[1].data = Buffer.from("changed").toString("base64");
      expect(() => assembleCloudHistoryDocument(staged)).toThrow();
    });
  it("refuses noncanonical JSON, even with a matching attacker-selected content hash", () => {
    const raw = Buffer.from(JSON.stringify(record())), sha256 = createHash("sha256").update(raw).digest("hex");
    const staged = Array.from({ length: Math.ceil(raw.length / 131072) }, (_, index) => ({ version: 1, kind: "record", sha256,
      index, count: Math.ceil(raw.length / 131072), bytes: raw.length, data: raw.subarray(index * 131072, (index + 1) * 131072).toString("base64") }));
    expect(() => assembleCloudHistoryDocument(staged)).toThrow();
  });
  it("refuses lossy/deep native data and malformed FULL source/ref identity", () => {
    for (const value of [{ n: Infinity }, { missing: undefined }, [undefined], new Date(0)]) expect(() => canonicalCloudHistoryJson(value)).toThrow();
    let nested: unknown = 1; for (let i = 0; i < 34; i++) nested = { child: nested };
    expect(() => canonicalCloudHistoryJson(nested)).toThrow();
    const duplicate = manifest(); duplicate.deleted = false;
    const ref = { entityKind: "message", entityId: "message", schemaVersion: 1, sourceRevision: 2, sha256: "a".repeat(64) };
    expect(() => assembleCloudHistoryDocument(parts({ ...duplicate, records: [ref, ref] }, "manifest"))).toThrow();
  });
});
