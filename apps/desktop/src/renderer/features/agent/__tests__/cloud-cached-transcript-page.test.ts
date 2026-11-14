import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeCloudChatCacheClient } from "../../../platform/cloud-chat-cache-client";
import { cachedWindowOlderMessages } from "../cloud-cached-transcript-page";
import type { CloudCacheRequest } from "../../../../../shared/cloud-chat-cache";

const boundary = vi.hoisted(() => ({ native: undefined as unknown as NativeCloudChatCacheClient }));
vi.mock("../../../platform/cloud-chat-cache", () => ({ get nativeCloudChatCache() { return boundary.native; } }));
const owner = JSON.stringify(["https://api.example.test", "viewer-a"]);
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const chatId = `cloud:${target.organizationId}:${target.workspaceId}:chat`;
const message = { id: "older", kind: "text" as const, role: "agent" as const, text: "Earlier answer", createdAt: 2 };
const opening = { ...message, id: "opening", role: "user", text: "Earlier question", createdAt: 1 };
const envelope = (value: typeof message | typeof opening) => ({ msgId: value.id, kind: value.kind, payload: JSON.stringify(value), createdAt: value.createdAt });
const range = { revision: 8, messageCount: 3, fromIndex: 1, toIndex: 2, rows: [{ ...envelope(message), index: 1 }], turnOpening: envelope(opening) };
let invoke: ReturnType<typeof vi.fn<(input: CloudCacheRequest) => Promise<unknown>>>;
const marker = () => ({ owner, epoch: boundary.native.epoch, revision: 8 });
beforeEach(() => {
  invoke = vi.fn(async input => input.op === "bind" ? { ok: true, result: { lease: "33333333-3333-4333-8333-333333333333" } }
    : { ok: true, result: input.op === "read-before" ? range : null });
  boundary.native = new NativeCloudChatCacheClient({ invoke }); boundary.native.bindOwner(owner, "sign-in-a");
});

describe("cached-only older transcript windows", () => {
  it("preserves the native opening and cached revision using only a disk read", async () => {
    const cached = marker();
    expect(await cachedWindowOlderMessages(chatId, 200, "tail", cached)).toMatchObject({ messages: [message], leadingPrompt: opening, cloudCache: cached });
    expect(invoke.mock.calls.map(([input]) => input.op)).toEqual(["bind", "read-before"]);
    expect(invoke.mock.calls[1][0]).toMatchObject({ target: { ...target, chatId: "chat" } });
  });
  it("never sends a Local chat or an old owner lifetime to main", async () => {
    await expect(cachedWindowOlderMessages("local-chat", 200, "tail", marker())).rejects.toThrow();
    await expect(cachedWindowOlderMessages(chatId, 200, "tail", { ...marker(), epoch: 0 })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("cannot publish an old cached page after an A to B to A account switch", async () => {
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation(async input => input.op === "bind" ? { ok: true, result: { lease: "33333333-3333-4333-8333-333333333333" } }
      : input.op === "read-before" ? new Promise(done => { resolve = done; }) : { ok: true, result: null });
    const page = cachedWindowOlderMessages(chatId, 200, "tail", marker());
    const result = page.then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    boundary.native.bindOwner("other", "sign-in-b"); boundary.native.bindOwner(owner, "sign-in-a");
    resolve({ ok: true, result: range });
    expect(await result).toMatchObject({ error: { reason: "owner_changed" } });
  });
  it("leaves a missing or malformed saved range unavailable without a network fallback", async () => {
    invoke.mockImplementation(async input => input.op === "bind" ? { ok: true, result: { lease: "33333333-3333-4333-8333-333333333333" } }
      : { ok: true, result: { ...range, revision: 9 } });
    expect(await cachedWindowOlderMessages(chatId, 200, "tail", marker())).toBeNull();
    expect(invoke.mock.calls.map(([input]) => input.op)).toEqual(["bind", "read-before"]);
  });
});
