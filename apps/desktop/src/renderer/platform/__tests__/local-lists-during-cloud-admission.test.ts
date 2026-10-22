import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient } from "../bridge/ws-client";
import { WorkspaceRuntimeClient, type CloudPeer } from "../bridge/workspace-runtime-client";
import { cloudWorkspaceKey } from "../bridge/cloud-workspace-key";
import type { BridgeMessage } from "../bridge/messages";

describe("Local lists during a pending cloud admission", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  it.each(["/personal/local", "/organization/local"])("keeps %s routing, counts and order independent of a pending cloud admission", async folder => {
    const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
    const rows = [{ id: "local-a", folder: "/personal/local" }, { id: "local-b", folder: "/organization/local" }];
    const cloud = { id: "cloud", folder: cloudWorkspaceKey(target), placement: "cloud" };
    const local = vi.spyOn(RuntimeClient.prototype, "request").mockImplementation(async message => ({
      type: "WORKSPACE_RESPONSE", op: (message as { op?: string }).op,
      result: (message as { op?: string }).op === "workspace.list" ? { workspaces: rows } : { content: folder },
    } as BridgeMessage));
    let finish!: (peer: CloudPeer) => void;
    const opening = new Promise<CloudPeer>(resolve => { finish = resolve; });
    const open = vi.fn(async () => opening), release = vi.fn();
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [cloud], workspacesConfirmed: () => true });
    try {
      const read = () => client.request({ type: "WORKSPACE_REQUEST", op: "workspace.list", params: {} });
      const before = await read();
      expect((before as unknown as { result: { workspaces: unknown[] } }).result.workspaces).toEqual([...rows, cloud]);
      expect(open).not.toHaveBeenCalled();
      const pending = client.warmWorkspace(target).catch(() => {});
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      for (const cwd of [folder, folder === "/personal/local" ? "/organization/local" : "/personal/local", folder]) {
        await client.request({ type: "WORKSPACE_REQUEST", op: "file.read", params: { cwd, path: "README.md" } });
        expect((await read() as unknown as { result: { workspaces: unknown[] } }).result.workspaces).toEqual([...rows, cloud]);
      }
      expect(open).toHaveBeenCalledOnce();
      expect(client.executionIdentity).toMatchObject({ kind: "local" });
      expect(local.mock.calls.filter(([message]) => (message as { op?: string }).op === "file.read")).toHaveLength(3);
      client.dispose(); finish({ release } as unknown as CloudPeer); await pending;
      expect(release).toHaveBeenCalledOnce();
    } finally { client.dispose(); finish({ release } as unknown as CloudPeer); }
  });
});
