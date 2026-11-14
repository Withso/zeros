import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionUpdate } from "@zeros/protocol/agent-events";
import { CloudWorker } from "../worker";
import type { Agents } from "../agents";
import type { CheckoutRefresh } from "../workspace/checkout";
import { SessionStore, type SessionData } from "../sessions/session-store";
import { TurnService } from "../workspace/turns";
import { CLIENT_A, FakeDriver, FakeRelay, WORKSPACE_ID, WORKSPACE_KEY, browserFrame, config } from "./worker-fixtures";

const directories: string[] = [], workers: CloudWorker[] = [];
const defer = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
const delivery = (id = randomUUID(), chatId = "chat", epoch = "0", sequence = "1", agentId: "codex" | "claude" = "codex") => ({
  receipt: { workspaceId: WORKSPACE_ID, chatId, userMessageId: id, epoch, sequence,
    acceptedAt: new Date(0).toISOString(), workspaceState: "running" as const },
  deliveryId: randomUUID(),
  payload: { chatId, userMessageId: id, agentId, model: agentId === "claude" ? "claude-opus-4-8" : "gpt-6-luna", effort: "low",
    prompt: [{ type: "text" as const, text: "Reply with exactly: ok" }], startedAt: 1 },
});
type Delivery = ReturnType<typeof delivery>;
type Batch = { prompts: Delivery[]; stops: { chatId: string; epoch: string }[] };
type Operation = "pull" | "ack" | "begin" | "outcome" | "stop-ack" | "stop";

class PullRelay extends FakeRelay {
  queued: Batch[] = [];
  waiting?: (batch: Batch) => void;
  calls: { op: string; body: any }[] = [];
  onAck?: (body: any, signal?: AbortSignal) => Promise<unknown>;
  onBegin?: (body: any, signal?: AbortSignal) => Promise<unknown>;
  onOutcome?: (body: any) => Promise<unknown>;
  onStop?: (body: any) => Promise<unknown>;
  enqueue(batch: Batch): void {
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve(batch); }
    else this.queued.push(batch);
  }
  async promptRequest(op: Operation, body: any, signal?: AbortSignal): Promise<any> {
    this.calls.push({ op, body });
    if (op === "pull") {
      if (this.queued.length) return this.queued.shift();
      if (body.waitMs === 0) return { prompts: [], stops: [] };
      return new Promise<Batch>((resolve, reject) => {
        const abort = () => { this.waiting = undefined; reject(new DOMException("Aborted", "AbortError")); };
        this.waiting = batch => { signal?.removeEventListener("abort", abort); resolve(batch); };
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (op === "ack") return this.onAck ? this.onAck(body, signal) : { state: "inboxed" };
    if (op === "begin") return this.onBegin ? this.onBegin(body, signal) : { dispatch: true, state: "dispatching" };
    if (op === "outcome") return this.onOutcome ? this.onOutcome(body) : { state: body.state };
    if (op === "stop") return this.onStop ? this.onStop(body) : { chatId: body.chatId, epoch: (BigInt(body.throughEpoch) + 1n).toString() };
    return { ok: true };
  }
}

async function setup(options: { relay?: PullRelay; driver?: FakeDriver; createDriver?: () => FakeDriver; directory?: string; enabled?: boolean; interactions?: boolean; agent?: "codex" | "claude"; refresh?: CheckoutRefresh } = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "zeros-outbox-"));
  if (!options.directory) directories.push(directory);
  const relay = options.relay ?? new PullRelay(), driver = options.driver ?? new FakeDriver();
  const worker = new CloudWorker({ directory, transport: relay, workspaceId: WORKSPACE_ID,
    prepareCheckout: async () => ({ createdBranch: true, refresh: options.refresh }), drivers: { [options.agent ?? "codex"]: options.createDriver ?? (() => driver) } });
  workers.push(worker); worker.start();
  await relay.receive({ ...config, ...(options.interactions ? { agentInteractions: 1 } : {}),
    ...(options.agent === "claude" ? { agents: { claude: { apiKey: "fixture-claude-token" } } } : {}),
    ...(options.enabled === false ? {} : { promptOutbox: 1 }) });
  return { worker, relay, driver, directory };
}
async function persisted(directory: string) {
  const folder = join(directory, "sessions");
  return Promise.all((await readdir(folder)).filter(file => file.endsWith(".json")).map(async file => JSON.parse(await readFile(join(folder, file), "utf8"))));
}
const until = (read: () => unknown) => expect.poll(read, { timeout: 1500, interval: 5 });
afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.dispose()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

it("fences outbox delivery before driver startup without treating empty polls as activity", async () => {
  const gate = defer(), touch = vi.fn(() => gate.promise);
  const f = await setup({ refresh: { mayFastForward: true, start: async () => {}, touch, dispose: async () => { gate.resolve(); } } });
  try {
    await until(() => !!f.relay.waiting).toBe(true);
    expect(touch).not.toHaveBeenCalled();
    f.relay.enqueue({ prompts: [delivery()], stops: [] });
    await until(() => touch.mock.calls.length).toBe(1);
    expect(f.driver.opened).toBeUndefined();
    expect(f.driver.prompts).toHaveLength(0);
    gate.resolve();
    await until(() => f.driver.prompts.length).toBe(1);
    f.driver.complete();
  } finally { gate.resolve(); }
});

