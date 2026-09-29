import { afterEach, expect, it, vi } from "vitest";
import { RuntimeClient } from "@/renderer/platform/bridge/ws-client";
import {
  WorkspaceRuntimeClient,
  type CloudPeer,
} from "@/renderer/platform/bridge/workspace-runtime-client";
import { setActiveBridge } from "@/renderer/platform/bridge/active-bridge";
import {
  cloudIncoming,
  cloudOutgoing,
} from "@/renderer/platform/bridge/cloud-runtime-wire";
import {
  cloudScopedId,
  cloudWorkspaceKey,
  type CloudWorkspaceTarget,
} from "@/renderer/platform/bridge/cloud-workspace-key";
import {
  bridgeTurnsReset,
  bridgeTurnsUndoReset,
} from "@/renderer/platform/bridge/workspace-bridge";
import { resolveReviewProvider } from "@/renderer/shell/pr/review-provider";
import {
  peekReviewLiveData,
  prefetchReviewLiveData,
} from "@/renderer/shell/workbench/tabs/review-data";

const scope = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  root: "/srv/zeros/workspace",
  engineWorkspaceId: "local-main",
};
const folder = cloudWorkspaceKey(scope);
const chatId = cloudScopedId(scope, "cloud-chat");
const clients: WorkspaceRuntimeClient[] = [];
function runtime() {
  const request = vi.fn(
    async (
      message: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => ({
      type: "WORKSPACE_RESPONSE",
      op: message.op,
      result:
        message.op === "chats.list"
          ? { chats: [], chatDeletions: [] }
          : // This is the real WorkspaceService's cloud projection, covered by
            // service.test.ts: "does not treat a cloud read credential ...".
            message.op === "gh.repoAccess"
            ? { state: "unknown" }
            : message.op === "gh.prGet"
              ? { number: 12, title: "Cloud PR" }
              : message.op === "turns.reset"
                ? {
                    resetId: "cloud-reset",
                    applied: [],
                    conflicts: [],
                    skipped: [],
                  }
                : {},
    }),
  );
  const peer = {
    client: {
      request,
      status: "connected",
      on: () => () => {},
      onStatusChange: () => () => {},
    },
    scope,
    release: () => {},
  } as unknown as CloudPeer;
  const client = new WorkspaceRuntimeClient({
    open: async () => peer,
    workspaces: () => [],
  });
  clients.push(client);
  return { client, request };
}
afterEach(() => {
  setActiveBridge(null);
  for (const client of clients.splice(0)) client.dispose();
  vi.restoreAllMocks();
});

it("a connected cloud workspace loads its Review PR independently of write-access preflight", async () => {
  const { client, request } = runtime();
  setActiveBridge(client);
  const provider = resolveReviewProvider("github.com")!;
  await prefetchReviewLiveData(provider, folder, 12, { force: true });
  expect(peekReviewLiveData(provider, folder, 12).error).toBeNull();
  expect(
    request.mock.calls.some(([message]) => message.op === "gh.prGet"),
  ).toBe(true);
});

it("Undo after a cloud turn reset never dispatches to the Local engine", async () => {
  const local = vi
    .spyOn(RuntimeClient.prototype, "request")
    .mockResolvedValue({ type: "WORKSPACE_RESPONSE", result: {} } as never);
  const { client, request } = runtime();
  const reset = await bridgeTurnsReset(client, { chatId, turnId: "turn-1" });
  await bridgeTurnsUndoReset(client, { resetId: reset.resetId });
  expect(local.mock.calls).toEqual([]);
  expect(
    request.mock.calls.some(([message]) => message.op === "turns.undoReset"),
  ).toBe(true);
});

it("cloud turn metadata retains its cloud owner for subsequent diff/reset operations", () => {
  const result = cloudIncoming(scope, {
    type: "WORKSPACE_RESPONSE",
    op: "turns.list",
    result: {
      turns: [
        {
          chatId: "cloud-chat",
          turnId: "turn-1",
          workspaceId: "local-main",
          folder: scope.root,
        },
      ],
    },
  });
  expect(result).toMatchObject({
    result: { turns: [{ chatId, workspaceId: folder, folder }] },
  });
});

it("full-context turn diffs translate their nested chat identity back to the cloud engine", () => {
  const identity = { chatId, turnId: "turn-1" };
  const request = cloudOutgoing(scope, {
    type: "WORKSPACE_REQUEST",
    op: "git.diff",
    params: {
      workspaceId: folder,
      history: { kind: "turn-range", from: identity, to: identity },
      fullContext: true,
    },
  });
  expect(request).toMatchObject({
    params: {
      workspaceId: "local-main",
      history: { from: { chatId: "cloud-chat" }, to: { chatId: "cloud-chat" } },
    },
  });
});

it("confirmed cloud history remains readable while the Local engine is disconnected", async () => {
  vi.spyOn(RuntimeClient.prototype, "request").mockRejectedValue(
    new Error("Local engine disconnected"),
  );
  const client = new WorkspaceRuntimeClient({
    open: vi.fn(),
    workspaces: () => [],
    readHistory: async () => ({
      chats: [{ id: chatId, folder }],
      chatDeletions: [],
    }),
  });
  clients.push(client);
  await client.warmHistoryWorkspace(scope);
  expect(client.hasChatSnapshot(folder)).toBe(true);
  await expect(
    client.request({
      type: "WORKSPACE_REQUEST",
      op: "chats.list",
      params: {},
    } as never),
  ).resolves.toMatchObject({ result: { chats: [{ id: chatId, folder }] } });
});

it("Review loads all read resources and still requires an exact write grant", async () => {
  const { client, request } = runtime();
  setActiveBridge(client);
  const provider = resolveReviewProvider("github.com")!;
  await prefetchReviewLiveData(provider, folder, 13, { force: true });
  for (const op of ["gh.prGet", "gh.prChecks", "gh.prCommits", "gh.prReviews"])
    expect(request.mock.calls.some(([message]) => message.op === op)).toBe(
      true,
    );
  expect(
    request.mock.calls.some(([message]) => message.op === "gh.repoAccess"),
  ).toBe(false);
  await expect(
    provider.addComment(
      { workspaceId: folder, hostOrigin: "github.com", reviewRef: "13" },
      "comment",
    ),
  ).rejects.toThrow(/write authorization/);
  expect(
    request.mock.calls.some(([message]) => message.op === "gh.prComment"),
  ).toBe(false);
});

it("Review retains real read-auth failures and Local still probes its own auth", async () => {
  const { client, request } = runtime();
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (message) => {
    if (message.op === "gh.prGet")
      throw Object.assign(new Error("Read credential expired"), {
        code: "NOT_AUTHENTICATED",
      });
    return original(message);
  });
  setActiveBridge(client);
  const provider = resolveReviewProvider("github.com")!;
  await prefetchReviewLiveData(provider, folder, 14, { force: true });
  expect(peekReviewLiveData(provider, folder, 14).authed).toBe(false);
  const local = vi
    .spyOn(RuntimeClient.prototype, "request")
    .mockResolvedValue({
      type: "WORKSPACE_RESPONSE",
      result: { authenticated: false },
    } as never);
  await prefetchReviewLiveData(provider, "/repo/local", 14, { force: true });
  expect(local).toHaveBeenCalledWith(
    expect.objectContaining({ op: "gh.authStatus" }),
    expect.anything(),
  );
  expect(peekReviewLiveData(provider, "/repo/local", 14).authed).toBe(false);
});

