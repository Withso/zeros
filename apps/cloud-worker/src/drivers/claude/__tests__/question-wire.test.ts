import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudV2PromptDelivery } from "@zeros/protocol/cloud-v2-prompts";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { CloudWorker } from "../../../worker";
import { Agents } from "../../../agents";
import type { PromptRequest } from "../../../transport";
import { SessionStore } from "../../../sessions/session-store";
import { CLIENT_A, FakeRelay, WORKSPACE_ID, browserFrame, config } from "../../../__tests__/worker-fixtures";
import { CLOUD_INPUT_TIMEOUT_MS } from "../../shared/native-input";
import { ClaudeDriver } from "../driver";
import { harness } from "./fake-query";

afterEach(() => vi.restoreAllMocks());
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

it.each(["answer", "conversation Stop", "HTTP Stop", "workspace Stop", "worker disposal"])("settles a Full access native question under the durable %s boundary", async boundary => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-question-wire-")), native = harness(), relay = new FakeRelay();
  const driver = new ClaudeDriver({ query: native.query });
  const worker = new CloudWorker({ directory, homeDirectory: directory, transport: relay, prepareCheckout: async () => {}, drivers: { claude: () => driver } });
  const entered = gate(), held = gate();
  let answer: Promise<void> | undefined, shutdown: Promise<void> | undefined;
  try {
    worker.start();
    await relay.receive({ ...config, agentInteractions: 1, agents: { claude: { oauthToken: "offline-question-placeholder" } } });
    await relay.receive({ t: "open", clientId: CLIENT_A });
    const opening = browserFrame("AGENT_NEW_SESSION", { agentId: "claude", chatId: "chat", cwd: config.workspace.checkoutPath });
    await relay.request(CLIENT_A, opening);
    const created = relay.response(opening.id) as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>;
    const executionId = created.session.sessionId;
    await relay.request(CLIENT_A, browserFrame("AGENT_PROMPT", { agentId: "claude", chatId: "chat", sessionId: executionId,
      executionId, userMessageId: "prompt", prompt: [{ type: "text", text: "fixture" }] }));
    await expect.poll(() => native.queries.length).toBe(1);
    const query = native.queries[0]; await query.read();
    expect(query.args.options.canUseTool).toBeUndefined();
    const hook = query.args.options.hooks?.PreToolUse?.[0].hooks[0];
    expect(hook).toBeTypeOf("function");
    let liveAnswered = false;
    const pending = hook!({ hook_event_name: "PreToolUse", session_id: query.args.options.sessionId!, transcript_path: "/fixture/transcript",
      cwd: config.workspace.checkoutPath, tool_name: "AskUserQuestion", tool_use_id: "native-question",
      tool_input: { questions: [{ question: "Route?", options: [{ label: "A" }, { label: "B" }] }] } }, "native-question", { signal: new AbortController().signal })
      .then(value => { liveAnswered = "hookSpecificOutput" in value && value.hookSpecificOutput?.hookEventName === "PreToolUse" &&
        value.hookSpecificOutput.permissionDecision === "allow" && !query.closed; return value; });
    await expect.poll(() => relay.bridge("AGENT_QUESTION_REQUEST").length).toBe(1);
    const request = relay.bridge("AGENT_QUESTION_REQUEST")[0].frame as Extract<BridgeMessage, { type: "AGENT_QUESTION_REQUEST" }>;
    const finish = SessionStore.prototype.finishInteraction;
    vi.spyOn(SessionStore.prototype, "finishInteraction").mockImplementation(async function (this: SessionStore, ...args) {
      entered.resolve(); await held.promise; return finish.apply(this, args);
    });
    answer = relay.request(CLIENT_A, browserFrame("AGENT_QUESTION_RESPONSE", { chatId: "chat", executionId,
      questionId: request.questionId, response: { outcome: { outcome: "answered", answers: [{ questionId: "q0", selectedOptionIds: ["o1"] }] } } }));
    await entered.promise;
    if (boundary !== "answer") {
      shutdown = boundary === "HTTP Stop" ? (worker as unknown as { agents: Agents }).agents.stopOutbox("chat", "1") : boundary === "conversation Stop"
        ? relay.request(CLIENT_A, browserFrame("AGENT_CANCEL", { agentId: "claude", chatId: "chat", sessionId: executionId, executionId }))
        : boundary === "workspace Stop" ? relay.receive({ t: "stop", id: randomUUID() }) : worker.dispose();
      await expect.poll(() => query.closed || query.interrupts > 0).toBe(true);
    }
    held.resolve();
    expect(await pending).toMatchObject({ hookSpecificOutput: { permissionDecision: boundary === "answer" ? "allow" : "deny" } });
    expect(liveAnswered).toBe(boundary === "answer");
    await Promise.all([answer, shutdown]);
    expect(relay.bridge("AGENT_PERMISSION_REQUEST")).toEqual([]);
  } finally { held.resolve(); await Promise.allSettled([answer, shutdown]); await worker.dispose(); await rm(directory, { recursive: true, force: true }); }
});

