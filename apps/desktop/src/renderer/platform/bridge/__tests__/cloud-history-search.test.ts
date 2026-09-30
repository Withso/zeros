import { describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient } from "../workspace-runtime-client";
import { cloudScopedId, cloudWorkspaceKey } from "../cloud-workspace-key";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
describe("stopped workspace search routing", () => {
  it("shares exact-key searches without opening or waking a VM", async () => {
    const open = vi.fn(async () => { throw new Error("VM must stay stopped"); });
    const readHistory = vi.fn(async () => ({ hits: [{ chatId: cloudScopedId(target, "chat"), msgId: "saved" }] }));
    const client = new WorkspaceRuntimeClient({ open, readHistory, workspaces: () => [] });
    try {
      const request = { type: "WORKSPACE_REQUEST" as const, op: "messages.search", params: { folder: cloudWorkspaceKey(target), query: "saved" } };
      const [a, b] = await Promise.all([client.request(request), client.request(request)]);
      expect(a).toMatchObject({ result: { hits: [{ msgId: "saved" }] } });
      expect(a).toEqual(b);
      expect(readHistory).toHaveBeenCalledOnce();
      expect(open).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });
  it("discards an in-flight search after account replacement", async () => {
    let release!: (value: Record<string, unknown>) => void;
    const readHistory = vi.fn(() => new Promise<Record<string, unknown>>(resolve => { release = resolve; }));
    const open = vi.fn(async () => { throw new Error("VM must stay stopped"); });
    const client = new WorkspaceRuntimeClient({ open, readHistory, workspaces: () => [] });
    try {
      const result = client.request({ type: "WORKSPACE_REQUEST", op: "messages.search", params: { chatId: cloudScopedId(target, "chat"), query: "saved" } });
      const rejected = expect(result).rejects.toThrow(/changed|retired|closed/i);
      await vi.waitFor(() => expect(readHistory).toHaveBeenCalledOnce());
      client.dispose();
      release({ hits: [] });
      await rejected;
      expect(open).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });
});
