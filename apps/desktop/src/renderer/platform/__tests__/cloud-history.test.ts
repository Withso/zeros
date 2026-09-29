import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloudScopedId,
  cloudWorkspaceKey,
} from "../bridge/cloud-workspace-key";
const state = vi.hoisted(() => ({ request: vi.fn(), generation: 0 }));
vi.mock("../cloud-workspaces", () => ({ cloudAccountRequest: state.request }));
vi.mock("../../features/team/team-store", () => ({
  getOrganizationStoreGeneration: () => state.generation,
}));
import { readCloudWorkspaceHistory } from "../cloud-history";
const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const page = (extra: object = {}) => ({
  ...target,
  revision: 1,
  chats: [],
  chatDeletions: [],
  nextCursor: null,
  ...extra,
});
beforeEach(() => {
  state.request.mockReset();
  state.generation = 0;
});

describe("database-backed cloud transcript reads", () => {
  it("searches saved history with scoped hits and bounded revision-pinned pagination", async () => {
    state.request.mockResolvedValueOnce(page({ hits: [{ chatId: "chat", msgId: "m1", payload: "first", createdAt: 1 }], nextCursor: "cursor" }))
      .mockResolvedValueOnce(page({ hits: [{ chatId: "chat", msgId: "m2", payload: "second", createdAt: 2 }] }));
    expect(await readCloudWorkspaceHistory(target, "messages.search", { query: "saved words", folder: cloudWorkspaceKey(target), limit: 2 }))
      .toEqual({ hits: [
        { chatId: cloudScopedId(target, "chat"), msgId: "m1", payload: "first", createdAt: 1 },
        { chatId: cloudScopedId(target, "chat"), msgId: "m2", payload: "second", createdAt: 2 },
      ] });
    expect(state.request.mock.calls[0][0]).toContain("/search?query=saved+words&limit=2&folder=.");
    expect(state.request.mock.calls[1][0]).toContain("cursor=cursor&revision=1");
  });
  it("fences search requests and responses across workspace/account changes", async () => {
    const other = { ...target, workspaceId: target.organizationId };
    await expect(readCloudWorkspaceHistory(target, "messages.search", { query: "saved", chatId: cloudScopedId(other, "chat") })).rejects.toThrow(/another workspace/);
    await expect(readCloudWorkspaceHistory(target, "messages.search", { query: "saved", folder: cloudWorkspaceKey(other) })).rejects.toThrow(/another workspace/);
    expect(state.request).not.toHaveBeenCalled();
    state.request.mockResolvedValueOnce(page({ hits: [], organizationId: target.workspaceId }));
    await expect(readCloudWorkspaceHistory(target, "messages.search", { query: "saved", folder: cloudWorkspaceKey(target) })).rejects.toThrow(/different workspace/);
    state.request.mockImplementationOnce(async () => { state.generation++; return page({ hits: [] }); });
    await expect(readCloudWorkspaceHistory(target, "messages.search", { query: "saved", folder: cloudWorkspaceKey(target) })).rejects.toThrow(/account changed/i);
  });
  it("bounds search pagination and rejects revision drift", async () => {
    const params = { query: "saved", folder: cloudWorkspaceKey(target) };
    state.request.mockResolvedValue(page({ hits: [], nextCursor: "repeat" }));
    await expect(readCloudWorkspaceHistory(target, "messages.search", params)).rejects.toThrow(/limit/);
    state.request.mockReset().mockResolvedValueOnce(page({ hits: [], nextCursor: "one" }))
      .mockResolvedValueOnce(page({ hits: [], revision: 2 }));
    await expect(readCloudWorkspaceHistory(target, "messages.search", params)).rejects.toThrow(/changed/);
  });
  it("scopes metadata and deletions and pins subsequent pages to the first revision", async () => {
    state.request
      .mockResolvedValueOnce(
        page({
          chats: [
            {
              id: "chat",
              folder: "subdir",
              sourceChatId: "source",
              sessionId: "session",
            },
          ],
          nextCursor: "chat",
        }),
      )
      .mockResolvedValueOnce(page({ chatDeletions: ["deleted"] }));
    expect(await readCloudWorkspaceHistory(target, "chats.list", {})).toEqual({
      revision: 1,
      chats: [
        {
          id: cloudScopedId(target, "chat"),
          folder: `${cloudWorkspaceKey(target)}/subdir`,
          sourceChatId: cloudScopedId(target, "source"),
          sessionId: cloudScopedId(target, "session"),
        },
      ],
      chatDeletions: [cloudScopedId(target, "deleted")],
    });
    expect(state.request.mock.calls[1][0]).toContain("afterId=chat&revision=1");
  });
  it("discards a mixed revision and retries the complete list only once", async () => {
    state.request
      .mockResolvedValueOnce(
        page({ chats: [{ id: "old", folder: "." }], nextCursor: "old" }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("Changed"), { code: "cloud_history_changed" }),
      )
      .mockResolvedValueOnce(
        page({ revision: 2, chats: [{ id: "new", folder: "." }] }),
      );
    expect(
      await readCloudWorkspaceHistory(target, "chats.list", {}),
    ).toMatchObject({ chats: [{ id: cloudScopedId(target, "new") }] });
    state.request.mockRejectedValue(
      Object.assign(new Error("Changed"), { code: "cloud_history_changed" }),
    );
    await expect(
      readCloudWorkspaceHistory(target, "chats.list", {}),
    ).rejects.toThrow("Changed");
    expect(state.request).toHaveBeenCalledTimes(5);
  });
  it("keeps tool payloads intact and reads older windows with their exact cursor", async () => {
    const messages = [
      {
        msgId: "tool",
        kind: "tool_call",
        payload: '{"status":"completed","content":"Read"}',
        createdAt: 1,
      },
    ];
    state.request.mockResolvedValue(page({ messages }));
    expect(
      await readCloudWorkspaceHistory(target, "messages.windowOlder", {
        chatId: cloudScopedId(target, "chat"),
        beforeMsgId: "message/1",
        limit: 1500,
      }),
    ).toEqual({ messages });
    expect(state.request.mock.calls[0][0]).toContain(
      "/messages/chat?limit=1000&beforeMsgId=message%2F1",
    );
  });
  it("rejects another workspace and malformed folders without publishing a partial snapshot", async () => {
    await expect(
      readCloudWorkspaceHistory(target, "messages.window", {
        chatId: cloudScopedId(
          { ...target, workspaceId: target.organizationId },
          "chat",
        ),
      }),
    ).rejects.toThrow(/another workspace/);
    expect(state.request).not.toHaveBeenCalled();
    state.request.mockResolvedValue(
      page({ organizationId: target.workspaceId }),
    );
    await expect(
      readCloudWorkspaceHistory(target, "chats.list", {}),
    ).rejects.toThrow(/different workspace/);
    for (const folder of ["../elsewhere", "/absolute", "a/../b", "a\u0000b"]) {
      state.request.mockResolvedValue(
        page({ chats: [{ id: "chat", folder }] }),
      );
      await expect(
        readCloudWorkspaceHistory(target, "chats.list", {}),
      ).rejects.toThrow(/folder/);
    }
  });
  it("fences the entire multi-page read when the account changes between pages", async () => {
    state.request
      .mockImplementationOnce(async () => {
        state.generation++;
        return page({ nextCursor: "next" });
      })
      .mockResolvedValue(page());
    await expect(
      readCloudWorkspaceHistory(target, "chats.list", {}),
    ).rejects.toThrow(/account changed/i);
    expect(state.request).toHaveBeenCalledOnce();
  });
  it("bounds retained metadata bytes and rejects repeated page cursors", async () => {
    state.request.mockResolvedValue(page({ nextCursor: "repeat" }));
    await expect(
      readCloudWorkspaceHistory(target, "chats.list", {}),
    ).rejects.toThrow(/limit/);
    state.request.mockImplementation(async () =>
      page({
        chats: [
          { id: "huge", folder: ".", title: "x".repeat(9 * 1024 * 1024) },
        ],
      }),
    );
    await expect(
      readCloudWorkspaceHistory(target, "chats.list", {}),
    ).rejects.toThrow(/limit/);
  });
});
