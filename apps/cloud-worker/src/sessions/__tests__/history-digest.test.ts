import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLOUD_V2_MAX_HISTORY_ROWS, HISTORY_DIGEST_FEATURE, type CloudV2HistoryDigestsReply, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { SessionStore } from "../session-store";
import { HistoryMirror } from "../history-mirror";
import { FakeRelay, WORKSPACE_KEY } from "../../__tests__/worker-fixtures";
import { CLOUD_WORKER_FEATURES } from "../../worker-features";

// history-digest-v1 (owner-approved wake cost). A clean reconnect reads the stored digests once and re-sends nothing
// unchanged; every repair case (offline gap, cut, older-checkpoint restore, CP loss) and any doubt still replaces.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/** Simulates the control plane: any write to a chat clears its digest (the database trigger); only a frame that carries
 * a digest stamps it, in the same transaction. */
class DigestRelay extends FakeRelay {
  digests = new Map<string, string | null>();
  reads = 0;
  fail?: Error;
  async historyDigests(): Promise<CloudV2HistoryDigestsReply> {
    this.reads++;
    if (this.fail) throw this.fail;
    return { chats: [...this.digests].map(([chatId, digest]) => ({ chatId, digest })) };
  }
  override async send(frame: CloudV2WorkerFrame): Promise<boolean> {
    const sent = await super.send(frame);
    if (frame.t === "history") {
      for (const chat of frame.chats ?? []) this.digests.set(chat.id, null);
      for (const chatId of frame.chatDeletions ?? []) this.digests.delete(chatId);
      if (frame.messages) this.digests.set(frame.messages.chatId, frame.messages.digest ?? null);
    }
    return sent;
  }
}

async function setup(options: { chats?: number; rows?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "worker-history-digest-"));
  const store = await SessionStore.open(directory, WORKSPACE_KEY);
  for (let c = 0; c < (options.chats ?? 3); c++) {
    await store.upsert({ id: `chat-${c}`, folder: WORKSPACE_KEY, title: `Chat ${c}` });
    await store.importMessages(`chat-${c}`, Array.from({ length: options.rows ?? 2 }, (_, i) => ({ msgId: `c${c}-r${i}`, kind: "text", createdAt: i,
      payload: JSON.stringify({ id: `c${c}-r${i}`, kind: "text", role: "assistant", text: `${c}/${i}`, createdAt: i }) })));
  }
  const relay = new DigestRelay(); relay.connected = true;
  const state = { enabled: true, restored: false };
  const mirror = new HistoryMirror(store, relay, () => true, value => value, { enabled: () => state.enabled, restored: () => state.restored });
  cleanups.push(async () => { await mirror.dispose(); await store.flush(); await rm(directory, { recursive: true, force: true }); });
  const reconnect = async () => { relay.frames.length = 0; mirror.disconnect(); mirror.connect(); await mirror.flush(); };
  const replaced = () => relay.frames.filter(frame => frame.t === "history" && frame.messages?.replace).map(frame => (frame as { messages: { chatId: string } }).messages.chatId).sort();
  return { store, relay, mirror, state, reconnect, replaced };
}

