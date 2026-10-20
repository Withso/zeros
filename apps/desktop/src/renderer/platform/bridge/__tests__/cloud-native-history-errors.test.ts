import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudAgentBootConversationSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { WorkspaceRuntimeClient } from "../workspace-runtime-client";
import { RuntimeClient } from "../ws-client";
import { workspaceOp } from "../workspace-bridge";
import { cloudScopedId, cloudWorkspaceKey } from "../cloud-workspace-key";
import type { WireRecord } from "../cloud-runtime-wire";

const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const identity = {
  ...target,
  version: 1,
  mode: "boot-owner-v1",
  fundingScope: "workspace-roles-v1",
  generation: 2,
  engineInstanceId: "33333333-3333-4333-8333-333333333333",
  bootId: "44444444-4444-4444-8444-444444444444",
  writerEpoch: "55555555-5555-4555-8555-555555555555",
  fundingOwnerUserId: "66666666-6666-4666-8666-666666666666",
  fundingOwnerEpoch: 1,
};
const metadata = {
  projection: { ...identity, mirroredSequence: 0, sealedSequence: null, complete: false },
  historyHeads: [],
};
const binding = CloudAgentBootConversationSchema.parse({
  ...identity,
  authorityEpoch: 1,
  cacheRevision: 1,
  desiredCacheRevision: 1,
  initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })),
});
const clients: WorkspaceRuntimeClient[] = [];
const finishProjections: (() => void)[] = [];

function fixture() {
  const request = vi.fn(async (message: WireRecord): Promise<WireRecord> => ({
    type: "WORKSPACE_RESPONSE",
    op: message.op,
    result: { chats: [], chatDeletions: [], ...metadata },
  }));
  const release = vi.fn();
  const peer = {
    client: {
      request,
      status: "connected",
      activatedCloudAgentBootBinding: binding,
      executionIdentity: { kind: "cloud", ...target, generation: identity.generation,
        engineInstanceId: identity.engineInstanceId, authorityEpoch: 1, bootScope: identity },
      onStatusChange: () => () => {},
      on: () => () => {},
    } as unknown as RuntimeClient,
    scope: { ...target, root: "/workspace/repo", engineWorkspaceId: "main" },
    generation: identity.generation,
    runtimeId: "exact-history-admission",
    release,
  };
  const open = vi.fn(async () => peer);
  // An optional cold CP projection must not obscure the native read under test.
  let finishProjection!: (result: WireRecord) => void;
  const projection = new Promise<WireRecord>(resolve => { finishProjection = resolve; });
  const readHistory = vi.fn(() => projection);
  finishProjections.push(() => finishProjection({ chats: [], chatDeletions: [], ...metadata }));
  const client = new WorkspaceRuntimeClient({ open, readHistory, workspaces: () => [] });
  clients.push(client);
  return { client, request, open, readHistory, release };
}

function historyMessage(op = "messages.window") {
  return {
    type: "WORKSPACE_REQUEST" as const,
    op,
    params: op === "chats.list" ? { folder: cloudWorkspaceKey(target) } : {
      chatId: cloudScopedId(target, "chat"),
      limit: 200,
      ...(op === "messages.windowOlder" ? { beforeMsgId: "older-boundary" } : {}),
      ...(op === "messages.search" ? { query: "saved" } : {}),
    },
  };
}

