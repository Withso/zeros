import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CloudV2MessageRow, CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import { SessionStore } from "../session-store";
import { HistoryMirror } from "../history-mirror";
import { FakeRelay, WORKSPACE_KEY } from "../../__tests__/worker-fixtures";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup(count: number, enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), "worker-history-cut-"));
  const store = await SessionStore.open(directory, WORKSPACE_KEY);
  await store.upsert({ id: "chat", folder: WORKSPACE_KEY });
  const rows = Array.from({ length: count }, (_, index) => ({ msgId: `row-${index}`, kind: "text", createdAt: index,
    payload: JSON.stringify({ id: `row-${index}`, kind: "text", role: "assistant", text: `${index}`, createdAt: index }) }));
  await store.importMessages("chat", rows);
  const relay = new FakeRelay(); relay.connected = true;
  const mirror = new HistoryMirror(store, relay, () => enabled);
  cleanups.push(async () => { await mirror.dispose(); await store.flush(); await rm(directory, { recursive: true, force: true }); });
  return { store, relay, mirror, rows, setEnabled: (value: boolean) => { enabled = value; } };
}
function mirrored(frames: CloudV2WorkerFrame[]) {
  const rows = new Map<string, CloudV2MessageRow>();
  for (const frame of frames) if (frame.t === "history" && frame.messages) {
    if (frame.messages.replace) rows.clear();
    for (const row of frame.messages.rows) rows.set(row.msgId, row);
  }
  return [...rows.values()];
}

it("clears an empty cut and replays that clear after reconnect", async () => {
  const f = await setup(3);
  f.mirror.connect(); await f.mirror.flush();
  await f.store.truncateMessages("chat", "row-0"); await f.mirror.flush();
  expect(f.relay.frames).toContainEqual({ t: "history", messages: { chatId: "chat", replace: true, rows: [], historyState: { revision: 1 } } });
  expect(mirrored(f.relay.frames)).toEqual([]);
  f.relay.frames.length = 0;
  f.mirror.disconnect(); f.mirror.connect(); await f.mirror.flush();
  expect(f.relay.frames).toContainEqual({ t: "history", messages: { chatId: "chat", replace: true, rows: [], historyState: { revision: 1 } } });
});

it("drops the unsent tail of an old backfill when a cut lands during its held first batch", async () => {
  const f = await setup(600), send = f.relay.send.bind(f.relay);
  let entered!: () => void, release!: () => void, once = true;
  const held = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  f.relay.send = async frame => {
    if (once && frame.t === "history" && frame.messages) { once = false; entered(); await wait; }
    return send(frame);
  };
  f.mirror.connect(); await held;
  try { await f.store.truncateMessages("chat", "row-20"); } finally { release(); }
  await f.mirror.flush();
  expect(mirrored(f.relay.frames)).toEqual(f.rows.slice(0, 20));
  const batches = f.relay.frames.flatMap(frame => frame.t === "history" && frame.messages ? [frame.messages] : []);
  expect(batches).toHaveLength(2);
  expect(batches[1]).toMatchObject({ replace: true, rows: f.rows.slice(0, 20) });
});

it("reconnects from the current disk transcript after an offline cut", async () => {
  const f = await setup(4);
  f.mirror.connect(); await f.mirror.flush(); f.mirror.disconnect();
  await f.store.truncateMessages("chat", "row-2");
  f.mirror.connect(); await f.mirror.flush();
  expect(mirrored(f.relay.frames)).toEqual(f.rows.slice(0, 2));
});

it("keeps the previous history wire shape when replacement is not negotiated", async () => {
  const f = await setup(2, false);
  f.mirror.connect(); await f.mirror.flush();
  expect(f.relay.frames.filter(frame => frame.t === "history" && frame.messages)).toEqual([
    { t: "history", messages: { chatId: "chat", rows: f.rows } },
  ]);
});

it("fails the mirror closed when an online configuration loses replacement support after a cut", async () => {
  const f = await setup(2);
  f.mirror.connect(); await f.mirror.flush();
  await f.store.truncateMessages("chat", "row-1"); await f.mirror.flush();
  f.relay.frames.length = 0;
  f.setEnabled(false); f.mirror.connect();
  await f.store.upsert({ id: "chat", title: "After downgrade" });
  expect(await f.mirror.flush()).toBe(false);
  expect(f.relay.frames).toEqual([]);
  f.setEnabled(true); f.mirror.connect();
  expect(await f.mirror.flush()).toBe(true);
  expect(mirrored(f.relay.frames)).toEqual(f.rows.slice(0, 1));
});

it("publishes the cut revision and confirmed Stop epoch with replacement and retains it across metadata writes", async () => {
  const f = await setup(2);
  f.mirror.connect(); await f.mirror.flush(); f.relay.frames.length = 0;
  await f.store.stopOutbox("chat", "7");
  await f.store.truncateMessages("chat", "row-0"); await f.mirror.flush();
  expect(f.relay.frames).toContainEqual({ t: "history", messages: { chatId: "chat", replace: true, rows: [], historyState: { revision: 1, beforeEpoch: "7" } } });
  await f.store.upsert({ id: "chat", title: "Renamed", historyState: { revision: 99, beforeEpoch: "100" } });
  f.relay.frames.length = 0; f.mirror.disconnect(); f.mirror.connect(); await f.mirror.flush();
  expect(f.relay.frames).toContainEqual({ t: "history", messages: { chatId: "chat", replace: true, rows: [], historyState: { revision: 1, beforeEpoch: "7" } } });
});
