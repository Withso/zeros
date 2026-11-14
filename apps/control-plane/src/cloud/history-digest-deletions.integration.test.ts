import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { LoadBudgetProbe, scenarioTotals } from "../test-support/load-budget.js";
import { executionFixture, type ExecutionFixture } from "./execution/test-fixture.js";
import { newCloudV2Token } from "./tokens.js";
// Only the integration test imports the worker; the deployed control plane stays standalone.
import { SessionStore } from "../../../cloud-worker/src/sessions/session-store.js";
import { HistoryMirror } from "../../../cloud-worker/src/sessions/history-mirror.js";
import type { Transport } from "../../../cloud-worker/src/transport.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const deletionFeature = "history-digest-deletions-v1";
const digest = "a".repeat(64);

suite("negotiated history deletion reconciliation", () => {
  let pool: pg.Pool, probe: LoadBudgetProbe, f: ExecutionFixture, sequence: number;
  const cleanups: Array<() => Promise<void>> = [];
  const features = () => `${f.features},history-replace-v1,history-digest-v1,chat-edit-v1`;
  const read = (advertised = `${features()},${deletionFeature}`, options: { token?: string; boot?: string } = {}) =>
    f.worker("history/digests", {}, { features: advertised, ...options });
  const write = (input: object) => f.worker("history", { t: "history", bootId: f.boot, sequence: ++sequence, ...input }, { features: features() });
  const change = (query: string, values: unknown[] = [f.workspace.id]) => withSystemTx(pool, tx => tx.query(query, values));

  async function nativeMirror(options: { ids?: string[]; directory?: string; restored?: boolean; legacyReply?: boolean } = {}) {
    const directory = options.directory ?? await mkdtemp(join(tmpdir(), "history-deletions-"));
    const key = `cloud://${f.organizationId}/${f.workspace.id}`;
    const store = await SessionStore.open(directory, key);
    for (const id of options.ids ?? (options.directory ? [] : ["keep", "gone", "other"])) {
      await store.upsert({ id, folder: key, title: id });
      await store.importMessages(id, [{ msgId: `${id}-row`, kind: "text", createdAt: 1,
        payload: JSON.stringify({ id: `${id}-row`, kind: "text", role: "assistant", text: id, createdAt: 1 }) }]);
    }
    const frames: Array<Extract<Parameters<Transport["send"]>[0], { t: "history" }>> = [];
    const state = { enabled: true, restored: options.restored ?? false };
    let reads = 0;
    const transport: Transport = {
      start() {}, async dispose() {},
      historyDigests: async () => {
        reads++;
        const response = await read(options.legacyReply ? features() : undefined);
        if (!response.ok) throw new Error(`digest read: ${response.status}`);
        return response.json();
      },
      send: async frame => {
        if (frame.t !== "history") throw new Error("unexpected mirror frame");
        frames.push(frame);
        const response = await write(frame);
        if (!response.ok) throw new Error(`history write: ${response.status}`);
        return true;
      },
    };
    const mirror = new HistoryMirror(store, transport, () => true, value => value,
      { enabled: () => state.enabled, restored: () => state.restored });
    cleanups.push(async () => {
      mirror.disconnect(); await mirror.dispose(); await store.flush();
      if (!options.directory) await rm(directory, { recursive: true, force: true });
    });
    const connect = async () => { mirror.connect(); expect(await mirror.flush()).toBe(true); };
    return { directory, key, store, mirror, transport, frames, state, connect, reads: () => reads,
      deleted: () => frames.flatMap(frame => frame.chatDeletions ?? []).sort(),
      replaced: () => frames.filter(frame => frame.messages?.replace).map(frame => frame.messages!.chatId).sort(),
      reconnect: async () => { frames.length = 0; reads = 0; mirror.disconnect(); await connect(); } };
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
    probe = new LoadBudgetProbe(pool);
  });
  afterAll(async () => { probe.close(); await pool.end(); });
  beforeEach(async () => {
    sequence = 0;
    f = await executionFixture(pool, { teamOwnership: true });
    await f.login(); await f.activate();
    expect((await f.hello(features())).status).toBe(200);
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await f?.close(); await f?.cp.teamSharing.signals.close();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it("returns an explicit empty deletion list only for the negotiated feature", async () => {
    expect(await (await read()).json()).toEqual({ chats: [], deleted: [] });
    expect(await (await read(features())).json()).toEqual({ chats: [] });
  });

  it("separates soft-deleted rows from live null digests within the authenticated workspace", async () => {
    expect((await write({ chats: [{ id: "live-null" }, { id: "stamped" }] })).status).toBe(200);
    expect((await write({ messages: { chatId: "stamped", rows: [], replace: true, historyState: { revision: 0 }, digest } })).status).toBe(200);
    expect((await write({ chatDeletions: ["deleted"] })).status).toBe(200);
    await f.cp.store.writeHistory(f.own.id, { chats: [{ id: "foreign-live" }], chatDeletions: ["foreign-deleted"] });
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      chats: [{ chatId: "live-null", digest: null }, { chatId: "stamped", digest }], deleted: ["deleted"],
    });
  });

  it.each(["", "history-digest-deletions-v10", "history-digest-deletions-v1-extra"])(
    "preserves the strict N-1 reply for a worker advertising %s", async extra => {
      expect((await write({ chats: [{ id: "live" }], chatDeletions: ["deleted"] })).status).toBe(200);
      const response = await read(`${features()},${extra}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ chats: [{ chatId: "deleted", digest: null }, { chatId: "live", digest: null }] });
    });

  it("keeps old soft-deleted rows until workspace history is removed", async () => {
    expect((await write({ chats: [{ id: "deleted", title: "Before deletion" }], messages: {
      chatId: "deleted", rows: [{ msgId: "row", kind: "text", payload: "old", createdAt: 1 }],
    } })).status).toBe(200);
    await f.cp.store.chatEdits.applyForManager({ organizationId: f.organizationId, userId: f.creator.id },
      f.workspace.id, "deleted", { title: "Pending edit" }, async () => {});
    expect((await write({ chatDeletions: ["deleted"] })).status).toBe(200);
    await change("UPDATE cloud_v2_chats SET deleted_at=clock_timestamp()-interval '365 days' WHERE workspace_id=$1");
    expect((await change(`SELECT (SELECT count(*) FROM cloud_v2_messages WHERE workspace_id=$1)::int AS messages,
      (SELECT count(*) FROM cloud_v2_chat_edits WHERE workspace_id=$1)::int AS edits`)).rows).toEqual([{ messages: 0, edits: 0 }]);
    expect(await (await read()).json()).toEqual({ chats: [], deleted: ["deleted"] });
    await f.cp.store.revoke(f.workspace.id, true);
    expect((await change("SELECT chat_id FROM cloud_v2_chats WHERE workspace_id=$1")).rows).toEqual([]);
  });

  it("keeps the established N-1 upsert revival behavior", async () => {
    expect((await write({ chatDeletions: ["deleted"] })).status).toBe(200);
    expect(await (await read(features())).json()).toEqual({ chats: [{ chatId: "deleted", digest: null }] });
    expect((await write({ chats: [{ id: "deleted", title: "N-1 resend" }] })).status).toBe(200);
    expect((await change("SELECT deleted_at,row->>'title' AS title FROM cloud_v2_chats WHERE workspace_id=$1")).rows)
      .toEqual([{ deleted_at: null, title: "N-1 resend" }]);
    expect(await (await read()).json()).toEqual({ chats: [{ chatId: "deleted", digest: null }], deleted: [] });
  });

  it.each([0, 2048, 4096])("bounds a combined reply with %s deleted rows and never returns a partial list", async deleted => {
    await change(`INSERT INTO cloud_v2_chats(workspace_id,chat_id,row,deleted_at)
      SELECT $1,'chat-' || id,'{}'::jsonb,CASE WHEN id<=$2 THEN clock_timestamp() END FROM generate_series(1,4096) id`, [f.workspace.id, deleted]);
    const accepted = await read();
    expect(accepted.status).toBe(200);
    const reply = await accepted.json() as { chats: unknown[]; deleted: unknown[] };
    expect(reply.chats).toHaveLength(4096 - deleted); expect(reply.deleted).toHaveLength(deleted);
    await change("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row,deleted_at) VALUES($1,'overflow','{}',clock_timestamp())");
    const overflow = await read();
    expect(overflow.status).toBe(503);
    expect(await overflow.json()).toMatchObject({ error: { code: "history_digest_limit" } });
  });

  it.each([false, true])("keeps the digest read at one transaction and five SQL statements with deleted=%s", async includeDeleted => {
    expect((await write({ chats: [{ id: "live" }], chatDeletions: ["deleted"] })).status).toBe(200);
    await f.cp.loginChanges.stop();
    const { cost } = await probe.measure("history-deletions", () => probe.request(
      new Request("https://api.example.test/v2/cloud/worker/history/digests", { method: "POST" }),
      () => read(includeDeleted ? undefined : features()),
    ));
    expect(scenarioTotals(cost)).toMatchObject({ requests: 1, queries: 1, transactions: 1, statements: 5, failures: 0, inFlight: 0 });
  });

  it("delivers a local tombstone while the server still lists its live row with a null digest", async () => {
    const native = await nativeMirror();
    await native.connect();
    native.mirror.disconnect();
    await native.store.delete("gone");
    await change("UPDATE cloud_v2_chats SET row=row WHERE workspace_id=$1 AND chat_id='gone'");
    expect(await (await read()).json()).toMatchObject({ chats: expect.arrayContaining([{ chatId: "gone", digest: null }]) });
    await native.reconnect();
    expect(native.reads()).toBe(1);
    expect(native.deleted()).toEqual(["gone"]);
    expect(native.replaced()).toEqual([]);
    expect(await (await read()).json()).toMatchObject({ deleted: ["gone"] });
    expect(await f.cp.store.windowMessages(f.workspace.id, "gone", 10)).toEqual([]);
  });

  it("skips seven acknowledged tombstone POSTs and retains their durable rejection guards", async () => {
    const deleted = Array.from({ length: 7 }, (_, index) => `deleted-${index}`);
    const native = await nativeMirror({ ids: ["keep", ...deleted] });
    await native.connect();
    for (const id of deleted) await native.store.delete(id);
    expect(await native.mirror.flush()).toBe(true);
    expect(native.store.list().chatDeletions.sort()).toEqual(deleted);
    expect(await (await read()).json()).toMatchObject({ deleted });
    await native.reconnect();
    expect(native.reads()).toBe(1); expect(native.frames).toEqual([]);
    expect(native.store.list().chatDeletions.sort()).toEqual(deleted);
    await native.store.flush();
    const reopened = await SessionStore.open(native.directory, native.key);
    expect(reopened.list().chatDeletions.sort()).toEqual(deleted);
    for (const id of deleted)
      await expect(reopened.upsert({ id, folder: native.key, title: "Delayed row" })).rejects.toThrow("deleted");
    expect(reopened.list().chats.map(chat => chat.id)).toEqual(["keep"]);
    expect(await (await read()).json()).toMatchObject({ deleted });
  });

  it("restores an older checkpoint without reviving named deletions or deleting an unnamed chat", async () => {
    const native = await nativeMirror();
    await native.connect(); await native.store.flush();
    native.mirror.disconnect();
    const checkpoint = await mkdtemp(join(tmpdir(), "history-deletions-checkpoint-"));
    cleanups.push(() => rm(checkpoint, { recursive: true, force: true }));
    await cp(native.directory, checkpoint, { recursive: true });
    expect((await write({ chatDeletions: ["gone"] })).status).toBe(200);
    await f.cp.store.writeHistory(f.own.id, { chatDeletions: ["other"] });
    const restored = await nativeMirror({ directory: checkpoint, restored: true, ids: ["unknown"] });
    expect(restored.store.list().chats.map(chat => chat.id).sort()).toEqual(["gone", "keep", "other", "unknown"]);
    await restored.connect();
    expect(restored.reads()).toBe(1);
    expect(restored.deleted()).toEqual([]);
    expect(restored.replaced()).toEqual(["keep", "other", "unknown"]);
    expect(restored.frames.some(frame => frame.chats?.some(chat => chat.id === "gone"))).toBe(false);
    expect(restored.store.list().chats.map(chat => chat.id).sort()).toEqual(["keep", "other", "unknown"]);
    expect(await (await read()).json()).toMatchObject({ deleted: ["gone"] });
    expect(await f.cp.store.windowMessages(f.workspace.id, "gone", 10)).toEqual([]);
    for (const id of ["keep", "other", "unknown"])
      expect(await f.cp.store.windowMessages(f.workspace.id, id, 10)).toEqual(restored.store.history(id));
    await restored.reconnect();
    expect(restored.reads()).toBe(1); expect(restored.frames).toEqual([]);
  });

  it("keeps new-worker fallback compatible with the exact N-1 control-plane reply", async () => {
    const native = await nativeMirror({ legacyReply: true });
    await native.connect();
    await native.store.delete("gone");
    expect(await native.mirror.flush()).toBe(true);
    await native.reconnect();
    expect(native.deleted()).toEqual(["gone"]);
    expect(native.store.list().chatDeletions).toContain("gone");
    expect(native.store.list().chats.map(chat => chat.id).sort()).toEqual(["keep", "other"]);
    expect(await (await read(features())).json()).not.toHaveProperty("deleted");
  });

  it.each(["404", "network", "invalid", "over-cap", "disabled", "restored"])(
    "retains tombstones and full replacement when discovery is %s", async failure => {
      const native = await nativeMirror({ restored: failure === "restored" });
      await native.store.delete("gone");
      expect((await write({ chatDeletions: ["gone"] })).status).toBe(200);
      if (failure === "404" || failure === "network")
        native.transport.historyDigests = async () => { throw Object.assign(new Error("unavailable"), { status: failure === "404" ? 404 : undefined }); };
      if (failure === "invalid") native.transport.historyDigests = async () => ({ chats: [], deleted: ["keep"], invalid: true });
      if (failure === "over-cap") native.transport.historyDigests = async () => ({
        chats: Array.from({ length: 4096 }, (_, index) => ({ chatId: `remote-${index}`, digest: null })), deleted: ["keep"],
      });
      if (failure === "disabled") native.state.enabled = false;
      await native.connect();
      expect(native.deleted()).toEqual(failure === "restored" ? [] : ["gone"]);
      expect(native.replaced()).toEqual(["keep", "other"]);
      expect(native.store.list().chatDeletions).toContain("gone");
      expect(native.store.list().chats.map(chat => chat.id).sort()).toEqual(["keep", "other"]);
      if (failure !== "restored") expect(native.frames.some(frame => frame.messages?.digest !== undefined)).toBe(false);
      expect(await (await read()).json()).toMatchObject({ deleted: ["gone"] });
    });

  it("does not apply a deletion reply after the connection that requested it closes", async () => {
    const native = await nativeMirror();
    expect((await write({ chatDeletions: ["gone"] })).status).toBe(200);
    const discover = native.transport.historyDigests!;
    let observed!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { observed = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    native.transport.historyDigests = async () => {
      const reply = await discover(); observed(); await held; return reply;
    };
    try {
      native.mirror.connect(); await ready;
      native.mirror.disconnect(); release();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(native.frames).toEqual([]);
      expect(native.store.list().chats.map(chat => chat.id).sort()).toEqual(["gone", "keep", "other"]);
      native.transport.historyDigests = discover;
      await native.reconnect();
      expect(native.store.list().chats.map(chat => chat.id).sort()).toEqual(["keep", "other"]);
      expect(native.replaced()).toEqual(["keep", "other"]);
    } finally { release(); }
  });

  it("sends a new local deletion made while the digests read is in flight", async () => {
    const native = await nativeMirror(); await native.connect();
    const discover = native.transport.historyDigests!;
    native.transport.historyDigests = async () => {
      const reply = await discover(); await native.store.delete("gone"); return reply;
    };
    await native.reconnect();
    expect(native.deleted()).toEqual(["gone"]);
    expect(native.replaced()).toEqual([]);
    expect(await (await read()).json()).toMatchObject({ deleted: ["gone"] });
  });

  it.each(["token", "boot", "organization"])("retains the current %s authority check for deletion lists", async revoked => {
    expect((await write({ chatDeletions: ["deleted"] })).status).toBe(200);
    if (revoked === "organization") await pool.query("UPDATE organizations SET cloud_workspaces_allowed=false WHERE id=$1", [f.organizationId]);
    const options = { ...(revoked === "token" ? { token: newCloudV2Token("worker").token } : {}),
      ...(revoked === "boot" ? { boot: randomUUID() } : {}) };
    expect((await read(undefined, options)).status).toBe(401);
  });
});
