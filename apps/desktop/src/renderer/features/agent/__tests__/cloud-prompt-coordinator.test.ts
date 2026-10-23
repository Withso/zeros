import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudPromptCoordinator } from "../cloud-prompt-coordinator";
import { emptyPromptJournal, promptOwnerKey, type CloudPromptApi, type CloudPromptJournal, type CloudPromptOwner, type PromptJournalRecord } from "../cloud-prompt-channel";

const owner: CloudPromptOwner = { backend: "https://api.example.test", accountId: "account", organizationId: "org", workspaceId: "workspace", chatId: "chat" };
const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const records = new Map<string, PromptJournalRecord>();
  const journal: CloudPromptJournal = {
    read: async key => records.get(promptOwnerKey(key)) ?? emptyPromptJournal(key),
    change: async (key, update) => { const value = update(records.get(promptOwnerKey(key)) ?? emptyPromptJournal(key)); records.set(promptOwnerKey(key), value); return value; },
    owners: async () => [...records.values()].map(record => record.owner),
    erase: async key => { records.delete(promptOwnerKey(key)); },
  };
  return { records, journal, coordinator: new CloudPromptCoordinator(journal) };
}
const emptyPage = { epoch: "0", items: [], nextAfter: null };
function api(): CloudPromptApi { return { enqueue: vi.fn(), list: vi.fn(async () => emptyPage), stop: vi.fn() }; }
afterEach(() => vi.useRealTimers());

describe("cloud prompt coordinator", () => {
  it("bounds all concurrent requests across repeated wake calls, and releases the next waiting chat promptly", async () => {
    vi.useFakeTimers();
    const f = fixture(), gate = defer<typeof emptyPage>();
    let active = 0, peak = 0;
    const apis = Array.from({ length: 8 }, () => ({ ...api(), list: vi.fn(async () => {
      peak = Math.max(peak, ++active); const result = await gate.promise; active--; return result;
    }) }));
    const chats = apis.map((value, i) => f.coordinator.channel({ ...owner, chatId: String(i) }, value, () => true, vi.fn()));
    for (const chat of chats.slice(0, 4)) f.coordinator.wake(chat);
    await vi.advanceTimersByTimeAsync(0); expect(active).toBe(4);
    for (const chat of chats.slice(4)) f.coordinator.wake(chat);
    await vi.advanceTimersByTimeAsync(0); expect(peak).toBe(4);
    gate.resolve(emptyPage); await vi.advanceTimersByTimeAsync(1);
    expect(apis.every(value => vi.mocked(value.list).mock.calls.length === 1)).toBe(true);
    f.coordinator.stop();
  });
  it("does not poll idle chats, and fences a pending response after owner erasure", async () => {
    vi.useFakeTimers();
    const f = fixture(), value = api(), changed = vi.fn(), chat = f.coordinator.channel(owner, value, () => true, changed);
    f.coordinator.wake(chat); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000); expect(value.list).toHaveBeenCalledTimes(1);
    const gate = defer<typeof emptyPage>(); vi.mocked(value.list).mockImplementationOnce(() => gate.promise);
    f.coordinator.wake(chat); await vi.advanceTimersByTimeAsync(0);
    await f.coordinator.erase(owner); const before = changed.mock.calls.length;
    gate.resolve(emptyPage); await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenCalledTimes(before); expect(f.records.size).toBe(0);
    f.coordinator.stop();
  });
  it("reloads private pending work after restart and never sends through a retired account generation", async () => {
    vi.useFakeTimers();
    const f = fixture(), value = api(); let current = true;
    const chat = f.coordinator.channel(owner, value, () => current, vi.fn());
    await chat.enqueue(async () => ({ chatId: owner.chatId, userMessageId: "saved", agentId: "codex", prompt: [{ type: "text", text: "ok" }], startedAt: 1 }));
    current = false; f.coordinator.wake(chat); await vi.advanceTimersByTimeAsync(10_000);
    expect(value.enqueue).not.toHaveBeenCalled();
    const next = api(); vi.mocked(next.enqueue).mockResolvedValue({ workspaceId: owner.workspaceId, chatId: owner.chatId, userMessageId: "saved", sequence: "1", epoch: "0", acceptedAt: new Date(0).toISOString(), workspaceState: "running" });
    const replacement = f.coordinator.channel(owner, next, () => true, vi.fn());
    f.coordinator.wake(replacement); await vi.advanceTimersByTimeAsync(0);
    expect(next.enqueue).toHaveBeenCalledTimes(1); f.coordinator.stop();
  });
});

it("commits Send without waiting for an already-running history/status read", async () => {
  vi.useFakeTimers(); const f = fixture(), value = api(), history = defer<typeof emptyPage>();
  vi.mocked(value.list).mockImplementationOnce(() => history.promise);
  const chat = f.coordinator.channel(owner, value, () => true, vi.fn());
  f.coordinator.wake(chat, true); await vi.advanceTimersByTimeAsync(0); expect(value.list).toHaveBeenCalledOnce();
  const receipt = { workspaceId: owner.workspaceId, chatId: owner.chatId, userMessageId: "now", sequence: "1", epoch: "0", acceptedAt: new Date(0).toISOString(), workspaceState: "running" as const };
  vi.mocked(value.enqueue).mockResolvedValue(receipt);
  await chat.enqueue(async () => ({ chatId: owner.chatId, userMessageId: "now", agentId: "codex", prompt: [{ type: "text", text: "ok" }], startedAt: 1 }));
  let committed = false; const sending = f.coordinator.flush(chat).then(() => { committed = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(value.enqueue).toHaveBeenCalledOnce(); expect(committed).toBe(true);
  history.resolve(emptyPage); await sending; f.coordinator.stop();
});
