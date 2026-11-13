import { describe, expect, it, vi } from "vitest";
import { ControlPlaneCloudChatCacheSource } from "../cloud-chat-cache/source";
import { CloudCacheAccessLost, CloudCacheUnsupported, type CloudCacheRequestContext } from "../cloud-chat-cache/service";
import type { CloudCacheKey } from "../../shared/cloud-chat-cache";
import type { CloudV2PromptStatus } from "@zeros/protocol/cloud-v2-prompts";

const key: CloudCacheKey = { owner: JSON.stringify(["https://api.example.test", "viewer-a"]),
  organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", chatId: "chat" };
const page = { revision: 3, messageCount: 0, fromIndex: 0, toIndex: 0, rows: [] };
function item(sequence: string): CloudV2PromptStatus {
  const id = `prompt-${sequence}`;
  return { receipt: { workspaceId: key.workspaceId, chatId: key.chatId, userMessageId: id, sequence, epoch: "2",
    acceptedAt: "2026-11-12T12:00:00.000Z", workspaceState: "stopped" }, state: "queued", cancelRequested: false,
    payload: { chatId: key.chatId, userMessageId: id, agentId: "codex", prompt: [{ type: "text", text: "fixture prompt" }], startedAt: 1 } };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function setup() {
  let current = true;
  const request = vi.fn<typeof fetch>();
  const session = vi.fn(async () => ({ accountId: "viewer-a", sessionId: "session-a", accessToken: "fixture-bearer" }));
  const context: CloudCacheRequestContext = { session: "session-a", signal: new AbortController().signal,
    current: () => { if (!current) throw new Error("changed"); } };
  const wait = vi.fn(async () => {});
  const source = new ControlPlaneCloudChatCacheSource({ baseUrl: "https://api.example.test/", session, fetch: request, wait });
  return { source, request, session, context, wait, retire: () => { current = false; } };
}

describe("passive native cloud cache transport", () => {
  it("uses the exact viewer session and history shape without sync, device or wake routes", async () => {
    const f = setup();
    f.request.mockResolvedValueOnce(json({ workspace: { id: key.workspaceId, organizationId: key.organizationId } }))
      .mockResolvedValueOnce(json({ result: page }))
      .mockResolvedValueOnce(json({ result: { resync: false, fromRevision: 3, revision: 3, messageCount: 0, rows: [] } }));
    expect(await f.source.workspace(key, f.context)).toEqual({ id: key.workspaceId, organizationId: key.organizationId });
    expect(await f.source.range(key, 0, 0, f.context)).toEqual(page);
    await f.source.since(key, 3, f.context);
    expect(f.request.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/v1/cloud-v2/workspaces/${key.workspaceId}`, `/v1/cloud-v2/workspaces/${key.workspaceId}/history`, `/v1/cloud-v2/workspaces/${key.workspaceId}/history`,
    ]);
    for (const [, init] of f.request.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-bearer");
      expect(new Headers(init?.headers).get("x-zeros-team-sharing")).toBe("1");
      expect(new Headers(init?.headers).has("x-zeros-sync")).toBe(false);
      expect(new Headers(init?.headers).has("x-zeros-device-id")).toBe(false);
      expect(init?.redirect).toBe("error");
    }
    expect(JSON.parse(f.request.mock.calls[1][1]!.body as string)).toEqual({ op: "messages.range", params: { chatId: "chat", fromIndex: 0, toIndex: 0 } });
    expect(JSON.parse(f.request.mock.calls[2][1]!.body as string)).toEqual({ op: "messages.since", params: { chatId: "chat", revision: 3 } });
  });

  it("rejects a token for another account or session before issuing a request", async () => {
    const f = setup();
    f.session.mockResolvedValueOnce({ accountId: "viewer-b", sessionId: "session-a", accessToken: "fixture-other" });
    await expect(f.source.range(key, 0, 0, f.context)).rejects.toThrow();
    f.session.mockResolvedValueOnce({ accountId: "viewer-a", sessionId: "session-b", accessToken: "fixture-other" });
    await expect(f.source.range(key, 0, 0, f.context)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rechecks the owner after token acquisition and after reading a reply", async () => {
    const f = setup();
    f.session.mockImplementationOnce(async () => { f.retire(); return { accountId: "viewer-a", sessionId: "session-a", accessToken: "fixture-bearer" }; });
    await expect(f.source.range(key, 0, 0, f.context)).rejects.toThrow("changed");
    expect(f.request).not.toHaveBeenCalled();
    const g = setup();
    g.request.mockImplementationOnce(async () => { g.retire(); return json({ result: page }); });
    await expect(g.source.range(key, 0, 0, g.context)).rejects.toThrow("changed");
  });

  it("recognizes the old history server without fabricating a revision", async () => {
    const f = setup();
    f.request.mockResolvedValueOnce(json({ error: { code: "invalid_request" } }, 400));
    await expect(f.source.range(key, 0, 0, f.context)).rejects.toBeInstanceOf(CloudCacheUnsupported);
  });

  it("separates confirmed access loss from a transient failure", async () => {
    const f = setup();
    f.request.mockResolvedValueOnce(json({}, 403));
    await expect(f.source.range(key, 0, 0, f.context)).rejects.toBeInstanceOf(CloudCacheAccessLost);
    f.request.mockResolvedValueOnce(json({}, 503));
    await expect(f.source.range(key, 0, 0, f.context)).rejects.not.toBeInstanceOf(CloudCacheAccessLost);
  });

  it("still recognizes confirmed denial when its error body is unreadable", async () => {
    const f = setup();
    f.request.mockResolvedValueOnce(new Response("not-json", { status: 403 }));
    await expect(f.source.range(key, 0, 0, f.context)).rejects.toBeInstanceOf(CloudCacheAccessLost);
  });

  it("rejects an oversized body without waiting for the server to acknowledge cancellation", async () => {
    const f = setup();
    let release!: () => void, start!: () => void, settled = false;
    const cancelled = new Promise<void>(resolve => { start = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const body = new ReadableStream({ cancel: () => { start(); return held; } });
    f.request.mockResolvedValueOnce(new Response(body, { headers: { "content-length": String(64 * 1024 ** 2 + 1) } }));
    const response = f.source.range(key, 0, 0, f.context).then(() => {}, () => { settled = true; });
    try {
      await cancelled;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(true);
    } finally { release(); await response; }
  });

  it("collects a complete own-receipt snapshot with a pinned numeric queue revision", async () => {
    const f = setup();
    f.request.mockResolvedValueOnce(json({ epoch: "2", items: [item("1")], nextAfter: "1", queueRevision: 8 }))
      .mockResolvedValueOnce(json({ epoch: "2", items: [item("3")], nextAfter: null, queueRevision: 8 }));
    expect(await f.source.pending(key, f.context)).toEqual({ epoch: "2", queueRevision: 8, items: [item("1"), item("3")] });
    const [first, second] = f.request.mock.calls;
    expect(Object.fromEntries(new URL(String(first[0])).searchParams)).toEqual({ chatId: "chat", after: "0", limit: "100", includePayload: "true" });
    expect(Object.fromEntries(new URL(String(second[0])).searchParams)).toEqual({ chatId: "chat", after: "1", limit: "100", includePayload: "true", queueRevision: "8" });
    for (const [, init] of f.request.mock.calls) expect(new Headers(init?.headers).get("x-zeros-chat-cache")).toBe("1");
  });

  it("does not cache receipts when an old server ignores the own-receipt opt-in", async () => {
    const f = setup();
    f.request.mockResolvedValueOnce(json({ epoch: "2", items: [item("1")], nextAfter: null }));
    expect(await f.source.pending(key, f.context)).toBeNull();
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("discards an interrupted receipt snapshot and restarts at zero on queue_changed", async () => {
    const f = setup();
    f.request.mockResolvedValueOnce(json({ epoch: "2", items: [item("1")], nextAfter: "1", queueRevision: 8 }))
      .mockResolvedValueOnce(json({ error: { code: "queue_changed" } }, 409))
      .mockResolvedValueOnce(json({ epoch: "3", items: [item("3")], nextAfter: null, queueRevision: 9 }));
    expect(await f.source.pending(key, f.context)).toEqual({ epoch: "3", queueRevision: 9, items: [item("3")] });
    expect(new URL(String(f.request.mock.calls[2][0])).searchParams.get("after")).toBe("0");
    expect(new URL(String(f.request.mock.calls[2][0])).searchParams.has("queueRevision")).toBe(false);
    expect(f.wait).toHaveBeenCalledTimes(1);
  });

  it("bounds queue-change retries instead of looping during a busy turn", async () => {
    const f = setup();
    f.request.mockImplementation(async () => json({ error: { code: "queue_changed" } }, 409));
    await expect(f.source.pending(key, f.context)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.wait).toHaveBeenCalledTimes(2);
  });

  it("refuses mixed revisions, repeated cursors and foreign receipt scopes", async () => {
    for (const bad of [
      { epoch: "2", items: [item("3")], nextAfter: null, queueRevision: 9 },
      { epoch: "2", items: [item("3")], nextAfter: "1", queueRevision: 8 },
      { epoch: "2", items: [{ ...item("3"), receipt: { ...item("3").receipt, chatId: "other-chat" } }], nextAfter: null, queueRevision: 8 },
    ]) {
      const f = setup();
      f.request.mockResolvedValueOnce(json({ epoch: "2", items: [item("1")], nextAfter: "1", queueRevision: 8 }))
        .mockResolvedValueOnce(json(bad));
      await expect(f.source.pending(key, f.context)).rejects.toThrow();
    }
  });
});