it("Local and two cloud workspaces can undo identical native reset IDs independently", async () => {
  const other = {
    ...scope,
    workspaceId: "33333333-3333-4333-8333-333333333333",
  };
  const calls: Array<[string, Record<string, unknown>]> = [];
  const open = vi.fn(
    async (target: CloudWorkspaceTarget) =>
      ({
        scope: { ...scope, ...target },
        release: vi.fn(),
        runtimeId: target.workspaceId,
        client: {
          status: "connected",
          on: () => () => {},
          onStatusChange: () => () => {},
          request: async (message: Record<string, unknown>) => {
            calls.push([target.workspaceId, message]);
            return {
              type: "WORKSPACE_RESPONSE",
              op: message.op,
              result:
                message.op === "chats.list"
                  ? { chats: [], chatDeletions: [] }
                  : { resetId: "same-native-reset", restored: [] },
            };
          },
        },
      }) as unknown as CloudPeer,
  );
  let allowed = true;
  const options = { open, workspaces: () => [], canAccess: () => allowed };
  const client = new WorkspaceRuntimeClient(options);
  clients.push(client);
  const local = vi
    .spyOn(RuntimeClient.prototype, "request")
    .mockResolvedValue({
      type: "WORKSPACE_RESPONSE",
      result: { resetId: "same-native-reset", restored: [] },
    } as never);
  const localReset = await bridgeTurnsReset(client, {
    chatId: "local-chat",
    turnId: "turn",
  });
  const aReset = await bridgeTurnsReset(client, { chatId, turnId: "turn" });
  const bReset = await bridgeTurnsReset(client, {
    chatId: cloudScopedId(other, "cloud-chat"),
    turnId: "turn",
  });
  expect(localReset.resetId).toBe("same-native-reset");
  expect(aReset.resetId).not.toBe(bReset.resetId);
  await bridgeTurnsUndoReset(client, { resetId: localReset.resetId });
  client.retireCloudRuntime(scope.workspaceId);
  await bridgeTurnsUndoReset(client, { resetId: aReset.resetId });
  // A serialized handle is sufficient after reload; no focus/map is authority.
  const reloaded = new WorkspaceRuntimeClient(options);
  clients.push(reloaded);
  await bridgeTurnsUndoReset(reloaded, {
    resetId: JSON.parse(JSON.stringify(bReset.resetId)),
  });
  expect(
    calls.filter(([, message]) => message.op === "turns.undoReset"),
  ).toEqual([
    [
      scope.workspaceId,
      expect.objectContaining({ params: { resetId: "same-native-reset" } }),
    ],
    [
      other.workspaceId,
      expect.objectContaining({ params: { resetId: "same-native-reset" } }),
    ],
  ]);
  expect(local).toHaveBeenCalledTimes(2);
  client.clearCloudConnections();
  allowed = false;
  await expect(
    bridgeTurnsUndoReset(client, { resetId: aReset.resetId }),
  ).rejects.toThrow(/access/);
  expect(local).toHaveBeenCalledTimes(2);
});

