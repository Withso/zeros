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
  ])("is unavailable for a %s-scoped cloud search without opening, waking or reading the mirror", async (_scope, params) => {
    const open = vi.fn(async () => { throw new Error("VM must stay stopped"); });
    const readHistory = vi.fn(async () => ({ hits: [] }));
    const client = new WorkspaceRuntimeClient({ open, readHistory, historyRoot: () => "/home/user/Owner/repo", workspaces: () => [] });
    try {
      await expect(client.request({ type: "WORKSPACE_REQUEST", op: "messages.search", params })).rejects
        .toMatchObject({ code: "CLOUD_V2_UNSUPPORTED", message: expect.stringMatching(/isn't available in cloud/) });
      expect(readHistory).not.toHaveBeenCalled();
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