class ExpiryRelay extends FakeRelay {
  prompts: CloudV2PromptDelivery[] = [];
  calls: Array<{ operation: string; body: Record<string, unknown> }> = [];
  promptRequest: PromptRequest = async (operation, raw, signal) => {
    const body = raw as Record<string, unknown>;
    this.calls.push({ operation, body });
    if (operation === "pull") {
      if (this.prompts.length || body.waitMs === 0) return { prompts: this.prompts.splice(0), stops: [] };
      return new Promise((_, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (operation === "ack") return { state: "inboxed" };
    if (operation === "begin") return { dispatch: true, state: "dispatching" };
    if (operation === "outcome") return { state: body.state };
    if (operation === "stop") return { chatId: body.chatId, epoch: "1" };
    return { ok: true };
  };
}

it.each(["bridge", "HTTP"])("expires a Full access %s question through Stop before the hook backstop", async origin => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-question-expiry-")), native = harness(), relay = new ExpiryRelay();
  const worker = new CloudWorker({ directory, homeDirectory: directory, transport: relay, workspaceId: WORKSPACE_ID,
    prepareCheckout: async () => {}, drivers: { claude: () => new ClaudeDriver({ query: native.query }) } });
  const delivery = (sequence: string): CloudV2PromptDelivery => {
    const userMessageId = randomUUID();
    return { receipt: { workspaceId: WORKSPACE_ID, chatId: "chat", userMessageId, epoch: "0", sequence,
      acceptedAt: new Date(0).toISOString(), workspaceState: "running" }, deliveryId: randomUUID(),
    payload: { chatId: "chat", userMessageId, agentId: "claude", prompt: [{ type: "text", text: "fixture" }], startedAt: 1 } };
  };
  const first = delivery("1"), second = delivery("2");
  if (origin === "HTTP") relay.prompts.push(first);
  try {
    worker.start();
    await relay.receive({ ...config, agentInteractions: 1, ...(origin === "HTTP" ? { promptOutbox: 1 } : {}),
      agents: { claude: { oauthToken: "offline-question-placeholder" } } });
    if (origin === "bridge") {
      await relay.receive({ t: "open", clientId: CLIENT_A });
      const opening = browserFrame("AGENT_NEW_SESSION", { agentId: "claude", chatId: "chat", cwd: config.workspace.checkoutPath });
      await relay.request(CLIENT_A, opening);
      const created = relay.response(opening.id) as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>;
      const executionId = created.session.sessionId;
      await relay.request(CLIENT_A, browserFrame("AGENT_PROMPT", { agentId: "claude", chatId: "chat", sessionId: executionId,
        executionId, userMessageId: first.receipt.userMessageId, prompt: [{ type: "text", text: "fixture" }] }));
    }
    await expect.poll(() => native.queries.length).toBe(1);
    const query = native.queries[0]; await query.read();
    const deadlines: Array<{ at: number; fire: () => void }> = [], schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms && ms >= CLOUD_INPUT_TIMEOUT_MS - 1_000 && ms <= CLOUD_INPUT_TIMEOUT_MS + 5_000)
        deadlines.push({ at: Date.now() + ms, fire: () => callback(...args) });
      return schedule(callback, ms, ...args);
    }) as typeof setTimeout);
    const hook = query.args.options.hooks!.PreToolUse![0].hooks[0];
    const pending = hook({ hook_event_name: "PreToolUse", session_id: query.args.options.sessionId!, transcript_path: "/fixture/transcript",
      cwd: config.workspace.checkoutPath, tool_name: "AskUserQuestion", tool_use_id: "native-question",
      tool_input: { questions: [{ question: "Route?", options: [{ label: "A" }] }] } }, "native-question", { signal: new AbortController().signal });
    const store = (worker as unknown as { store: SessionStore }).store;
    await expect.poll(() => store.snapshot("chat")?.pendingInteractions?.length).toBe(1);
    if (origin === "HTTP") {
      relay.prompts.push(second); await relay.receive({ t: "prompts" });
      await expect.poll(() => store.snapshot("chat")?.inbox[1]?.outbox?.acknowledged).toBe(true);
    }
    expect(deadlines).toHaveLength(2);
    deadlines.sort((a, b) => a.at - b.at)[0].fire();
    await expect(pending).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await expect.poll(() => query.interrupts + Number(query.closed)).toBeGreaterThan(0);
    await expect.poll(() => store.snapshot("chat")?.inbox.map(entry => entry.state))
      .toEqual(origin === "HTTP" ? ["cancelled", "cancelled"] : ["cancelled"]);
    await worker.flush();
    expect(JSON.stringify(store.window("chat"))).toContain("dismissed after 15 minutes without an answer");
    expect(native.queries).toHaveLength(1);
    if (origin === "HTTP") {
      await expect.poll(() => relay.calls.filter(call => call.operation === "outcome" && call.body.state === "cancelled").length).toBe(2);
      expect(relay.calls.some(call => call.operation === "stop")).toBe(true);
      expect(relay.calls.filter(call => call.operation === "begin")).toHaveLength(1);
    }
  } finally { vi.restoreAllMocks(); await worker.dispose(); await rm(directory, { recursive: true, force: true }); }
});
