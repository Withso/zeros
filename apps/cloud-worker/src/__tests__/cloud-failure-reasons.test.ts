import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudV2Agent } from "@zeros/protocol/cloud-v2-relay";
import { CloudWorker } from "../worker";
import { SessionStore } from "../sessions/session-store";
import { fileURLToPath } from "node:url";
import { ClaudeDriver } from "../drivers/claude/driver";
import { CodexDriver } from "../drivers/codex/driver";
import type { Driver } from "../drivers/driver";
import { harness, result } from "../drivers/claude/__tests__/fake-query";
import { CLIENT_A, FakeDriver, FakeRelay, WORKSPACE_KEY, browserFrame, config } from "./worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(prepare?: (driver: FakeDriver) => void, expiresAt = Date.now() + 60_000, nativeFactory?: () => Driver) {
  const directory = await mkdtemp(join(tmpdir(), "cloud-failure-reasons-"));
  const root = join(directory, "checkout"), state = join(directory, "state");
  await mkdir(root);
  const relay = new FakeRelay(), drivers: FakeDriver[] = [];
  const factory = () => { if (nativeFactory) return nativeFactory(); const driver = new FakeDriver(); prepare?.(driver); drivers.push(driver); return driver; };
  const worker = new CloudWorker({ directory: state, transport: relay, prepareCheckout: async () => {},
    drivers: { claude: factory, codex: factory, cursor: factory } });
  cleanups.push(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
  const configuration = { ...config, workspace: { ...config.workspace, checkoutPath: root }, agents: {
    claude: { apiKey: "fixture-claude-credential" }, cursor: { apiKey: "fixture-cursor-credential" },
    codex: { ...config.agents.codex!, expiresAt },
  } };
  worker.start();
  await relay.receive(configuration);
  await relay.receive({ t: "open", clientId: CLIENT_A });
  const request = async (type: string, fields: Record<string, unknown> = {}) => {
    const frame = browserFrame(type, fields);
    await relay.request(CLIENT_A, frame);
    await worker.flush();
    if (type === "AGENT_PROMPT") await expect.poll(() => relay.response(frame.id), { timeout: 5000 }).toBeDefined();
    const response = relay.response(frame.id);
    if (!response) throw new Error(`No ${type} response`);
    return response;
  };
  const open = (agentId: CloudV2Agent = "cursor", chatId = "chat") => request("AGENT_NEW_SESSION", { agentId, chatId, cwd: WORKSPACE_KEY });
  return { worker, relay, drivers, request, open, state, configuration };
}

const privateDetail = "PRIVATE_DIAGNOSTIC_MUST_NOT_LEAVE_WORKER";
const failures = [
  { native: { code: "invalid_api_key" }, kind: "auth-required", reason: "auth-required" },
  { native: { status: 429 }, kind: "rate-limited", reason: "rate-limited" },
  { native: { code: "thread_not_found" }, kind: "session-expired", reason: "session-expired" },
  { native: { code: "model_not_found" }, kind: "protocol-error", reason: "model-unavailable" },
  { native: { status: 503 }, kind: "transport-closed", reason: "provider-unavailable" },
] as const;

it.each(failures)("preserves $reason through the real worker startup reply", async ({ native, kind, reason }) => {
  const f = await setup(driver => { driver.open = async () => { throw Object.assign(new Error(privateDetail), native); }; });
  const reply = await f.open();
  expect(reply).toMatchObject({ type: "AGENT_ERROR", failure: { kind, stage: "newSession", agentId: "cursor",
    cloud: { source: "provider", provider: "cursor", reason } } });
  if (reply.type !== "AGENT_ERROR") throw new Error("Expected failure");
  expect(reply.failure?.kind).toBe(kind);
  expect(JSON.stringify(reply)).not.toContain(privateDetail);
});

it("keeps a confirmed Retry-After deadline without exporting the provider's headers", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_800_000_000_000);
  const f = await setup(driver => { driver.open = async () => { throw Object.assign(new Error(privateDetail), {
    status: 429, headers: { "retry-after": "60", "x-private-diagnostic": privateDetail },
  }); }; });
  const reply = await f.open();
  expect(reply).toMatchObject({ type: "AGENT_ERROR", failure: {
    cloud: { source: "provider", reason: "rate-limited", retryAt: Date.now() + 60_000 },
  } });
  expect(JSON.stringify(reply)).not.toContain(privateDetail);
  expect(JSON.stringify(reply)).not.toContain("headers");
});

