import { describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient } from "../workspace-runtime-client";
import { cloudScopedId, cloudWorkspaceKey } from "../cloud-workspace-key";

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
