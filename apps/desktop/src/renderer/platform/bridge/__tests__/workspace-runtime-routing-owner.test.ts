import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient } from "../ws-client";
import { WorkspaceRuntimeClient, type CloudPeer } from "../workspace-runtime-client";
import { cloudWorkspaceKey, type CloudWorkspaceTarget } from "../cloud-workspace-key";
import type { BridgeMessage } from "../messages";

const a = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
function fakePeer(target: CloudWorkspaceTarget) {
  const handlers = new Map<string, Set<(message: BridgeMessage) => void>>();
  const request = vi.fn(
    async (
      message: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      return { type: "WORKSPACE_RESPONSE", op: message.op, result:
        message.op === "chats.list"
          ? { chats: [], chatDeletions: [] }
          : { target: target.workspaceId } };
    },
  );
  const send = vi.fn();
  const release = vi.fn();
  const client = {
    request,
    send,
    status: "connected",
    on: (type: string, fn: (message: BridgeMessage) => void) => {
      const set = handlers.get(type) ?? new Set();
      set.add(fn);
      handlers.set(type, set);
      return () => set.delete(fn);
    },
    onStatusChange: () => () => {},
  } as unknown as RuntimeClient;
  return {
    peer: {
      client,
      scope: {
        ...target,
        root: "/workspace/repo",
        engineWorkspaceId: "local-main",
      },
      release,
    } as CloudPeer,
    request,
    send,
    release,
    emit: (type: string, fields: object) => {
      for (const fn of handlers.get(type) ?? [])
        fn({ type, ...fields } as BridgeMessage);
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe("runtime routing with an organization selected (unified-workspaces)", () => {
  it("runs a Local workspace on this Mac and swaps to a cloud workspace without crossing state", async () => {
    const { setActiveOrganizationSelection } = await import("../../../features/team/active-team");
    setActiveOrganizationSelection(a.organizationId, false);
    const local = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue({
      type: "WORKSPACE_RESPONSE", op: "file.read", result: { local: true },
    } as BridgeMessage);
    const peer = fakePeer(a);
    const open = vi.fn(async () => peer.peer);
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
    try {
      for (const op of ["file.read", "git.status", "pty.list"])
        await client.request({ type: "WORKSPACE_REQUEST", op, params: { workspaceId: "ws_local" } });
      expect(local).toHaveBeenCalledTimes(3);
      expect(open).not.toHaveBeenCalled();
      await client.request({ type: "WORKSPACE_REQUEST", op: "file.read",
        params: { workspaceId: cloudWorkspaceKey(a), path: "same.ts" } });
      expect(open).toHaveBeenCalledOnce();
      expect(local).toHaveBeenCalledTimes(3);
      expect(peer.request).toHaveBeenLastCalledWith(
        expect.objectContaining({ params: { workspaceId: "local-main", path: "same.ts" } }), 5000);
      const peerCalls = peer.request.mock.calls.length;
      await client.request({ type: "WORKSPACE_REQUEST", op: "file.read", params: { workspaceId: "ws_local", path: "same.ts" } });
      expect(local).toHaveBeenCalledTimes(4);
      expect(local).toHaveBeenLastCalledWith(
        expect.objectContaining({ params: { workspaceId: "ws_local", path: "same.ts" } }), expect.anything());
      expect(peer.request).toHaveBeenCalledTimes(peerCalls);
      expect(peer.request.mock.calls.some(([message]) =>
        (message as { params?: { workspaceId?: string } }).params?.workspaceId === "ws_local")).toBe(false);
    } finally {
      client.dispose();
      setActiveOrganizationSelection(null, true);
    }
  });
});