function refusal(op: string, code = "command_conflict") {
  return { type: "WORKSPACE_ERROR", op, code,
    message: "The cloud history writer changed during this read.",
    remediation: "Read again after the current writer settles." };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  for (const finish of finishProjections.splice(0)) finish();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

describe("bounded native history conflict recovery", () => {

  it.each(["messages.window", "messages.windowOlder", "messages.search", "chats.list"])(
    "recovers %s without a runtime update after four timing conflicts", async op => {
      const f = fixture();
      await f.client.warmWorkspace(target);
      f.request.mockClear();
      const rows = op === "chats.list" ? "chats" : op === "messages.search" ? "hits" : "messages";
      const response = { type: "WORKSPACE_RESPONSE", op, result: { [rows]: [], ...metadata } };
      for (let i = 0; i < 4; i++) f.request.mockResolvedValueOnce(refusal(op));
      f.request.mockResolvedValue(response);
      const pending = Promise.allSettled([f.client.request(historyMessage(op))]);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await pending).toMatchObject([{ status: "fulfilled", value: response }]);
      expect(f.request).toHaveBeenCalledTimes(5);
      expect(f.open).toHaveBeenCalledOnce();
    },
  );

  it("shares five bounded attempts and preserves the final refusal without CP fallback", async () => {
    const f = fixture();
    await f.client.warmWorkspace(target);
    f.request.mockClear(); f.readHistory.mockClear();
    f.request.mockResolvedValue(refusal("messages.window"));
    const pending = Promise.allSettled([f.client.request(historyMessage()), f.client.request(historyMessage())]);
    await vi.advanceTimersByTimeAsync(8_000);
    const results = await pending;
    expect(results).toMatchObject([
      { status: "rejected", reason: { code: "command_conflict" } },
      { status: "rejected", reason: { code: "command_conflict" } },
    ]);
    expect(f.request).toHaveBeenCalledTimes(5);
    expect(f.readHistory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.request).toHaveBeenCalledTimes(5);
  });

  it("does not dispatch another retry after account retirement during backoff", async () => {
    const f = fixture(); await f.client.warmWorkspace(target);
    f.request.mockClear(); f.request.mockResolvedValue(refusal("messages.window"));
    const pending = Promise.allSettled([f.client.request(historyMessage())]);
    await vi.advanceTimersByTimeAsync(0);
    f.client.clearCloudConnections();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await pending).toMatchObject([{ status: "rejected", reason: { message: expect.stringMatching(/changed|retired/i) } }]);
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("does not restart the original eight-second budget after a slow conflicting read", async () => {
    const f = fixture(); await f.client.warmWorkspace(target);
    f.request.mockClear();
    f.request.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(refusal("messages.window")), 7_500)));
    const pending = Promise.allSettled([f.client.request(historyMessage())]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await pending).toMatchObject([{ status: "rejected", reason: { code: "command_conflict" } }]);
    expect(f.request).toHaveBeenCalledOnce();
  });
});

