import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient } from "../ws-client";
import {
  WorkspaceRuntimeClient,
  type CloudPeer,
} from "../workspace-runtime-client";
import {
  cloudScopedId,
  cloudWorkspaceKey,
  type CloudWorkspaceTarget,
} from "../cloud-workspace-key";
import type { BridgeMessage } from "../messages";
import {
  bridgePtyCreate,
  bridgePtyTerminals,
  bridgePtyWrite,
  bridgePtyResize,
  bridgePtyKill,
  subscribeBridgePtyData,
  subscribeBridgePtyExit,
} from "../pty-bridge";

const organizationId = "11111111-1111-4111-8111-111111111111";
const a = {
  organizationId,
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const b = {
  organizationId,
  workspaceId: "33333333-3333-4333-8333-333333333333",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fakePeer(target: CloudWorkspaceTarget) {
  const handlers = new Map<string, Set<(message: BridgeMessage) => void>>();
  const request = vi.fn(
    async (
      message: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => ({
      type: "WORKSPACE_RESPONSE",
      op: message.op,
      result:
        message.op === "chats.list"
          ? { chats: [], chatDeletions: [] }
          : { target: target.workspaceId },
    }),
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

describe("workspace runtime routing", () => {
  it("isolates terminal discovery, shells, input, output, resize and close across identical cloud roots", async () => {
    const local = vi.spyOn(RuntimeClient.prototype, "request");
    const pa = fakePeer(a),
      pb = fakePeer(b);
    for (const peer of [pa, pb]) {
      peer.request.mockImplementation(async (message) => {
        if (message.type === "PTY_LIST")
          return {
            type: "PTY_LIST_RESULT",
            terminals: [
              {
                sessionId: "shell",
                cwd: "/workspace/repo",
                workspaceId: "local-main",
                createdAt: 1,
              },
            ],
          };
        if (message.type === "PTY_CREATE")
          return {
            ...message,
            type: "PTY_CREATED",
            pid: 42,
            reattached: true,
            replay: "remote output",
          };
        return {
          type: "WORKSPACE_RESPONSE",
          result: { chats: [], chatDeletions: [] },
        };
      });
    }
    const client = new WorkspaceRuntimeClient({
      open: async (target) =>
        target.workspaceId === a.workspaceId ? pa.peer : pb.peer,
      workspaces: () => [],
    });
    const data = vi.fn(),
      exit = vi.fn();
    subscribeBridgePtyData(client, data);
    subscribeBridgePtyExit(client, exit);
    for (const target of [a, b]) {
      const folder = cloudWorkspaceKey(target),
        sessionId = cloudScopedId(target, "shell");
      const terminals = await bridgePtyTerminals(client, folder);
      expect(terminals).toEqual([
        { sessionId, cwd: folder, workspaceId: folder, createdAt: 1 },
      ]);
      expect(
        await bridgePtyCreate(client, {
          sessionId,
          cwd: folder,
          cols: 80,
          rows: 24,
        }),
      ).toMatchObject({ sessionId, cwd: folder, reattached: true });
    }
    expect(pa.request).toHaveBeenCalledWith(
      expect.objectContaining({ type: "PTY_LIST", workspaceId: "local-main" }),
      10_000,
    );
    expect(pb.request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PTY_CREATE",
        sessionId: "shell",
        cwd: "/workspace/repo",
      }),
      10_000,
    );
    bridgePtyWrite(client, {
      sessionId: cloudScopedId(a, "shell"),
      data: "pwd\r",
    });
    bridgePtyResize(client, {
      sessionId: cloudScopedId(a, "shell"),
      cols: 120,
      rows: 40,
    });
    bridgePtyKill(client, { sessionId: cloudScopedId(b, "shell") });
    expect(pa.send.mock.calls.map(([message]) => message)).toEqual([
      { type: "PTY_WRITE", sessionId: "shell", data: "pwd\r" },
      { type: "PTY_RESIZE", sessionId: "shell", cols: 120, rows: 40 },
    ]);
    expect(pb.send).toHaveBeenCalledExactlyOnceWith({
      type: "PTY_KILL",
      sessionId: "shell",
    });
    pa.emit("PTY_DATA", { sessionId: "shell", data: "output A" });
    pb.emit("PTY_DATA", { sessionId: "shell", data: "output B" });
    pb.emit("PTY_EXIT", { sessionId: "shell", exitCode: 0, signal: null });
    expect(data.mock.calls.map(([event]) => event)).toEqual([
      { sessionId: cloudScopedId(a, "shell"), data: "output A" },
      { sessionId: cloudScopedId(b, "shell"), data: "output B" },
    ]);
    expect(exit).toHaveBeenCalledWith({
      sessionId: cloudScopedId(b, "shell"),
      exitCode: 0,
      signal: null,
    });
    expect(local).not.toHaveBeenCalled();
    await expect(
      client.request({
        type: "PTY_CREATE",
        sessionId: cloudScopedId(a, "shell"),
        cwd: cloudWorkspaceKey(b),
      }),
    ).rejects.toThrow(/cross cloud workspace boundaries/);
    client.dispose();
  });

  it("keeps local operations local and isolates two identical cloud checkouts", async () => {
    const local = vi
      .spyOn(RuntimeClient.prototype, "request")
      .mockResolvedValue({
        type: "WORKSPACE_RESPONSE",
        op: "file.read",
        result: { local: true },
      } as BridgeMessage);
    const pa = fakePeer(a),
      pb = fakePeer(b);
    const open = vi.fn(async (target: CloudWorkspaceTarget) =>
      target.workspaceId === a.workspaceId ? pa.peer : pb.peer,
    );
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [] });
    await Promise.all(
      [a, b, a].map((target) =>
        client.request({
          type: "WORKSPACE_REQUEST",
          op: "file.read",
          params: { workspaceId: cloudWorkspaceKey(target), path: "same.ts" },
        }),
      ),
    );
    expect(open).toHaveBeenCalledTimes(2);
    expect(local).not.toHaveBeenCalled();
    expect(pa.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: { workspaceId: "local-main", path: "same.ts" },
      }),
      5000,
    );
    await client.request({
      type: "WORKSPACE_REQUEST",
      op: "git.status",
      params: { workspaceId: "ws_local" },
    });
    expect(local).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("streams both runtimes and sends Stop to the captured execution", async () => {
    const pa = fakePeer(a),
      pb = fakePeer(b);
    const client = new WorkspaceRuntimeClient({
      open: async (target) =>
        target.workspaceId === a.workspaceId ? pa.peer : pb.peer,
      workspaces: () => [],
    });
    const updates = vi.fn();
    const off = client.on("AGENT_SESSION_UPDATE", updates);
    await Promise.all([client.warmWorkspace(a), client.warmWorkspace(b)]);
    pa.emit("AGENT_SESSION_UPDATE", {
      sessionId: "run",
      update: { text: "A" },
    });
    pb.emit("AGENT_SESSION_UPDATE", {
      sessionId: "run",
      update: { text: "B" },
    });
    expect(updates.mock.calls.map(([event]) => event.sessionId)).toEqual([
      cloudScopedId(a, "run"),
      cloudScopedId(b, "run"),
    ]);
    client.send({
      type: "AGENT_CANCEL",
      agentId: "codex",
      sessionId: cloudScopedId(a, "run"),
    });
    expect(pa.send).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "run" }),
    );
    expect(pb.send).not.toHaveBeenCalled();
    off();
    client.dispose();
  });

  it("closes late connections after sign-out and never dispatches their pending write", async () => {
    const wait = deferred<CloudPeer>();
    const pa = fakePeer(a);
    const client = new WorkspaceRuntimeClient({
      open: () => wait.promise,
      workspaces: () => [],
    });
    const request = client.request({
      type: "WORKSPACE_REQUEST",
      op: "git.stage",
      params: { workspaceId: cloudWorkspaceKey(a), paths: ["a"] },
    });
    const rejected = expect(request).rejects.toThrow(/account changed/);
    client.clearCloudConnections();
    wait.resolve(pa.peer);
    await rejected;
    expect(pa.request).not.toHaveBeenCalled();
    expect(pa.release).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("reads cloud tombstones before accepting cached chat writes", async () => {
    const pa = fakePeer(a);
    pa.request.mockImplementation(async (message) => ({
      type: "WORKSPACE_RESPONSE",
      op: message.op,
      result:
        message.op === "chats.list"
          ? {
              chats: [
                { id: "newer", folder: "/workspace/repo", updatedAt: 30 },
              ],
              chatDeletions: ["gone"],
            }
          : { target: a.workspaceId },
    }));
    const client = new WorkspaceRuntimeClient({
      open: async () => pa.peer,
      workspaces: () => [],
    });
    const row = (id: string, updatedAt: number) => ({
      id: cloudScopedId(a, id),
      folder: cloudWorkspaceKey(a),
      updatedAt,
    });
    await client.request({
      type: "WORKSPACE_REQUEST",
      op: "chats.bulkUpsert",
      params: { chats: [row("gone", 50), row("newer", 20), row("fresh", 10)] },
    });
    expect(pa.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: {
          chats: [{ id: "fresh", folder: "/workspace/repo", updatedAt: 10 }],
        },
      }),
      5000,
    );
    client.dispose();
  });

  it("rejects a response from a retired runtime even if the account is unchanged", async () => {
    const pa = fakePeer(a);
    pa.peer.runtimeId = "old-runtime";
    const client = new WorkspaceRuntimeClient({
      open: async () => pa.peer,
      workspaces: () => [],
    });
    await client.warmWorkspace(a);
    const wait = deferred<Record<string, unknown>>();
    pa.request.mockImplementationOnce(() => wait.promise);
    const request = client.request({
      type: "WORKSPACE_REQUEST",
      op: "file.read",
      params: { workspaceId: cloudWorkspaceKey(a), path: "same.ts" },
    });
    const rejected = expect(request).rejects.toThrow(/connection changed/);
    await vi.waitFor(() => expect(pa.request).toHaveBeenCalledTimes(2));
    client.retireCloudRuntime("old-runtime");
    wait.resolve({
      type: "WORKSPACE_RESPONSE",
      op: "file.read",
      result: { content: "obsolete" },
    });
    await rejected;
    client.dispose();
  });
});
