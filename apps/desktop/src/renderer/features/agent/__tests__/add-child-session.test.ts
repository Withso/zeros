import { describe, expect, it, vi } from "vitest";

import type { ChatThread } from "../../../state/store";
import type { TranscriptSnapshot } from "../chat-transcript-attach";
import { addChildSession, canAddChildSession, createChildChat, hasParentContext } from "../add-child-session";
import { isAddChildSessionShortcut } from "../../../shell/use-add-child-session-hotkey";

const parent: ChatThread = {
  id: "parent",
  folder: "/repo",
  agentId: "codex",
  agentName: "Codex",
  model: "gpt-5",
  effort: "high",
  permissionMode: "tool-approval",
  title: "Fix the parser",
  createdAt: 1,
  updatedAt: 2,
  sessionId: "execution",
  providerBinding: { version: 1, providerId: "codex", kind: "native", resumeId: "thread" },
};

const snapshot = (over: Partial<TranscriptSnapshot> = {}): TranscriptSnapshot => ({
  text: "# handoff\n",
  count: 1,
  truncated: false,
  complete: true,
  ...over,
});

function deps(over: Partial<Parameters<typeof addChildSession>[1]> = {}) {
  return {
    publishChat: vi.fn(),
    createChild: vi.fn().mockResolvedValue({ parentChatId: "parent", rootChatId: "parent" }),
    loadTranscript: vi.fn().mockResolvedValue(snapshot()),
    deliver: vi.fn(),
    chatExists: () => true,
    onError: vi.fn(),
    ...over,
  };
}

describe("Add child session", () => {
  it("links a fresh chat one level below its parent without provider identity", () => {
    const child = createChildChat(parent, "child", 10);
    expect(child).toMatchObject({ id: "child", folder: "/repo", agentId: "codex", model: "gpt-5", parentChatId: "parent", rootChatId: "parent", sourceChatId: "parent" });
    expect(child).not.toHaveProperty("sessionId");
    expect(child).not.toHaveProperty("providerBinding");
    expect(createChildChat({ ...child, title: "Child" }, "grandchild").rootChatId).toBe("parent");
    expect(hasParentContext(child)).toBe(true);
    expect(hasParentContext({ ...child, sourceChatId: undefined })).toBe(false);
  });

  it("is Local only", () => {
    expect(canAddChildSession(parent)).toBe(true);
    expect(canAddChildSession({ ...parent, folder: "cloud://org-1/ws-1" })).toBe(false);
    expect(canAddChildSession({ ...parent, kind: "terminal" })).toBe(false);
    expect(canAddChildSession({ ...parent, archived: true })).toBe(false);
    expect(canAddChildSession(undefined)).toBe(false);
    const d = deps();
    expect(addChildSession({ ...parent, folder: "cloud://org-1/ws-1" }, d)).toBeNull();
    expect(d.publishChat).not.toHaveBeenCalled();
    expect(d.createChild).not.toHaveBeenCalled();
  });

  it("publishes at once, records the Local link and stages the handoff transcript", async () => {
    const d = deps();
    const child = addChildSession(parent, d)!;
    expect(d.publishChat).toHaveBeenCalledWith(child);
    expect(d.createChild).toHaveBeenCalledWith(expect.objectContaining({ id: child.id, folder: "/repo", sourceChatId: "parent" }), "parent");
    expect(d.loadTranscript).toHaveBeenCalledWith(expect.objectContaining({ chatId: "parent", mode: "handoff" }));
    await vi.waitFor(() => expect(d.deliver).toHaveBeenCalled());
    expect(d.deliver).toHaveBeenCalledWith(child.id, expect.objectContaining({ name: "fix-the-parser.handoff.txt", text: "# handoff\n" }));
    expect(d.onError).not.toHaveBeenCalled();
  });

  it("reads the parent's current transcript for every child, not a cached one", () => {
    const loadTranscript = vi.fn().mockResolvedValue(snapshot());
    const d = deps({ loadTranscript });
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_000).mockReturnValueOnce(3_000).mockReturnValueOnce(4_000);
    addChildSession(parent, d);
    addChildSession(parent, d);
    vi.restoreAllMocks();
    const [first, second] = loadTranscript.mock.calls.map((call) => (call[0] as { lastMessageAt: number }).lastMessageAt);
    expect(first).not.toBe(parent.updatedAt);
    expect(first).not.toBe(second);
  });

  it("stages nothing for an empty parent or a child deleted mid-read, and reports a failed link", async () => {
    const empty = deps({ loadTranscript: vi.fn().mockResolvedValue(snapshot({ count: 0 })) });
    addChildSession(parent, empty);
    const gone = deps({ chatExists: () => false });
    addChildSession(parent, gone);
    const unlinked = deps({ createChild: vi.fn().mockRejectedValue(new Error("offline")) });
    addChildSession(parent, unlinked);
    await vi.waitFor(() => expect(unlinked.onError).toHaveBeenCalledWith("Couldn't link the child session to its parent.", expect.any(Error)));
    expect(empty.deliver).not.toHaveBeenCalled();
    expect(gone.deliver).not.toHaveBeenCalled();
    expect(gone.onError).not.toHaveBeenCalled();
  });

  it("answers ⌥⌘T only", () => {
    const key = { metaKey: true, altKey: true, ctrlKey: false, shiftKey: false, code: "KeyT" };
    expect(isAddChildSessionShortcut(key)).toBe(true);
    expect(isAddChildSessionShortcut({ ...key, shiftKey: true })).toBe(false);
    expect(isAddChildSessionShortcut({ ...key, altKey: false })).toBe(false);
    expect(isAddChildSessionShortcut({ ...key, ctrlKey: true })).toBe(false);
  });
});
