import { afterEach, expect, it, vi } from "vitest";
import { subscribeChatSnapshots } from "../chat-snapshot-subscription";
import { reconcileChatSnapshot } from "../chat-reconciliation";
import { sanitizeCachedChat } from "../chat-boot-cache";
import { WorkspaceRuntimeClient } from "../../platform/bridge/workspace-runtime-client";
import { RuntimeClient } from "../../platform/bridge/ws-client";
import {
  cloudScopedId,
  cloudWorkspaceKey,
} from "../../platform/bridge/cloud-workspace-key";
const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const folder = cloudWorkspaceKey(target);
const local = sanitizeCachedChat({ id: "local", folder: "/local" })!;
const remote = sanitizeCachedChat({
  id: cloudScopedId(target, "saved"),
  folder,
})!;
afterEach(() => vi.restoreAllMocks());
it("chat persistence subscribes before Local is ready and merges a later confirmed cloud snapshot", async () => {
  vi.spyOn(RuntimeClient.prototype, "request").mockRejectedValue(
    new Error("Local engine disconnected"),
  );
  const bridge = new WorkspaceRuntimeClient({
    open: vi.fn(),
    workspaces: () => [],
    readHistory: async () => ({ chats: [remote], chatDeletions: [] }),
  });
  let chats = [local];
  const onSnapshot = vi.fn((snapshot) => {
    chats = reconcileChatSnapshot(
      chats,
      snapshot.chats,
      snapshot.chatDeletions,
      snapshot.confirmedCloudWorkspaces,
      snapshot.confirmedLocalChats,
    ).chats;
  });
  const off = subscribeChatSnapshots({
    bridge,
    onSnapshot,
    onError: vi.fn(),
    onLocalReadinessChange: vi.fn(),
  });
  try {
    await bridge.warmHistoryWorkspace(target);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chats).toEqual([local, remote]);
    expect(onSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmedLocalChats: false,
        confirmedCloudWorkspaces: [folder],
      }),
    );
  } finally {
    off();
    bridge.dispose();
  }
});
it("a cloud-only snapshot cannot mirror an unconfirmed Local boot row", () => {
  const result = reconcileChatSnapshot([local], [remote], [], [folder], false);
  expect(result.chats).toEqual([local, remote]);
  expect(result.rowsToPush).toEqual([]);
});
it("Local restart and recovery publish independently while preserving confirmed cloud history", async () => {
  const request = vi
    .spyOn(RuntimeClient.prototype, "request")
    .mockResolvedValue({
      type: "WORKSPACE_RESPONSE",
      result: { chats: [local], chatDeletions: [] },
    } as never);
  let now = 1000,
    revision = 1;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const bridge = new WorkspaceRuntimeClient({
    open: vi.fn(),
    workspaces: () => [],
    readHistory: async () => ({
      revision,
      chats: [{ ...remote, title: `Revision ${revision}` }],
      chatDeletions: [],
    }),
  });
  const status = (next: "connected" | "disconnected") =>
    (bridge as unknown as { setStatus: (next: string) => void }).setStatus(
      next,
    );
  status("connected");
  await bridge.warmHistoryWorkspace(target);
  const onSnapshot = vi.fn();
  const readiness = vi.fn();
  const off = subscribeChatSnapshots({
    bridge,
    onSnapshot,
    onLocalReadinessChange: readiness,
    onError: vi.fn(),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSnapshot.mock.lastCall?.[0]).toMatchObject({
      confirmedLocalChats: true,
      chats: [{ id: local.id }, { id: remote.id, title: "Revision 1" }],
    });
    status("disconnected");
    request.mockRejectedValue(new Error("Restarting"));
    now += 2000;
    revision++;
    await bridge.warmHistoryWorkspace(target);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readiness).toHaveBeenCalledOnce();
    expect(onSnapshot.mock.lastCall?.[0]).toMatchObject({
      confirmedLocalChats: false,
      chats: [{ id: local.id }, { id: remote.id, title: "Revision 2" }],
    });
    request.mockResolvedValue({
      type: "WORKSPACE_RESPONSE",
      result: { chats: [], chatDeletions: [local.id] },
    } as never);
    status("connected");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSnapshot.mock.lastCall?.[0]).toMatchObject({
      confirmedLocalChats: true,
      chats: [{ id: remote.id, title: "Revision 2" }],
      chatDeletions: [local.id],
    });
  } finally {
    off();
    bridge.dispose();
  }
});
