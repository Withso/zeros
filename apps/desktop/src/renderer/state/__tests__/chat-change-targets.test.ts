import { afterEach, expect, it, vi } from "vitest";
import { chatChangeTargets } from "../chat-change-targets";
import {
  cloudScopedId,
  cloudWorkspaceKey,
  type CloudWorkspaceTarget,
} from "../../platform/bridge/cloud-workspace-key";
import { WorkspaceRuntimeClient } from "../../platform/bridge/workspace-runtime-client";
import { RuntimeClient } from "../../platform/bridge/ws-client";
const a = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const b = { ...a, workspaceId: "33333333-3333-4333-8333-333333333333" };
const ids = ["local", cloudScopedId(a, "chat"), cloudScopedId(b, "chat")];
afterEach(() => vi.restoreAllMocks());
it("a cloud history nudge only re-reads that owner's open transcripts", async () => {
  const local = vi
    .spyOn(RuntimeClient.prototype, "request")
    .mockResolvedValue({
      type: "WORKSPACE_RESPONSE",
      result: { messages: [] },
    } as never);
  const reads = vi.fn(async (target: CloudWorkspaceTarget, op: string) =>
    op === "chats.list"
      ? {
          revision: 1,
          chats: [{ id: cloudScopedId(target, "chat") }],
          chatDeletions: [],
        }
      : { messages: [] },
  );
  const client = new WorkspaceRuntimeClient({
    open: vi.fn(),
    workspaces: () => [],
    readHistory: reads,
  });
  const pending: Promise<unknown>[] = [];
  const off = client.on("DB_CHANGED", (message) => {
    for (const chatId of chatChangeTargets(message, ids))
      pending.push(
        client.request({
          type: "WORKSPACE_REQUEST",
          op: "messages.window",
          params: { chatId },
        }),
      );
  });
  try {
    await client.warmHistoryWorkspace(a);
    await Promise.all(pending);
    expect(local).not.toHaveBeenCalled();
    expect(
      reads.mock.calls
        .filter(([, op]) => op === "messages.window")
        .map(([target]) => target.workspaceId),
    ).toEqual([a.workspaceId]);
  } finally {
    off();
    client.dispose();
  }
});
it("scopes Local fallback and intersects exact chat IDs with the cloud owner", () => {
  expect(chatChangeTargets({ kinds: ["messages"] }, ids)).toEqual([ids[0]]);
  expect(
    chatChangeTargets(
      {
        kinds: ["messages"],
        cloudWorkspace: cloudWorkspaceKey(a),
        chatIds: ids,
      },
      ids,
    ),
  ).toEqual([ids[1]]);
  expect(
    chatChangeTargets(
      { kinds: ["messages"], cloudWorkspace: cloudWorkspaceKey(b) },
      ids,
    ),
  ).toEqual([ids[2]]);
  expect(
    chatChangeTargets(
      { kinds: ["messages"], cloudWorkspace: "cloud://bad-owner" },
      ids,
    ),
  ).toEqual([]);
  expect(
    chatChangeTargets(
      { kinds: ["files"], cloudWorkspace: cloudWorkspaceKey(a) },
      ids,
    ),
  ).toEqual([]);
});
