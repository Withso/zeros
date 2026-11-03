import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import type { SessionNotification } from "@zeros/protocol/agent-events";
import { CloudV2WorkerFrameSchema, CloudV2WorkerHistorySchema, CloudFailureSchema } from "@zeros/protocol/cloud-v2-relay";
import { CloudV2PromptOutcomeSchema, CloudV2PromptStatusSchema } from "@zeros/protocol/cloud-v2-prompts";
import { CloudWorker } from "../../../../../../cloud-worker/src/worker";
import { CLIENT_A, WORKSPACE_KEY, FakeDriver, FakeRelay, browserFrame, config } from "../../../../../../cloud-worker/src/__tests__/worker-fixtures";
import { fromPersistedMessage } from "../../../features/agent/agent-history-client";
import { turnFailureForCard } from "../../../features/agent/turn-failure";
import { isRunnableAgent, isSelectableAgent } from "../../../features/agent/agent-runnable";
import { parseInboundBridgeWebSocketFrame } from "../runtime-client";
import { cloudIncoming } from "../cloud-runtime-wire";
import { classifyRpcError, isRecoverable } from "../failure";
import * as previous from "./fixtures/previous-cloud-decoders.mjs";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const privateText = "PRIVATE_PROVIDER_DIAGNOSTIC";
const bootId = "33333333-3333-4333-8333-333333333333";

it("pins the actual previous decoder artifact independently of checkout depth", () => {
  const manifest = JSON.parse(readFileSync(new URL("./fixtures/previous-cloud-decoders.provenance.json", import.meta.url), "utf8"));
  const bytes = readFileSync(new URL("./fixtures/previous-cloud-decoders.mjs", import.meta.url));
  expect(manifest.revision).toBe("b3f7105390ff9339f55a245646a2bcff51e0f49d");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.sha256);
  expect(manifest.sources).toHaveLength(10);
});