it("pulls without an app socket and fsyncs the VM inbox before ACK or driver startup", async () => {
  const relay = new PullRelay(), ack = defer<unknown>(), ready = defer();
  const driver = new FakeDriver(); driver.opening = ready.promise;
  const item = delivery(); relay.enqueue({ prompts: [item], stops: [] });
  relay.onAck = () => ack.promise;
  const f = await setup({ relay, driver });
  try {
    await until(() => relay.calls.some(call => call.op === "ack")).toBe(true);
    expect((await persisted(f.directory))[0].inbox[0]).toMatchObject({ userMessageId: item.receipt.userMessageId, state: "queued" });
    expect(driver.opened).toBeUndefined(); expect(driver.prompts).toHaveLength(0);
    ack.resolve({ state: "inboxed" });
    await until(() => !!driver.opened).toBe(true);
    expect(relay.calls.some(call => call.op === "begin")).toBe(false);
    ready.resolve();
    await until(() => driver.prompts.length).toBe(1);
    const begin = relay.calls.find(call => call.op === "begin")!.body;
    expect(begin).toMatchObject({ userMessageId: item.receipt.userMessageId, deliveryId: item.deliveryId });
    expect((await persisted(f.directory))[0].inbox[0]).toMatchObject({ state: "running", outbox: { dispatchId: begin.dispatchId } });
    expect(driver.opened).toMatchObject({ model: "gpt-6-luna", effort: "low" });
    driver.complete();
    await until(() => relay.calls.some(call => call.op === "outcome" && call.body.state === "completed")).toBe(true);
  } finally { ack.resolve({ state: "inboxed" }); ready.resolve(); }
});

it("deduplicates repeated pulls and a lost inbox ACK using the original message id", async () => {
  const relay = new PullRelay(), item = delivery();
  relay.enqueue({ prompts: [item], stops: [] });
  const f = await setup({ relay });
  await until(() => f.driver.prompts.length).toBe(1);
  relay.enqueue({ prompts: [item], stops: [] });
  await relay.receive({ t: "prompts" });
  await until(() => relay.calls.filter(call => call.op === "ack").length).toBeGreaterThanOrEqual(2);
  expect(f.driver.prompts).toHaveLength(1);
  expect((await persisted(f.directory))[0].inbox).toHaveLength(1);
  f.driver.complete();
  await until(() => relay.calls.some(call => call.op === "outcome" && call.body.state === "completed")).toBe(true);
  relay.enqueue({ prompts: [{ ...item, deliveryId: randomUUID() }], stops: [] });
  await relay.receive({ t: "prompts" });
  await until(() => relay.calls.filter(call => call.op === "ack").length).toBeGreaterThanOrEqual(3);
  expect(f.driver.prompts).toHaveLength(1);
  expect((await persisted(f.directory))[0].rows.filter((row: { msgId: string }) => row.msgId === item.receipt.userMessageId)).toHaveLength(1);
});

it("repairs a missed hint with the outbound long poll and leaves legacy configurations alone", async () => {
  const f = await setup();
  await until(() => !!f.relay.waiting).toBe(true);
  f.relay.enqueue({ prompts: [delivery()], stops: [] });
  await until(() => f.driver.prompts.length).toBe(1);
  f.driver.complete();
  const legacy = await setup({ enabled: false });
  expect(legacy.relay.calls).toEqual([]);
});

it("does not call the provider when Stop wins the dispatch fence", async () => {
  const relay = new PullRelay(), item = delivery(); relay.enqueue({ prompts: [item], stops: [] });
  relay.onBegin = async () => ({ dispatch: false, state: "cancelled" });
  const f = await setup({ relay });
  await until(() => relay.calls.some(call => call.op === "begin")).toBe(true);
  await until(async () => (await persisted(f.directory))[0].inbox[0].state).toBe("cancelled");
  expect(f.driver.prompts).toHaveLength(0);
});

it("applies Stop to older epochs only and does not cancel the next explicit send", async () => {
  const relay = new PullRelay(), old = delivery(); relay.enqueue({ prompts: [old], stops: [] });
  const f = await setup({ relay });
  await until(() => f.driver.prompts.length).toBe(1);
  const next = delivery(randomUUID(), "chat", "1", "2");
  relay.enqueue({ prompts: [next], stops: [{ chatId: "chat", epoch: "1" }] });
  await relay.receive({ t: "prompts" });
  await until(() => f.driver.prompts.length).toBe(2);
  expect(f.driver.interrupts).toBe(1);
  relay.enqueue({ prompts: [], stops: [{ chatId: "chat", epoch: "1" }] });
  await relay.receive({ t: "prompts" });
  await until(() => relay.calls.filter(call => call.op === "stop-ack").length).toBeGreaterThanOrEqual(2);
  expect(f.driver.interrupts).toBe(1);
  f.driver.complete();
  await until(async () => (await persisted(f.directory))[0].inbox.find((entry: { userMessageId: string }) => entry.userMessageId === next.receipt.userMessageId)?.state).toBe("completed");
});

it("never replays a possibly consumed turn after restart", async () => {
  const first = await setup(), item = delivery();
  first.relay.enqueue({ prompts: [item], stops: [] });
  await until(() => first.driver.prompts.length).toBe(1);
  const copy = await mkdtemp(join(tmpdir(), "zeros-outbox-crash-")); directories.push(copy);
  await cp(join(first.directory, "sessions"), join(copy, "sessions"), { recursive: true });
  const recovered = await setup({ directory: copy });
  await until(() => recovered.relay.calls.some(call => call.op === "outcome" && call.body.state === "interrupted")).toBe(true);
  expect(recovered.driver.prompts).toHaveLength(0);
  expect((await persisted(copy))[0].inbox[0]).toMatchObject({ state: "interrupted", userMessageId: item.receipt.userMessageId,
    error: "The worker restarted before this turn finished. Send a new message to continue." });
  first.driver.complete();
});

it("resumes an inbox saved before its ACK was received, using the same message id", async () => {
  const relay = new PullRelay(), ack = defer<unknown>(), item = delivery();
  relay.onAck = () => ack.promise;
  relay.enqueue({ prompts: [item], stops: [] });
  const first = await setup({ relay });
  try {
    await until(() => relay.calls.some(call => call.op === "ack")).toBe(true);
    const copy = await mkdtemp(join(tmpdir(), "zeros-outbox-queued-")); directories.push(copy);
    await cp(join(first.directory, "sessions"), join(copy, "sessions"), { recursive: true });
    const nextRelay = new PullRelay();
    nextRelay.enqueue({ prompts: [{ ...item, deliveryId: randomUUID() }], stops: [] });
    const recovered = await setup({ directory: copy, relay: nextRelay });
    await until(() => recovered.driver.prompts.length).toBe(1);
    expect((await persisted(copy))[0].inbox).toHaveLength(1);
    recovered.driver.complete();
  } finally { ack.resolve({ state: "cancelled" }); }
});

