import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { QuestionRequest } from "@zeros/protocol/agent-events";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { CloudWorker } from "../worker";
import { SessionStore } from "../sessions/session-store";
import { CLOUD_INPUT_TIMEOUT_MS } from "../drivers/shared/native-input";
import { CLIENT_A, CLIENT_B, FakeDriver, FakeRelay, browserFrame, config } from "./worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks(); vi.useRealTimers(); });
const until = (read: () => unknown) => expect.poll(read, { timeout: 2000, interval: 5 });

async function fixture(enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), "zeros-input-")), relay = new FakeRelay(), driver = new FakeDriver();
  let nextDriver = driver;
  const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {}, drivers: { codex: () => nextDriver } });
  cleanups.push(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
  worker.start(); await relay.receive({ ...config, ...(enabled ? { agentInteractions: 1 } : {}) });
  await relay.receive({ t: "open", clientId: CLIENT_A });
  const opening = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "chat", cwd: config.workspace.checkoutPath });
  await relay.request(CLIENT_A, opening);
  const created = relay.response(opening.id) as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>;
  const executionId = created.session.sessionId;
  await relay.request(CLIENT_A, browserFrame("AGENT_PROMPT", { agentId: "codex", chatId: "chat", sessionId: executionId,
    executionId, userMessageId: "prompt", prompt: [{ type: "text", text: "ask me" }] }));
  await until(() => driver.prompts.length).toBe(1);
  const request: QuestionRequest = { sessionId: executionId, questionId: "question", nativeRequestId: "native-question", toolCallId: "ask-tool",
    source: "native_rpc", blocking: true, questions: [{ id: "route", prompt: "Choose a route", options: [{ id: "A", label: "A" }], allowOther: true }] };
  const history = async () => {
    const folder = join(directory, "sessions"), name = (await readdir(folder)).find(name => name.endsWith(".json"))!;
    return JSON.parse(await readFile(join(folder, name), "utf8"));
  };
  const answer = (fields: Record<string, unknown> = {}) => relay.request(CLIENT_A, browserFrame("AGENT_QUESTION_RESPONSE", {
    chatId: "chat", executionId, questionId: request.questionId, response: { outcome: { outcome: "answered", answers: [{ questionId: "route", selectedOptionIds: ["A"] }] } }, ...fields,
  }));
  return { directory, relay, driver, worker, executionId, created, request, history, answer,
    replaceDriver: () => (nextDriver = new FakeDriver()) };
}

it("saves a pending question before publication, replays it on reconnect and settles only its exact owner", async () => {
  const f = await fixture();
  expect(f.driver.opened?.onQuestion).toBeTypeOf("function");
  let resolved = false;
  const pending = f.driver.opened!.onQuestion!(f.request).then(value => { resolved = true; return value; });
  await until(() => f.relay.bridge("AGENT_QUESTION_REQUEST").length).toBe(1);
  expect((await f.history()).pendingInteractions).toMatchObject([{ kind: "question", id: "question" }]);
  expect(f.relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: true });
  await f.answer({ executionId: "foreign" }); await f.answer({ chatId: "other" }); await f.answer({ questionId: "stale", nativeRequestId: f.request.nativeRequestId });
  expect(resolved).toBe(false);
  await f.relay.receive({ t: "close", clientId: CLIENT_A }); await f.relay.receive({ t: "open", clientId: CLIENT_B });
  await f.relay.request(CLIENT_B, browserFrame("AGENT_LOAD_SESSION", { chatId: "chat", agentId: "codex", sessionId: f.executionId, executionId: f.executionId, cwd: config.workspace.checkoutPath }));
  expect(f.relay.bridge("AGENT_QUESTION_REQUEST").at(-1)).toMatchObject({ clientId: CLIENT_B, frame: { request: { questionId: "question", executionId: f.executionId } } });
  await f.relay.receive({ t: "open", clientId: CLIENT_A });
  await f.answer(); expect(await pending).toMatchObject({ outcome: { outcome: "answered" } });
  expect((await f.history()).pendingInteractions).toEqual([]);
  expect((await f.history()).rows.map((row: { payload: string }) => JSON.parse(row.payload))).toContainEqual(expect.objectContaining({
    toolCallId: "ask-tool", rawOutput: { zerosQuestion: expect.objectContaining({ outcome: "answered", summary: "A" }) },
  }));
  await f.answer(); expect(f.relay.bridge("AGENT_QUESTION_SETTLED")).toHaveLength(2);
  f.driver.complete();
});

