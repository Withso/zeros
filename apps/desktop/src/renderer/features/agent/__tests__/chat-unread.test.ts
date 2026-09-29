import { beforeEach, describe, expect, it } from "vitest";

import {
  CHAT_UNREAD_LIMIT,
  chatUnread,
  closedChats,
  finishedChats,
  forgetChatUnread,
  noteChatsFinished,
  resetChatUnreadForTests,
  setChatsInView,
} from "../chat-unread";
import { BLANK } from "../sessions-store";
import type { AgentSessionState } from "../use-agent-session";

const STORAGE_KEY = "zeros-chat-unread-v1";
let values: Map<string, string>;

function installStorage(): void {
  values = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
}

const stored = (): unknown => {
  const raw = values.get(STORAGE_KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
};

const slot = (overrides: Partial<AgentSessionState> = {}) =>
  ({ ...BLANK, agentId: "claude", ...overrides }) as AgentSessionState;
const snapshot = (
  sessions: Record<string, AgentSessionState>,
  extra: { pendingLocalTurns?: Record<string, string>; cancellingChats?: Set<string> } = {},
) => ({
  sessions,
  pendingLocalTurns: extra.pendingLocalTurns ?? {},
  cancellingChats: extra.cancellingChats ?? new Set<string>(),
});

beforeEach(() => {
  installStorage();
  resetChatUnreadForTests();
});

describe("finishedChats", () => {
  const working = slot({ status: "streaming" });
  const done = slot({ status: "ready", lastStopReason: "end_turn" });

  it("reports a chat whose agent went from working to done", () => {
    expect(finishedChats(snapshot({ a: working }), snapshot({ a: done }))).toEqual(["a"]);
    // A finished local send (the optimistic turn) counts too.
    expect(
      finishedChats(
        snapshot({ a: slot({ status: "ready" }) }, { pendingLocalTurns: { a: "turn" } }),
        snapshot({ a: done }),
      ),
    ).toEqual(["a"]);
  });

  it("reports a turn that ended in a failure, which also wants a look", () => {
    expect(
      finishedChats(snapshot({ a: working }), snapshot({ a: slot({ status: "failed", error: "boom" }) })),
    ).toEqual(["a"]);
  });

  it("ignores a Stop, a closed session and unchanged chats", () => {
    const stopped = slot({ status: "ready", lastStopReason: "cancelled" });
    expect(finishedChats(snapshot({ a: working }), snapshot({ a: stopped }))).toEqual([]);
    expect(
      finishedChats(
        snapshot({ a: working }, { cancellingChats: new Set(["a"]) }),
        snapshot({ a: done }, { cancellingChats: new Set(["a"]) }),
      ),
    ).toEqual([]);
    expect(finishedChats(snapshot({ a: working }), snapshot({}))).toEqual([]);
    expect(finishedChats(snapshot({ a: working }), snapshot({ a: working }))).toEqual([]);
    expect(finishedChats(snapshot({ a: done }), snapshot({ a: slot({ status: "ready" }) }))).toEqual([]);
  });

  it("waits for a turn parked on the user, which hasn't finished", () => {
    const parked = slot({
      status: "streaming",
      pendingQuestions: [{ questionId: "q", request: { blocking: true, questions: [] } }] as never,
    });
    expect(finishedChats(snapshot({ a: working }), snapshot({ a: parked }))).toEqual([]);
    expect(finishedChats(snapshot({ a: parked }), snapshot({ a: done }))).toEqual(["a"]);
  });

  it("waits for Claude's background continuation before calling it done", () => {
    const waitingOnTasks = slot({
      status: "ready",
      waitingForBackgroundTasks: true,
      backgroundActivity: { state: "idle", startedAt: 1 },
      backgroundTasks: [{ taskId: "t", name: "Tests", startedAt: 1, updatedAt: 1 }],
    });
    expect(finishedChats(snapshot({ a: working }), snapshot({ a: waitingOnTasks }))).toEqual([]);
    expect(finishedChats(snapshot({ a: waitingOnTasks }), snapshot({ a: done }))).toEqual(["a"]);
  });
});

describe("chat unread state", () => {
  it("marks a finished chat that isn't on screen, and only that one", () => {
    setChatsInView(["seen"]);
    noteChatsFinished(["seen", "elsewhere"]);
    expect(chatUnread("seen")).toBe(false);
    expect(chatUnread("elsewhere")).toBe(true);
    expect(stored()).toEqual(["elsewhere"]);
  });

  it("reads a chat as soon as it comes on screen", () => {
    noteChatsFinished(["a", "b"]);
    setChatsInView(["a"]);
    expect(chatUnread("a")).toBe(false);
    expect(chatUnread("b")).toBe(true);
    expect(stored()).toEqual(["b"]);
    // Nothing on screen (another page or workspace): everything finishing is unread.
    setChatsInView([]);
    noteChatsFinished(["a"]);
    expect(chatUnread("a")).toBe(true);
  });

  it("survives a relaunch", () => {
    values.set(STORAGE_KEY, JSON.stringify(["a", 7, "", "b"]));
    resetChatUnreadForTests();
    expect(chatUnread("a")).toBe(true);
    expect(chatUnread("b")).toBe(true);
  });

  it("is bounded, keeping the most recent", () => {
    noteChatsFinished(Array.from({ length: CHAT_UNREAD_LIMIT + 5 }, (_, i) => `chat-${i}`));
    expect(chatUnread("chat-0")).toBe(false);
    expect(chatUnread(`chat-${CHAT_UNREAD_LIMIT + 4}`)).toBe(true);
    expect((stored() as string[]).length).toBe(CHAT_UNREAD_LIMIT);
  });

  it("forgets a chat whose tab closes", () => {
    noteChatsFinished(["a", "b"]);
    forgetChatUnread(["a"]);
    expect(chatUnread("a")).toBe(false);
    expect(stored()).toEqual(["b"]);
    const chats = (ids: string[], archived: string[] = []) =>
      ids.map((id) => ({ id, archived: archived.includes(id) }));
    expect(closedChats(chats(["a", "b", "c"]), chats(["a", "b", "c"], ["b"]))).toEqual(["b"]);
    // Dropping out of the list (chats reloading) or a first load never prunes.
    expect(closedChats(chats(["a", "b"]), chats(["a"]))).toEqual([]);
    expect(closedChats([], chats(["a"], ["a"]))).toEqual([]);
  });
});