it("requires a fresh delivery ACK after restart before any acknowledged queued input may dispatch", async () => {
  const ready = defer(), driver = new FakeDriver(); driver.opening = ready.promise;
  const first = await setup({ driver }), item = delivery();
  try {
    first.relay.enqueue({ prompts: [item], stops: [] });
    await until(() => !!driver.opened).toBe(true);
    const copy = await mkdtemp(join(tmpdir(), "zeros-outbox-ack-restart-")); directories.push(copy);
    await cp(join(first.directory, "sessions"), join(copy, "sessions"), { recursive: true });
    const reopened = await SessionStore.open(join(copy, "sessions"), WORKSPACE_KEY);
    expect(reopened.hasQueued("chat")).toBe(false);
    expect(await reopened.claim("chat")).toBeUndefined();
    const relay = new PullRelay(); relay.enqueue({ prompts: [{ ...item, deliveryId: randomUUID() }], stops: [] });
    const recovered = await setup({ directory: copy, relay });
    await until(() => recovered.driver.prompts.length).toBe(1); recovered.driver.complete();
  } finally { ready.resolve(); }
});

it("honors the saved model and effort of each message in FIFO order", async () => {
  const drivers = [new FakeDriver(), new FakeDriver()]; let opens = 0;
  const f = await setup({ createDriver: () => drivers[opens++]! });
  const first = delivery(), second = delivery(randomUUID(), "chat", "0", "2");
  second.payload.model = "another-model"; second.payload.effort = "medium";
  f.relay.enqueue({ prompts: [first, second], stops: [] });
  await until(() => drivers[0]!.prompts.length).toBe(1);
  expect(drivers[0]!.opened).toMatchObject({ model: first.payload.model, effort: "low" });
  expect(drivers[1]!.prompts).toHaveLength(0);
  drivers[0]!.complete();
  await until(() => drivers[1]!.prompts.length).toBe(1);
  expect(drivers[1]!.opened).toMatchObject({ model: second.payload.model, effort: "medium", nativeSessionId: `native-${drivers[0]!.opened!.sessionId}` });
  expect(drivers[0]!.disposed).toBe(true);
  drivers[1]!.complete();
});

it("keeps provider acceptance separate from the inbox ACK and publishes it once", async () => {
  const relay = new PullRelay(), item = delivery(); relay.enqueue({ prompts: [item], stops: [] });
  const f = await setup({ relay });
  await until(() => f.driver.prompts.length).toBe(1);
  expect(relay.calls.filter(call => call.op === "outcome")).toEqual([]);
  for (let i = 0; i < 10; i++) f.driver.emit({ sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "ok" } });
  await until(() => relay.calls.filter(call => call.op === "outcome" && call.body.state === "accepted").length).toBe(1);
  f.driver.complete();
  await until(() => relay.calls.filter(call => call.op === "outcome" && call.body.state === "completed").length).toBe(1);
});

it.each<[string, SessionUpdate]>([
  ["context snapshot", { sessionUpdate: "usage_update", size: 100, used: 20, categories: [] }],
  ["wake-up notice", { sessionUpdate: "wakeup_notice", noticeId: "wakeup", source: "loop_wakeup" }],
])("does not treat a delayed Claude %s as acceptance of the next prompt", async (_kind, update) => {
  const f = await setup({ agent: "claude" });
  const first = delivery(randomUUID(), "chat", "0", "1", "claude"), second = delivery(randomUUID(), "chat", "0", "2", "claude");
  f.relay.enqueue({ prompts: [first, second], stops: [] });
  await until(() => f.driver.prompts.length).toBe(1);
  f.driver.complete();
  await until(() => f.driver.prompts.length).toBe(2);
  const accept = vi.spyOn(SessionStore.prototype, "acceptOutbox");
  try {
    f.driver.emit(update);
    // Driver event admission is synchronous; observing the spy needs no sleep or
    // race with the async journal writer. This reply belongs to the prior result.
    expect(accept).not.toHaveBeenCalled();
    f.driver.emit({ sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "ok" } });
    expect(accept).toHaveBeenCalledWith("chat", `outbox:${second.receipt.userMessageId}`);
    await until(() => f.relay.calls.some(call => call.op === "outcome" && call.body.userMessageId === second.receipt.userMessageId && call.body.state === "accepted")).toBe(true);
    f.driver.complete();
    await until(() => f.relay.calls.some(call => call.op === "outcome" && call.body.userMessageId === second.receipt.userMessageId && call.body.state === "completed")).toBe(true);
  } finally { accept.mockRestore(); }
});

it("settles a cold-start failure without a dispatch permit and saves a safe failure notice", async () => {
  const relay = new PullRelay(), driver = new FakeDriver();
  driver.open = async () => { throw new Error("private diagnostic must not appear"); };
  const f = await setup({ relay, driver });
  relay.enqueue({ prompts: [delivery()], stops: [] });
  await until(() => relay.calls.some(call => call.op === "outcome" && call.body.state === "failed")).toBe(true);
  expect(relay.calls.some(call => call.op === "begin")).toBe(false);
  await until(async () => (await persisted(f.directory))[0].rows.some((row: { kind: string }) => row.kind === "error_notice")).toBe(true);
  const disk = (await persisted(f.directory))[0];
  expect(disk.inbox[0].state).toBe("failed");
  expect(disk.rows.some((row: { payload: string }) => JSON.parse(row.payload).kind === "error_notice")).toBe(true);
  expect(JSON.stringify(disk)).not.toContain("private diagnostic");
  expect(driver.prompts).toHaveLength(0);
});

