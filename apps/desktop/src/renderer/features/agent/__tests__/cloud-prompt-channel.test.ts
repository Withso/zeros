import { describe, expect, it, vi } from "vitest";
import type { CloudV2Prompt, CloudV2PromptReceipt, CloudV2PromptStatus } from "@zeros/protocol/cloud-v2-prompts";
import { CloudPromptChannel, emptyPromptJournal, promptOwnerKey, type CloudPromptJournal, type CloudPromptOwner, type PromptJournalRecord } from "../cloud-prompt-channel";

const owner: CloudPromptOwner = { backend: "https://api.example.test", accountId: "account-a", organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222", chatId: "conversation" };
const prompt = (id: string): CloudV2Prompt => ({ userMessageId: id, chatId: owner.chatId, agentId: "codex", model: "gpt-6-luna", effort: "low",
  prompt: [{ type: "text", text: id }], startedAt: 1, bubble: { displayText: id, retryText: id } });
const defer = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

class Journal implements CloudPromptJournal {
  data = new Map<string, PromptJournalRecord>();
  fail = false;
  maxEntries = Infinity;
  async read(key: CloudPromptOwner) { return structuredClone(this.data.get(promptOwnerKey(key)) ?? emptyPromptJournal(key)); }
  async change(key: CloudPromptOwner, update: (record: PromptJournalRecord) => PromptJournalRecord) {
    if (this.fail) throw new Error("Private storage is unavailable");
    const value = update(await this.read(key));
    if (value.entries.length > this.maxEntries) throw new Error("Private storage is full");
    this.data.set(promptOwnerKey(key), structuredClone(value)); return value;
  }
  async owners() { return [...this.data.values()].map(value => value.owner); }
  async erase(key: CloudPromptOwner) { this.data.delete(promptOwnerKey(key)); }
}
function fixture(journal = new Journal(), key = owner) {
  let current = true, epoch = "0", sequence = 0;
  const rows = new Map<string, CloudV2PromptStatus>(), order: string[] = [], changed = vi.fn();
  const api = {
    enqueue: vi.fn(async (body: CloudV2Prompt): Promise<CloudV2PromptReceipt> => {
      let row = rows.get(body.userMessageId);
      if (!row) {
        const receipt: CloudV2PromptReceipt = { workspaceId: key.workspaceId, chatId: key.chatId, userMessageId: body.userMessageId,
          epoch, sequence: String(++sequence), acceptedAt: new Date(1).toISOString(), workspaceState: "running" };
        row = { receipt, payload: body, state: "queued", cancelRequested: false }; rows.set(body.userMessageId, row); order.push(body.userMessageId);
      }
      return row.receipt;
    }),
    list: vi.fn(async (after = "0", includePayload = true) => ({ epoch,
      items: [...rows.values()].filter(row => BigInt(row.receipt.sequence) > BigInt(after)).map(row => ({ ...row, payload: includePayload ? row.payload : null })), nextAfter: null as string | null })),
    stop: vi.fn(async (throughEpoch: string) => {
      if (epoch === throughEpoch) { epoch = String(Number(epoch) + 1); for (const row of rows.values()) row.state = "cancelled"; }
      return { chatId: key.chatId, epoch };
    }),
  };
  const make = () => new CloudPromptChannel(key, journal, api, () => current, changed);
  return { journal, api, rows, order, changed, make, channel: make(), retire: () => { current = false; } };
}

describe("durable cloud prompt channel", () => {
  it("commits privately before accepting Send, then submits over HTTPS without any live bridge", async () => {
    const f = fixture(); await f.channel.enqueue(async () => prompt("one"));
    expect((await f.journal.read(owner)).entries[0]?.payload).toEqual(prompt("one"));
    expect(f.api.enqueue).not.toHaveBeenCalled();
    await f.channel.flush();
    expect(f.order).toEqual(["one"]); expect(f.channel.snapshot.entries[0]?.receipt?.userMessageId).toBe("one");
  });
  it("never accepts or sends a message whose private transaction failed", async () => {
    const f = fixture(); f.journal.fail = true;
    await expect(f.channel.enqueue(async () => prompt("one"))).rejects.toThrow("storage");
    await f.channel.flush(); expect(f.api.enqueue).not.toHaveBeenCalled();
  });
  it("preserves FIFO across slow attachment preparation and concurrent Send calls", async () => {
    const f = fixture(), file = defer<CloudV2Prompt>();
    const first = f.channel.enqueue(() => file.promise), second = f.channel.enqueue(async () => prompt("two"));
    file.resolve(prompt("one")); await Promise.all([first, second]); await f.channel.flush();
    expect(f.order).toEqual(["one", "two"]);
  });
  it("reuses the same id and bytes after a committed response is lost and the app restarts", async () => {
    const f = fixture(), real = f.api.enqueue.getMockImplementation()!;
    f.api.enqueue.mockImplementationOnce(async body => { await real(body); throw new TypeError("network disconnected"); });
    await f.channel.enqueue(async () => prompt("one")); await f.channel.flush();
    expect(f.channel.snapshot.entries[0]?.phase).toBe("uncertain");
    const reopened = f.make(); await reopened.flush();
    expect(f.order).toEqual(["one"]); expect(f.api.enqueue).toHaveBeenCalledTimes(2);
    expect(f.api.enqueue.mock.calls.map(call => call[0])).toEqual([prompt("one"), prompt("one")]);
    expect(reopened.snapshot.entries[0]?.phase).toBe("saved");
  });
  it("keeps a refused message visible and allows later messages to send", async () => {
    const f = fixture(); f.api.enqueue.mockRejectedValueOnce(Object.assign(new Error("private diagnostic"), { status: 409 }));
    await f.channel.enqueue(async () => prompt("one")); await f.channel.enqueue(async () => prompt("two")); await f.channel.flush();
    expect(f.channel.snapshot.entries[0]).toMatchObject({ phase: "refused", payload: prompt("one"), failure: expect.stringMatching(/retry/i) });
    expect(JSON.stringify(f.channel.snapshot)).not.toContain("private diagnostic"); expect(f.order).toEqual(["two"]);
  });
  it("restores committed remote work on another app and settles a mid-turn worker restart as interrupted", async () => {
    const f = fixture(); await f.api.enqueue(prompt("one")); f.rows.get("one")!.state = "accepted";
    await f.channel.refresh(true); expect(f.channel.snapshot.entries[0]?.state).toBe("accepted");
    f.rows.get("one")!.state = "interrupted"; await f.channel.refresh();
    expect(f.channel.snapshot.entries[0]).toMatchObject({ state: "interrupted", payload: prompt("one") });
    expect(f.api.enqueue).toHaveBeenCalledTimes(1);
    expect(f.api.list).toHaveBeenLastCalledWith("0", false);
  });
  it("recovers pending receipts without filling the retry journal with completed native history", async () => {
    const f = fixture(); f.journal.maxEntries = 2;
    for (const id of ["old-one", "old-two", "old-three"]) {
      await f.api.enqueue(prompt(id)); f.rows.get(id)!.state = "completed";
    }
    await expect(f.channel.refresh()).resolves.toBeUndefined();
    expect(f.api.list).toHaveBeenCalledExactlyOnceWith("0", false);
    expect(f.channel.snapshot.entries).toEqual([]);
    await f.api.enqueue(prompt("active")); f.rows.get("active")!.state = "accepted";
    await f.api.enqueue(prompt("refused")); f.rows.get("refused")!.state = "failed";
    await expect(f.channel.refresh(true)).resolves.toBeUndefined();
    expect(f.channel.snapshot.entries.map(entry => entry.payload.userMessageId)).toEqual(["active", "refused"]);
    expect(f.channel.snapshot.entries[1]?.state).toBe("failed");
    expect(f.channel.snapshot.cursor).toBe("5");
    f.rows.get("active")!.state = "interrupted";
    await f.channel.refresh();
    expect(f.channel.snapshot.entries[0]?.state).toBe("interrupted");
    expect(f.api.enqueue).toHaveBeenCalledTimes(5);
  });
  it("Stop resolves ambiguous POSTs, persists its epoch, and never cancels a future send on retry", async () => {
    const f = fixture(), enqueue = f.api.enqueue.getMockImplementation()!, stop = f.api.stop.getMockImplementation()!;
    f.api.enqueue.mockImplementationOnce(async body => { await enqueue(body); throw new TypeError("lost reply"); });
    await f.channel.enqueue(async () => prompt("one")); await f.channel.flush();
    await f.channel.stop(); await f.channel.enqueue(async () => prompt("two"));
    f.api.stop.mockImplementationOnce(async epoch => { await stop(epoch); throw new TypeError("lost stop reply"); });
    await f.channel.flush(); expect(f.api.stop).toHaveBeenCalledWith("0"); expect(f.order).toEqual(["one"]);
    const reopened = f.make(); await reopened.flush();
    expect(f.api.stop.mock.calls).toEqual([["0"], ["0"]]); expect(f.order).toEqual(["one", "two"]);
    expect(f.rows.get("two")?.receipt.epoch).toBe("1"); expect(reopened.snapshot.stop).toBeUndefined();
  });
  it("Stop cancels never-submitted work and settles with nothing running", async () => {
    const f = fixture(); await f.channel.enqueue(async () => prompt("one")); await f.channel.stop(); await f.channel.flush();
    expect(f.api.enqueue).not.toHaveBeenCalled(); expect(f.channel.snapshot.entries[0]?.state).toBe("cancelled");
    expect(f.channel.snapshot.stop).toBeUndefined();
  });
  it("blocks dispatch as soon as Stop is requested, even while its private fence waits for attachment preparation", async () => {
    const f = fixture(); await f.channel.enqueue(async () => prompt("one"));
    const attachment = defer<CloudV2Prompt>();
    const next = f.channel.enqueue(() => attachment.promise), stop = f.channel.stop();
    await f.channel.flush(); expect(f.api.enqueue).not.toHaveBeenCalled();
    attachment.resolve(prompt("two")); await Promise.all([next, stop]); await f.channel.flush();
    expect(f.api.enqueue).not.toHaveBeenCalled(); expect(f.channel.snapshot.entries.every(row => row.state === "cancelled")).toBe(true);
  });
  it("fences stale callbacks and submissions through account A → B → A, with backend/owner isolation", async () => {
    const f = fixture(), response = defer<CloudV2PromptReceipt>();
    await f.channel.enqueue(async () => prompt("one")); f.api.enqueue.mockImplementationOnce(() => response.promise);
    const pending = f.channel.flush(); await vi.waitFor(() => expect(f.api.enqueue).toHaveBeenCalled());
    f.retire(); const before = f.changed.mock.calls.length;
    response.resolve({ workspaceId: owner.workspaceId, chatId: owner.chatId, userMessageId: "one", sequence: "1", epoch: "0", acceptedAt: new Date(1).toISOString(), workspaceState: "running" });
    await pending; expect(f.changed.mock.calls).toHaveLength(before);
    await expect(f.channel.enqueue(async () => prompt("two"))).rejects.toThrow(/account|owner/i);
    for (const other of [{ ...owner, accountId: "account-b" }, { ...owner, backend: "https://other.example.test" }, { ...owner, organizationId: "other" }])
      expect((await f.journal.read(other)).entries).toEqual([]);
  });
  it("refuses changed payload replays and foreign chat receipts", async () => {
    const f = fixture(); await f.channel.enqueue(async () => prompt("one"));
    await expect(f.channel.enqueue(async () => ({ ...prompt("one"), model: "different" }))).rejects.toThrow(/changed/i);
    const real = f.api.enqueue.getMockImplementation()!;
    f.api.enqueue.mockImplementationOnce(async body => ({ ...await real(body), chatId: "foreign" }));
    await f.channel.flush(); expect(f.channel.snapshot.entries[0]?.phase).toBe("uncertain");
  });
  it("cannot roll back a committed Stop with a status page read before the fence", async () => {
    const f = fixture(); await f.channel.enqueue(async () => prompt("one")); await f.channel.flush();
    const old = { epoch: "0", items: [structuredClone(f.rows.get("one")!)], nextAfter: null }, gate = defer<typeof old>();
    f.api.list.mockImplementationOnce(() => gate.promise);
    const refreshing = f.channel.refresh(); await vi.waitFor(() => expect(f.api.list).toHaveBeenCalled());
    await f.channel.stop(); await f.channel.flush();
    expect(f.channel.snapshot.entries[0]?.state).toBe("cancelled");
    gate.resolve(old); await refreshing;
    expect(f.channel.snapshot).toMatchObject({ epoch: "1", entries: [{ state: "cancelled" }] });
  });
  it("can recover from transient private storage unavailability before submission", async () => {
    const f = fixture(), read = f.journal.read.bind(f.journal);
    vi.spyOn(f.journal, "read").mockRejectedValueOnce(new Error("Private storage unavailable")).mockImplementation(read);
    await expect(f.channel.enqueue(async () => prompt("one"))).rejects.toThrow("storage");
    await f.channel.enqueue(async () => prompt("one")); await f.channel.flush(); expect(f.order).toEqual(["one"]);
  });
});
