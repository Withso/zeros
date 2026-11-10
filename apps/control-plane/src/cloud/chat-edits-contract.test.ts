import { beforeAll, expect, it } from "vitest";
import { CloudV2WorkerHistorySchema } from "./contract.js";
import { CloudV2ChatEditSchema, CloudV2ChatEditAckSchema, CloudV2PromptPullSchema, CloudV2PromptPullReplySchema } from "./prompt-contract.js";

type Schema = { safeParse(value: unknown): { success: boolean; data?: unknown }; parse(value: unknown): unknown };
let protocol: Record<string, Schema>, history: Schema;
beforeAll(async () => {
  // The isolated control-plane branch can test the worker's integration source
  // before the two halves are joined; normal runs use the repository contracts.
  const root = new URL(process.env.CLOUD_API_TEST_PROTOCOL_ROOT ?? "../../../../packages/protocol/src/", import.meta.url);
  protocol = await import(new URL("cloud-v2-prompts.ts", root).href);
  history = (await import(new URL("cloud-v2-relay.ts", root).href)).CloudV2WorkerHistorySchema;
});

function parity(left: Schema, right: Schema, value: unknown, valid: boolean) {
  const a = left.safeParse(value), b = right.safeParse(value);
  expect(a.success).toBe(valid); expect(b.success).toBe(valid);
  if (valid) expect(a.data).toEqual(b.data);
}

it.each([
  { edit: { chatId: "chat", version: "1", title: "  Title  ", archived: false }, valid: true },
  { edit: { chatId: "cloud:legacy-chat", version: "0" }, valid: true },
  { edit: { chatId: "chat", version: "9223372036854775806", archived: true }, valid: true },
  ...["", "01", "-1", "9223372036854775807", 1].map(version => ({ edit: { chatId: "chat", version }, valid: false })),
  ...["", " ", "x".repeat(121), "line\nbreak", "control\u0085", "\tTitle"].map(title => ({ edit: { chatId: "chat", version: "1", title }, valid: false })),
  ...["", "x".repeat(257)].map(chatId => ({ edit: { chatId, version: "1" }, valid: false })),
  { edit: { chatId: "chat", version: "1", archived: 1 }, valid: false },
  { edit: { chatId: "chat", version: "1", unexpected: true }, valid: false },
])("mirrors chat edit acceptance exactly: $edit", ({ edit, valid }) => {
  parity(CloudV2ChatEditSchema, protocol.CloudV2ChatEditSchema!, edit, valid);
  parity(CloudV2PromptPullReplySchema, protocol.CloudV2PromptPullReplySchema!, { prompts: [], stops: [], chatEdits: [edit] }, valid);
});

it.each([
  { ack: { chatId: "chat", version: "1" }, valid: true },
  { ack: { chatId: "cloud:legacy-chat", version: "9223372036854775806" }, valid: true },
  { ack: { chatId: "chat", version: "01" }, valid: false },
  { ack: { chatId: "chat", version: "9223372036854775807" }, valid: false },
  { ack: { chatId: "", version: "1" }, valid: false },
  { ack: { chatId: "chat", version: "1", title: "Not an ack field" }, valid: false },
])("mirrors history acknowledgements exactly: $ack", ({ ack, valid }) => {
  parity(CloudV2ChatEditAckSchema, protocol.CloudV2ChatEditAckSchema!, ack, valid);
  parity(CloudV2WorkerHistorySchema, history, { t: "history", bootId: "11111111-1111-4111-8111-111111111111", sequence: 1,
    chats: [{ id: "chat", title: "Title", updatedAt: 1 }], chatEditAcks: [ack] }, valid);
});

it("bounds both optional arrays, keeps N-1 replies valid, and never adds acknowledgements to the pull request", () => {
  const ack = { chatId: "chat", version: "1" };
  const reply = { prompts: [], stops: [] }, frame = { t: "history", bootId: "11111111-1111-4111-8111-111111111111", sequence: 1 };
  parity(CloudV2PromptPullReplySchema, protocol.CloudV2PromptPullReplySchema!, reply, true);
  parity(CloudV2WorkerHistorySchema, history, frame, true);
  for (const count of [0, 128, 129]) {
    parity(CloudV2PromptPullReplySchema, protocol.CloudV2PromptPullReplySchema!, { ...reply, chatEdits: Array(count).fill(ack) }, count <= 128);
    parity(CloudV2WorkerHistorySchema, history, { ...frame, chatEditAcks: Array(count).fill(ack) }, count <= 128);
  }
  const legacy = CloudV2PromptPullReplySchema.omit({ chatEdits: true });
  expect(legacy.parse(reply)).toEqual(reply);
  expect(legacy.safeParse({ ...reply, chatEdits: [ack] }).success).toBe(false);
  parity(CloudV2PromptPullSchema, protocol.CloudV2PromptPullSchema!, { waitMs: 0, held: [], chatEditAcks: [ack] }, false);
});
