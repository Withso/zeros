import { mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { applyUpdate } from "@zeros/protocol/agent-messages";
import { SessionStore } from "../session-store";
import { HistoryMirror } from "../history-mirror";
import { FakeRelay, WORKSPACE_KEY } from "../../__tests__/worker-fixtures";

vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "worker-cadence-"));
  const store = await SessionStore.open(directory, WORKSPACE_KEY);
  await store.upsert({ id: "chat", folder: WORKSPACE_KEY, title: "Stream" });
  await store.enqueue("chat", { requestId: "turn", userMessageId: "user", prompt: [{ type: "text", text: "Go" }], startedAt: 0 });
  await store.claim("chat");
  // Stable identity also lets us compare with an unthrottled applyUpdate fold.
  await store.importMessages("chat", [{ msgId: "answer", kind: "text", createdAt: 0, payload: JSON.stringify({
    id: "answer", kind: "text", role: "agent", messageId: "stream", createdAt: 0, text: "",
  }) }]);
  const relay = new FakeRelay(); relay.connected = true;
  const mirror = new HistoryMirror(store, relay);
  mirror.connect(); await mirror.flush(); relay.frames = [];
  const chunk = () => ({ sessionId: "exec", update: { sessionUpdate: "agent_message_chunk" as const, messageId: "stream", content: { type: "text" as const, text: "x".repeat(100) } } });
  const cleanup = async () => { await mirror.dispose(); await store.flush(); await rm(directory, { recursive: true, force: true }); };
  return { directory, store, relay, mirror, chunk, cleanup };
}

it("bounds a 300-delta stream and preserves the final mirror and atomic disk snapshot", async () => {
  const { directory, store, relay, mirror, chunk, cleanup } = await setup();
  const disk = { writes: 0, bytes: 0, fsyncs: 0 };
  const realOpen = vi.mocked(open).getMockImplementation()!;
  vi.mocked(open).mockImplementation(async (...args) => {
    const file = await realOpen(...args);
    const write = file.writeFile.bind(file), sync = file.sync.bind(file);
    vi.spyOn(file, "writeFile").mockImplementation(async (data, options) => {
      disk.writes++; disk.bytes += Buffer.byteLength(data as string); return write(data, options);
    });
    vi.spyOn(file, "sync").mockImplementation(async () => { disk.fsyncs++; return sync(); });
    return file;
  });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(0);
  try {
    const mirrored = new Map(store.history("chat").map(row => [row.msgId, row]));
    let expected = store.snapshot("chat")!.messages;
    for (let i = 0; i < 300; i++) {
      const notification = chunk();
      expected = applyUpdate(expected, notification);
      await store.fold("chat", notification);
      await vi.advanceTimersByTimeAsync(10);
    }
    await store.finish("chat", "turn", { stopReason: "end_turn" });
    await tick(); // Completion must flush without advancing the cadence timer.
    const frames = relay.frames.filter(frame => frame.t === "history");
    for (const row of frames.flatMap(frame => frame.messages?.rows ?? [])) mirrored.set(row.msgId, row);
    const final = store.history("chat").find(row => row.msgId === "answer")!;
    const saved = JSON.parse(await readFile(join(directory, (await readdir(directory)).find(name => name.endsWith(".json"))!), "utf8"));
    const counts = { frames: frames.length, transactions: frames.length,
      mirrorBytes: frames.reduce((n, frame) => n + Buffer.byteLength(JSON.stringify(frame)), 0), ...disk };
    // Test-only measurements; each history frame maps to one writeHistory transaction.
    process.stdout.write(`300-delta persistence: ${JSON.stringify(counts)}\n`);
    expect(store.snapshot("chat")!.messages).toEqual(expected);
    expect(mirrored.get("answer")).toEqual(final);
    expect([...mirrored.values()]).toEqual(store.history("chat"));
    expect(saved.rows).toEqual(store.history("chat"));
    expect(saved.inbox[0].state).toBe("completed");
    expect(counts.frames).toBeLessThanOrEqual(4);
    expect(disk.writes).toBeLessThanOrEqual(7);
    expect(disk.fsyncs).toBe(disk.writes * 2);
    await mirror.flush();
  } finally { await cleanup(); }
});