it("turn get/list, pagination, Changes ranges and footer expanded diff round-trip only typed identities", async () => {
  const { bridgeTurnsGet, bridgeTurnsList } =
    await import("../workspace-bridge");
  const { loadWorkspaceFileDiff } =
    await import("@/renderer/shell/workspace-file-data-cache");
  const { client, request } = runtime();
  const original = request.getMockImplementation()!;
  const nativeTurn = {
    chatId: "cloud-chat",
    turnId: "turn-1",
    workspaceId: "local-main",
    folder: scope.root,
    startedAt: 123,
    files: [{ path: "a.ts", payload: { chatId: "opaque" } }],
  };
  request.mockImplementation(async (message) => {
    const result =
      message.op === "turns.get"
        ? { turn: nativeTurn }
        : message.op === "turns.list"
          ? { turns: [nativeTurn] }
          : message.op === "git.diff"
            ? { patch: "unchanged patch" }
            : null;
    return result
      ? { type: "WORKSPACE_RESPONSE", op: message.op, result }
      : original(message);
  });
  setActiveBridge(client);
  const turn = (await bridgeTurnsGet(client, chatId, "turn-1"))!;
  expect(turn).toMatchObject({ chatId, workspaceId: folder, folder });
  expect(turn.files).toBe(nativeTurn.files);
  const turns = await bridgeTurnsList(client, folder, {
    after: {
      chatId: turn.chatId,
      turnId: turn.turnId,
      startedAt: turn.startedAt,
    },
  });
  expect(turns[0]).toEqual(turn);
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      op: "turns.list",
      params: {
        workspaceId: "local-main",
        after: { chatId: "cloud-chat", turnId: "turn-1", startedAt: 123 },
      },
    }),
    expect.anything(),
  );
  for (const diffScope of ["turn", "history"] as const) {
    expect(
      await loadWorkspaceFileDiff({
        workspaceId: folder,
        path: "a.ts",
        diffScope,
        fullContext: true,
        turnChatId: turn.chatId,
        turnId: turn.turnId,
        diffHistory: { kind: "turn-range", from: turn, to: turn },
      }),
    ).toBe("unchanged patch");
  }
  for (const [message] of request.mock.calls.filter(
    ([m]) => m.op === "git.diff",
  ))
    expect(message).toMatchObject({
      params: {
        history: {
          from: { chatId: "cloud-chat" },
          to: { chatId: "cloud-chat" },
        },
      },
    });
});

