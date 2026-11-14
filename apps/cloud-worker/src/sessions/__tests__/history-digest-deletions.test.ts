import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudV2HistoryDigestsReplySchema, HISTORY_DIGEST_DELETIONS_FEATURE, type CloudV2HistoryDigestsReply, type CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { SessionStore } from "../session-store";
import { HistoryMirror } from "../history-mirror";
import { FakeRelay, WORKSPACE_KEY } from "../../__tests__/worker-fixtures";
import { CLOUD_WORKER_FEATURES } from "../../worker-features";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const settled = () => new Promise<void>(resolve => setImmediate(resolve));

// Older control planes list soft-deleted rows in chats[] with null digests.
class DeletionsRelay extends FakeRelay {
  digests = new Map<string, string | null>();
  softDeleted = new Set<string>();
  withDeleted = true;
  async historyDigests(): Promise<CloudV2HistoryDigestsReply> {
    const chats = [...this.digests].map(([chatId, digest]) => ({ chatId, digest }));
    if (!this.withDeleted) return { chats: [...chats, ...[...this.softDeleted].map(chatId => ({ chatId, digest: null }))] };
    return { chats, deleted: [...this.softDeleted] };
  }
  override async send(frame: CloudV2WorkerFrame): Promise<boolean> {
    const sent = await super.send(frame);
    if (frame.t === "history") {
      // The control plane's chat upsert revives a soft-deleted chat (store.ts deleted_at = NULL).
      for (const chat of frame.chats ?? []) { this.digests.set(chat.id, null); this.softDeleted.delete(chat.id); }
      for (const chatId of frame.chatDeletions ?? []) { this.digests.delete(chatId); this.softDeleted.add(chatId); }
      if (frame.messages) this.digests.set(frame.messages.chatId, frame.messages.digest ?? null);
    }
    return sent;
  }
  tombstones(): string[] { return this.frames.flatMap(frame => frame.t === "history" ? frame.chatDeletions ?? [] : []).sort(); }
  resent(): string[] { return this.frames.flatMap(frame => frame.t === "history" ? (frame.chats ?? []).map(chat => chat.id) : []).sort(); }
}

async function setup(directory?: string) {
  const dir = directory ?? await mkdtemp(join(tmpdir(), "worker-digest-deletions-"));
  const store = await SessionStore.open(dir, WORKSPACE_KEY);
  if (!directory) for (const id of ["keep", "gone", "other"]) await store.upsert({ id, folder: WORKSPACE_KEY, title: id });
  const relay = new DeletionsRelay(); relay.connected = true;
  const state = { restored: false, enabled: true };
  const mirror = new HistoryMirror(store, relay, () => true, value => value, { enabled: () => state.enabled, restored: () => state.restored });
  const reconnect = async () => { relay.frames.length = 0; mirror.disconnect(); mirror.connect(); await mirror.flush(); };
  const close = async () => { await mirror.dispose(); await store.flush(); if (!directory) await rm(dir, { recursive: true, force: true }); };
  return { dir, store, relay, mirror, state, reconnect, close };
}

