import { beforeEach, describe, expect, it, vi } from "vitest";

const editChat = vi.fn();
vi.mock("../cloud-chat-edits", () => ({ editChat: (...args: unknown[]) => editChat(...args) }));

const chats: Array<{ id: string; archived?: boolean }> = [];
vi.mock("../workspace-store", () => ({ useWorkspaceStore: { getState: () => ({ chats }) } }));

import { openSession } from "../open-session";

describe("openSession", () => {
  beforeEach(() => {
    editChat.mockReset();
    chats.length = 0;
  });

  it("reopens a chat closed with the old tab strip before selecting it", () => {
    chats.push({ id: "closed", archived: true });
    const dispatch = vi.fn();
    openSession(dispatch, "closed");
    expect(editChat).toHaveBeenCalledWith(dispatch, "closed", { archived: false });
    expect(dispatch).toHaveBeenCalledWith({ type: "SET_ACTIVE_CHAT", id: "closed" });
  });

  it("only selects an open chat", () => {
    chats.push({ id: "open" });
    const dispatch = vi.fn();
    openSession(dispatch, "open");
    expect(editChat).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: "SET_ACTIVE_CHAT", id: "open" });
  });
});
