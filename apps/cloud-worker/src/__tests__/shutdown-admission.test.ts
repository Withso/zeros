import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudV2PromptDelivery } from "@zeros/protocol/cloud-v2-prompts";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { CloudWorker } from "../worker";
import { Agents } from "../agents";
import { PromptInbox } from "../prompt-inbox";
import { SessionStore } from "../sessions/session-store";
import { ClaudeDriver } from "../drivers/claude/driver";
import { harness } from "../drivers/claude/__tests__/fake-query";
import { CLIENT_A, FakeDriver, FakeRelay, browserFrame, config } from "./worker-fixtures";

afterEach(() => vi.restoreAllMocks());
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
type Batch = { prompts: CloudV2PromptDelivery[]; stops: { chatId: string; epoch: string }[] };
class PullRelay extends FakeRelay {
  calls: { op: string; body: any }[] = [];
  queued: Batch[] = [];
  waiting?: (batch: Batch) => void;
  enqueue(batch: Batch): void {
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve(batch); }
    else this.queued.push(batch);
  }
  async promptRequest(op: string, body: any, signal?: AbortSignal): Promise<unknown> {
    this.calls.push({ op, body });
    if (op === "pull") {
      if (this.queued.length) return this.queued.shift();
      if (!body.waitMs) return { prompts: [], stops: [] };
      return new Promise<Batch>((resolve, reject) => {
        const abort = () => { this.waiting = undefined; reject(new DOMException("Aborted", "AbortError")); };
        this.waiting = batch => { signal?.removeEventListener("abort", abort); resolve(batch); };
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (op === "stop") return { chatId: body.chatId, epoch: (BigInt(body.throughEpoch) + 1n).toString() };
    if (op === "ack") return { state: "inboxed" };
    if (op === "begin") return { state: "dispatching", dispatch: true };
    if (op === "outcome") return { state: body.state };
    return { ok: true };
  }
}

it.each([
  { boundary: "workspace Stop", pendingAdmission: false },
  { boundary: "worker disposal", pendingAdmission: false },
  { boundary: "workspace Stop", pendingAdmission: true },
  { boundary: "worker disposal", pendingAdmission: true },
])("fences a live approval during $boundary while a reset holds HTTP admission: $pendingAdmission", async ({ boundary, pendingAdmission }) => {
  const directory = await mkdtemp(join(tmpdir(), "g835-shutdown-"));
  const native = harness(), relay = new PullRelay(), driver = new ClaudeDriver({ query: native.query });
  const worker = new CloudWorker({ directory, homeDirectory: directory, transport: relay, prepareCheckout: async () => {}, drivers: { claude: () => driver } });
  const approvalEntered = gate(), approvalHeld = gate(), mutationEntered = gate(), mutationHeld = gate(), inboxDisposing = gate();
  let answer: Promise<void> | undefined, shutdown: Promise<void> | undefined, mutation: Promise<void> | undefined;
  let permission: Promise<any> | undefined;
  worker.start();
  try {
    await relay.receive({ ...config, promptOutbox: 1, agentInteractions: 1, historyReplacement: 1,
      agents: { claude: { oauthToken: "offline-review-placeholder" } } });
    await relay.receive({ t: "open", clientId: CLIENT_A });
    const opening = browserFrame("AGENT_NEW_SESSION", { agentId: "claude", chatId: "approval-chat", cwd: config.workspace.checkoutPath,
      env: { ZEROS_PERMISSION_MODE: "plan" } });
    await relay.request(CLIENT_A, opening);
    const created = relay.response(opening.id) as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>;
    expect(created.type).toBe("AGENT_SESSION_CREATED");
    const executionId = created.session.sessionId;
    await relay.request(CLIENT_A, browserFrame("AGENT_PROMPT", { agentId: "claude", chatId: "approval-chat", sessionId: executionId,
      executionId, userMessageId: "prompt", prompt: [{ type: "text", text: "fixture" }] }));
    await expect.poll(() => native.queries.length).toBe(1);
    const query = native.queries[0]!; await query.read();
    let liveApproved = false;
    permission = query.args.options.canUseTool!("Bash", { command: "fixture action" }, {
      signal: new AbortController().signal, toolUseID: "approval-native", matchedAskRule: { source: "projectSettings", toolName: "Bash" },
    } as never).then(value => { liveApproved = value?.behavior === "allow" && !query.closed; return value; });
    await expect.poll(() => relay.bridge("AGENT_PERMISSION_REQUEST").length).toBe(1);
    const request = relay.bridge("AGENT_PERMISSION_REQUEST")[0]!.frame as Extract<BridgeMessage, { type: "AGENT_PERMISSION_REQUEST" }>;
    const finish = SessionStore.prototype.finishInteraction;
    vi.spyOn(SessionStore.prototype, "finishInteraction").mockImplementation(async function (this: SessionStore, ...args) {
      if (args[0] === "approval-chat") { approvalEntered.resolve(); await approvalHeld.promise; }
      return finish.apply(this, args);
    });
    answer = relay.request(CLIENT_A, browserFrame("AGENT_PERMISSION_RESPONSE", { chatId: "approval-chat", executionId,
      permissionId: request.permissionId, response: { outcome: { outcome: "selected", optionId: "allow_once" } } }));
    await approvalEntered.promise;

    await relay.request(CLIENT_A, browserFrame("WORKSPACE_REQUEST", { op: "chats.upsert", params: { chat: {
      id: "reset-chat", folder: config.workspace.checkoutPath, agentId: "claude", createdAt: 1,
    } } }));
    await relay.request(CLIENT_A, browserFrame("WORKSPACE_REQUEST", { op: "messages.import", params: { chatId: "reset-chat", messages: [{
      msgId: "cut", kind: "text", createdAt: 1, payload: JSON.stringify({ id: "cut", kind: "text", role: "user", text: "cut", createdAt: 1 }),
    }] } }));
    const truncate = SessionStore.prototype.truncateMessages;
    vi.spyOn(SessionStore.prototype, "truncateMessages").mockImplementation(async function (this: SessionStore, ...args) {
      if (args[0] === "reset-chat") { mutationEntered.resolve(); await mutationHeld.promise; }
      return truncate.apply(this, args);
    });
    mutation = relay.request(CLIENT_A, browserFrame("WORKSPACE_REQUEST", { op: "messages.truncateFrom", params: { chatId: "reset-chat", fromMsgId: "cut" } }));
    await mutationEntered.promise;
    if (pendingAdmission) {
      const waiting = gate(), target = Agents.prototype as unknown as { afterMutation(chatId: string, signal?: AbortSignal): Promise<void> };
      const after = target.afterMutation;
      vi.spyOn(target, "afterMutation").mockImplementation(function (this: Agents, ...args) {
        const result = after.apply(this, args);
        if (args[0] === "reset-chat") waiting.resolve();
        return result;
      });
      relay.enqueue({ prompts: [{ deliveryId: randomUUID(), payload: { chatId: "reset-chat", userMessageId: "successor", agentId: "claude",
        startedAt: 2, prompt: [{ type: "text", text: "successor" }] }, receipt: { chatId: "reset-chat", userMessageId: "successor", epoch: "1",
        sequence: "1", workspaceId: config.workspace.id, acceptedAt: new Date().toISOString(), workspaceState: "running" } }], stops: [] });
      await relay.receive({ t: "prompts" });
      await waiting.promise;
    }
    const dispose = PromptInbox.prototype.dispose;
    vi.spyOn(PromptInbox.prototype, "dispose").mockImplementation(function (this: PromptInbox) {
      const result = dispose.call(this); inboxDisposing.resolve(); return result;
    });
    shutdown = boundary === "workspace Stop" ? relay.receive({ t: "stop", id: randomUUID() }) : worker.dispose();
    await inboxDisposing.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    approvalHeld.resolve();
    const result = await permission;
    expect({ behavior: result?.behavior, liveApproved }).toEqual({ behavior: "deny", liveApproved: false });
  } finally {
    approvalHeld.resolve(); mutationHeld.resolve();
    await Promise.allSettled([answer, permission, mutation, shutdown]);
    await worker.dispose(); await rm(directory, { recursive: true, force: true });
  }
});

it("disables the HTTP inbox during a held mutation without failing or admitting its waiting delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-inbox-mutation-")), relay = new PullRelay(), driver = new FakeDriver();
  const worker = new CloudWorker({ directory, homeDirectory: directory, transport: relay, prepareCheckout: async () => {}, drivers: { codex: () => driver } });
  const entered = gate(), held = gate();
  let mutation: Promise<void> | undefined, disable: Promise<void> | undefined;
  worker.start();
  try {
    await relay.receive({ ...config, promptOutbox: 1, historyReplacement: 1 });
    const { store, agents } = worker as unknown as { store: SessionStore; agents: Agents };
    await store.upsert({ id: "chat", folder: config.workspace.checkoutPath, agentId: "codex", createdAt: 1 });
    mutation = agents.mutateChat("chat", false, async () => { entered.resolve(); await held.promise; });
    await entered.promise;
    const receive = vi.spyOn(agents, "receiveOutbox");
    const item: CloudV2PromptDelivery = { deliveryId: randomUUID(), payload: { chatId: "chat", userMessageId: "waiting", agentId: "codex",
      startedAt: 2, prompt: [{ type: "text", text: "waiting" }] }, receipt: { chatId: "chat", userMessageId: "waiting", epoch: "1",
      sequence: "1", workspaceId: config.workspace.id, acceptedAt: new Date().toISOString(), workspaceState: "running" } };
    relay.enqueue({ prompts: [item], stops: [] });
    await relay.receive({ t: "prompts" });
    await expect.poll(() => receive.mock.calls.length).toBe(1);
    let disabled = false;
    disable = relay.receive({ ...config, loginRevision: "2", historyReplacement: 1 }).then(() => { disabled = true; });
    await expect.poll(() => disabled).toBe(true);
    expect(store.receipt("chat", "waiting")).toBeUndefined();
    expect(relay.calls.some(call => call.op === "outcome" && call.body.userMessageId === "waiting")).toBe(false);
    held.resolve(); await mutation;
    expect(store.receipt("chat", "waiting")).toBeUndefined();
    await relay.receive({ ...config, loginRevision: "3", promptOutbox: 1, historyReplacement: 1 });
    relay.enqueue({ prompts: [item], stops: [] });
    await expect.poll(() => driver.prompts.length).toBe(1);
    driver.complete();
  } finally {
    held.resolve(); await Promise.allSettled([mutation, disable]);
    await worker.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
