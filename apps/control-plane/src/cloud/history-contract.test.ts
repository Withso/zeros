import { expect, it } from "vitest";
import { CloudV2WorkerHistorySchema, CloudV2ControlFrameSchema } from "./contract.js";
import { CloudV2WorkerHistorySchema as protocolHistory, CloudV2ControlFrameSchema as protocolConfig } from "../../../../packages/protocol/src/cloud-v2-relay.js";

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
    expect(schema.safeParse({ ...config, historyReplacement: 2 }).success).toBe(false);
  }
});
