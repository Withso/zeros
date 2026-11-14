import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("keeps the rejection guard after server acknowledgement without sending the tombstone again", async () => {
    const f = await setup(); cleanups.push(f.close);
    f.mirror.connect(); await f.mirror.flush();
    await f.store.delete("gone"); await f.mirror.flush();
    expect(f.relay.softDeleted.has("gone")).toBe(true);
    await f.reconnect();
    expect(f.relay.tombstones()).toEqual([]);
    expect(f.store.list().chatDeletions).toContain("gone");
    await f.reconnect();
    expect(f.relay.tombstones()).toEqual([]);
  });

  it("an older checkpoint restored after the prune cannot resurrect the chat; unnamed chats are never deleted", async () => {
    const f = await setup(); cleanups.push(f.close);
    f.mirror.connect(); await f.mirror.flush();
    const checkpoint = await mkdtemp(join(tmpdir(), "worker-deletion-checkpoint-"));
    await cp(f.dir, checkpoint, { recursive: true });
    cleanups.push(() => rm(checkpoint, { recursive: true, force: true }));
    await f.store.delete("gone"); await f.mirror.flush();
    await f.reconnect();
    // The checkpoint predates the deletion; the original mirror stays offline.
    f.mirror.disconnect();
    const store = await SessionStore.open(checkpoint, WORKSPACE_KEY);
    expect(store.list().chats.map(chat => chat.id)).toContain("gone");
    await store.upsert({ id: "fresh", folder: WORKSPACE_KEY, title: "fresh" });
    const restored = new HistoryMirror(store, f.relay, () => true, value => value, { enabled: () => true, restored: () => true });
    cleanups.unshift(() => restored.dispose());
    f.relay.frames.length = 0;
    restored.connect(); await restored.flush();
    expect(f.relay.resent()).not.toContain("gone");
    expect(f.relay.softDeleted.has("gone")).toBe(true);
    expect(store.list().chats.map(chat => chat.id)).not.toContain("gone");
    expect(f.relay.resent()).toEqual(["fresh", "keep", "other"]);
    expect(store.list().chats.map(chat => chat.id).sort()).toEqual(["fresh", "keep", "other"]);
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

  it("retains only compact deletion evidence without the deleted chat's content", async () => {
    const f = await setup(); cleanups.push(f.close);
    f.mirror.connect(); await f.mirror.flush();
    await f.store.delete("gone");
    await f.mirror.flush(); await f.reconnect();
    const saved = await Promise.all((await readdir(f.dir)).filter(name => name.endsWith(".json"))
      .map(async name => JSON.parse(await readFile(join(f.dir, name), "utf8"))));
    expect(saved.find(row => row.chatId === "gone")).toMatchObject({ chat: null, rows: [], inbox: [], steers: [], turns: [], resets: [] });
    expect(saved.find(row => row.chatId === "gone")).not.toHaveProperty("nativeSessionId");
    expect(f.store.list().chats.map(chat => chat.id).sort()).toEqual(["keep", "other"]);
  });

  it.each([false, true])("keeps acknowledged deleted IDs fenced against a delayed upsert (restart: %s)", async restart => {
    const f = await setup(); cleanups.push(f.close);
    f.mirror.connect(); await f.mirror.flush();
    await f.store.delete("gone"); await f.mirror.flush();
    await f.reconnect();
    const store = restart ? await SessionStore.open(f.dir, WORKSPACE_KEY) : f.store;
    await expect(store.upsert({ id: "gone", folder: WORKSPACE_KEY, title: "Delayed renderer row" })).rejects.toThrow("deleted");
    expect(store.list().chats.map(chat => chat.id)).not.toContain("gone");
    expect(f.relay.softDeleted.has("gone")).toBe(true);
    expect(f.relay.resent()).not.toContain("gone");
  });

  it.each([false, true])("ends a failed local deletion reconciliation and retries it on the next connect (restored: %s)", async restored => {
    const f = await setup(); cleanups.push(f.close);
    f.mirror.connect(); await f.mirror.flush(); f.mirror.disconnect();
    const mirror = new HistoryMirror(f.store, f.relay, () => true, value => value, { enabled: () => true, restored: () => restored });
    cleanups.unshift(() => mirror.dispose());
    f.relay.digests.delete("gone"); f.relay.softDeleted.add("gone");
    await f.store.upsert({ id: "keep", folder: WORKSPACE_KEY, title: "Changed while offline" });
    const remove = vi.spyOn(f.store, "delete").mockRejectedValueOnce(new Error("Fixture persistence unavailable"));
    mirror.connect();
    await expect(mirror.flush()).resolves.toBe(false);
    expect(f.store.list().chats.map(chat => chat.id)).toContain("gone");
    f.relay.frames.length = 0;
    mirror.connect();
    expect(await mirror.flush()).toBe(true);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(f.store.list().chats.map(chat => chat.id)).not.toContain("gone");
    expect(f.relay.resent()).toEqual(restored ? ["keep", "other"] : ["keep"]);
    expect(f.relay.softDeleted.has("gone")).toBe(true);
  });

  it.each([false, true])("does not let an old local deletion failure disconnect a newer discovery (restored: %s)", async restored => {
    const f = await setup(); cleanups.push(f.close);
    f.mirror.connect(); await f.mirror.flush(); f.mirror.disconnect();
    const mirror = new HistoryMirror(f.store, f.relay, () => true, value => value, { enabled: () => true, restored: () => restored });
    cleanups.unshift(() => mirror.dispose());
    f.relay.digests.delete("gone"); f.relay.softDeleted.add("gone");
    const oldEntered = deferred(), newEntered = deferred(), newRelease = deferred();
    let failOld!: () => void;
    vi.spyOn(f.store, "delete").mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      failOld = () => reject(new Error("Previous connection's persistence failed")); oldEntered.resolve();
    }));
    mirror.connect(); await oldEntered.promise;
    const draining = mirror.flush();
    const discover = f.relay.historyDigests.bind(f.relay);
    f.relay.historyDigests = async () => { newEntered.resolve(); await newRelease.promise; return discover(); };
    try {
      mirror.disconnect(); mirror.connect(); await newEntered.promise;
      failOld(); await settled(); f.relay.frames.length = 0;
      await f.store.upsert({ id: "keep", folder: WORKSPACE_KEY, title: "Changed during new discovery" });
      await settled(); expect(f.relay.frames).toEqual([]);
      newRelease.resolve();
      expect(await draining).toBe(true);
      expect(await mirror.flush()).toBe(true);
      expect(f.relay.resent()).toEqual(restored ? ["keep", "other"] : ["keep"]);
      expect(f.relay.softDeleted.has("gone")).toBe(true);
    } finally { failOld(); newRelease.resolve(); await draining; }
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
