import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { CloudWorker } from "../worker";
import { Agents } from "../agents";
import { SessionStore } from "../sessions/session-store";
import { ClaudeDriver } from "../drivers/claude/driver";
import { harness } from "../drivers/claude/__tests__/fake-query";
import { CLIENT_A, FakeRelay, browserFrame, config } from "./worker-fixtures";

afterEach(() => vi.restoreAllMocks());
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

it.each(["conversation Stop", "HTTP Stop", "workspace Stop", "worker disposal"])("does not release a held native approval after %s owns shutdown", async boundary => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-review-input-")), native = harness(), relay = new FakeRelay();
  const driver = new ClaudeDriver({ query: native.query });
  const worker = new CloudWorker({ directory, homeDirectory: directory, transport: relay, prepareCheckout: async () => {}, drivers: { claude: () => driver } });
  const entered = gate(), held = gate(), stopping = gate();
  let answer: Promise<void> | undefined, shutdown: Promise<void> | undefined;
  worker.start();
  try {
    await relay.receive({ ...config, agentInteractions: 1, agents: { claude: { oauthToken: "offline-review-placeholder" } } });
    await relay.receive({ t: "open", clientId: CLIENT_A });
    const opening = browserFrame("AGENT_NEW_SESSION", { agentId: "claude", chatId: "chat", cwd: config.workspace.checkoutPath,
      env: { ZEROS_PERMISSION_MODE: "plan" } });
    await relay.request(CLIENT_A, opening);
    const created = relay.response(opening.id) as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>;
    expect(created.type).toBe("AGENT_SESSION_CREATED");
    const executionId = created.session.sessionId;
    await relay.request(CLIENT_A, browserFrame("AGENT_PROMPT", { agentId: "claude", chatId: "chat", sessionId: executionId,
      executionId, userMessageId: "prompt", prompt: [{ type: "text", text: "fixture" }] }));
    await expect.poll(() => native.queries.length).toBe(1);
    const query = native.queries[0]; await query.read();
    expect(query.args.options.canUseTool).toBeTypeOf("function");
    let liveApproved = false;
    const permission = query.args.options.canUseTool!("Bash", { command: "fixture action" }, {
      signal: new AbortController().signal, toolUseID: "approval-native", matchedAskRule: { source: "projectSettings", toolName: "Bash" },
    } as never).then(value => { liveApproved = value?.behavior === "allow" && !query.closed; return value; });
    await expect.poll(() => relay.bridge("AGENT_PERMISSION_REQUEST").length).toBe(1);
    const request = relay.bridge("AGENT_PERMISSION_REQUEST")[0].frame as Extract<BridgeMessage, { type: "AGENT_PERMISSION_REQUEST" }>;
    const finish = SessionStore.prototype.finishInteraction;
    vi.spyOn(SessionStore.prototype, "finishInteraction").mockImplementation(async function (this: SessionStore, ...args) {
      entered.resolve(); await held.promise; return finish.apply(this, args);
    });
    const close = Agents.prototype.closeChat;
    vi.spyOn(Agents.prototype, "closeChat").mockImplementation(async function (this: Agents, ...args) {
      stopping.resolve(); return close.apply(this, args);
    });
    const outboxStop = Agents.prototype.stopOutbox;
    vi.spyOn(Agents.prototype, "stopOutbox").mockImplementation(async function (this: Agents, ...args) {
      stopping.resolve(); return outboxStop.apply(this, args);
    });
    const interrupt = driver.interrupt.bind(driver);
    vi.spyOn(driver, "interrupt").mockImplementation(() => { stopping.resolve(); return interrupt(); });
    answer = relay.request(CLIENT_A, browserFrame("AGENT_PERMISSION_RESPONSE", { chatId: "chat", executionId,
      permissionId: request.permissionId, response: { outcome: { outcome: "selected", optionId: "allow_once" } } }));
    await entered.promise;
    shutdown = boundary === "HTTP Stop" ? (worker as unknown as { agents: Agents }).agents.stopOutbox("chat", "1") : boundary === "conversation Stop" ? relay.request(CLIENT_A, browserFrame("AGENT_CANCEL", { agentId: "claude",
      chatId: "chat", sessionId: executionId, executionId })) : boundary === "workspace Stop"
      ? relay.receive({ t: "stop", id: randomUUID() }) : worker.dispose();
    await stopping.promise;
    held.resolve();
    const result = await permission;
    await Promise.all([answer, shutdown]);
    expect({ behavior: result?.behavior, liveApproved }).toEqual({ behavior: "deny", liveApproved: false });
  } finally {
    held.resolve(); await Promise.allSettled([answer, shutdown]); await worker.dispose(); await rm(directory, { recursive: true, force: true });
  }
});

