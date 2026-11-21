import { describe, expect, it, vi } from "vitest";

import {
  liveProviderBindingUpdate,
  persistChatRowsWithBestEffortIdentityClears,
  providerIdentityClearForTransition,
} from "../chat-provider-identity-persistence";

const binding = {
  version: 1 as const,
  providerId: "codex",
  kind: "native" as const,
  resumeId: "thread-1",
};

describe("providerIdentityClearForTransition", () => {
  it("emits a guarded clear for an intentional same-agent reset", () => {
    expect(
      providerIdentityClearForTransition(
        { id: "chat-1", agentId: "codex", providerBinding: binding },
        { id: "chat-1", agentId: "codex", providerBinding: null },
      ),
    ).toEqual({
      chatId: "chat-1",
      agentId: "codex",
      resumeId: "thread-1",
    });
  });

  it("does not turn incomplete snapshots or agent changes into clears", () => {
    expect(
      providerIdentityClearForTransition(undefined, {
        id: "chat-1",
        agentId: "codex",
        providerBinding: null,
      }),
    ).toBeNull();
    expect(
      providerIdentityClearForTransition(
        { id: "chat-1", agentId: "codex", providerBinding: binding },
        { id: "chat-1", agentId: "claude", providerBinding: null },
      ),
    ).toBeNull();
    expect(
      providerIdentityClearForTransition(
        { id: "chat-1", agentId: "codex", providerBinding: binding },
        { id: "chat-1", agentId: "codex", providerBinding: binding },
      ),
    ).toBeNull();
  });
});

describe("persistChatRowsWithBestEffortIdentityClears", () => {
  it("writes the complete chat batch when one optional identity clear fails", async () => {
    const rows = [{ id: "chat-1" }, { id: "chat-2" }];
    const rejectedClear = {
      chatId: "chat-1",
      agentId: "codex",
      resumeId: "thread-1",
    };
    const successfulClear = {
      chatId: "chat-2",
      agentId: "claude",
      resumeId: "thread-2",
    };
    const clearProviderIdentity = vi
      .fn()
      .mockRejectedValueOnce(new Error("remote operation refused"))
      .mockResolvedValueOnce(true);
    const replaceRows = vi.fn().mockResolvedValue(undefined);

    await expect(
      persistChatRowsWithBestEffortIdentityClears(
        rows,
        [rejectedClear, successfulClear],
        clearProviderIdentity,
        replaceRows,
      ),
    ).resolves.toEqual([rejectedClear]);

    expect(clearProviderIdentity).toHaveBeenCalledTimes(2);
    expect(replaceRows).toHaveBeenCalledOnce();
    expect(replaceRows).toHaveBeenCalledWith(rows);
  });

  it("still rejects when the authoritative chat upsert itself fails", async () => {
    const upsertFailure = new Error("bulk upsert failed");

    await expect(
      persistChatRowsWithBestEffortIdentityClears(
        [{ id: "chat-1" }],
        [
          {
            chatId: "chat-1",
            agentId: "codex",
            resumeId: "thread-1",
          },
        ],
        vi.fn().mockRejectedValue(new Error("optional clear failed")),
        vi.fn().mockRejectedValue(upsertFailure),
      ),
    ).rejects.toBe(upsertFailure);
  });
});

describe("liveProviderBindingUpdate", () => {
  it("persists a new binding for the chat's own agent", () => {
    expect(liveProviderBindingUpdate({ id: "c", agentId: "codex", providerBinding: null }, binding, null))
      .toEqual({ providerBinding: binding, sessionId: "thread-1" });
  });

  it("skips a binding the chat already holds", () => {
    expect(liveProviderBindingUpdate({ id: "c", agentId: "codex", providerBinding: { ...binding } }, binding, null))
      .toBeNull();
  });

  it("skips the previous agent's binding left on the slot by an in-place switch", () => {
    // UPDATE_CHAT_SETTINGS drops a binding for another provider, so writing it
    // would only bump updatedAt and re-run the persisting effect forever.
    expect(liveProviderBindingUpdate({ id: "c", agentId: "claude", providerBinding: null }, binding, null))
      .toBeNull();
  });
});
