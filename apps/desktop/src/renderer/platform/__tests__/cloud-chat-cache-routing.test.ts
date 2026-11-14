import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCloudV2History } from "../cloud-v2";
import { nativeCloudChatCache } from "../cloud-chat-cache";

const io = vi.hoisted(() => ({ request: vi.fn(), invoke: vi.fn() }));
vi.mock("../cloud-workspaces", () => ({ cloudAccountRequest: io.request }));
const owner = JSON.stringify(["https://api.example.test", "viewer-a"]);
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const row = { msgId: "row", kind: "text", payload: '{"id":"row","kind":"text","role":"user","text":"Native","createdAt":1}', createdAt: 1 };
const range = { revision: 5, messageCount: 1, fromIndex: 0, toIndex: 1, rows: [{ ...row, index: 0 }] };
beforeEach(() => {
  vi.clearAllMocks();
  io.request.mockResolvedValue({ result: { messages: [] } });
  io.invoke.mockImplementation(async (_command: string, input: { op: string }) => {
    if (input.op === "bind") return { ok: true, result: { lease: "33333333-3333-4333-8333-333333333333" } };
    if (input.op === "refresh") return { ok: true, result: { range, replaced: false } };
    if (input.op === "refresh-before") return { ok: true, result: range };
    return { ok: true, result: null };
  });
  vi.stubGlobal("window", { __ZEROS_NATIVE__: { invoke: io.invoke, on: () => () => {} } });
  nativeCloudChatCache.bindOwner(owner, "session-a");
});
afterEach(() => { nativeCloudChatCache.bindOwner(null); vi.unstubAllGlobals(); });

describe("cloud history reader native cache integration", () => {
  it("routes an unfiltered tail through main's passive authoritative refresh", async () => {
    expect(await readCloudV2History(target, "messages.window", { chatId: "chat", limit: 200 })).toEqual({ messages: [row] });
    expect(io.request).not.toHaveBeenCalled();
    expect(io.invoke).toHaveBeenCalledWith("cloud_chat_cache", expect.objectContaining({ op: "refresh", target: { ...target, chatId: "chat" } }));
  });

  it.each(["unsupported", "unavailable"])("preserves the old history route when native refresh is %s", async reason => {
    io.invoke.mockImplementation(async (_command: string, input: { op: string }) => input.op === "bind"
      ? { ok: true, result: { lease: "33333333-3333-4333-8333-333333333333" } } : { ok: false, reason });
    expect(await readCloudV2History(target, "messages.window", { chatId: "chat", limit: 200 })).toEqual({ messages: [] });
    expect(io.request).toHaveBeenCalledWith(`/v1/cloud-v2/workspaces/${target.workspaceId}/history`, expect.anything(),
      expect.objectContaining({ body: { op: "messages.window", params: { chatId: "chat", limit: 200 } } }), expect.anything());
  });

  it.each(["access_lost", "owner_changed"])("does not fall back after native %s", async reason => {
    io.invoke.mockImplementation(async (_command: string, input: { op: string }) => input.op === "bind"
      ? { ok: true, result: { lease: "33333333-3333-4333-8333-333333333333" } } : { ok: false, reason });
    await expect(readCloudV2History(target, "messages.window", { chatId: "chat", limit: 200 })).rejects.toMatchObject({ reason });
    expect(io.request).not.toHaveBeenCalled();
  });

  it("keeps main's bind rejection fenced from the current account's old history route", async () => {
    io.invoke.mockResolvedValue({ ok: false, reason: "owner_changed" });
    await expect(readCloudV2History(target, "messages.window", { chatId: "chat", limit: 200 })).rejects.toMatchObject({ reason: "owner_changed" });
    expect(io.request).not.toHaveBeenCalled();
  });

  it("does not fall back when an unavailable old bind finishes after an account switch", async () => {
    let finish!: (reply: unknown) => void, started!: () => void;
    const held = new Promise<unknown>(resolve => { finish = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    io.invoke.mockImplementation(async (_command: string, input: { op: string }) => {
      if (input.op === "bind") { started(); return held; }
      return { ok: true, result: null };
    });
    const reading = readCloudV2History(target, "messages.window", { chatId: "chat", limit: 200 });
    const refused = expect(reading).rejects.toMatchObject({ reason: "owner_changed" });
    await entered;
    nativeCloudChatCache.bindOwner(JSON.stringify(["https://api.example.test", "viewer-b"]), "session-b");
    finish({ ok: false, reason: "unavailable" });
    await refused;
    expect(io.request).not.toHaveBeenCalled();
  });

  it("leaves metadata, timestamp windows and large export windows on the existing reader", async () => {
    for (const [op, params] of [["chats.list", {}], ["messages.window", { chatId: "chat", limit: 200, before: 1 }],
      ["messages.window", { chatId: "chat", limit: 1000 }]] as const) await readCloudV2History(target, op, params);
    expect(io.request).toHaveBeenCalledTimes(3);
    expect(io.invoke.mock.calls.some(([, input]) => input.op === "refresh")).toBe(false);
  });

  it.each([
    ["metadata", "chats.list", {}],
    ["timestamp window", "messages.window", { chatId: "chat", limit: 200, before: 1 }],
    ["export window", "messages.window", { chatId: "chat", limit: 1000 }],
  ] as const)("fences the %s fallback when the viewing account changes before dispatch", async (_name, op, params) => {
    const reading = readCloudV2History(target, op, params);
    const refused = expect(reading).rejects.toMatchObject({ reason: "owner_changed" });
    expect(io.request).not.toHaveBeenCalled();
    nativeCloudChatCache.bindOwner(JSON.stringify(["https://api.example.test", "viewer-b"]), "session-b");
    await refused;
    expect(io.request).not.toHaveBeenCalled();
  });
});