describe("history-digest-deletions-v1 (worker half)", () => {
  it("is advertised, and the reply schema is bounded and disjoint", () => {
    expect(CLOUD_WORKER_FEATURES.split(",")).toContain(HISTORY_DIGEST_DELETIONS_FEATURE);
    expect(CloudV2HistoryDigestsReplySchema.safeParse({ chats: [{ chatId: "a", digest: null }], deleted: ["b"] }).success).toBe(true);
    expect(CloudV2HistoryDigestsReplySchema.safeParse({ chats: [{ chatId: "a", digest: null }], deleted: ["a"] }).success).toBe(false);
    expect(CloudV2HistoryDigestsReplySchema.safeParse({ chats: Array.from({ length: 4000 }, (_, i) => ({ chatId: `c${i}`, digest: null })),
      deleted: Array.from({ length: 97 }, (_, i) => `d${i}`) }).success).toBe(false);
  });

  it("a locally deleted chat whose live row still exists on the server still gets its tombstone", async () => {
    const f = await setup(); cleanups.push(f.close);
    f.mirror.connect(); await f.mirror.flush();
    f.mirror.disconnect();
    await f.store.delete("gone");
    await f.reconnect();
    expect(f.relay.tombstones()).toEqual(["gone"]);
  });

  it("a server row that is soft-deleted is treated as absent: no tombstone, and the local one is pruned", async () => {
    const f = await setup(); cleanups.push(f.close);
    f.mirror.connect(); await f.mirror.flush();
    await f.store.delete("gone"); await f.mirror.flush();
    expect(f.relay.softDeleted.has("gone")).toBe(true);
    await f.reconnect();
    expect(f.relay.tombstones()).toEqual([]);
    expect(f.store.list().chatDeletions).not.toContain("gone");
    await f.reconnect();
    expect(f.relay.tombstones()).toEqual([]);
  });

  it("an older checkpoint restored after the prune cannot resurrect the chat; unnamed chats are never deleted", async () => {
    const f = await setup(); cleanups.push(f.close);
    f.mirror.connect(); await f.mirror.flush();
    await f.store.delete("gone"); await f.mirror.flush();
    await f.reconnect();
    // The checkpoint predates the deletion; the original mirror stays offline.
    f.mirror.disconnect();
    await f.store.upsert({ id: "gone", folder: WORKSPACE_KEY, title: "gone" });
    await f.store.upsert({ id: "fresh", folder: WORKSPACE_KEY, title: "fresh" });
    f.state.restored = true;
    const restored = new HistoryMirror(f.store, f.relay, () => true, value => value, { enabled: () => true, restored: () => true });
    f.relay.frames.length = 0;
    restored.connect(); await restored.flush();
    expect(f.relay.resent()).not.toContain("gone");
    expect(f.relay.softDeleted.has("gone")).toBe(true);
    expect(f.store.list().chats.map(chat => chat.id)).not.toContain("gone");
    expect(f.relay.resent()).toEqual(["fresh", "keep", "other"]);
    expect(f.store.list().chats.map(chat => chat.id).sort()).toEqual(["fresh", "keep", "other"]);
    await restored.dispose();
  });

  it("N−1 control plane (no deleted list): soft-deleted rows listed with null digests still get tombstones; nothing is pruned or deleted", async () => {
    const f = await setup(); cleanups.push(f.close);
    f.relay.withDeleted = false;
    f.mirror.connect(); await f.mirror.flush();
    await f.store.delete("gone"); await f.mirror.flush();
    await f.reconnect();
    expect(f.relay.tombstones()).toEqual(["gone"]);
    expect(f.store.list().chatDeletions).toContain("gone");
    f.relay.softDeleted.delete("gone");
    await f.reconnect();
    expect(f.relay.tombstones()).toEqual([]);
    expect(f.store.list().chatDeletions).toContain("gone");
  });

  it("sends every tombstone after a failed read", async () => {
    const f = await setup(); cleanups.push(f.close);
    f.mirror.connect(); await f.mirror.flush();
    await f.store.delete("gone"); await f.mirror.flush();
    f.relay.historyDigests = async () => { throw Object.assign(new Error("not found"), { status: 404 }); };
    await f.reconnect();
    expect(f.relay.tombstones()).toEqual(["gone"]);
    expect(f.store.list().chatDeletions).toContain("gone");
  });

  it("pruning removes only the tombstone file, never a live chat", async () => {
    const f = await setup(); cleanups.push(f.close);
    expect(await f.store.forgetTombstone("keep")).toBe(false);
    await f.store.delete("gone");
    const before = (await readdir(f.dir)).length;
    expect(await f.store.forgetTombstone("gone")).toBe(true);
    expect((await readdir(f.dir)).length).toBe(before - 1);
    expect(f.store.list().chats.map(chat => chat.id).sort()).toEqual(["keep", "other"]);
  });

  it("can flush through a legacy reconnect after disconnecting during digest discovery", async () => {
    const f = await setup(); cleanups.push(f.close);
    const entered = deferred(), release = deferred();
    const discover = f.relay.historyDigests.bind(f.relay);
    f.relay.historyDigests = async () => { entered.resolve(); await release.promise; return discover(); };
    try {
      f.mirror.connect(); await entered.promise;
      f.mirror.disconnect(); release.resolve(); await settled();
      f.state.enabled = false; f.mirror.connect(); await settled();
      expect(f.relay.resent()).toEqual(["gone", "keep", "other"]);
      expect(await f.mirror.flush()).toBe(true);
    } finally {
      release.resolve(); f.state.enabled = true; f.relay.historyDigests = discover;
      await f.reconnect();
    }
  });

  it.each(["discovery", "history frame"])("does not let an old %s completion release the next connection's discovery", async previous => {
    const f = await setup(); cleanups.push(f.close);
    const oldEntered = deferred(), oldRelease = deferred(), newEntered = deferred(), newRelease = deferred();
    const discover = f.relay.historyDigests.bind(f.relay), send = f.relay.send.bind(f.relay);
    let firstRead = true, firstSend = true;
    f.state.enabled = previous === "discovery";
    f.relay.historyDigests = async () => {
      if (previous === "discovery" && firstRead) {
        firstRead = false; oldEntered.resolve(); await oldRelease.promise;
      } else { newEntered.resolve(); await newRelease.promise; }
      return discover();
    };
    f.relay.send = async frame => {
      if (previous === "history frame" && firstSend) {
        firstSend = false; oldEntered.resolve(); await oldRelease.promise;
      }
      return send(frame);
    };
    try {
      f.mirror.connect(); await oldEntered.promise;
      f.mirror.disconnect(); f.state.enabled = true; f.mirror.connect(); await newEntered.promise;
      oldRelease.resolve(); await settled(); f.relay.frames.length = 0;
      await f.store.upsert({ id: "keep", folder: WORKSPACE_KEY, title: "Changed during discovery" });
      await settled();
      expect(f.relay.frames).toEqual([]);
      newRelease.resolve(); await settled();
      expect(await f.mirror.flush()).toBe(true);
      expect(f.relay.resent()).toContain("keep");
    } finally { oldRelease.resolve(); newRelease.resolve(); await settled(); }
  });
});