it("accepts real new worker failures in the previous strict envelopes, live decoder and history reader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-previous-decoders-")), root = join(directory, "checkout");
  await mkdir(root);
  const relay = Object.assign(new FakeRelay(), { mcpAuthorization: async () => { throw Object.assign(new Error(privateText), { code: "mcp_auth_required" }); } });
  let failStart = false;
  const drivers: FakeDriver[] = [];
  const factory = () => {
    const driver = new FakeDriver(), open = driver.open.bind(driver);
    driver.open = async input => { if (failStart) throw Object.assign(new Error(privateText), { status: 503 }); return open(input); };
    driver.prompt = async () => { throw Object.assign(new Error(privateText), { code: "invalid_api_key" }); };
    drivers.push(driver); return driver;
  };
  const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {}, drivers: { cursor: factory, codex: factory } });
  cleanups.push(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
  worker.start();
  await relay.receive({ ...config, workspace: { ...config.workspace, checkoutPath: root },
    agents: { codex: { ...config.agents.codex!, expiresAt: 1 }, cursor: { apiKey: "fixture-credential" } },
    mcpServers: [{ id: bootId, name: "fixture", transport: "http", url: "https://mcp.example.test", auth: "oauth" }] });
  await relay.receive({ t: "open", clientId: CLIENT_A });
  const request = async (type: string, fields: Record<string, unknown> = {}) => {
    const frame = browserFrame(type, { agentId: "cursor", ...fields });
    await relay.request(CLIENT_A, frame);
    await expect.poll(() => relay.response(frame.id)).toBeDefined();
    await worker.flush();
    return relay.response(frame.id)!;
  };
  const opened = await request("AGENT_NEW_SESSION", { chatId: "chat", cwd: WORKSPACE_KEY });
  if (opened.type !== "AGENT_SESSION_CREATED") throw new Error("Expected session");
  const [server] = Object.values(drivers[0].opened!.mcpServers!);
  const response = await fetch(server.url, { method: "POST", headers: { ...server.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }) });
  await response.arrayBuffer();
  await request("AGENT_PROMPT", { sessionId: opened.session.sessionId, userMessageId: "prompt", prompt: [{ type: "text", text: "Synthetic prompt" }] });
  const registry = await request("AGENT_LIST_AGENTS");
  if (registry.type !== "AGENT_AGENTS_LIST") throw new Error("Expected registry");
  const unavailable = registry.agents.find(agent => agent.id === "codex")!;
  expect(isSelectableAgent(unavailable)).toBe(false);
  expect(isRunnableAgent(unavailable)).toBe(false);
  failStart = true;
  await request("AGENT_NEW_SESSION", { chatId: "failed-start", cwd: WORKSPACE_KEY });

  const scope = { organizationId: config.workspace.organizationId, workspaceId: config.workspace.id, engineWorkspaceId: config.workspace.id, root };
  const previousEvents: AgentMessage[] = [], currentEvents: AgentMessage[] = [];
  const seen = new Set<string>();
  for (const frame of relay.frames) {
    const oldEnvelope = previous.CloudV2WorkerFrameSchema.parse(JSON.parse(JSON.stringify(frame)));
    expect(CloudV2WorkerFrameSchema.safeParse(oldEnvelope).success).toBe(true);
    if (frame.t === "history") {
      expect(previous.CloudV2WorkerHistorySchema.safeParse({ ...frame, bootId, sequence: 1 }).success).toBe(true);
      for (const row of frame.messages?.rows ?? []) {
        const oldMessage = previous.fromPersistedMessage(row), current = fromPersistedMessage(row);
        expect(current).toEqual(oldMessage);
        if (current?.kind === "error_notice" && current.cloud) expect(CloudFailureSchema.safeParse(current.cloud).success).toBe(true);
      }
    }
    if (frame.t !== "frame") continue;
    expect(previous.CloudV2ControlFrameSchema.safeParse({ ...frame, clientId: CLIENT_A }).success).toBe(true);
    const oldMessage = previous.parseInboundBridgeWebSocketFrame(JSON.stringify(frame.frame));
    const current = parseInboundBridgeWebSocketFrame(JSON.stringify(frame.frame));
    expect(oldMessage).toEqual(current);
    expect(oldMessage).not.toBeNull();
    const mapped = cloudIncoming(scope, current as unknown as Record<string, unknown>);
    expect(previous.cloudIncoming(scope, oldMessage as unknown as Record<string, unknown>)).toEqual(mapped);
    if (current!.type === "AGENT_ERROR" || current!.type === "AGENT_PROMPT_FAILED") {
      expect(current!.failure?.cloud).toBeDefined();
      expect(isRecoverable(current!.failure!)).toBe(false);
      seen.add(current!.type);
    }
    if (current!.type === "AGENT_SESSION_UPDATE") {
      const notification = mapped.notification as SessionNotification;
      previousEvents.push(...previous.applyUpdate([], notification));
      currentEvents.push(...applyUpdate([], notification));
    }
  }
  expect([...seen].sort()).toEqual(["AGENT_ERROR", "AGENT_PROMPT_FAILED"]);
  const previousNotices = previousEvents.filter(event => event.kind === "error_notice");
  expect(previousNotices).toHaveLength(2);
  expect(previousNotices.every(event => !event.cloud && !!event.message)).toBe(true);
  const currentNotices = currentEvents.filter(event => event.kind === "error_notice");
  expect(currentNotices.map(event => event.cloud?.source).sort()).toEqual(["mcp", "provider"]);
  const turnId = currentNotices.find(event => event.cloud?.source === "provider")!.turnFailure!.turnId;
  expect(turnFailureForCard({ events: currentNotices, turnId, status: "failed" })).toMatchObject({ kind: "auth-required", cloud: { source: "provider", reason: "auth-required" } });
  expect(JSON.stringify(relay.frames)).not.toContain(privateText);
});