it("bounds a blocking input to 15 minutes and interrupts the turn with a durable dismissal", async () => {
  const timers = vi.spyOn(globalThis, "setTimeout"), f = await fixture();
  expect(f.driver.opened?.onQuestion).toBeTypeOf("function");
  const pending = f.driver.opened!.onQuestion!(f.request);
  await until(() => f.relay.bridge("AGENT_QUESTION_REQUEST").length).toBe(1);
  const expiry = timers.mock.calls.find(([, ms]) => typeof ms === "number" && ms <= CLOUD_INPUT_TIMEOUT_MS && ms > CLOUD_INPUT_TIMEOUT_MS - 1000)?.[0] as (() => void) | undefined;
  const busyReports = f.relay.frames.filter(frame => frame.t === "idle" && !frame.idle).length;
  expect(expiry).toBeTypeOf("function"); expiry!();
  await expect(pending).resolves.toMatchObject({ outcome: { outcome: "dismissed" } });
  await until(() => f.driver.interrupts).toBe(1);
  await until(async () => (await f.history()).inbox[0].state).toBe("cancelled");
  expect(JSON.stringify((await f.history()).rows)).toContain("dismissed after 15 minutes without an answer");
  expect(f.relay.frames.filter(frame => frame.t === "idle" && !frame.idle)).toHaveLength(busyReports);
});

it("keeps independent tools and child work busy while input is pending", async () => {
  const f = await fixture();
  expect(f.driver.opened?.onQuestion).toBeTypeOf("function");
  f.driver.emit({ sessionUpdate: "tool_call", toolCallId: "working", title: "shell", status: "in_progress", kind: "execute" });
  const pending = f.driver.opened!.onQuestion!(f.request);
  await until(() => f.relay.bridge("AGENT_QUESTION_REQUEST").length).toBe(1);
  expect(f.relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: false });
  f.driver.emit({ sessionUpdate: "tool_call_update", toolCallId: "working", status: "completed" });
  await until(() => f.relay.frames.filter(frame => frame.t === "idle").at(-1)).toEqual({ t: "idle", idle: true });
  await f.answer(); await pending; f.driver.complete();
});

it("dismisses on workspace shutdown and never restores a native resolver from disk", async () => {
  const f = await fixture(); expect(f.driver.opened?.onQuestion).toBeTypeOf("function");
  const pending = f.driver.opened!.onQuestion!(f.request);
  await until(() => f.relay.bridge("AGENT_QUESTION_REQUEST").length).toBe(1);
  await f.worker.dispose(); await pending;
  expect(JSON.stringify((await f.history()).rows)).toContain("dismissed when the workspace stopped");
  const restored = await SessionStore.open(join(f.directory, "sessions"), `cloud://${config.workspace.organizationId}/${config.workspace.id}`);
  expect(restored.snapshot("chat")?.pendingInteractions ?? []).toEqual([]);
});

it("advertises only negotiated Plan/full modes and refuses Plan on an older peer", async () => {
  const f = await fixture(false);
  expect(f.created.session.modes).toBeUndefined(); expect(f.driver.opened?.onQuestion).toBeUndefined();
  const mode = browserFrame("AGENT_SET_MODE", { agentId: "codex", sessionId: f.executionId, executionId: f.executionId, chatId: "chat", modeId: "read-only" });
  await f.relay.request(CLIENT_A, mode);
  expect(f.relay.response(mode.id)).toMatchObject({ type: "AGENT_ERROR", code: "CLOUD_V2_UNSUPPORTED" });
  f.driver.complete();
  const supported = await fixture();
  expect(supported.created.session.modes).toMatchObject({ availableModes: [{ id: "read-only" }, { id: "full-access" }] });
  supported.driver.complete();
});


it("keeps a timed-out Plan approval dismissed after late native output and a stale history import", async () => {
  const timers = vi.spyOn(globalThis, "setTimeout"), f = await fixture();
  const pending = f.driver.opened!.onPermission!({ sessionId: f.executionId,
    nativeRequestId: "plan-native", toolCall: { toolCallId: "plan-tool", title: "ExitPlanMode", kind: "switch_mode", status: "pending", rawInput: { plan: "Add the change" } },
    options: [{ optionId: "allow_once", name: "Approve", kind: "allow_once" }, { optionId: "reject_once", name: "Deny", kind: "reject_once" }] });
  await until(() => f.relay.bridge("AGENT_PERMISSION_REQUEST").length).toBe(1);
  const saved = (await f.history()).rows.find((row: { payload: string }) => JSON.parse(row.payload).toolCallId === "plan-tool");
  const timeout = timers.mock.calls.find(([, ms]) => typeof ms === "number" && ms > CLOUD_INPUT_TIMEOUT_MS - 1000 && ms <= CLOUD_INPUT_TIMEOUT_MS)![0] as () => void;
  timeout(); await pending; await until(() => f.driver.interrupts).toBe(1);
  f.driver.emit({ sessionUpdate: "tool_call_update", toolCallId: "plan-tool", status: "completed", rawOutput: "late native output" });
  await f.relay.request(CLIENT_A, browserFrame("WORKSPACE_REQUEST", { op: "messages.import", params: { chatId: "chat", messages: [saved] } }));
  await until(async () => !(await f.history()).pendingInteractions?.length).toBe(true);
  const plan = (await f.history()).rows.map((row: { payload: string }) => JSON.parse(row.payload)).find((row: { toolCallId: string }) => row.toolCallId === "plan-tool");
  expect(plan.status).toBe("failed"); expect(plan.rawOutput.zerosInputDismissal).toBe("dismissed after 15 minutes without an answer");
});