describe("history-digest-v1 (worker half)", () => {
  it("is advertised; the control plane opts in with config.historyDigest", () => {
    expect(HISTORY_DIGEST_FEATURE).toBe("history-digest-v1");
    expect(CLOUD_WORKER_FEATURES.split(",")).toContain(HISTORY_DIGEST_FEATURE);
  });

  it("a clean reconnect is one digests read and zero history frames", async () => {
    const f = await setup();
    f.mirror.connect(); await f.mirror.flush();
    expect(f.replaced()).toEqual(["chat-0", "chat-1", "chat-2"]);
    await f.reconnect();
    expect(f.relay.reads).toBe(2);
    expect(f.relay.frames.filter(frame => frame.t === "history")).toEqual([]);
  });

  it("stamps the digest only on the final frame of a multi-frame replacement", async () => {
    const f = await setup({ chats: 1, rows: CLOUD_V2_MAX_HISTORY_ROWS + 5 });
    f.mirror.connect(); await f.mirror.flush();
    const frames = f.relay.frames.filter(frame => frame.t === "history" && frame.messages) as Array<{ messages: { digest?: string } }>;
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.slice(0, -1).every(frame => frame.messages.digest === undefined)).toBe(true);
    expect(frames.at(-1)!.messages.digest).toMatch(/^[0-9a-f]{64}$/);
    await f.reconnect();
    expect(f.relay.frames.filter(frame => frame.t === "history")).toEqual([]);
  });

  it("repair cases still replace: an offline change and a cut replace only their chat", async () => {
    const f = await setup();
    f.mirror.connect(); await f.mirror.flush();
    f.mirror.disconnect();
    await f.store.upsert({ id: "chat-1", folder: WORKSPACE_KEY, title: "Renamed while offline" });
    await f.store.truncateMessages("chat-2", "c2-r1");
    f.relay.frames.length = 0;
    f.mirror.connect(); await f.mirror.flush();
    expect(f.replaced()).toEqual(["chat-1", "chat-2"]);
  });

  it("repair cases still replace: an older-checkpoint restore and a control plane that lost the rows replace everything", async () => {
    const f = await setup();
    // The control plane holds digests from a later state; this boot restored an older checkpoint.
    for (const chatId of ["chat-0", "chat-1", "chat-2"]) f.relay.digests.set(chatId, "f".repeat(64));
    f.state.restored = true;
    f.mirror.connect(); await f.mirror.flush();
    expect(f.relay.reads).toBe(0);
    expect(f.replaced()).toEqual(["chat-0", "chat-1", "chat-2"]);
    // Only the boot's first connect is forced; its replacement stamped fresh digests, so the next reconnect skips.
    await f.reconnect();
    expect(f.relay.reads).toBe(1); expect(f.replaced()).toEqual([]);
    f.relay.digests.clear();
    await f.reconnect();
    expect(f.replaced()).toEqual(["chat-0", "chat-1", "chat-2"]);
  });

  it("any doubt replaces: a read error, a 404, a missing or mismatched digest, or the capability off", async () => {
    const f = await setup();
    f.mirror.connect(); await f.mirror.flush();
    for (const fail of [new Error("socket hang up"), Object.assign(new Error("not found"), { status: 404 })]) {
      f.relay.fail = fail; await f.reconnect();
      expect(f.replaced()).toEqual(["chat-0", "chat-1", "chat-2"]);
    }
    f.relay.fail = undefined;
    f.relay.digests.set("chat-0", "0".repeat(64)); f.relay.digests.delete("chat-1");
    await f.reconnect();
    expect(f.replaced()).toEqual(["chat-0", "chat-1"]);
    f.state.enabled = false;
    const reads = f.relay.reads;
    await f.reconnect();
    expect(f.relay.reads).toBe(reads);
    expect(f.replaced()).toEqual(["chat-0", "chat-1", "chat-2"]);
    expect(JSON.stringify(f.relay.frames)).not.toContain("digest");
  });

  it("a chat-edit ACK pending on the replacement sends no digest for that chat", async () => {
    const f = await setup({ chats: 1 });
    f.mirror.connect();
    f.mirror.acknowledgeChatEdit("chat-0", "3");
    await f.mirror.flush();
    const frames = f.relay.frames.filter(frame => frame.t === "history") as Array<{ messages?: { digest?: string }; chatEditAcks?: unknown[] }>;
    expect(frames.some(frame => frame.chatEditAcks?.length)).toBe(true);
    expect(frames.some(frame => frame.messages?.digest)).toBe(false);
    await f.reconnect();
    expect(f.replaced()).toEqual(["chat-0"]);
  });

  it("flush waits for the digests read and the resulting sends (no early idle)", async () => {
    const f = await setup();
    f.mirror.connect(); await f.mirror.flush();
    f.mirror.disconnect();
    await f.store.upsert({ id: "chat-0", folder: WORKSPACE_KEY, title: "Changed" });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const read = f.relay.historyDigests.bind(f.relay);
    f.relay.historyDigests = async () => { await held; return read(); };
    f.relay.frames.length = 0;
    f.mirror.connect();
    let flushed = false;
    const flushing = f.mirror.flush().then(() => { flushed = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(flushed).toBe(false); expect(f.mirror.runtimeBusy).toBe(true);
    release(); await flushing;
    expect(f.replaced()).toEqual(["chat-0"]);
  });
});
