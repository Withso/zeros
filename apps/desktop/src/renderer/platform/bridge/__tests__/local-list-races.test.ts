import { afterEach, expect, it, vi } from "vitest";
import { RuntimeClient } from "@/renderer/platform/bridge/ws-client";
import { WorkspaceRuntimeClient } from "@/renderer/platform/bridge/workspace-runtime-client";
import { subscribeChatSnapshots } from "@/renderer/state/chat-snapshot-subscription";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => vi.restoreAllMocks());

it("a Local DB change during a pending list requires a successor read before publishing confirmation", async () => {
  const old = {
    type: "WORKSPACE_RESPONSE",
    op: "chats.list",
    result: {
      chats: [{ id: "local-chat", folder: "/local", title: "Old" }],
      chatDeletions: [],
    },
  };
  const fresh = {
    type: "WORKSPACE_RESPONSE",
    op: "chats.list",
    result: {
      chats: [],
      chatDeletions: ["local-chat"],
    },
  };
  const request = vi
    .spyOn(RuntimeClient.prototype, "request")
    .mockResolvedValue(old as never);
  const bridge = new WorkspaceRuntimeClient({
    open: vi.fn(),
    workspaces: () => [],
  });
  (bridge as any).setStatus("connected");
  const snapshots: any[] = [];
  const off = subscribeChatSnapshots({
    bridge,
    onSnapshot: (s) => snapshots.push(s),
    onError: vi.fn(),
    onLocalReadinessChange: vi.fn(),
  });
  const emit = () =>
    (bridge as any).handleIncoming({ type: "DB_CHANGED", kinds: ["chats"] });
  try {
    await flush();
    expect(snapshots.at(-1).chats[0].id).toBe("local-chat");
    let finish!: (value: any) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    request.mockResolvedValue(fresh as never);
    emit(); // An ordinary refresh starts and captures the old database contents.
    await flush();
    emit(); // The chat is deleted while that response is delayed in transit.
    finish(old);
    await flush();
    await flush();
    expect(snapshots.at(-1).confirmedLocalChats).not.toBe(false);
    expect(snapshots.at(-1)).toMatchObject({
      chats: [],
      chatDeletions: ["local-chat"],
    });
  } finally {
    off();
    bridge.dispose();
  }
});

it.each([
  ["chats.list", "chats", "confirmedLocalChats"],
  ["workspace.list", "workspaces", "confirmedLocalWorkspaces"],
] as const)(
  "%s retains its confirmed snapshot and coalesces mutation bursts into one successor",
  async (op, field, confirmation) => {
    const target = {
      organizationId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
    };
    const row = {
      id: "local-old",
      folder: "/local",
      path: "/local",
      repoSlug: "local",
    };
    const response = (rows: unknown[]) => ({
      type: "WORKSPACE_RESPONSE",
      op,
      result: { [field]: rows },
    });
    const request = vi
      .spyOn(RuntimeClient.prototype, "request")
      .mockResolvedValue(response([row]) as never);
    const bridge = new WorkspaceRuntimeClient({
      open: vi.fn(),
      workspaces: () => [{ id: "cloud", path: "cloud", repoSlug: "cloud" }],
      readHistory: async () => ({ chats: [], chatDeletions: [], revision: 1 }),
    });
    const read = () =>
      bridge.request({
        type: "WORKSPACE_REQUEST",
        op,
        params: {},
      } as never) as Promise<{ result: Record<string, unknown> }>;
    const emit = (kinds: string[]) =>
      (
        bridge as unknown as { handleIncoming: (event: unknown) => void }
      ).handleIncoming({ type: "DB_CHANGED", kinds });
    try {
      await bridge.warmHistoryWorkspace(target);
      await read();
      await flush();
      let finishOld!: (value: never) => void;
      let finishNew!: (value: never) => void;
      request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      );
      request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNew = resolve;
          }),
      );
      const retained = (await read()).result[field];
      expect(retained).toContainEqual(row);
      for (let i = 0; i < 4; i++) {
        emit([field]);
        await read();
      }
      expect(request).toHaveBeenCalledTimes(2);
      finishOld(response([{ ...row, id: "obsolete-response" }]) as never);
      await flush();
      expect(request).toHaveBeenCalledTimes(3);
      const pending = (await read()).result;
      expect(pending[field]).toContainEqual(row);
      expect(pending[confirmation]).toBe(false);
      finishNew(response([]) as never);
      await flush();
      // A cloud publication consumes the retained aggregate while its own Local
      // completion notification must not invalidate or queue a fourth read.
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      bridge.dispose();
    }
  },
);