it("rejects foreign owners in history endpoints, cursors and reset handles before opening a runtime", async () => {
  const other = {
    ...scope,
    workspaceId: "33333333-3333-4333-8333-333333333333",
  };
  const foreign = {
    chatId: cloudScopedId(other, "chat"),
    turnId: "turn",
    startedAt: 123,
  };
  const { client, request } = runtime();
  const local = vi.spyOn(RuntimeClient.prototype, "request");
  for (const params of [
    {
      op: "git.diff",
      params: {
        workspaceId: folder,
        history: {
          kind: "turn-range",
          from: { ...foreign, chatId },
          to: foreign,
        },
      },
    },
    { op: "turns.list", params: { workspaceId: folder, after: foreign } },
    {
      op: "turns.undoReset",
      params: { workspaceId: folder, resetId: cloudScopedId(other, "reset") },
    },
  ]) {
    await expect(
      client.request({ type: "WORKSPACE_REQUEST", ...params }),
    ).rejects.toThrow(/cross cloud/);
    expect(() =>
      cloudOutgoing(scope, { type: "WORKSPACE_REQUEST", ...params }),
    ).toThrow(/changed/);
  }
  expect(request).not.toHaveBeenCalled();
  expect(local).not.toHaveBeenCalled();
});

it("publishes confirmed cloud lists without waiting for a stalled Local read", async () => {
  let finish!: (value: never) => void;
  const local = vi.spyOn(RuntimeClient.prototype, "request").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const client = new WorkspaceRuntimeClient({
    open: vi.fn(),
    workspaces: () => [{ id: folder, repoSlug: "cloud-fixture" }],
    readHistory: async () => ({
      chats: [{ id: chatId, folder }],
      chatDeletions: [],
    }),
  });
  clients.push(client);
  await client.warmHistoryWorkspace(scope);
  const changed = vi.fn();
  client.on("DB_CHANGED", changed);
  const pending = client.request({
    type: "WORKSPACE_REQUEST",
    op: "chats.list",
  });
  const settled = vi.fn();
  void pending.then(settled);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toHaveBeenCalledWith(
    expect.objectContaining({
      result: expect.objectContaining({
        confirmedLocalChats: false,
        chats: [{ id: chatId, folder }],
      }),
    }),
  );
  finish({
    type: "WORKSPACE_RESPONSE",
    result: { chats: [{ id: "local" }], chatDeletions: [] },
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(changed).toHaveBeenCalledWith(
    expect.objectContaining({ kinds: ["chats"] }),
  );
  local.mockRejectedValue(new Error("Local restarted"));
  const retained = await client.request({
    type: "WORKSPACE_REQUEST",
    op: "chats.list",
  });
  expect(retained).toMatchObject({
    result: { chats: [{ id: "local" }, { id: chatId, folder }] },
  });
  expect(
    await client.request({ type: "WORKSPACE_REQUEST", op: "workspace.list" }),
  ).toMatchObject({
    result: { confirmedLocalWorkspaces: false, workspaces: [{ id: folder }] },
  });
});

it("does not publish a late aggregate after account replacement", async () => {
  let finish!: (value: never) => void;
  vi.spyOn(RuntimeClient.prototype, "request").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const client = new WorkspaceRuntimeClient({
    open: vi.fn(),
    workspaces: () => [],
  });
  clients.push(client);
  const pending = client.request({
    type: "WORKSPACE_REQUEST",
    op: "chats.list",
  });
  const rejection = expect(pending).rejects.toThrow(/account changed/i);
  client.clearCloudConnections();
  finish({
    type: "WORKSPACE_RESPONSE",
    result: { chats: [], chatDeletions: [] },
  } as never);
  await rejection;
});
