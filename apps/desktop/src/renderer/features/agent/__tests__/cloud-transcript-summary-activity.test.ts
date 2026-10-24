import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, read: vi.fn(), connected: vi.fn(), on: vi.fn(),
  chats: [] as unknown[], sessions: {} as Record<string, unknown>,
  memos: [] as Array<{ value: unknown; deps: unknown[] }>, memoIndex: 0,
  refs: [] as Array<{ current: unknown }>, refIndex: 0 }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useMemo: (compute: () => unknown, deps: unknown[]) => {
    const index = f.memoIndex++, previous = f.memos[index];
    if (previous && deps.every((value, slot) => Object.is(value, previous.deps[slot]))) return previous.value;
    const value = compute(); f.memos[index] = { value, deps }; return value;
  },
  useRef: (value: unknown) => f.refs[f.refIndex++] ??= { current: value },
  useEffect: (effect: () => void | (() => void)) => { f.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../agent-history-client", () => ({ listChatSummariesForFolder: f.read }));
vi.mock("../../../platform/bridge/use-bridge", () => ({ useBridge: () => ({ on: f.on }) }));
vi.mock("../../../platform/bridge/active-bridge", () => ({ onActiveBridgeConnected: f.connected }));
vi.mock("../../../state/workspace-store", () => ({ useWorkspaceStore: { getState: () => ({ chats: f.chats }), subscribe: () => () => {} } }));
vi.mock("../sessions-store", () => ({ useSessionsStore: { getState: () => ({ sessions: f.sessions }) } }));
const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); f.effects.length = 0;
  f.chats = []; f.sessions = {}; f.memos = []; f.memoIndex = 0;
  f.refs = []; f.refIndex = 0;
  f.read.mockReset().mockResolvedValue([]); f.connected.mockReset().mockReturnValue(() => {}); f.on.mockReset().mockReturnValue(() => {});
});

it("removes a memory-only pill on chat deletion while the first summary read is still held", async () => {
  const { bindAccountPresentationOwner } = await import("../../../platform/account-presentation-cache");
  bindAccountPresentationOwner("fixture-owner");
  const { useChatTranscriptSummaries } = await import("../use-chat-transcript-summaries");
  const { retainCloudTranscriptSummaries } = await import("../chat-transcript-summaries-cache");
  const chatId = "cloud:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:saved";
  f.chats = [{ id: chatId, folder, title: "Untitled", createdAt: 1 }];
  f.sessions = { [chatId]: { cwd: folder, transcriptState: "resident", messages: [
    { id: "prompt", kind: "text", role: "user", text: "Research the project", createdAt: 1 },
  ] } };
  expect(useChatTranscriptSummaries(folder, "new").summaries).toHaveLength(1);
  retainCloudTranscriptSummaries(id => id !== chatId, cwd => cwd === folder);
  f.chats = [];
  f.memoIndex = 0;
  f.refIndex = 0;
  expect(useChatTranscriptSummaries(folder, "new").summaries).toEqual([]);
});

it("starts no queued cloud read after the visible tab becomes hidden", async () => {
  const { bindAccountPresentationOwner } = await import("../../../platform/account-presentation-cache");
  bindAccountPresentationOwner("fixture-owner");
  const { useChatTranscriptSummaries } = await import("../use-chat-transcript-summaries");
  const { transcriptSummariesCache, chatTranscriptSummariesKey } = await import("../chat-transcript-summaries-cache");
  let resolve!: (rows: []) => void;
  f.read.mockReturnValueOnce(new Promise<[]>(done => { resolve = done; })).mockResolvedValue([]);
  const Fixture = (active: boolean) => {
    f.memoIndex = 0; f.refIndex = 0;
    useChatTranscriptSummaries(folder, "new", active);
    return f.effects.splice(0).map(effect => effect());
  };
  let stops = Fixture(true); await vi.advanceTimersByTimeAsync(0);
  transcriptSummariesCache.invalidate(chatTranscriptSummariesKey(folder));
  stops.forEach(stop => stop?.()); stops = Fixture(true);
  stops.forEach(stop => stop?.()); stops = Fixture(false);
  resolve([]); await vi.advanceTimersByTimeAsync(180_000);
  expect(f.read).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  stops.forEach(stop => stop?.());
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
it.each([false, true])("a hidden cloud tab starts no reads, connection observers or timers (signed in: %s)", async signedIn => {
  const { bindAccountPresentationOwner } = await import("../../../platform/account-presentation-cache");
  bindAccountPresentationOwner(signedIn ? "fixture-owner" : null);
  const { useChatTranscriptSummaries } = await import("../use-chat-transcript-summaries");
  useChatTranscriptSummaries(folder, "new", false);
  const cleanups = f.effects.splice(0).map(effect => effect());
  await vi.advanceTimersByTimeAsync(180_000);
  expect(f.read).not.toHaveBeenCalled(); expect(f.on).not.toHaveBeenCalled(); expect(f.connected).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  cleanups.forEach(cleanup => cleanup?.());
});
