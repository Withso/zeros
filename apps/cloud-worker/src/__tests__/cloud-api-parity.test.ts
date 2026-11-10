import { expect, it } from "vitest";
import * as shared from "@zeros/protocol/cloud-v2-relay";
// Test-only: the control plane deploys independently and mirrors Zod 4 in Zod 3.
import * as control from "../../../control-plane/src/cloud/contract";
import * as sharedPrompts from "@zeros/protocol/cloud-v2-prompts";
import * as controlPrompts from "../../../control-plane/src/cloud/prompt-contract";
import * as controlEnvironment from "../../../control-plane/src/cloud/environment-contract";
import { CloudV2ControlFrameSchema as legacyWorkerFrame } from "../../../control-plane/src/cloud/__fixtures__/worker-contract-before-identity";
import { WORKSPACE_ID, config } from "./worker-fixtures";

const token = `zw2a_${"a".repeat(43)}`;

it("keeps the optional workspace API configuration identical across the independently deployed contracts", () => {
  const api = { url: "https://api.example.test/api/v0", token };
  for (const contract of [shared, control]) {
    expect(contract.CloudV2ControlFrameSchema.parse(config)).toEqual(config);
    expect(contract.CloudV2ControlFrameSchema.parse({ ...config, api })).toEqual({ ...config, api });
    for (const value of [null, {}, { url: api.url }, { token }, { ...api, url: "http://api.example.test/api/v0" }, { ...api, url: `https://x.test/${"p".repeat(2048)}` },
      { ...api, token: `zw2p_${"a".repeat(43)}` }, { ...api, token: `zw2a_${"a".repeat(42)}` }, { ...api, token: `${token}=` }, { ...api, expiresAt: 1 }])
      expect(contract.CloudV2ControlFrameSchema.safeParse({ ...config, api: value }).success, JSON.stringify(value).slice(0, 60)).toBe(false);
  }
  // A worker from before the field rejects it, so the control plane must gate it on workspace-api-v1.
  expect(legacyWorkerFrame.safeParse({ ...config, api }).success).toBe(false);
});

it("keeps the optional session name on a prompt delivery identical across the contracts, and out of the payload", () => {
  const payload = { chatId: "chat", userMessageId: "user-1", agentId: "codex", startedAt: 1, prompt: [{ type: "text", text: "Hello" }] };
  const delivery = { deliveryId: "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", payload,
    receipt: { workspaceId: WORKSPACE_ID, chatId: "chat", userMessageId: "user-1", epoch: "1", sequence: "1", acceptedAt: new Date(0).toISOString(), workspaceState: "running" } };
  const accepted = [undefined, "Fix login", "x".repeat(120), `  ${"y".repeat(120)}  `];
  const refused = [null, "", "   ", "x".repeat(121), "line\nbreak", "tab\there", "\u0000", "control\u0085char", 7];
  for (const contract of [sharedPrompts, controlPrompts]) {
    for (const sessionName of accepted)
      expect(contract.CloudV2PromptDeliverySchema.safeParse({ ...delivery, ...(sessionName === undefined ? {} : { sessionName }) }).success, String(sessionName).slice(0, 12)).toBe(true);
    for (const sessionName of refused)
      expect(contract.CloudV2PromptDeliverySchema.safeParse({ ...delivery, sessionName }).success, JSON.stringify(sessionName).slice(0, 12)).toBe(false);
    expect(contract.CloudV2PromptSchema.safeParse({ ...payload, sessionName: "Task" }).success).toBe(false);
  }
});

it("reserves the worker-owned ZEROS names on both sides and exempts exactly the user's API key", () => {
  for (const reserved of [shared.isCloudReservedEnvironmentName, controlEnvironment.isCloudReservedEnvironmentName]) {
    for (const name of ["ZEROS_API_URL", "ZEROS_API_TOKEN", "ZEROS_WORKSPACE_ID", "ZEROS_SESSION_ID", "ZEROS_WORKER_TOKEN", "zeros_api_key", "ZEROS_API_KEY_2"])
      expect(reserved(name), name).toBe(true);
    expect(reserved("ZEROS_API_KEY")).toBe(false);
  }
});

it("keeps chat edits and their history acknowledgements identical across the contracts", () => {
  const edits = { accepted: [{ chatId: "chat", version: "1", title: "Renamed" }, { chatId: "chat", version: "2", archived: true },
    { chatId: "chat", version: "9223372036854775806", title: "x".repeat(120), archived: false }, { chatId: "chat", version: "3" }],
    refused: [{ chatId: "", version: "1" }, { chatId: "chat", version: "01" }, { chatId: "chat", version: 1 }, { chatId: "chat", version: "1", title: "" },
      { chatId: "chat", version: "1", title: "x".repeat(121) }, { chatId: "chat", version: "1", title: "line\nbreak" }, { chatId: "chat", version: "1", archived: "yes" },
      { chatId: "chat", version: "1", updatedAt: 1 }, { chatId: "x".repeat(257), version: "1" }] };
  for (const contract of [sharedPrompts, controlPrompts]) {
    for (const edit of edits.accepted) {
      expect(contract.CloudV2ChatEditSchema.safeParse(edit).success, JSON.stringify(edit).slice(0, 50)).toBe(true);
      expect(contract.CloudV2PromptPullReplySchema.safeParse({ prompts: [], stops: [], chatEdits: [edit] }).success).toBe(true);
    }
    for (const edit of edits.refused) expect(contract.CloudV2ChatEditSchema.safeParse(edit).success, JSON.stringify(edit).slice(0, 50)).toBe(false);
    expect(contract.CloudV2PromptPullReplySchema.safeParse({ prompts: [], stops: [] }).success).toBe(true);
    expect(contract.CloudV2PromptPullReplySchema.safeParse({ prompts: [], stops: [], chatEdits: Array.from({ length: 129 }, () => edits.accepted[0]) }).success).toBe(false);
    for (const ack of [{ chatId: "chat", version: "1" }]) expect(contract.CloudV2ChatEditAckSchema.safeParse(ack).success).toBe(true);
    for (const ack of [{ chatId: "chat" }, { chatId: "chat", version: "1", title: "x" }, { chatId: "chat", version: "-1" }])
      expect(contract.CloudV2ChatEditAckSchema.safeParse(ack).success, JSON.stringify(ack)).toBe(false);
  }
  const frame = (extra: Record<string, unknown>) => ({ t: "history", chats: [], ...extra });
  for (const contract of [shared, control]) {
    expect(contract.CloudV2WorkerFrameSchema.safeParse(frame({})).success).toBe(true);
    expect(contract.CloudV2WorkerFrameSchema.safeParse(frame({ chatEditAcks: [{ chatId: "chat", version: "4" }] })).success).toBe(true);
    expect(contract.CloudV2WorkerFrameSchema.safeParse(frame({ chatEditAcks: [{ chatId: "chat", version: "4", extra: 1 }] })).success).toBe(false);
    expect(contract.CloudV2WorkerFrameSchema.safeParse(frame({ chatEditAcks: Array.from({ length: 129 }, () => ({ chatId: "chat", version: "4" })) })).success).toBe(false);
  }
});