it("persists the same sanitized prompt failure in its receipt and transcript across a worker restart", async () => {
  const f = await setup(driver => { driver.prompt = async () => { throw Object.assign(new Error(privateDetail), { code: "invalid_api_key" }); }; });
  const opened = await f.open();
  if (opened.type !== "AGENT_SESSION_CREATED") throw new Error("Expected session");
  const reply = await f.request("AGENT_PROMPT", { agentId: "cursor", sessionId: opened.session.sessionId,
    userMessageId: "opening-message", prompt: [{ type: "text", text: "A synthetic prompt" }] });
  expect(reply).toMatchObject({ type: "AGENT_PROMPT_FAILED", failure: { kind: "auth-required", stage: "prompt",
    cloud: { source: "provider", provider: "cursor", reason: "auth-required" } } });
  await f.worker.dispose();
  const store = await SessionStore.open(join(f.state, "sessions"), WORKSPACE_KEY);
  const snapshot = store.snapshot("chat")!;
  expect(snapshot.inbox[0]).toMatchObject({ state: "failed", failure: { kind: "auth-required" } });
  expect(snapshot.messages.filter(message => message.kind === "error_notice")).toMatchObject([
    { cloud: { source: "provider", reason: "auth-required" }, turnFailure: { turnId: "opening-message", kind: "auth-required" } },
  ]);
  expect(JSON.stringify(snapshot)).not.toContain(privateDetail);
  await store.flush();
});

it("uses the same Codex credential verdict for registry selection, fresh admission and renewal", async () => {
  const expiresAt = Date.now() + 60_000, f = await setup(undefined, expiresAt);
  const registry = async () => {
    const reply = await f.request("AGENT_LIST_AGENTS");
    if (reply.type !== "AGENT_AGENTS_LIST") throw new Error("Expected registry");
    return reply.agents.find(agent => agent.id === "codex")!;
  };
  expect((await registry()).authenticated).toBe(true);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(expiresAt);
  const unavailable = await registry();
  expect(unavailable).toMatchObject({ authenticated: false, cloud: { source: "provider", provider: "codex", reason: "credentials-unavailable" } });
  expect(await f.open("codex")).toMatchObject({ type: "AGENT_ERROR", failure: { kind: "cloud-credentials-unavailable",
    cloud: { reason: "credentials-unavailable" } } });
  expect(f.drivers).toHaveLength(0);
  await f.relay.receive({ ...f.configuration, agents: { ...f.configuration.agents,
    codex: { ...f.configuration.agents.codex, expiresAt: Date.now() + 60_000 } } });
  expect((await registry()).authenticated).toBe(true);
  expect(await f.open("codex")).toMatchObject({ type: "AGENT_SESSION_CREATED" });
});

it("refuses new input on an idle existing Codex execution after its proxy grant expires", async () => {
  const expiresAt = Date.now() + 60_000;
  const nativePrompt = vi.fn(async () => ({ stopReason: "end_turn" as const }));
  const f = await setup(driver => { driver.prompt = nativePrompt; }, expiresAt);
  const opened = await f.open("codex");
  if (opened.type !== "AGENT_SESSION_CREATED") throw new Error("Expected session");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(expiresAt);
  const reply = await f.request("AGENT_PROMPT", { agentId: "codex", sessionId: opened.session.sessionId,
    userMessageId: "after-expiry", prompt: [{ type: "text", text: "A synthetic follow-up" }] });
  expect(reply).toMatchObject({ type: "AGENT_PROMPT_FAILED", failure: { kind: "cloud-credentials-unavailable" } });
  expect(nativePrompt).not.toHaveBeenCalled();
});

it("reattaches to a running turn after grant expiry while still refusing new native work", async () => {
  const expiresAt = Date.now() + 60_000, f = await setup(undefined, expiresAt);
  const opened = await f.open("codex");
  if (opened.type !== "AGENT_SESSION_CREATED") throw new Error("Expected session");
  const sessionId = opened.session.sessionId;
  const prompt = browserFrame("AGENT_PROMPT", { agentId: "codex", sessionId, userMessageId: "running-turn", prompt: [{ type: "text", text: "Synthetic work" }] });
  await f.relay.request(CLIENT_A, prompt);
  await expect.poll(() => f.drivers[0].prompts.length).toBe(1);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(expiresAt);
  expect(await f.request("AGENT_LOAD_SESSION", { agentId: "codex", sessionId, chatId: "chat", cwd: WORKSPACE_KEY, adoptOnly: true }))
    .toMatchObject({ type: "AGENT_SESSION_LOADED", promptActive: true });
  expect(f.drivers).toHaveLength(1);
  expect(f.drivers[0].disposed).toBe(false);
  f.drivers[0].complete();
  await expect.poll(() => f.relay.response(prompt.id)).toMatchObject({ type: "AGENT_PROMPT_COMPLETE" });
  expect(await f.request("AGENT_PROMPT", { agentId: "codex", sessionId, userMessageId: "next-turn", prompt: [{ type: "text", text: "Synthetic follow-up" }] }))
    .toMatchObject({ type: "AGENT_PROMPT_FAILED", failure: { kind: "cloud-credentials-unavailable" } });
  expect(f.drivers[0].prompts).toHaveLength(1);
});