it.each(["finish", "metadata", "delete", "shutdown", "reconnect"])("flushes pending rows immediately on %s", async action => {
  const { store, relay, mirror, chunk, cleanup } = await setup();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    await store.fold("chat", chunk()); await tick();
    expect(relay.frames).toEqual([]);
    if (action === "finish") await store.finish("chat", "turn", { stopReason: "end_turn" });
    if (action === "metadata") await store.upsert({ id: "chat", folder: WORKSPACE_KEY, title: "Renamed" });
    if (action === "delete") await store.delete("chat");
    if (action === "shutdown") await mirror.dispose();
    if (action === "reconnect") { mirror.disconnect(); mirror.connect(); }
    await tick();
    const frames = relay.frames.filter(frame => frame.t === "history");
    if (action === "delete") {
      expect(frames).toEqual([{ t: "history", chatDeletions: ["chat"] }]);
    } else {
      expect(frames.flatMap(frame => frame.messages?.rows ?? []).find(row => row.msgId === "answer"))
        .toEqual(store.history("chat").find(row => row.msgId === "answer"));
    }
  } finally { await cleanup(); }
});

it("R3: sends a streaming item to the control plane only when it is whole, never token by token", async () => {
  const { store, relay, mirror, chunk, cleanup } = await setup();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(0);
  try {
    // 300 deltas across 60 seconds: the live relay carries them, the durable mirror waits for the whole item.
    for (let i = 0; i < 300; i++) { await store.fold("chat", chunk()); await vi.advanceTimersByTimeAsync(200); }
    expect(relay.frames.filter(frame => frame.t === "history")).toEqual([]);
    // The next item starts: the previous one is whole and goes within the one-second gather.
    await store.fold("chat", { sessionId: "exec", update: { sessionUpdate: "tool_call", toolCallId: "tool", title: "Read", status: "pending" } } as never);
    await vi.advanceTimersByTimeAsync(1000);
    const rows = relay.frames.filter(frame => frame.t === "history").flatMap(frame => frame.messages?.rows ?? []);
    expect(rows.map(row => row.msgId)).toEqual(["answer"]);
    expect(JSON.parse(rows[0]!.payload).text).toBe("x".repeat(30_000));
    // The turn's end releases the new tail.
    await store.finish("chat", "turn", { stopReason: "end_turn" });
    await mirror.flush();
    const all = new Map(relay.frames.filter(frame => frame.t === "history").flatMap(frame => frame.messages?.rows ?? []).map(row => [row.msgId, row]));
    // Every row this turn produced reached the control plane in its final version.
    const produced = store.history("chat").filter(row => row.msgId === "answer" || row.kind === "tool");
    expect(produced.length).toBe(2);
    for (const row of produced) expect(all.get(row.msgId)).toEqual(row);
  } finally { await cleanup(); }
});

it("R3: a final flush (Stop) sends the held streaming item", async () => {
  const { store, relay, mirror, chunk, cleanup } = await setup();
  try {
    for (let i = 0; i < 5; i++) await store.fold("chat", chunk());
    expect(relay.frames.filter(frame => frame.t === "history")).toEqual([]);
    expect(await mirror.flush()).toBe(true);
    const answer = relay.frames.filter(frame => frame.t === "history").flatMap(frame => frame.messages?.rows ?? []).find(row => row.msgId === "answer");
    expect(JSON.parse(answer!.payload).text).toBe("x".repeat(500));
  } finally { await cleanup(); }
});

it("R3: a burst of completed tool items gathers into one write", async () => {
  const { store, relay, cleanup } = await setup();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(0);
  try {
    for (let i = 0; i < 10; i++) {
      await store.fold("chat", { sessionId: "exec", update: { sessionUpdate: "tool_call", toolCallId: `tool-${i}`, title: "Read", status: "pending" } } as never);
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(1000);
    // Nine whole items (the tenth is still the streaming tail) in at most two frames, never one per item.
    const frames = relay.frames.flatMap(frame => frame.t === "history" && frame.messages ? [frame.messages] : []);
    expect(frames.length).toBeLessThanOrEqual(2);
    expect(frames.flatMap(messages => messages.rows).filter(row => row.kind === "tool").length).toBeGreaterThanOrEqual(9);
  } finally { await cleanup(); }
});