it.each(["open", "prompt"] as const)("keeps a failed %s outcome unreported until its notice is durable", async stage => {
  const relay = new PullRelay(), driver = new FakeDriver(), item = delivery(), write = defer();
  const storage = SessionStore.prototype as unknown as { save(data: SessionData): Promise<void> };
  const save = storage.save;
  let savingNotice = false, reported: SessionData | undefined;
  vi.spyOn(storage, "save").mockImplementation(async function(this: typeof storage, data) {
    if (data.rows.some(row => row.kind === "error_notice")) { savingNotice = true; await write.promise; }
    await save.call(this, data);
  });
  if (stage === "open") driver.open = async () => { throw new Error("private diagnostic must not appear"); };
  const f = await setup({ relay, driver });
  relay.onOutcome = async body => {
    if (body.state === "failed") reported = (await persisted(f.directory))[0];
    return { state: body.state };
  };
  try {
    relay.enqueue({ prompts: [item], stops: [] });
    if (stage === "prompt") { await until(() => driver.prompts.length).toBe(1); driver.fail(); }
    await until(() => savingNotice).toBe(true);
    const pulls = relay.calls.filter(call => call.op === "pull").length;
    await relay.receive({ t: "prompts" });
    // Join the reporting loop while the actual notice write is held. An
    // unrelated hint must not let the failed receipt overtake that write.
    await until(() => relay.calls.some(call => call.op === "outcome" && call.body.state === "failed") ||
      relay.calls.filter(call => call.op === "pull").length > pulls).toBe(true);
    expect(relay.calls.some(call => call.op === "outcome" && call.body.state === "failed")).toBe(false);
    expect((await persisted(f.directory))[0].inbox[0].state).toBe(stage === "open" ? "queued" : "running");
    write.resolve();
    await until(() => reported).toBeDefined();
    expect(reported!.inbox[0]).toMatchObject({ userMessageId: item.receipt.userMessageId, state: "failed" });
    expect(reported!.rows.map(row => JSON.parse(row.payload))).toMatchObject([
      { id: item.receipt.userMessageId, kind: "text", role: "user" },
      { kind: "error_notice", turnFailure: { turnId: item.receipt.userMessageId } },
    ]);
    expect(JSON.stringify(reported)).not.toContain("private diagnostic");
  } finally { write.resolve(); }
});

it("keeps the provider's actionable failure instead of replacing it with a generic inbox notice", async () => {
  const f = await setup(), item = delivery();
  f.relay.enqueue({ prompts: [item], stops: [] });
  await until(() => f.driver.prompts.length).toBe(1);
  f.driver.emit({ sessionUpdate: "error_notice", noticeId: "provider-failure", severity: "error",
    message: "Pick another model.", turnFailure: { turnId: item.receipt.userMessageId, kind: "model-unavailable" }, at: Date.now() });
  f.driver.fail();
  await until(() => f.relay.calls.some(call => call.op === "outcome" && call.body.state === "failed")).toBe(true);
  await until(() => f.relay.bridge("AGENT_SESSION_UPDATE").some(({ frame }) => frame.type === "AGENT_SESSION_UPDATE" &&
    frame.notification.update.sessionUpdate === "turn_state" && frame.notification.update.state === "failed")).toBe(true);
  const rows = (await persisted(f.directory))[0].rows.map((row: { payload: string }) => JSON.parse(row.payload));
  expect(rows.filter((row: { kind: string }) => row.kind === "error_notice")).toMatchObject([
    { message: "This model is unavailable for the provider account. Choose another model.",
      cloud: { source: "provider", reason: "model-unavailable" }, turnFailure: { kind: "model-unavailable" } },
  ]);
});

it("fences saved native work when worker authorization ends", async () => {
  const relay = new PullRelay(), item = delivery();
  relay.onAck = async () => { throw Object.assign(new Error("Unauthorized"), { status: 401 }); };
  relay.enqueue({ prompts: [item], stops: [] });
  const f = await setup({ relay });
  await until(() => relay.calls.some(call => call.op === "ack")).toBe(true);
  await until(async () => (await persisted(f.directory))[0].inbox[0].state).toBe("cancelled");
  expect(f.driver.prompts).toHaveLength(0);
  expect(f.driver.opened).toBeUndefined();
});

it("re-adopts the persisted execution after wake and confirms Stop on the original app route", async () => {
  const first = await setup(), item = delivery();
  first.relay.enqueue({ prompts: [item], stops: [] });
  await until(() => first.driver.prompts.length).toBe(1);
  const execution = first.driver.opened!.sessionId;
  first.driver.complete();
  await until(() => first.relay.calls.some(call => call.op === "outcome" && call.body.state === "completed")).toBe(true);
  // The outcome call precedes its durable report. Finish those writes before
  // cp enumerates a temporary file that an atomic rename can remove mid-copy.
  await first.worker.flush();
  const copy = await mkdtemp(join(tmpdir(), "zeros-outbox-wake-")); directories.push(copy);
  await cp(join(first.directory, "sessions"), join(copy, "sessions"), { recursive: true });
  const next = delivery(randomUUID(), "chat", "0", "2"), relay = new PullRelay();
  relay.enqueue({ prompts: [next], stops: [] });
  const recovered = await setup({ directory: copy, relay });
  await until(() => recovered.driver.prompts.length).toBe(1);
  expect(recovered.driver.opened).toMatchObject({ sessionId: execution, nativeSessionId: `native-${execution}` });
  await relay.receive({ t: "open", clientId: CLIENT_A });
  const cancel = browserFrame("AGENT_CANCEL", { agentId: "codex", chatId: "chat", sessionId: execution, executionId: execution });
  await relay.request(CLIENT_A, cancel);
  expect(relay.response(cancel.id)).toMatchObject({ type: "WORKSPACE_RESPONSE", result: { conversationId: "chat", state: "cancelled" } });
  await until(() => relay.calls.some(call => call.op === "outcome" && call.body.state === "cancelled")).toBe(true);
  expect((await persisted(copy))[0].inbox.every((entry: { state: string }) => entry.state !== "queued" && entry.state !== "running")).toBe(true);
});

