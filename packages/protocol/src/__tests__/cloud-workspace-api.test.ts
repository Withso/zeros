import { describe, expect, it } from "vitest";
import { CloudV2PromptDeliverySchema, CloudV2PromptPullReplySchema } from "../cloud-v2-prompts";
import { CloudEnvironmentMaterialSchema, CloudV2ControlFrameSchema, CloudV2WorkerFrameSchema, CloudV2WorkerHistorySchema, CloudWorkspaceResourcesSchema, isCloudReservedEnvironmentName } from "../cloud-v2-relay";

const id = "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11";
const config = { t: "config", loginRevision: "0", agents: {}, workspace: {
  id, organizationId: id, checkoutPath: "/home/user/example/repo", repository: "example/repo", branch: "zeros/new", baseBranch: "main",
} };
const token = `zw2a_${"A".repeat(43)}`;

describe("workspace API delivery", () => {
  it("keeps api optional so a worker accepts a configuration from a control plane that predates it", () => {
    expect(CloudV2ControlFrameSchema.parse(config)).toEqual(config);
    const delivered = { ...config, api: { url: "https://api.example.test/api/v0", token } };
    expect(CloudV2ControlFrameSchema.parse(delivered)).toEqual(delivered);
  });

  it("accepts only an https base and an exact workspace token shape", () => {
    const good = { url: "https://api.example.test/api/v0", token };
    for (const api of [{ ...good, url: "http://api.example.test/api/v0" }, { ...good, url: "not a url" }, { ...good, url: `https://a.test/${"x".repeat(2048)}` },
      { ...good, token: `zw2p_${"A".repeat(43)}` }, { ...good, token: `zw2a_${"A".repeat(42)}` }, { ...good, token: `zw2a_${"A".repeat(44)}` },
      { ...good, token: `zw2a_${"A".repeat(42)}+` }, { ...good, extra: 1 }, { url: good.url }, null])
      expect(CloudV2ControlFrameSchema.safeParse({ ...config, api }).success, JSON.stringify(api)?.slice(0, 80)).toBe(false);
  });
});

describe("workspace environment names", () => {
  it("reserves every ZEROS_ name except exactly ZEROS_API_KEY", () => {
    for (const name of ["ZEROS_API_URL", "ZEROS_API_TOKEN", "ZEROS_WORKSPACE_ID", "ZEROS_SESSION_ID", "ZEROS_API_KEYS", "zeros_api_token"])
      expect(isCloudReservedEnvironmentName(name), name).toBe(true);
    expect(isCloudReservedEnvironmentName("ZEROS_API_KEY")).toBe(false);
    expect(CloudEnvironmentMaterialSchema.safeParse({ variables: { ZEROS_API_KEY: "zk_fixture" }, files: [] }).success).toBe(true);
    const reserved = CloudEnvironmentMaterialSchema.safeParse({ variables: { ZEROS_API_TOKEN: "x" }, files: [] });
    expect(reserved.success).toBe(false);
    expect(reserved.error?.issues[0]?.message).toBe("cloud_environment_reserved");
  });
});

describe("workspace resources", () => {
  const sample = { cpu: { cores: 4, usedPercent: 12.5 }, memory: { totalBytes: 8 * 2 ** 30, usedPercent: 40 }, disk: { totalBytes: 64 * 2 ** 30, usedPercent: 10 }, sampledAt: 1 };
  it("accepts a bounded sample and rejects anything else", () => {
    expect(CloudWorkspaceResourcesSchema.parse(sample)).toEqual(sample);
    for (const bad of [{ ...sample, cpu: { cores: 0, usedPercent: 1 } }, { ...sample, memory: { totalBytes: 1, usedPercent: 101 } },
      { ...sample, disk: { totalBytes: -1, usedPercent: 0 } }, { ...sample, extra: true }, { ...sample, sampledAt: undefined }])
      expect(CloudWorkspaceResourcesSchema.safeParse(bad).success).toBe(false);
  });
});

