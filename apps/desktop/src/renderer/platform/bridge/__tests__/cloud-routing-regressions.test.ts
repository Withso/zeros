import { afterEach, expect, it, vi } from "vitest";
const cloudGithub = vi.hoisted(() => ({ request: vi.fn(async (_target: unknown, op: string) => op === "gh.prGet" ? { number: 12, title: "Cloud PR" } : op === "gh.authStatus" ? { authenticated: true, login: "cloud-user" } : {}) }));
vi.mock("../../cloud-github-pr", () => ({ requestCloudGithubPr: cloudGithub.request }));
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
/** The control-plane mirror holds the worker's native rows. */
const nativeRoot = "/home/user/Owner/repo";
const nativeHistory = async () => ({ chats: [{ id: "cloud-chat", folder: nativeRoot }], chatDeletions: [] });
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
  cloudGithub.request.mockReset();
  cloudGithub.request.mockImplementation(async (_target, op) => op === "gh.prGet" ? { number: 12, title: "Cloud PR" } : op === "gh.authStatus" ? { authenticated: true, login: "cloud-user" } : {});
});

it("reads the cloud GitHub identity with no Local engine or VM connection", async () => {
  setActiveBridge(null);
  const provider = resolveReviewProvider("github.com")!;
  await expect(provider.authStatus(folder)).resolves.toEqual({ authenticated: true, login: "cloud-user" });
  expect(cloudGithub.request).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: scope.workspaceId }), "gh.authStatus", {});
});

it("a cloud workspace loads Review through HTTPS independently of its VM and write-access preflight", async () => {
  const { client, request } = runtime();
  setActiveBridge(client);
  const provider = resolveReviewProvider("github.com")!;
  await prefetchReviewLiveData(provider, folder, 12, { force: true });
  expect(peekReviewLiveData(provider, folder, 12).error).toBeNull();
  expect(
    request.mock.calls.some(([message]) => message.op === "gh.prGet"),
  ).toBe(false);
  expect(cloudGithub.request).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: scope.workspaceId }), "gh.prGet", expect.objectContaining({ prNumber: 12 }));
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
    readHistory: nativeHistory,
    historyRoot: () => nativeRoot,
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

it("Review retains real read-auth failures and Local still probes its own auth", async () => {
  const { client } = runtime();
  cloudGithub.request.mockRejectedValue(Object.assign(new Error("Read credential expired"), { code: "NOT_AUTHENTICATED" }));
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
    readHistory: nativeHistory,
    historyRoot: () => nativeRoot,
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