it("does not interrupt a later turn when a nonblocking question expires", async () => {
  const timers = vi.spyOn(globalThis, "setTimeout"), f = await fixture();
  const pending = f.driver.opened!.onQuestion!({ ...f.request, blocking: false });
  await until(() => f.relay.bridge("AGENT_QUESTION_REQUEST").length).toBe(1);
  f.driver.complete(); await until(() => f.relay.bridge("AGENT_PROMPT_COMPLETE").length).toBe(1);
  await f.relay.request(CLIENT_A, browserFrame("AGENT_PROMPT", { agentId: "codex", chatId: "chat", executionId: f.executionId, sessionId: f.executionId,
    userMessageId: "later", prompt: [{ type: "text", text: "continue" }] }));
  await until(() => f.driver.prompts.length).toBe(2);
  const timeout = timers.mock.calls.find(([, ms]) => typeof ms === "number" && ms > CLOUD_INPUT_TIMEOUT_MS - 1000 && ms <= CLOUD_INPUT_TIMEOUT_MS)![0] as () => void;
  timeout(); await pending; expect(f.driver.interrupts).toBe(0); f.driver.complete();
});

it("passes a secret answer to the native resolver without putting it in history or broadcasts", async () => {
  const f = await fixture(), secret = "private answer fixture";
  const pending = f.driver.opened!.onQuestion!({ ...f.request, questions: [{ ...f.request.questions[0], secret: true }] });
  await until(() => f.relay.bridge("AGENT_QUESTION_REQUEST").length).toBe(1);
  await f.answer({ response: { outcome: { outcome: "answered", answers: [{ questionId: "route", selectedOptionIds: [], freeText: secret }] } } });
  expect(await pending).toMatchObject({ outcome: { answers: [{ freeText: secret }] } });
  expect(JSON.stringify((await f.history()).rows)).not.toContain(secret);
  expect(JSON.stringify(f.relay.frames)).not.toContain(secret);
  f.driver.complete();
});

it("cancels instead of delivering an answer whose durable write failed", async () => {
  const f = await fixture();
  const pending = f.driver.opened!.onQuestion!(f.request);
  await until(() => f.relay.bridge("AGENT_QUESTION_REQUEST").length).toBe(1);
  const write = vi.spyOn(SessionStore.prototype, "finishInteraction").mockRejectedValueOnce(new Error("fixture write failure"));
  await f.answer();
  expect(await pending).toMatchObject({ outcome: { outcome: "dismissed" } });
  await until(() => f.driver.interrupts).toBe(1);
  write.mockRestore();
});

it("rejects foreign and unoffered permission choices, then acknowledges and persists a native mode change", async () => {
  const f = await fixture(); let resolved = false;
  const pending = f.driver.opened!.onPermission!({ sessionId: f.executionId, nativeRequestId: "plan", requiresExplicitApproval: true,
    toolCall: { toolCallId: "plan", title: "ExitPlanMode", kind: "switch_mode", rawInput: { plan: "Change it" } },
    options: [{ optionId: "allow_once", name: "Approve", kind: "allow_once" }] }).then(value => { resolved = true; return value; });
  await until(() => f.relay.bridge("AGENT_PERMISSION_REQUEST").length).toBe(1);
  const request = f.relay.bridge("AGENT_PERMISSION_REQUEST")[0].frame as Extract<BridgeMessage, { type: "AGENT_PERMISSION_REQUEST" }>;
  const response = (executionId: string, optionId: string) => f.relay.request(CLIENT_A, browserFrame("AGENT_PERMISSION_RESPONSE", {
    chatId: "chat", executionId, permissionId: request.permissionId, response: { outcome: { outcome: "selected", optionId } },
  }));
  await response("foreign", "allow_once"); await response(f.executionId, "allow_always");
  expect(resolved).toBe(false);
  const mode = browserFrame("AGENT_SET_MODE", { agentId: "codex", chatId: "chat", sessionId: f.executionId, executionId: f.executionId, modeId: "full-access" });
  await f.relay.request(CLIENT_A, mode);
  expect(f.relay.response(mode.id)).toMatchObject({ type: "AGENT_MODE_CHANGED", modeId: "full-access", executionId: f.executionId });
  expect((await f.history()).chat).toMatchObject({ permissionMode: "danger", lastModeId: "full-access" });
  expect(resolved).toBe(false);
  await response(f.executionId, "allow_once"); expect(await pending).toMatchObject({ outcome: { optionId: "allow_once" } });
  f.driver.complete();
});

