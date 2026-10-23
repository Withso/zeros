import { afterEach, expect, it, vi } from "vitest";
import { RuntimeClient } from "@/renderer/platform/bridge/ws-client";
import { WorkspaceRuntimeClient } from "@/renderer/platform/bridge/workspace-runtime-client";
import { subscribeChatSnapshots } from "@/renderer/state/chat-snapshot-subscription";
import { classifyRpcError } from "@/renderer/platform/bridge/failure";
import { bindFailureWasSuperseded } from "@/renderer/features/agent/session-reload-lifecycle";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => vi.restoreAllMocks());

it.each(["chats.list", "workspace.list"] as const)(
  "%s cancels a cold read retired by startup or restart without a terminal chat failure",
  async op => {
    const field = op === "chats.list" ? "chats" : "workspaces";
    for (const folder of ["/personal/project", "/organization/project"]) {
      for (const restart of [false, true]) {
        let finish!: (value: never) => void;
        const request = vi.spyOn(RuntimeClient.prototype, "request").mockImplementationOnce(
          () => new Promise(resolve => { finish = resolve; }),
        );
        const open = vi.fn();
        const bridge = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
        const setStatus = (status: "connected" | "disconnected") =>
          (bridge as unknown as { setStatus(status: string): void }).setStatus(status);
        const read = () => bridge.request({ type: "WORKSPACE_REQUEST", op });
        try {
          if (restart) setStatus("connected");
          const pending = read().catch(error => classifyRpcError({ agentId: "claude", stage: "loadSession", error }));
          if (restart) setStatus("disconnected");
          setStatus("connected");
          finish({ type: "WORKSPACE_RESPONSE", op, result: { [field]: [{ id: "obsolete", folder, path: folder }] } } as never);
          const failure = await pending;
          expect(failure).toMatchObject({ kind: "lifecycle-superseded", stage: "loadSession" });
          expect(bindFailureWasSuperseded(failure as ReturnType<typeof classifyRpcError>)).toBe(true);
          // The next bind can obtain fresh ownership; the retired response is
          // neither cached nor mistaken for confirmed emptiness.
          request.mockResolvedValue({ type: "WORKSPACE_RESPONSE", op,
            result: { [field]: [{ id: "current", folder, path: folder }] } } as never);
          expect(await read()).toMatchObject({ result: { [field]: [{ id: "current" }] } });
          expect(request).toHaveBeenCalledTimes(2);
          expect(open).not.toHaveBeenCalled();
        } finally { bridge.dispose(); request.mockRestore(); }
      }
    }
  },
);

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

it("still publishes confirmed cloud workspaces across a Local startup transition", async () => {
  let finish!: (value: never) => void;
  vi.spyOn(RuntimeClient.prototype, "request").mockImplementationOnce(
    () => new Promise(resolve => { finish = resolve; }),
  );
  const row = { id: "cloud-workspace", path: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", repoSlug: "cloud" };
  const open = vi.fn();
  const bridge = new WorkspaceRuntimeClient({ open, workspaces: () => [row], workspacesConfirmed: () => true });
  try {
    const pending = bridge.request({ type: "WORKSPACE_REQUEST", op: "workspace.list" });
    (bridge as unknown as { setStatus(status: string): void }).setStatus("connected");
    finish({ type: "WORKSPACE_RESPONSE", op: "workspace.list", result: { workspaces: [{ id: "obsolete-local" }] } } as never);
    expect(await pending).toMatchObject({ result: { workspaces: [row], confirmedLocalWorkspaces: false, confirmedCloudWorkspaces: true } });
    expect(open).not.toHaveBeenCalled();
  } finally { bridge.dispose(); }
});

it("preserves a real read failure when Local ownership has not changed", async () => {
  const error = new Error("Workspace database read failed");
  vi.spyOn(RuntimeClient.prototype, "request").mockRejectedValue(error);
  const bridge = new WorkspaceRuntimeClient({ open: vi.fn(), workspaces: () => [] });
  try {
    await expect(bridge.request({ type: "WORKSPACE_REQUEST", op: "workspace.list" })).rejects.toBe(error);
  } finally { bridge.dispose(); }
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
      historyRoot: () => "/home/user/Owner/repo",
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