it("acknowledges Stop with no native work and leaves working activity idle", async () => {
  const f = await setup();
  f.relay.enqueue({ prompts: [], stops: [{ chatId: "never-opened", epoch: "1" }] });
  await until(() => f.relay.calls.some(call => call.op === "stop-ack")).toBe(true);
  expect(f.driver.opened).toBeUndefined();
  expect(f.relay.frames.some(frame => frame.t === "idle" && !frame.idle)).toBe(false);
});

it("does not acknowledge a Stop whose native interrupt failed, and retries the same fence", async () => {
  const f = await setup(), item = delivery();
  f.relay.enqueue({ prompts: [item], stops: [] });
  await until(() => f.driver.prompts.length).toBe(1);
  const original = f.driver.interrupt.bind(f.driver);
  f.driver.interrupt = async () => { if (!f.driver.interrupts) { f.driver.interrupts++; throw new Error("fixture interrupt failure"); } await original(); };
  const batch = { prompts: [], stops: [{ chatId: "chat", epoch: "1" }] };
  f.relay.enqueue(batch);
  await until(() => f.driver.interrupts).toBe(1);
  expect(f.relay.calls.some(call => call.op === "stop-ack")).toBe(false);
  f.relay.enqueue(batch);
  await until(() => f.relay.calls.some(call => call.op === "stop-ack")).toBe(true);
  expect(f.driver.interrupts).toBe(2);
  await until(async () => (await persisted(f.directory))[0].inbox[0].state).toBe("cancelled");
});

it.each(["outbox revocation", "HTTP Stop batch"])("interrupts all affected chats before held persistence during %s", async boundary => {
  const relay = new PullRelay(), drivers: FakeDriver[] = [], held = defer(), entered = defer();
  const f = await setup({ relay, createDriver: () => { const driver = new FakeDriver(); drivers.push(driver); return driver; } });
  relay.enqueue({ prompts: [delivery(randomUUID(), "first"), delivery(randomUUID(), "first", "0", "2"), delivery(randomUUID(), "second")], stops: [] });
  // A precondition, not the behavior under test. Under a loaded CI runner the
  // second chat's first prompt arrived after the 1.5 s default (#933, #936).
  await expect.poll(() => drivers.map(driver => driver.prompts.length), { timeout: 15_000, interval: 5 }).toEqual([1, 1]);
  const stop = SessionStore.prototype.stopOutbox;
  vi.spyOn(SessionStore.prototype, "stopOutbox").mockImplementation(async function (this: SessionStore, chatId, epoch) {
    if (chatId === "first") { entered.resolve(); await held.promise; }
    return stop.call(this, chatId, epoch);
  });
  let stopping: Promise<void> | undefined;
  try {
    if (boundary === "outbox revocation") stopping = (f.worker as unknown as { agents: Agents }).agents.fenceOutbox();
    else relay.enqueue({ prompts: [], stops: [{ chatId: "first", epoch: "1" }, { chatId: "second", epoch: "1" }] });
    await entered.promise;
    expect(drivers.map(driver => driver.interrupts)).toEqual([1, 1]);
  } finally {
    held.resolve(); await stopping;
    if (boundary === "HTTP Stop batch") await until(() => relay.calls.filter(call => call.op === "stop-ack").length).toBe(2);
  }
});

it("fences control-plane follow-ups when an older desktop sends Stop over the bridge", async () => {
  const f = await setup(), item = delivery();
  f.relay.enqueue({ prompts: [item], stops: [] });
  await until(() => f.driver.prompts.length).toBe(1);
  const execution = f.driver.opened!.sessionId;
  await f.relay.receive({ t: "open", clientId: CLIENT_A });
  const cancel = browserFrame("AGENT_CANCEL", { agentId: "codex", chatId: "chat", sessionId: execution, executionId: execution });
  await f.relay.request(CLIENT_A, cancel);
  expect(f.relay.calls.filter(call => call.op === "stop")).toEqual([{ op: "stop", body: { chatId: "chat", throughEpoch: "0" } }]);
  expect(f.relay.response(cancel.id)).toMatchObject({ type: "WORKSPACE_RESPONSE", result: { state: "cancelled" } });
  expect(f.driver.interrupts).toBe(1);
});

it("a durable Stop interrupts a turn sent by an older desktop exactly once", async () => {
  const f = await setup(); await f.relay.receive({ t: "open", clientId: CLIENT_A });
  const open = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "chat", cwd: config.workspace.checkoutPath });
  await f.relay.request(CLIENT_A, open);
  const execution = f.driver.opened!.sessionId;
  await f.relay.request(CLIENT_A, browserFrame("AGENT_PROMPT", { agentId: "codex", chatId: "chat", sessionId: execution,
    userMessageId: "bridge-user", prompt: [{ type: "text", text: "ok" }] }));
  await until(() => f.driver.prompts.length).toBe(1);
  const batch = { prompts: [], stops: [{ chatId: "chat", epoch: "1" }] };
  f.relay.enqueue(batch);
  await until(() => f.relay.calls.some(call => call.op === "stop-ack")).toBe(true);
  expect(f.driver.interrupts).toBe(1);
  await until(async () => (await persisted(f.directory))[0].inbox[0].state).toBe("cancelled");
  f.relay.enqueue(batch);
  await until(() => f.relay.calls.filter(call => call.op === "stop-ack").length).toBe(2);
  expect(f.driver.interrupts).toBe(1);
});

it("an explicit user close fences the durable queue, while shutdown never sends a new Stop", async () => {
  const f = await setup(), item = delivery(); f.relay.enqueue({ prompts: [item], stops: [] });
  await until(() => f.driver.prompts.length).toBe(1);
  await f.relay.receive({ t: "open", clientId: CLIENT_A });
  await f.relay.request(CLIENT_A, browserFrame("AGENT_CLOSE_SESSION", { agentId: "codex", chatId: "chat",
    sessionId: f.driver.opened!.sessionId, userStop: true }));
  expect(f.relay.calls.filter(call => call.op === "stop")).toHaveLength(1);
  const other = await setup(); await other.worker.dispose();
  expect(other.relay.calls.some(call => call.op === "stop")).toBe(false);
});

