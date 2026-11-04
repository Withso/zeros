import { describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient } from "../workspace-runtime-client";
import { cloudScopedId, cloudWorkspaceKey } from "../cloud-workspace-key";
import { RuntimeClient } from "../ws-client";
import { createMessage } from "@zeros/protocol";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
describe("cloud workspace search", () => {
  it.each([
    ["folder", { folder: cloudWorkspaceKey(target), query: "saved" }],
    ["chat", { chatId: cloudScopedId(target, "chat"), query: "saved" }],
  ])("reads a %s-scoped cloud search from the mirror without opening or waking", async (_scope, params) => {
    const open = vi.fn(async () => { throw new Error("VM must stay stopped"); });
    const hit = { chatId: "chat", msgId: "native-message", payload: '{"text":"saved"}', createdAt: 1 };
    const readHistory = vi.fn(async () => ({ hits: [hit] }));
    const client = new WorkspaceRuntimeClient({ open, readHistory, historyRoot: () => "/home/user/Owner/repo", workspaces: () => [] });
    try {
      expect(await client.request({ type: "WORKSPACE_REQUEST", op: "messages.search", params })).toMatchObject({ result: { hits: [{ ...hit, chatId: cloudScopedId(target, "chat") }] } });
      expect(readHistory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(target), "messages.search", _scope === "folder"
        ? { folder: "/home/user/Owner/repo", query: "saved" } : { chatId: "chat", query: "saved" });
      expect(open).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });

  it("shares exact query flights and fences account A → B → A responses", async () => {
    let release!: (value: { hits: unknown[] }) => void;
    const pending = new Promise<{ hits: unknown[] }>(resolve => { release = resolve; });
    const readHistory = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ hits: [] }), open = vi.fn();
    let account = "A";
    const client = new WorkspaceRuntimeClient({ open, readHistory, identity: () => account, historyRoot: () => "/home/user/Owner/repo", workspaces: () => [] });
    const request = { type: "WORKSPACE_REQUEST" as const, op: "messages.search", params: { folder: cloudWorkspaceKey(target), query: "same" } };
    try {
      const old = Promise.allSettled([client.request(request), client.request(request)]);
      await vi.waitFor(() => expect(readHistory).toHaveBeenCalledOnce());
      account = "B"; client.clearCloudConnections();
      expect(await client.request(request)).toMatchObject({ result: { hits: [] } });
      account = "A"; client.clearCloudConnections();
      expect(await client.request(request)).toMatchObject({ result: { hits: [] } });
      release({ hits: [{ chatId: "old", msgId: "m", payload: "old account", createdAt: 1 }] });
      expect((await old).every(result => result.status === "rejected")).toBe(true);
      expect(readHistory).toHaveBeenCalledTimes(3);
      expect(open).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });
});

describe("Local search forwarding", () => {
  it.each(["/personal/local", "/organization/local"])("leaves %s search ownership and payload on the Local transport", async folder => {
    const hit = { chatId: "chat", msgId: "reply", payload: "{\"text\":\"old transcript\"}", createdAt: 1 };
    const request = createMessage({ type: "WORKSPACE_REQUEST", source: "browser", op: "messages.search",
      params: { folder, chatId: "chat", query: "old", limit: 20 } });
    const reply = createMessage({ type: "WORKSPACE_RESPONSE", source: "engine", requestId: request.id, op: "messages.search", result: { hits: [hit] } });
    const local = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue(reply), open = vi.fn(), readHistory = vi.fn();
    const client = new WorkspaceRuntimeClient({ open, readHistory, workspaces: () => [] });
    try {
      expect(await client.request(request, 3210)).toBe(reply);
      expect(local).toHaveBeenCalledWith(request, 3210);
      expect(open).not.toHaveBeenCalled();
      expect(readHistory).not.toHaveBeenCalled();
      expect(hit.chatId).toBe("chat");
    } finally { client.dispose(); local.mockRestore(); }
  });
});