it.each(["rpc", "event"])("keeps native Codex %s rate-limit evidence through the actual driver, worker and durable consumer", async mode => {
  const driver = new CodexDriver({ command: process.execPath,
    args: [fileURLToPath(new URL("../drivers/codex/__tests__/fixtures/app-server.mjs", import.meta.url))], environment: {} });
  const f = await setup(undefined, undefined, () => driver);
  const opened = await f.open("codex");
  if (opened.type !== "AGENT_SESSION_CREATED") throw new Error("Expected session");
  const error = { message: privateDetail, data: { status: 429 } };
  const prompt = mode === "rpc" ? `refusal:${JSON.stringify(error)}` : `fixture:${JSON.stringify([{ method: "error", params: { error, willRetry: false } }])}`;
  const reply = await f.request("AGENT_PROMPT", { agentId: "codex", sessionId: opened.session.sessionId,
    userMessageId: "native-rate-limit", prompt: [{ type: "text", text: prompt }], bubble: { displayText: "Synthetic rate-limit probe" } });
  expect(reply).toMatchObject({ type: "AGENT_PROMPT_FAILED", failure: { kind: "rate-limited", cloud: { reason: "rate-limited" } } });
  await f.worker.dispose();
  const store = await SessionStore.open(join(f.state, "sessions"), WORKSPACE_KEY);
  const notice = store.snapshot("chat")!.messages.find(message => message.kind === "error_notice");
  expect(notice).toMatchObject({ turnFailure: { kind: "rate-limited" }, cloud: { reason: "rate-limited" } });
  expect(JSON.stringify(notice)).not.toContain(privateDetail);
});

it.each(["claude", "codex"] as const)("persists cancelled %s questions and MCP input as nonblocking transcript notices", async agentId => {
  const sdk = harness();
  const driver = agentId === "claude"
    ? new ClaudeDriver({ query: sdk.query, executable: "/fixture/claude", environment: {} })
    : new CodexDriver({ command: process.execPath, args: [fileURLToPath(new URL("../drivers/codex/__tests__/fixtures/app-server.mjs", import.meta.url))], environment: {} });
  const f = await setup(undefined, undefined, () => driver);
  const opened = await f.open(agentId);
  if (opened.type !== "AGENT_SESSION_CREATED") throw new Error("Expected session");
  const pending = f.request("AGENT_PROMPT", { agentId, sessionId: opened.session.sessionId,
    userMessageId: "question-turn", prompt: [{ type: "text", text: "requests" }] });
  if (agentId === "claude") {
    await expect.poll(() => sdk.queries.length).toBe(1);
    const query = sdk.queries[0], sent = await query.read(), options = query.args.options;
    expect(await options.onUserDialog!({ dialogKind: "unknown", payload: { privateDetail } } as never, {} as never)).toEqual({ behavior: "cancelled" });
    expect(await options.onElicitation!({ message: privateDetail } as never, {} as never)).toEqual({ action: "cancel" });
    query.push(result(sent.uuid, { session_id: options.sessionId }));
  }
  expect(await pending).toMatchObject({ type: "AGENT_PROMPT_COMPLETE" });
  await f.worker.dispose();
  const store = await SessionStore.open(join(f.state, "sessions"), WORKSPACE_KEY);
  const notices = store.snapshot("chat")!.messages.filter(message => message.kind === "error_notice");
  expect(notices).toMatchObject([
    { code: "cloud-question-unsupported", severity: "warning", recoverable: true },
    { code: "cloud-mcp-elicitation-unsupported", severity: "warning", recoverable: true },
  ]);
  expect(notices.every(notice => notice.message.includes("Local workspace"))).toBe(true);
  expect(JSON.stringify(notices)).not.toContain(privateDetail);
});
