import { expect, it } from "vitest";
import { CloudV2WorkerHistorySchema, CloudV2ControlFrameSchema, CloudV2HistoryDigestsReplySchema } from "./contract.js";
import { CloudV2WorkerHistorySchema as protocolHistory, CloudV2ControlFrameSchema as protocolConfig, CloudV2HistoryDigestsReplySchema as protocolDigests } from "../../../../packages/protocol/src/cloud-v2-relay.js";

const bootId = "11111111-1111-4111-8111-111111111111";
it.each([
  { state: { revision: 0 }, valid: true }, { state: { revision: 1, beforeEpoch: "0" }, valid: true },
  { state: { revision: Number.MAX_SAFE_INTEGER, beforeEpoch: "9223372036854775806" }, valid: true },
  ...[-1, 1.1, Number.MAX_SAFE_INTEGER + 1, "1"].map(revision => ({ state: { revision }, valid: false })),
  ...["01", "-1", "9223372036854775807", "1\n"].map(beforeEpoch => ({ state: { revision: 1, beforeEpoch }, valid: false })),
  { state: { revision: 1, actor: "client" }, valid: false },
])("validates optional cut metadata identically in protocol and CP: $state", ({ state, valid }) => {
  const value = { t: "history", bootId, sequence: 1, messages: { chatId: "chat", rows: [], replace: true, historyState: state } };
  const a = CloudV2WorkerHistorySchema.safeParse(value), b = protocolHistory.safeParse(value);
  expect(a.success).toBe(valid); expect(b.success).toBe(valid);
  if (a.success && b.success) expect(a.data).toEqual(b.data);
});
it("keeps legacy history valid and requires a replacement when state advances", () => {
  for (const schema of [CloudV2WorkerHistorySchema, protocolHistory]) {
    const value = { t: "history", bootId, sequence: 1, messages: { chatId: "chat", rows: [] } };
    expect(schema.parse(value)).toEqual(value);
    expect(schema.safeParse({ ...value, messages: { ...value.messages, historyState: { revision: 1 } } }).success).toBe(false);
  }
});
it("keeps history capability negotiation optional in both config mirrors", () => {
  const config = { t: "config", loginRevision: "0", workspace: { id: bootId, organizationId: bootId, checkoutPath: "/home/user/Owner/Project",
    repository: "Owner/Project", branch: "zeros/work", baseBranch: "main" }, agents: {} };
  for (const schema of [CloudV2ControlFrameSchema, protocolConfig]) {
    expect(schema.parse(config)).toEqual(config);
    expect(schema.parse({ ...config, historyReplacement: 1 })).toEqual({ ...config, historyReplacement: 1 });
    expect(schema.parse({ ...config, historyReplacement: 1, historyDigest: 1 })).toEqual({ ...config, historyReplacement: 1, historyDigest: 1 });
    expect(schema.safeParse({ ...config, historyReplacement: 2 }).success).toBe(false);
  }
});

it.each(["a".repeat(64), "A".repeat(64), "0".repeat(63), `${"f".repeat(64)}\n`, null])("validates the optional opaque digest identically: %s", digest => {
  const value = { t: "history", bootId, sequence: 1, messages: { chatId: "chat", rows: [], digest } };
  const a = CloudV2WorkerHistorySchema.safeParse(value), b = protocolHistory.safeParse(value);
  expect(a.success).toBe(digest === "a".repeat(64)); expect(b.success).toBe(a.success);
  if (a.success && b.success) expect(a.data).toEqual(b.data);
});
it("keeps the digest reply strict and bounded in both mirrors", () => {
  const value = { chats: [{ chatId: "chat", digest: "f".repeat(64) }, { chatId: "missing", digest: null }] };
  for (const schema of [CloudV2HistoryDigestsReplySchema, protocolDigests]) {
    expect(schema.parse(value)).toEqual(value);
    expect(schema.safeParse({ ...value, workspaceId: bootId }).success).toBe(false);
    expect(schema.safeParse({ chats: [{ chatId: "chat", digest: null, row: {} }] }).success).toBe(false);
    expect(schema.safeParse({ chats: Array.from({ length: 4097 }, () => value.chats[0]) }).success).toBe(false);
  }
});

it.each([
  { name: "empty deletion list", value: { chats: [], deleted: [] }, valid: true },
  { name: "disjoint live and deleted chats", value: { chats: [{ chatId: "live", digest: null }], deleted: ["deleted"] }, valid: true },
  { name: "overlapping chat identities", value: { chats: [{ chatId: "same", digest: null }], deleted: ["same"] }, valid: false },
  { name: "empty deleted identity", value: { chats: [], deleted: [""] }, valid: false },
  { name: "oversized deleted identity", value: { chats: [], deleted: ["d".repeat(257)] }, valid: false },
  { name: "combined overflow", value: { chats: [{ chatId: "live", digest: null }], deleted: Array.from({ length: 4096 }, (_, id) => `deleted-${id}`) }, valid: false },
  { name: "full deletion list", value: { chats: [], deleted: Array.from({ length: 4096 }, (_, id) => `deleted-${id}`) }, valid: true },
  { name: "unexpected deletion metadata", value: { chats: [], deleted: [], cursor: 1 }, valid: false },
])("validates negotiated deletion replies identically: $name", ({ value, valid }) => {
  const controlPlane = CloudV2HistoryDigestsReplySchema.safeParse(value), worker = protocolDigests.safeParse(value);
  expect(controlPlane.success).toBe(valid); expect(worker.success).toBe(valid);
  if (controlPlane.success && worker.success) expect(controlPlane.data).toEqual(worker.data);
});