it.each(["delivered", "queued"] as const)("durably steers an active turn, retaining a %s provider response without a second attempt", async outcome => {
  const f = await setup(), first = delivery();
  f.driver.steerResult = outcome;
  f.relay.enqueue({ prompts: [first], stops: [] });
  await until(() => f.driver.prompts.length).toBe(1);
  const second = delivery(randomUUID(), "chat", "0", "2");
  f.relay.enqueue({ prompts: [{ ...second, payload: { ...second.payload, mode: "steer" } } as Delivery], stops: [] });
  await until(() => f.driver.steers.length).toBe(1);
  expect(f.driver.prompts).toHaveLength(1);
  if (outcome === "delivered") {
    await until(() => f.relay.calls.some(call => call.op === "outcome" && call.body.userMessageId === second.receipt.userMessageId && call.body.state === "completed")).toBe(true);
    f.driver.complete();
  } else {
    f.driver.complete();
    await until(() => f.driver.prompts.length).toBe(2);
    f.driver.complete();
  }
  expect(f.driver.steers).toHaveLength(1);
});


it("dispatches a first HTTP Plan prompt with its frozen mode before opening a native driver", async () => {
  const relay = new PullRelay(), item = delivery();
  Object.assign(item.payload, { permissionMode: "plan" }); relay.enqueue({ prompts: [item], stops: [] });
  const f = await setup({ relay, interactions: true });
  await until(() => f.driver.prompts.length).toBe(1);
  expect(f.driver.opened).toMatchObject({ modeId: "read-only" });
  expect((await persisted(f.directory))[0].inbox[0].outbox).toMatchObject({ permissionMode: "plan" });
  f.driver.complete();
});

it("preserves a frozen first-send Plan mode when selection changes during dispatch approval", async () => {
  const relay = new PullRelay(), item = delivery(), begin = defer<unknown>(), driver = new FakeDriver();
  Object.assign(item.payload, { permissionMode: "plan" });
  relay.enqueue({ prompts: [item], stops: [] }); relay.onBegin = () => begin.promise;
  const dispatched: Array<string | undefined> = [], prompt = driver.prompt.bind(driver);
  vi.spyOn(driver, "prompt").mockImplementation(content => {
    dispatched.push(driver.modes.at(-1) ?? driver.opened?.modeId); return prompt(content);
  });
  const f = await setup({ relay, driver, interactions: true });
  try {
    await until(() => relay.calls.some(call => call.op === "begin")).toBe(true);
    const executionId = (await persisted(f.directory))[0].executionId;
    await relay.receive({ t: "open", clientId: CLIENT_A });
    const mode = browserFrame("AGENT_SET_MODE", { agentId: "codex", chatId: "chat", executionId, sessionId: executionId, modeId: "full-access" });
    await relay.request(CLIENT_A, mode);
    expect(relay.response(mode.id)).toMatchObject({ type: "AGENT_MODE_CHANGED", modeId: "full-access" });
    expect(driver.prompts).toHaveLength(0);
    begin.resolve({ dispatch: true, state: "dispatching" });
    await until(() => driver.prompts.length).toBe(1);
    expect(dispatched).toEqual(["read-only"]);
    driver.complete();
  } finally { begin.resolve({ dispatch: false, state: "cancelled" }); }
});

it("refuses an explicit persisted Plan prompt when interactions were not negotiated", async () => {
  const relay = new PullRelay(), item = delivery();
  Object.assign(item.payload, { permissionMode: "plan" }); relay.enqueue({ prompts: [item], stops: [] });
  const f = await setup({ relay });
  await until(() => relay.calls.some(call => call.op === "outcome" && call.body.state === "failed")).toBe(true);
  expect(f.driver.opened).toBeUndefined(); expect(f.driver.prompts).toHaveLength(0);
  expect((await persisted(f.directory))[0].inbox[0].error).toContain("Plan mode");
});

it("waits for an older mode change before admitting the frozen Plan turn", async () => {
  const relay = new PullRelay(), item = delivery(), begin = defer<unknown>(), modeGate = defer(), snapshotted = defer(), driver = new FakeDriver();
  Object.assign(item.payload, { permissionMode: "plan" }); relay.enqueue({ prompts: [item], stops: [] }); relay.onBegin = () => begin.promise;
  let modeEntered = false;
  vi.spyOn(driver, "setMode").mockImplementation(async mode => {
    if (mode === "full-access") { modeEntered = true; await modeGate.promise; }
    driver.modes.push(mode);
  });
  const capture = TurnService.prototype.begin;
  vi.spyOn(TurnService.prototype, "begin").mockImplementation(async function (this: TurnService, ...args) {
    const result = await capture.apply(this, args); snapshotted.resolve(); return result;
  });
  const f = await setup({ relay, driver, interactions: true });
  try {
    await until(() => relay.calls.some(call => call.op === "begin")).toBe(true);
    const executionId = (await persisted(f.directory))[0].executionId;
    await relay.receive({ t: "open", clientId: CLIENT_A });
    const change = relay.request(CLIENT_A, browserFrame("AGENT_SET_MODE", { agentId: "codex", chatId: "chat", executionId, sessionId: executionId, modeId: "full-access" }));
    await until(() => modeEntered).toBe(true);
    begin.resolve({ dispatch: true, state: "dispatching" }); await snapshotted.promise;
    expect(driver.prompts).toHaveLength(0);
    modeGate.resolve(); await change;
    await until(() => driver.prompts.length).toBe(1);
    expect(driver.modes).toEqual(["full-access", "read-only"]); driver.complete();
  } finally { modeGate.resolve(); begin.resolve({ dispatch: false, state: "cancelled" }); }
});