it("reads records produced by the previous reducer without requiring cloud metadata", () => {
  const notification = { sessionId: "old-execution", update: { sessionUpdate: "error_notice", noticeId: "old-failure",
    severity: "error", message: "The agent could not complete this request.", turnFailure: { turnId: "old-prompt", kind: "protocol-error" }, at: 1 } } satisfies SessionNotification;
  const [message] = previous.applyUpdate([], notification);
  const row = { msgId: message.id, kind: message.kind, createdAt: message.createdAt, payload: JSON.stringify(message) };
  const history = previous.CloudV2WorkerFrameSchema.parse({ t: "history", messages: { chatId: "old-chat", rows: [row] } });
  expect(CloudV2WorkerFrameSchema.safeParse(history).success).toBe(true);
  expect(CloudV2WorkerHistorySchema.safeParse({ ...history, bootId, sequence: 1 }).success).toBe(true);
  expect(fromPersistedMessage(row)).toEqual(message);
  expect(applyUpdate([], notification as SessionNotification)).toEqual([message]);
  expect(turnFailureForCard({ events: [message], turnId: "old-prompt", status: "failed" })).toMatchObject({ kind: "protocol-error", message: notification.update.message });
});

it("keeps a missing worker execution recoverable without claiming that the native provider session expired", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-adoption-failure-")), root = join(directory, "checkout");
  await mkdir(root);
  const relay = new FakeRelay(), driver = new FakeDriver();
  const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {}, drivers: { codex: () => driver } });
  cleanups.push(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
  worker.start(); await relay.receive({ ...config, workspace: { ...config.workspace, checkoutPath: root } });
  await relay.receive({ t: "open", clientId: CLIENT_A });
  const frame = browserFrame("AGENT_LOAD_SESSION", { agentId: "codex", chatId: "chat", sessionId: "absent-execution", adoptOnly: true, cwd: WORKSPACE_KEY });
  await relay.request(CLIENT_A, frame);
  const reply = parseInboundBridgeWebSocketFrame(JSON.stringify(relay.response(frame.id)));
  expect(reply).toMatchObject({ type: "AGENT_ERROR", failure: { kind: "session-expired" } });
  if (reply?.type !== "AGENT_ERROR" || !reply.failure) throw new Error("Expected adoption miss");
  expect(reply.failure.cloud).toBeUndefined();
  expect(isRecoverable(reply.failure)).toBe(true);
  expect(driver.opened).toBeUndefined();
  const reopen = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "chat", cwd: WORKSPACE_KEY });
  await relay.request(CLIENT_A, reopen);
  expect(relay.response(reopen.id)).toMatchObject({ type: "AGENT_SESSION_CREATED" });
});

it("keeps strict HTTPS outbox outcomes and receipts compatible in both directions", () => {
  const outcome = { userMessageId: "prompt", dispatchId: bootId, state: "failed" };
  const status = { receipt: { workspaceId: config.workspace.id, chatId: "chat", userMessageId: "prompt", sequence: "1", epoch: "0", acceptedAt: new Date(0).toISOString(), workspaceState: "running" },
    state: "failed", payload: null, cancelRequested: false };
  expect(previous.CloudV2PromptOutcomeSchema.parse(CloudV2PromptOutcomeSchema.parse(outcome))).toEqual(outcome);
  expect(CloudV2PromptOutcomeSchema.parse(previous.CloudV2PromptOutcomeSchema.parse(outcome))).toEqual(outcome);
  expect(previous.CloudV2PromptStatusSchema.parse(CloudV2PromptStatusSchema.parse(status))).toEqual(status);
  expect(CloudV2PromptStatusSchema.parse(previous.CloudV2PromptStatusSchema.parse(status))).toEqual(status);
});

it.each(["/local/personal", "/local/organization"])("keeps %s readiness and transport recovery unchanged", folder => {
  const agent = { id: "codex", name: "Codex", version: "fixture", description: folder, distribution: {}, installed: true,
    authenticationUnavailableReason: "The Local execution prerequisite could not be checked." };
  expect(isRunnableAgent(agent)).toBe(true);
  expect(isSelectableAgent(agent)).toBe(false);
  expect(isRecoverable(classifyRpcError(new Error("connection closed")))).toBe(true);
});
