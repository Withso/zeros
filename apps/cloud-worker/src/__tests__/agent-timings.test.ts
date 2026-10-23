import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import type { DriverOpen } from "../drivers/driver";
import { CloudWorker } from "../worker";
import { CLIENT_A, FakeDriver, FakeRelay, WORKSPACE_KEY, browserFrame, config } from "./worker-fixtures";

interface Timing { agent: string; chat: string; phase: string; stage: string; elapsedMs: number }
type TimedOpen = DriverOpen & { onTiming?(stage: "process_ready" | "turn_sent" | "first_provider_event"): void };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

async function setup(observer?: (timing: Timing) => void) {
  const directory = await mkdtemp(join(tmpdir(), "worker-timing-")), relay = new FakeRelay(), driver = new FakeDriver();
  const records: Timing[] = [], events: TimedOpen[] = [];
  const open = driver.open.bind(driver), prompt = driver.prompt.bind(driver);
  vi.spyOn(driver, "open").mockImplementation(async input => { events.push(input); const result = await open(input); (input as TimedOpen).onTiming?.("process_ready"); return result; });
  vi.spyOn(driver, "prompt").mockImplementation(content => { events.at(-1)!.onTiming?.("turn_sent"); return prompt(content); });
  const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {}, drivers: { codex: () => driver },
    onTiming: (record: Timing) => { records.push(record); observer?.(record); } });
  cleanups.push(async () => { await worker.dispose(); await rm(directory, { force: true, recursive: true }); });
  worker.start(); await relay.receive(config); await relay.receive({ t: "open", clientId: CLIENT_A });
  const chatId = "private-chat-prefix-01234567-89ab-cdef-0123-456789abcdef";
  await relay.request(CLIENT_A, browserFrame("WORKSPACE_REQUEST", { op: "chats.upsert", params: { chat: { id: chatId, folder: WORKSPACE_KEY, agentId: "codex", model: "private-model" } } }));
  const opening = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId, cwd: WORKSPACE_KEY });
  await relay.request(CLIENT_A, opening);
  const session = relay.response(opening.id) as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>;
  expect(session.type).toBe("AGENT_SESSION_CREATED");
  const send = async (n: number) => {
    const frame = browserFrame("AGENT_PROMPT", { agentId: "codex", sessionId: session.session.sessionId, chatId,
      prompt: [{ type: "text", text: "private-prompt" }] });
    await relay.request(CLIENT_A, frame); await expect.poll(() => driver.prompts.length).toBe(n);
    return frame;
  };
  return { worker, relay, driver, records, events, chatId, send };
}

it("records bounded open and turn stages, once per turn, without content or full identities", async () => {
  const f = await setup();
  expect(f.records.filter(row => row.phase === "open").map(row => row.stage)).toEqual(["open_received", "process_ready", "driver_ready"]);
  for (let turn = 1; turn <= 2; turn++) {
    const sent = await f.send(turn);
    for (let i = 0; i < 300; i++) f.events.at(-1)!.onTiming?.("first_provider_event");
    f.driver.emit({ sessionUpdate: "agent_message_chunk", messageId: `answer-${turn}`, content: { type: "text", text: "private-output" } });
    f.driver.complete();
    await expect.poll(() => f.relay.response(sent.id)?.type).toBe("AGENT_PROMPT_COMPLETE");
  }
  const turns = f.records.filter(row => row.phase === "turn");
  expect(turns.map(row => row.stage)).toEqual(Array(2).fill(["turn_received", "driver_ready", "turn_sent", "first_provider_event", "turn_done"]).flat());
  for (const group of [f.records.filter(row => row.phase === "open"), turns.slice(0, 5), turns.slice(5)]) {
    expect(group.every((row, i) => Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && (i === 0 || row.elapsedMs >= group[i - 1].elapsedMs))).toBe(true);
  }
  for (const row of f.records) {
    expect(Object.keys(row).sort()).toEqual(["agent", "chat", "elapsedMs", "phase", "stage"]);
    expect(row).toMatchObject({ agent: "codex", chat: "89abcdef" });
  }
  const journal = JSON.stringify(f.records);
  for (const content of [f.chatId, "private-chat-prefix", "private-prompt", "private-output", "private-model", config.agents.codex!.token, config.workspace.checkoutPath]) expect(journal.includes(content)).toBe(false);
});

it("finishes timing a cancelled turn and ignores events after retirement", async () => {
  const f = await setup(), sent = await f.send(1);
  f.events[0].onTiming?.("first_provider_event");
  await f.relay.request(CLIENT_A, browserFrame("AGENT_CANCEL", { agentId: "codex", chatId: f.chatId, sessionId: f.driver.opened!.sessionId }));
  expect(f.relay.response(sent.id)?.type).toBe("AGENT_PROMPT_COMPLETE");
  expect(f.records.filter(row => row.stage === "turn_done")).toHaveLength(1);
  await f.worker.dispose();
  const count = f.records.length;
  f.events[0].onTiming?.("first_provider_event");
  expect(f.records).toHaveLength(count);
});

it("never lets an unavailable journal prevent a provider turn", async () => {
  const f = await setup(() => { throw new Error("fixture journal failure"); });
  const sent = await f.send(1); f.events[0].onTiming?.("first_provider_event"); f.driver.complete();
  await expect.poll(() => f.relay.response(sent.id)?.type).toBe("AGENT_PROMPT_COMPLETE");
  expect(f.records.some(row => row.stage === "turn_done")).toBe(true);
});