it("does not dispatch after Stop wins while the final native mode is applying", async () => {
  const relay = new PullRelay(), item = delivery(), modeGate = defer(), driver = new FakeDriver();
  Object.assign(item.payload, { permissionMode: "plan" }); relay.enqueue({ prompts: [item], stops: [] });
  let entered = false;
  vi.spyOn(driver, "setMode").mockImplementation(async () => { entered = true; await modeGate.promise; });
  const f = await setup({ relay, driver, interactions: true });
  try {
    await until(() => entered).toBe(true);
    relay.enqueue({ prompts: [], stops: [{ chatId: "chat", epoch: "1" }] });
    await relay.receive({ t: "prompts" });
    await until(async () => (await persisted(f.directory))[0].deliveryEpoch).toBe("1");
    modeGate.resolve();
    await until(() => relay.calls.some(call => call.op === "outcome" && call.body.state === "cancelled")).toBe(true);
    expect(driver.prompts).toHaveLength(0);
  } finally { modeGate.resolve(); }
});

it("queues a differing-mode HTTP steer without changing the running turn's mode", async () => {
  const relay = new PullRelay(), first = delivery(), second = delivery(randomUUID(), "chat", "0", "2");
  Object.assign(first.payload, { permissionMode: "bypass" });
  Object.assign(second.payload, { permissionMode: "plan", mode: "steer" });
  relay.enqueue({ prompts: [first], stops: [] });
  const f = await setup({ relay, interactions: true });
  await until(() => f.driver.prompts.length).toBe(1);
  relay.enqueue({ prompts: [second], stops: [] });
  await until(() => relay.calls.filter(call => call.op === "ack").length).toBe(2);
  expect(f.driver.opened).toMatchObject({ modeId: "full-access" }); expect(f.driver.modes).toEqual(["full-access"]); expect(f.driver.steers).toHaveLength(0);
  f.driver.complete(); await until(() => f.driver.prompts.length).toBe(2);
  expect(f.driver.modes).toEqual(["full-access", "read-only"]); f.driver.complete();
});

it.each(["explicit", "native"])("queues a frozen Plan steer after a %s switch changed the running mode", async source => {
  const relay = new PullRelay(), first = delivery(), second = delivery(randomUUID(), "chat", "0", "2");
  Object.assign(first.payload, { permissionMode: "plan" });
  Object.assign(second.payload, { permissionMode: "plan", mode: "steer" });
  relay.enqueue({ prompts: [first], stops: [] });
  const f = await setup({ relay, interactions: true });
  await until(() => f.driver.prompts.length).toBe(1);
  if (source === "explicit") {
    await relay.receive({ t: "open", clientId: CLIENT_A });
    await relay.request(CLIENT_A, browserFrame("AGENT_SET_MODE", { agentId: "codex", chatId: "chat", sessionId: f.driver.opened!.sessionId,
      executionId: f.driver.opened!.sessionId, modeId: "full-access" }));
  } else f.driver.emit({ sessionUpdate: "current_mode_update", currentModeId: "full-access" });
  await until(async () => (await persisted(f.directory))[0].chat.permissionMode).toBe("danger");
  relay.enqueue({ prompts: [second], stops: [] });
  await until(async () => (await persisted(f.directory))[0].inbox[1]?.outbox?.acknowledged).toBe(true);
  await until(() => !!relay.waiting).toBe(true);
  expect(f.driver.steers).toHaveLength(0);
  f.driver.complete(); await until(() => f.driver.prompts.length).toBe(2);
  expect(f.driver.modes.at(-1)).toBe("read-only"); f.driver.complete();
});

it("rechecks a frozen Plan steer after a held dispatch approval", async () => {
  const relay = new PullRelay(), first = delivery(), second = delivery(randomUUID(), "chat", "0", "2"), gate = defer<unknown>();
  Object.assign(first.payload, { permissionMode: "plan" });
  Object.assign(second.payload, { permissionMode: "plan", mode: "steer" });
  relay.enqueue({ prompts: [first], stops: [] });
  const f = await setup({ relay, interactions: true });
  await until(() => f.driver.prompts.length).toBe(1);
  relay.onBegin = () => gate.promise;
  try {
    relay.enqueue({ prompts: [second], stops: [] });
    await until(() => relay.calls.filter(call => call.op === "begin").length).toBe(2);
    f.driver.emit({ sessionUpdate: "current_mode_update", currentModeId: "full-access" });
    gate.resolve({ dispatch: true, state: "dispatching" });
    await until(async () => (await persisted(f.directory))[0].inbox[1].state).toBe("queued");
    expect(f.driver.steers).toHaveLength(0);
    f.driver.complete(); await until(() => f.driver.prompts.length).toBe(2);
    expect(f.driver.modes.at(-1)).toBe("read-only"); f.driver.complete();
  } finally { gate.resolve({ dispatch: true, state: "dispatching" }); }
});

it("expires pending HTTP input through Stop so queued successors never dispatch", async () => {
  const timers = vi.spyOn(globalThis, "setTimeout"), relay = new PullRelay(), first = delivery(), second = delivery(randomUUID(), "chat", "0", "2");
  relay.enqueue({ prompts: [first], stops: [] });
  const f = await setup({ relay, interactions: true });
  await until(() => f.driver.prompts.length).toBe(1);
  const response = f.driver.opened!.onQuestion!({ sessionId: f.driver.opened!.sessionId, questionId: "http-question", nativeRequestId: "http-native", toolCallId: "http-tool",
    source: "native_rpc", blocking: true, questions: [{ id: "ask", prompt: "Continue?", options: [], allowOther: true }] });
  await until(async () => (await persisted(f.directory))[0].pendingInteractions?.length).toBe(1);
  relay.enqueue({ prompts: [second], stops: [] });
  await until(() => relay.calls.filter(call => call.op === "ack").length).toBe(2);
  const timeout = timers.mock.calls.find(([, ms]) => typeof ms === "number" && ms > 899_000 && ms <= 900_000)?.[0] as () => void;
  expect(timeout).toBeTypeOf("function"); timeout();
  await expect(response).resolves.toMatchObject({ outcome: { outcome: "dismissed" } });
  await until(async () => (await persisted(f.directory))[0].inbox.map((entry: { state: string }) => entry.state)).toEqual(["cancelled", "cancelled"]);
  await until(() => relay.calls.filter(call => call.op === "outcome" && call.body.state === "cancelled").length).toBe(2);
  expect(relay.calls.some(call => call.op === "stop")).toBe(true);
  expect(f.driver.prompts).toHaveLength(1); expect(f.driver.interrupts).toBe(1);
  timers.mockRestore();
});