it("interrupts every execution before waiting for one held shutdown settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-shutdown-input-")), native = harness(), relay = new FakeRelay();
  const worker = new CloudWorker({ directory, homeDirectory: directory, transport: relay, prepareCheckout: async () => {},
    drivers: { claude: () => new ClaudeDriver({ query: native.query }) } });
  const entered = gate(), held = gate(), stopping = gate();
  let answer: Promise<void> | undefined, shutdown: Promise<void> | undefined;
  const permissions: Array<Promise<unknown>> = [];
  worker.start();
  try {
    await relay.receive({ ...config, agentInteractions: 1, agents: { claude: { oauthToken: "offline-review-placeholder" } } });
    await relay.receive({ t: "open", clientId: CLIENT_A });
    for (const chatId of ["first", "second"]) {
      const opening = browserFrame("AGENT_NEW_SESSION", { agentId: "claude", chatId, cwd: config.workspace.checkoutPath,
        env: { ZEROS_PERMISSION_MODE: "plan" } });
      await relay.request(CLIENT_A, opening);
      const created = relay.response(opening.id) as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>;
      expect(created.type).toBe("AGENT_SESSION_CREATED");
      const executionId = created.session.sessionId;
      await relay.request(CLIENT_A, browserFrame("AGENT_PROMPT", { agentId: "claude", chatId, executionId, sessionId: executionId,
        userMessageId: `prompt-${chatId}`, prompt: [{ type: "text", text: "fixture" }] }));
      await expect.poll(() => native.queries.length).toBe(permissions.length + 1);
      const query = native.queries.at(-1)!; await query.read();
      permissions.push(query.args.options.canUseTool!("Bash", { command: "fixture action" }, {
        signal: new AbortController().signal, toolUseID: `approval-${chatId}`,
        matchedAskRule: { source: "projectSettings", toolName: "Bash" },
      } as never));
    }
    await expect.poll(() => relay.bridge("AGENT_PERMISSION_REQUEST").length).toBe(2);
    const request = relay.bridge("AGENT_PERMISSION_REQUEST").map(value => value.frame as Extract<BridgeMessage, { type: "AGENT_PERMISSION_REQUEST" }>).find(frame => frame.chatId === "first")!;
    const finish = SessionStore.prototype.finishInteraction;
    vi.spyOn(SessionStore.prototype, "finishInteraction").mockImplementation(async function (this: SessionStore, ...args) {
      if (args[0] === "first") { entered.resolve(); await held.promise; }
      return finish.apply(this, args);
    });
    const close = Agents.prototype.closeChat;
    vi.spyOn(Agents.prototype, "closeChat").mockImplementation(async function (this: Agents, ...args) {
      stopping.resolve(); return close.apply(this, args);
    });
    answer = relay.request(CLIENT_A, browserFrame("AGENT_PERMISSION_RESPONSE", { chatId: "first", executionId: request.request.executionId,
      permissionId: request.permissionId, response: { outcome: { outcome: "selected", optionId: "allow_once" } } }));
    await entered.promise;
    shutdown = relay.receive({ t: "stop", id: randomUUID() });
    await stopping.promise;
    expect(native.queries.map(query => query.closed)).toEqual([true, true]);
  } finally {
    held.resolve(); await Promise.allSettled([answer, shutdown, ...permissions]);
    await worker.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