it.each([true, false])("changing to full access selects only an offered native once-only choice (offered=%s)", async offered => {
  const f = await fixture(); let resolved = false;
  const pending = f.driver.opened!.onPermission!({ sessionId: f.executionId, nativeRequestId: "native-command",
    toolCall: { toolCallId: "command", title: "Run command", kind: "execute" },
    options: [{ optionId: "acceptForSession", name: "Allow for session", kind: "allow_always" },
      ...(offered ? [{ optionId: "accept", name: "Allow once", kind: "allow_once" as const }] : [])],
  }).then(value => { resolved = true; return value; });
  await until(() => f.relay.bridge("AGENT_PERMISSION_REQUEST").length).toBe(1);
  try {
    await f.relay.request(CLIENT_A, browserFrame("AGENT_SET_MODE", { agentId: "codex", chatId: "chat", sessionId: f.executionId,
      executionId: f.executionId, modeId: "full-access" }));
    expect(resolved).toBe(offered);
    if (offered) expect(await pending).toMatchObject({ outcome: { outcome: "selected", optionId: "accept" } });
  } finally { await f.worker.dispose(); await pending; }
});

it("recovers a crash snapshot with a dismissal instead of a dangling native resolver", async () => {
  const f = await fixture(), snapshot = await mkdtemp(join(tmpdir(), "zeros-input-crash-"));
  cleanups.push(() => rm(snapshot, { recursive: true, force: true }));
  const pending = f.driver.opened!.onQuestion!(f.request);
  await until(() => f.relay.bridge("AGENT_QUESTION_REQUEST").length).toBe(1);
  await cp(join(f.directory, "sessions"), snapshot, { recursive: true });
  const restored = await SessionStore.open(snapshot, `cloud://${config.workspace.organizationId}/${config.workspace.id}`);
  expect(restored.snapshot("chat")?.pendingInteractions ?? []).toEqual([]);
  expect(JSON.stringify(restored.snapshot("chat")?.rows)).toContain("dismissed when the workspace stopped");
  expect(restored.snapshot("chat")?.inbox[0].state).toBe("interrupted");
  await f.answer(); await pending; f.driver.complete();
});

it("retires pending input before replacing a driver and refuses callbacks from that retired driver", async () => {
  const f = await fixture(), oldCallback = f.driver.opened!.onQuestion!;
  const pending = oldCallback({ ...f.request, blocking: false });
  await until(() => f.relay.bridge("AGENT_QUESTION_REQUEST").length).toBe(1);
  f.driver.complete(); await until(() => f.relay.bridge("AGENT_PROMPT_COMPLETE").length).toBe(1);
  const replacement = f.replaceDriver();
  await f.relay.receive({ ...config, agentInteractions: 1, loginRevision: "2",
    agents: { codex: { ...config.agents.codex!, token: "rotated-fixture-token" } } });
  await f.relay.request(CLIENT_A, browserFrame("AGENT_PROMPT", { agentId: "codex", chatId: "chat", sessionId: f.executionId,
    executionId: f.executionId, userMessageId: "next", prompt: [{ type: "text", text: "next" }] }));
  await until(() => replacement.prompts.length).toBe(1);
  expect(f.driver.disposed).toBe(true); expect(f.driver.prompts).toHaveLength(1);
  expect(await pending).toMatchObject({ outcome: { outcome: "dismissed" } });
  const count = f.relay.bridge("AGENT_QUESTION_REQUEST").length;
  expect(await oldCallback({ ...f.request, questionId: "retired", nativeRequestId: "retired" })).toMatchObject({ outcome: { outcome: "dismissed" } });
  expect(f.relay.bridge("AGENT_QUESTION_REQUEST")).toHaveLength(count);
  replacement.complete();
});