it("interrupts unanswered native input before a held control-plane Stop can release queued work", async () => {
  const timers = vi.spyOn(globalThis, "setTimeout"), relay = new PullRelay(), stop = defer<unknown>();
  relay.onStop = () => stop.promise;
  const first = delivery(), second = delivery(randomUUID(), "chat", "0", "2");
  relay.enqueue({ prompts: [first], stops: [] });
  const f = await setup({ relay, interactions: true });
  try {
    await until(() => f.driver.prompts.length).toBe(1);
    const response = f.driver.opened!.onQuestion!({ sessionId: f.driver.opened!.sessionId, questionId: "held", nativeRequestId: "held", toolCallId: "held",
      source: "native_rpc", blocking: true, questions: [{ id: "ask", prompt: "Continue?", options: [], allowOther: true }] });
    await until(async () => (await persisted(f.directory))[0].pendingInteractions?.length).toBe(1);
    relay.enqueue({ prompts: [second], stops: [] });
    await until(async () => (await persisted(f.directory))[0].inbox[1]?.outbox?.acknowledged).toBe(true);
    const busyReports = relay.frames.filter(frame => frame.t === "idle" && !frame.idle).length;
    const timeout = timers.mock.calls.find(([, ms]) => typeof ms === "number" && ms > 899_000 && ms <= 900_000)![0] as () => void;
    timeout(); await response;
    await until(() => relay.calls.some(call => call.op === "stop")).toBe(true);
    await until(async () => (await persisted(f.directory))[0].inbox[0].state).toBe("cancelled");
    expect(f.driver.interrupts).toBe(1); expect(f.driver.prompts).toHaveLength(1);
    expect(relay.frames.filter(frame => frame.t === "idle" && !frame.idle)).toHaveLength(busyReports);
    stop.resolve({ chatId: "chat", epoch: "1" });
    await until(async () => (await persisted(f.directory))[0].inbox[1].state).toBe("cancelled");
    expect(f.driver.prompts).toHaveLength(1);
  } finally { stop.resolve({ chatId: "chat", epoch: "1" }); }
});

it("applies chat edits after the reply's prompts and acknowledges each with its row in history; unknown chats wait", async () => {
  const f = await setup();
  await until(() => !!f.relay.waiting).toBe(true);
  const acks = () => f.relay.frames.flatMap(frame => frame.t === "history" && frame.chatEditAcks ? [{ acks: frame.chatEditAcks, chats: frame.chats?.map(chat => chat.id) }] : []);
  f.relay.enqueue({ prompts: [delivery(randomUUID(), "created")], stops: [],
    chatEdits: [{ chatId: "created", version: "1", title: "From the API" }, { chatId: "unknown", version: "1", archived: true }] } as unknown as Batch);
  await until(() => acks().length).toBe(1);
  expect(acks()).toEqual([{ acks: [{ chatId: "created", version: "1" }], chats: ["created"] }]);
  const { store } = f.worker as unknown as { store: SessionStore };
  expect(store.metadata("created")!.chat).toMatchObject({ title: "From the API", archived: false });
  expect(store.metadata("unknown")).toBeUndefined();
  f.driver.complete();
  const pulls = f.relay.calls.filter(call => call.op === "pull").length;
  f.relay.enqueue({ prompts: [], stops: [], chatEdits: [{ chatId: "created", version: "1", title: "Replayed" }, { chatId: "created", version: "2", archived: true }] } as unknown as Batch);
  // The replayed version is acknowledged again, changing nothing; then version 2.
  await until(() => acks().at(-1)?.acks[0]?.version).toBe("2");
  // Both may coalesce into one frame: acknowledging 2 also covers 1.
  for (const entry of acks().slice(1)) expect(["1", "2"]).toContain(entry.acks[0]!.version);
  expect(acks().every(entry => entry.chats?.[0] === "created")).toBe(true);
  expect(store.metadata("created")!.chat).toMatchObject({ title: "From the API", archived: true });
  // An edit this worker cannot apply yet counts as an empty reply for the poll guard.
  for (let i = 0; i < 4; i++) f.relay.enqueue({ prompts: [], stops: [], chatEdits: [{ chatId: "unknown", version: "1", archived: true }] } as unknown as Batch);
  const started = Date.now();
  await until(() => f.relay.calls.filter(call => call.op === "pull").length).toBeGreaterThanOrEqual(pulls + 5);
  expect(Date.now() - started).toBeGreaterThanOrEqual(700);
});

it("R1 push-signals-v1: an accepted pushSignals config long-polls 60 s; without it the pull keeps 25 s", async () => {
  const legacy = await setup();
  await until(() => legacy.relay.calls.some(call => call.op === "pull" && call.body.waitMs > 0)).toBe(true);
  expect(legacy.relay.calls.filter(call => call.op === "pull" && call.body.waitMs > 0).at(-1)!.body.waitMs).toBe(25_000);
  const relay = new PullRelay();
  const f = await setup({ relay });
  await relay.receive({ ...config, promptOutbox: 1, pushSignals: 1, loginRevision: "1" });
  // The waiting pull is replaced once the config is accepted.
  relay.enqueue({ prompts: [], stops: [] });
  await until(() => relay.calls.filter(call => call.op === "pull" && call.body.waitMs === 60_000).length).toBeGreaterThan(0);
  expect(f.worker).toBeDefined();
});