describe("native cloud history error envelopes", () => {
  it.each(["messages.window", "messages.windowOlder", "messages.search", "chats.list"])(
    "preserves the worker's refusal fields for %s through the history façade", async op => {
      const f = fixture();
      await f.client.warmWorkspace(target);
      const failure = refusal(op);
      f.request.mockResolvedValue(failure);
      f.readHistory.mockClear();

      const message = historyMessage(op);
      const rejected = expect(workspaceOp(f.client, op, message.params)).rejects.toMatchObject({
        name: "WorkspaceOpError", code: failure.code,
        message: failure.message, remediation: failure.remediation,
      });
      await vi.advanceTimersByTimeAsync(8_000); await rejected;
      expect(f.request).toHaveBeenCalledTimes(6);
      expect(f.open).toHaveBeenCalledOnce();
      expect(f.readHistory).not.toHaveBeenCalled();
      expect(f.client.hasCloudMessageSnapshot(cloudScopedId(target, "chat"), 200)).toBe(false);
    },
  );

  it.each(["command_conflict", "CLOUD_ACTOR_FORBIDDEN", "FUTURE_HISTORY_REFUSAL"])(
    "preserves %s when the initial native conversation list refuses", async code => {
      const f = fixture();
      const failure = refusal("chats.list", code);
      f.request.mockResolvedValue(failure);

      const rejected = expect(f.client.warmWorkspace(target)).rejects.toMatchObject({
        name: "WorkspaceOpError", code, message: failure.message, remediation: failure.remediation,
      });
      await vi.advanceTimersByTimeAsync(8_000); await rejected;
      expect(f.request).toHaveBeenCalledTimes(code === "command_conflict" ? 5 : 1);
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.client.hasChatSnapshot(cloudWorkspaceKey(target))).toBe(false);
    },
  );

  it("does not fabricate remediation when the engine omits it", async () => {
    const f = fixture();
    await f.client.warmWorkspace(target);
    const { remediation: _remediation, ...failure } = refusal("messages.window", "CLOUD_ACTOR_FORBIDDEN");
    f.request.mockResolvedValue(failure);
    const [result] = await Promise.allSettled([f.client.request(historyMessage())]);
    expect(result).toMatchObject({ status: "rejected", reason: {
      code: failure.code, message: failure.message,
    } });
    if (result.status !== "rejected") throw new Error("Native refusal succeeded");
    expect(result.reason).not.toHaveProperty("remediation");
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("preserves explicitly empty error message and remediation fields", async () => {
    const f = fixture();
    await f.client.warmWorkspace(target);
    f.request.mockResolvedValue({ ...refusal("messages.window"), message: "", remediation: "" });
    const rejected = expect(f.client.request(historyMessage())).rejects.toMatchObject({
      code: "command_conflict", message: "", remediation: "",
    });
    await vi.advanceTimersByTimeAsync(8_000); await rejected;
  });

  it("keeps a valid empty native transcript readable", async () => {
    const f = fixture();
    await f.client.warmWorkspace(target);
    f.request.mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", op: "messages.window",
      result: { messages: [], ...metadata } });
    await expect(f.client.request(historyMessage())).resolves.toMatchObject({
      type: "WORKSPACE_RESPONSE", result: { messages: [], ...metadata },
    });
    expect(f.client.hasCloudMessageSnapshot(cloudScopedId(target, "chat"), 200)).toBe(true);
  });

  it.each([
    { type: "WORKSPACE_RESPONSE", result: { messages: "invalid" }, code: "command_conflict", message: "not a refusal" },
    { type: "AGENT_ERROR", code: "command_conflict", message: "not a workspace refusal" },
  ])("keeps a malformed or unexpected native transcript reply distinct from a refusal", async response => {
    const f = fixture();
    await f.client.warmWorkspace(target);
    f.request.mockResolvedValueOnce(response);
    const result = await Promise.allSettled([f.client.request(historyMessage())]);
    expect(result[0]).toMatchObject({ status: "rejected", reason: {
      name: "Error", message: "Could not read the current cloud transcript",
    } });
    if (result[0].status !== "rejected") throw new Error("Malformed transcript reply succeeded");
    expect(result[0].reason).not.toHaveProperty("code");
    expect(result[0].reason).not.toHaveProperty("remediation");
  });

  it("keeps a malformed successful conversation list distinct from a refusal", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", op: "chats.list",
      result: { chats: "invalid" }, code: "command_conflict", message: "not a refusal" });
    await expect(f.client.warmWorkspace(target)).rejects.toMatchObject({
      name: "Error", message: "Could not read cloud conversations",
    });
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("shares one exact-key non-conflict refusal without retrying or falling back to CP history", async () => {
    const f = fixture();
    await f.client.warmWorkspace(target);
    let finish!: (response: WireRecord) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.request.mockClear();
    f.readHistory.mockClear();
    const pending = Promise.allSettled([
      f.client.request(historyMessage()), f.client.request(historyMessage()),
    ]);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    const failure = refusal("messages.window", "CLOUD_ACTOR_FORBIDDEN");
    finish(failure);
    const results = await pending;
    for (const result of results) expect(result).toMatchObject({
      status: "rejected", reason: { code: failure.code, message: failure.message, remediation: failure.remediation },
    });
    if (results[0].status !== "rejected" || results[1].status !== "rejected")
      throw new Error("Native refusal succeeded");
    expect(results[0].reason).toBe(results[1].reason);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.readHistory).not.toHaveBeenCalled();
  });

  it("retains the account/peer retirement error ahead of a late native refusal", async () => {
    const f = fixture();
    await f.client.warmWorkspace(target);
    let finish!: (response: WireRecord) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.client.request(historyMessage());
    const rejected = expect(pending).rejects.toThrow(/changed|retired/i);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
    f.client.clearCloudConnections();
    finish(refusal("messages.window"));
    await rejected;
    expect(f.client.hasCloudMessageSnapshot(cloudScopedId(target, "chat"), 200)).toBe(false);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["Personal Local", "organization-local"])("leaves %s history errors on the existing Local path", async placement => {
    const f = fixture();
    const failure = refusal("messages.window", "LOCAL_HISTORY_UNAVAILABLE");
    const local = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue(failure as never);
    const params = { chatId: "local-chat", folder: `/local/${placement}` };

    expect(await f.client.request({ type: "WORKSPACE_REQUEST", op: "messages.window", params })).toBe(failure);
    await expect(workspaceOp(f.client, "messages.window", params)).rejects.toMatchObject({
      name: "WorkspaceOpError", code: failure.code, message: failure.message, remediation: failure.remediation,
    });
    expect(local).toHaveBeenCalledTimes(2);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.readHistory).not.toHaveBeenCalled();
  });
});