describe("session names on prompt delivery", () => {
  const delivery = {
    deliveryId: "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11",
    receipt: { workspaceId: id, chatId: "chat", userMessageId: "user-1", epoch: "1", sequence: "1", acceptedAt: new Date(0).toISOString(), workspaceState: "running" },
    payload: { chatId: "chat", userMessageId: "user-1", agentId: "codex", startedAt: 1, prompt: [{ type: "text", text: "Hello" }] },
  };
  it("keeps sessionName optional and bounded: 1..120 characters after trimming, no control characters", () => {
    expect(CloudV2PromptDeliverySchema.safeParse(delivery).success).toBe(true);
    for (const sessionName of ["Fix login", "x".repeat(120), `  ${"y".repeat(120)}  `])
      expect(CloudV2PromptDeliverySchema.safeParse({ ...delivery, sessionName }).success, sessionName.slice(0, 10)).toBe(true);
    for (const sessionName of ["", "   ", "x".repeat(121), "line\nbreak", "tab\there", "\u0000", 7])
      expect(CloudV2PromptDeliverySchema.safeParse({ ...delivery, sessionName }).success, String(sessionName).slice(0, 10)).toBe(false);
  });
});

describe("chat edits (chat-edit-v1)", () => {
  const edit = { chatId: "chat", version: "3", title: "Renamed", archived: true };
  it("keeps chatEdits optional on the pull reply, bounded, strict and decimal-versioned", () => {
    expect(CloudV2PromptPullReplySchema.safeParse({ prompts: [], stops: [] }).success).toBe(true);
    for (const chatEdits of [[edit], [{ chatId: "chat", version: "0", title: "Only title" }], [{ chatId: "chat", version: "9223372036854775806", archived: false }],
      Array.from({ length: 128 }, (_, i) => ({ ...edit, chatId: `chat-${i}` }))])
      expect(CloudV2PromptPullReplySchema.safeParse({ prompts: [], stops: [], chatEdits }).success).toBe(true);
    for (const bad of [{ ...edit, version: "-1" }, { ...edit, version: "01" }, { ...edit, version: 3 }, { ...edit, chatId: "" }, { ...edit, chatId: "x".repeat(257) },
      { ...edit, title: "" }, { ...edit, title: "x".repeat(121) }, { ...edit, title: "a\nb" }, { ...edit, archived: "yes" }, { ...edit, model: "other" }])
      expect(CloudV2PromptPullReplySchema.safeParse({ prompts: [], stops: [], chatEdits: [bad] }).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    expect(CloudV2PromptPullReplySchema.safeParse({ prompts: [], stops: [], chatEdits: Array.from({ length: 129 }, (_, i) => ({ ...edit, chatId: `c${i}` })) }).success).toBe(false);
  });

  it("keeps chatEditAcks optional on the history batch and bounded", () => {
    const base = { t: "history", bootId: id, sequence: 1, chats: [{ id: "chat" }] };
    expect(CloudV2WorkerHistorySchema.safeParse(base).success).toBe(true);
    expect(CloudV2WorkerHistorySchema.safeParse({ ...base, chatEditAcks: [{ chatId: "chat", version: "3" }] }).success).toBe(true);
    expect(CloudV2WorkerFrameSchema.safeParse({ t: "history", chats: [{ id: "chat" }], chatEditAcks: [{ chatId: "chat", version: "3" }] }).success).toBe(true);
    for (const chatEditAcks of [[{ chatId: "chat", version: "x" }], [{ chatId: "chat" }], [{ chatId: "chat", version: "3", title: "no" }],
      Array.from({ length: 129 }, (_, i) => ({ chatId: `c${i}`, version: "1" }))])
      expect(CloudV2WorkerHistorySchema.safeParse({ ...base, chatEditAcks }).success).toBe(false);
  });

  it("needs negotiation both ways: a reader without the fields rejects them strictly", () => {
    const previousReply = CloudV2PromptPullReplySchema.omit({ chatEdits: true }).strict();
    expect(previousReply.safeParse({ prompts: [], stops: [], chatEdits: [edit] }).success).toBe(false);
    const previousHistory = CloudV2WorkerHistorySchema.omit({ chatEditAcks: true }).strict();
    expect(previousHistory.safeParse({ t: "history", bootId: id, sequence: 1, chatEditAcks: [{ chatId: "chat", version: "3" }] }).success).toBe(false);
    expect(previousHistory.safeParse({ t: "history", bootId: id, sequence: 1, chats: [{ id: "chat" }] }).success).toBe(true);
  });
});
