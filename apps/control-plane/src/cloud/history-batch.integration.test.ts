import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./execution/test-fixture.js";
// The real worker is a test oracle; the deployed control plane stays standalone.
import { SessionStore } from "../../../cloud-worker/src/sessions/session-store.js";
import { HistoryMirror } from "../../../cloud-worker/src/sessions/history-mirror.js";
import type { Transport } from "../../../cloud-worker/src/transport.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const digest = "b".repeat(64);
const row = (id: string) => ({ msgId: id, kind: "text", payload: JSON.stringify({ text: id }), createdAt: 1 });

suite("history-batch-v1: frames from several chats in one request and one transaction", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  const cleanups: Array<() => Promise<void>> = [];
  const capabilities = (batch = true) => `${f.features},history-replace-v1,history-digest-v1,chat-edit-v1${batch ? ",history-batch-v1" : ""}`;
  const batch = (sequence: number, frames: object[], batchFeature = true) =>
    f.worker("history/batch", { bootId: f.boot, sequence, frames }, { features: capabilities(batchFeature) });
  const window = async (chatId: string) => (await f.cp.store.windowMessages(f.workspace.id, chatId, 100)).map(value => value.msgId).sort();
  const historySequence = async () => Number((await pool.query("SELECT worker_history_sequence FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].worker_history_sequence);

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    f = await executionFixture(pool, { teamOwnership: true });
    await f.login(); await f.activate();
    const hello = await f.hello(capabilities());
    expect(hello.status).toBe(200);
    expect((await hello.json()).config.historyBatch).toBe(1);
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await f?.close();
    await f?.cp.teamSharing.signals.close();
    vi.restoreAllMocks();
  });

  it("writes two chats' rows in one request, advancing the sequence by the frame count; a replay changes nothing", async () => {
    const frames = [{ chats: [{ id: "a" }, { id: "b" }] }, { messages: { chatId: "a", rows: [row("a1"), row("a2")] } },
      { messages: { chatId: "b", rows: [row("b1")] } }];
    const response = await batch(1, frames);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sequence: 3 });
    expect(await historySequence()).toBe(3);
    expect(await window("a")).toEqual(["a1", "a2"]);
    expect(await window("b")).toEqual(["b1"]);
    const replay = await batch(1, frames);
    expect(replay.status).toBe(200);
    expect(await historySequence()).toBe(3);
  });

  it("keeps a replacement chain's digest rule inside one batch", async () => {
    const response = await batch(1, [{ chats: [{ id: "native" }] },
      { messages: { chatId: "native", replace: true, historyState: { revision: 0 }, rows: [row("first")], digest } }]);
    expect(response.status).toBe(200);
    const digests = await f.worker("history/digests", {}, { features: capabilities() });
    expect(await digests.json()).toEqual({ chats: [{ chatId: "native", digest }] });
  });

  it("commits all or nothing: a failing frame rolls back the frames before it", async () => {
    const response = await batch(1, [{ chats: [{ id: "a" }] }, { messages: { chatId: "a", rows: [row("a1")] } },
      { chatEditAcks: [{ chatId: "missing", version: "1" }] }]);
    expect(response.ok).toBe(false);
    expect(await historySequence()).toBe(0);
    expect(await window("a")).toEqual([]);
  });

  it("stamps each chat's digest when several replacements share one batch", async () => {
    const other = "c".repeat(64);
    expect((await batch(1, [{ chats: [{ id: "x" }] }, { messages: { chatId: "x", replace: true, historyState: { revision: 0 }, rows: [row("x1")], digest } },
      { chats: [{ id: "y" }] }, { messages: { chatId: "y", replace: true, historyState: { revision: 0 }, rows: [row("y1")], digest: other } }])).status).toBe(200);
    const digests = await (await f.worker("history/digests", {}, { features: capabilities() })).json();
    expect(digests.chats).toEqual(expect.arrayContaining([{ chatId: "x", digest }, { chatId: "y", digest: other }]));
  });

  it("refuses a batch when the worker did not advertise history-batch-v1, and a gap in the sequence", async () => {
    expect((await batch(1, [{ chats: [{ id: "a" }] }], false)).status).toBe(404);
    expect((await batch(1, [{ chats: [{ id: "a" }] }])).status).toBe(200);
    expect((await batch(5, [{ chats: [{ id: "b" }] }])).status).toBe(409);
  });

  it("a real worker mirror with batching leaves the control plane equal to the VM store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "history-batch-integration-"));
    const key = `cloud://${f.organizationId}/${f.workspace.id}`;
    const store = await SessionStore.open(directory, key);
    for (let chat = 0; chat < 4; chat++) {
      await store.upsert({ id: `chat-${chat}`, folder: key, title: `Chat ${chat}` });
      await store.importMessages(`chat-${chat}`, Array.from({ length: 3 }, (_, index) => ({ msgId: `row-${index}`, kind: "text", createdAt: index,
        payload: JSON.stringify({ id: `row-${index}`, kind: "text", role: "assistant", text: `${chat}/${index}`, createdAt: index }) })));
    }
    let sequence = 0, requests = 0;
    const transport: Transport = {
      start() {}, async dispose() {},
      historyDigests: async () => (await f.worker("history/digests", {}, { features: capabilities() })).json(),
      send: async () => { throw new Error("batched mirror sent a single frame"); },
      sendHistoryBatch: async frames => {
        requests++;
        const response = await batch(sequence + 1, frames.map(({ t: _t, ...frame }) => frame));
        if (!response.ok) return false;
        sequence += frames.length;
        return true;
      },
    };
    const mirror = new HistoryMirror(store, transport, () => true, value => value, { enabled: () => true, restored: () => false }, () => true);
    cleanups.push(async () => { mirror.disconnect(); await mirror.dispose(); await store.flush(); await rm(directory, { recursive: true, force: true }); });
    mirror.connect();
    expect(await mirror.flush()).toBe(true);
    // Four chats' full replacements (8 frames) in one request.
    expect(requests).toBe(1);
    for (let chat = 0; chat < 4; chat++) expect(await window(`chat-${chat}`)).toEqual(["row-0", "row-1", "row-2"]);
  });
});
