import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient, type RuntimeClientEnvironment, type RuntimeConnectionTarget } from "../runtime-client";
import { _resetRendererLogForTests, initRendererLogCapture } from "../../observability/logging/renderer-log";
import { _resetLogStoreForTests, initLogStore, readRecentLogs } from "../../../../../electron/log-store";
import { logSubmit, logsExportOpen, logsRecent } from "../../../../../electron/ipc/commands/logs";

const { nativeInvoke, openPath } = vi.hoisted(() => ({ nativeInvoke: vi.fn(), openPath: vi.fn(async () => "") }));
vi.mock("@/renderer/platform/runtime", () => ({ nativeInvoke, isElectron: () => true }));
vi.mock("electron", () => ({ shell: { openPath } }));

const NOW = Date.parse("2026-01-01T00:00:00Z");
const executionId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const privateText = "synthetic-private-prompt-output-and-error";
const prefix = "[Zeros cloud runtime] ";
const clients: RuntimeClient[] = [];
const directories: string[] = [];

function cloudTarget(n = 1) {
  return {
    kind: "cloud" as const, channel: "control-plane-websocket" as const, runtimeId: randomUUID(),
    organizationId: `${n}3333333-3333-4333-8333-333333333333`,
    workspaceId: `${n}4444444-4444-4444-8444-444444444444`,
    engineInstanceId: `${n}5555555-5555-4555-8555-555555555555`,
    generation: n, authorityEpoch: 1, connectionSequence: 1,
    url: "wss://api.zeros.test/v1/cloud-workspaces/bridge",
    cloudToken: `zwa_${"s".repeat(43)}`, expiresAt: NOW + 120_000,
  };
}

class Socket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror = null;
  sent: Record<string, unknown>[] = [];
  send(text: string) {
    const message = JSON.parse(text) as Record<string, unknown>;
    this.sent.push(message);
    if (message.type === "WORKSPACE_REQUEST" && message.op === "workspace.list") {
      this.receive({ type: "WORKSPACE_RESPONSE", requestId: message.id, op: message.op, result: { workspaces: [] } });
    }
  }
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ id: randomUUID(), source: "engine", timestamp: NOW, ...frame }) });
  }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; }
}

function runtime(target: RuntimeConnectionTarget) {
  const sockets: Socket[] = [];
  const environment: RuntimeClientEnvironment = {
    controlPlaneOrigin: "https://api.zeros.test", allowHttpLoopback: false,
    createWebSocket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; },
    resolveEnginePort: vi.fn(async () => 42001), resolveEngineToken: vi.fn(async () => ""),
    invalidateEnginePort: vi.fn(), invalidateEngineToken: vi.fn(), getAuthAccessToken: () => null,
    logger: console,
  };
  const client = new RuntimeClient(target, { environment });
  clients.push(client);
  return { client, sockets, environment };
}

async function connect(target: RuntimeConnectionTarget = cloudTarget()) {
  const fixture = runtime(target);
  await fixture.client.connect();
  const socket = fixture.sockets[0];
  socket.open();
  await Promise.resolve();
  socket.receive({ type: "ENGINE_READY", version: privateText, framework: privateText, root: `/private/${privateText}`, port: 42001,
    protocolVersion: 1, minProtocolVersion: 1 });
  return { ...fixture, socket };
}

function vmEvents(socket: Socket) {
  const common = { agentId: "codex", executionId, sessionId: executionId };
  socket.receive({ type: "AGENT_SESSION_CREATED", agentId: "codex", requestId: randomUUID(),
    session: { sessionId: executionId, privateText }, initialize: { privateText } });
  socket.receive({ type: "AGENT_SESSION_UPDATE", ...common,
    notification: { sessionId: executionId, update: { sessionUpdate: "turn_state", turnId, state: "running", startedAt: NOW, privateText } } });
  socket.receive({ type: "AGENT_SESSION_UPDATE", ...common,
    notification: { sessionId: executionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: privateText } } } });
  socket.receive({ type: "AGENT_AGENT_STDERR", agentId: "codex", line: privateText });
  socket.receive({ type: "PTY_DATA", terminalId: privateText, data: privateText });
  socket.receive({ type: "AGENT_STEERED", ...common, requestId: randomUUID(), turnId, outcome: "delivered", privateText });
  socket.receive({ type: "AGENT_PROMPT_FAILED", ...common, requestId: randomUUID(), error: privateText,
    failure: { kind: "transport-closed", message: privateText, advice: privateText, exit: { code: 1, signal: null, stderrTail: privateText } } });
  socket.receive({ type: "AGENT_AGENT_EXITED", ...common, code: 1, signal: "SIGTERM", privateText });
  socket.receive({ type: "AGENT_SESSION_CLOSED", ...common, requestId: randomUUID(), privateText });
}

async function exported() {
  // Drive the real bounded renderer batch, real main handler and real JSONL
  // store. No log/helper stub may supply the missing VM events.
  await vi.advanceTimersByTimeAsync(1_000);
  const recent = await logsRecent({}, {} as never) as { text: string };
  const file = await logsExportOpen({}, {} as never) as { path: string };
  directories.push(path.dirname(file.path));
  expect(readFileSync(file.path, "utf8")).toBe(recent.text);
  return recent.text;
}

function diagnostics(text: string): Array<Record<string, unknown>> {
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as { text: string })
    .filter(record => record.text.startsWith(prefix)).map(record => JSON.parse(record.text.slice(prefix.length)) as Record<string, unknown>);
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  vi.stubGlobal("window", new EventTarget());
  for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  _resetRendererLogForTests();
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-cloud-diagnostics-"));
  directories.push(directory); initLogStore(directory);
  nativeInvoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "log_submit") return logSubmit(args, {} as never);
    throw new Error("Unexpected diagnostic IPC");
  });
  initRendererLogCapture();
});
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  _resetRendererLogForTests(); _resetLogStoreForTests();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("cloud VM events in the ordinary diagnostic export", () => {
  it("exports bridge, VM readiness and agent-run metadata without their private payloads", async () => {
    const target = cloudTarget();
    const { client, socket, environment } = await connect(target);
    const delivered = vi.fn(); client.on("AGENT_PROMPT_FAILED", delivered);
    vmEvents(socket);
    const text = await exported();
    expect(text).toContain("[Zeros cloud bridge]");
    expect(diagnostics(text).map(event => event.type)).toEqual([
      "ENGINE_READY", "AGENT_SESSION_CREATED", "AGENT_SESSION_UPDATE", "AGENT_STEERED",
      "AGENT_PROMPT_FAILED", "AGENT_AGENT_EXITED", "AGENT_SESSION_CLOSED",
    ]);
    for (const event of diagnostics(text)) expect(event).toMatchObject({
      organizationId: target.kind === "cloud" ? target.organizationId : null,
      workspaceId: target.kind === "cloud" ? target.workspaceId : null, generation: 1,
      engineInstanceId: target.kind === "cloud" ? target.engineInstanceId : null,
    });
    expect(diagnostics(text)).toContainEqual(expect.objectContaining({ type: "AGENT_SESSION_UPDATE", state: "running", turnId, executionId }));
    expect(diagnostics(text)).toContainEqual(expect.objectContaining({ type: "AGENT_PROMPT_FAILED", failureKind: "transport-closed", executionId }));
    for (const line of text.split("\n").filter(Boolean)) {
      const record = JSON.parse(line) as { text: string; origin: string };
      if (record.text.startsWith(prefix)) expect(record.origin).toBe("frontend");
    }
    expect(readRecentLogs()).not.toContain(privateText);
    expect(text).not.toContain(privateText);
    if (target.kind === "cloud") for (const secret of [target.cloudToken, target.url]) expect(text).not.toContain(secret);
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ error: privateText }));
    expect(environment.resolveEnginePort).not.toHaveBeenCalled();
    expect(socket.sent.map(message => message.type)).toEqual(["CONNECTED", "WORKSPACE_REQUEST"]);
  });

  it.each(["Local Personal", "organization-local"])("keeps %s transport and logs unchanged", async owner => {
    const { client, socket } = await connect({ kind: "local" });
    const delivered = vi.fn(); client.on("AGENT_PROMPT_FAILED", delivered);
    console.info(`${owner} existing log`);
    vmEvents(socket);
    const text = await exported();
    expect(diagnostics(text)).toEqual([]);
    expect(text).not.toContain("[Zeros cloud bridge]");
    expect(text).toContain(`${owner} existing log`);
    expect(delivered).toHaveBeenCalledOnce();
    expect(socket.sent.map(message => message.type)).toEqual(["CONNECTED"]);
  });

  it("omits unknown payloads and independently closes every metadata value before persistence", async () => {
    const target = cloudTarget();
    const { socket } = await connect(target);
    const forgedScope = { workspaceId: privateText, organizationId: privateText, engineInstanceId: privateText, generation: privateText };
    socket.receive({ type: "ENGINE_ERROR", ...forgedScope, name: privateText, origin: privateText, message: privateText, stack: privateText });
    socket.receive({ type: "AGENT_SESSION_UPDATE", agentId: "codex", notification: null });
    socket.receive({ type: "AGENT_SESSION_UPDATE", agentId: "codex", notification: { update: { sessionUpdate: privateText, content: privateText } } });
    socket.receive({ type: "AGENT_SESSION_UPDATE", ...forgedScope, agentId: privateText, executionId: privateText,
      notification: { update: { sessionUpdate: "turn_state", state: privateText, turnId: privateText, stopReason: privateText } } });
    socket.receive({ type: "AGENT_PROMPT_FAILED", agentId: privateText, sessionId: privateText, requestId: privateText,
      error: privateText.repeat(5_000), failure: { kind: privateText, stage: privateText, stderrTail: privateText } });
    socket.receive({ type: "AGENT_AGENT_EXITED", agentId: privateText, code: -1, signal: privateText });
    socket.receive({ type: "future_private_type", message: privateText });
    const text = await exported(), events = diagnostics(text);
    expect(events.map(event => event.type)).toEqual(["ENGINE_READY", "ENGINE_ERROR", "AGENT_SESSION_UPDATE", "AGENT_PROMPT_FAILED", "AGENT_AGENT_EXITED"]);
    expect(events[1]).toMatchObject({ errorClass: "other" });
    expect(events[2]).toMatchObject({ state: "other", turnId: null, executionId: null, agentId: "other", stopReason: "other" });
    expect(events[3]).toMatchObject({ failureKind: "other", stage: "other", requestId: null });
    expect(events[4]).toMatchObject({ exitCode: null, signal: "other" });
    for (const event of events) expect(event).toMatchObject({ organizationId: target.organizationId, workspaceId: target.workspaceId,
      engineInstanceId: target.engineInstanceId, generation: 1 });
    expect(readRecentLogs()).not.toContain(privateText);
    expect(text).not.toContain(privateText);
  });

  it("keeps scope exact across A to B to A and refuses replaced or disposed socket events", async () => {
    const a = cloudTarget(), b = cloudTarget(2);
    const { client, socket: firstA, sockets } = await connect(a);
    const completed = { type: "AGENT_PROMPT_COMPLETE", agentId: "codex", sessionId: executionId,
      requestId: randomUUID(), stopReason: "end_turn", response: { privateText } };
    firstA.receive(completed);
    await client.setConnectionTarget(b);
    const socketB = sockets.at(-1)!; socketB.open(); await Promise.resolve();
    firstA.receive(completed); socketB.receive(completed);
    await client.setConnectionTarget({ ...a, runtimeId: randomUUID(), connectionSequence: 2 });
    const lastA = sockets.at(-1)!; lastA.open(); await Promise.resolve();
    firstA.receive(completed); socketB.receive(completed); lastA.receive(completed);
    client.dispose(); lastA.receive(completed);
    const events = diagnostics(await exported()).filter(event => event.type === "AGENT_PROMPT_COMPLETE");
    expect(events.map(event => [event.organizationId, event.workspaceId, event.connectionSequence])).toEqual([
      [a.organizationId, a.workspaceId, 1], [b.organizationId, b.workspaceId, 1], [a.organizationId, a.workspaceId, 2],
    ]);
    expect(readRecentLogs()).not.toContain(privateText);
  });

  it("bounds storms per event and in total, reports dropped events and creates no diagnostic polling", async () => {
    const { socket } = await connect();
    const failed = { type: "AGENT_PROMPT_FAILED", agentId: "codex", sessionId: executionId, error: privateText };
    // Distinct requests test the diagnostic rate budget independently of the
    // existing log store's consecutive-identical-line coalescer.
    for (let i = 0; i < 1_000; i++) socket.receive({ ...failed, requestId: randomUUID() });
    socket.receive({ type: "AGENT_SESSION_CLOSED", agentId: "codex", sessionId: executionId });
    const first = diagnostics(await exported());
    expect(first.filter(event => event.type === "AGENT_PROMPT_FAILED")).toHaveLength(8);
    expect(first.at(-1)).toMatchObject({ type: "AGENT_SESSION_CLOSED", suppressed: 992 });
    for (let i = 0; i < 20; i++) {
      vmEvents(socket);
      for (const type of ["AGENT_ERROR", "AGENT_PROMPT_COMPLETE", "AGENT_AGENT_INITIALIZED", "AGENT_SESSION_LOADED"]) {
        socket.receive({ type, agentId: "codex", sessionId: executionId, stopReason: "end_turn" });
      }
    }
    const text = await exported(), bounded = diagnostics(text);
    expect(bounded).toHaveLength(64);
    expect(bounded.every(event => Buffer.byteLength(prefix + JSON.stringify(event)) <= 1_536)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(500_000);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    socket.receive(failed);
    expect(diagnostics(await exported())).toHaveLength(65);
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.sent.map(message => message.type)).toEqual(["CONNECTED", "WORKSPACE_REQUEST"]);
    expect(readRecentLogs()).not.toContain(privateText);
  });

  it("cannot break correlated replies or listeners when the diagnostic observer throws", async () => {
    const { client, socket, environment } = await connect();
    const received = vi.fn(); client.on("AGENT_SESSION_CLOSED", received);
    environment.logger = { warn: line => { if (String(line).startsWith(prefix)) throw new Error(privateText); }, error: vi.fn() };
    const pending = client.request({ type: "AGENT_CLOSE_SESSION", agentId: "codex", sessionId: executionId }, 1_000);
    const requestId = socket.sent.at(-1)!.id;
    socket.receive({ type: "AGENT_SESSION_CLOSED", requestId, agentId: "codex", sessionId: executionId });
    await expect(pending).resolves.toMatchObject({ type: "AGENT_SESSION_CLOSED", requestId });
    expect(received).toHaveBeenCalledOnce();
    expect(await exported()).not.toContain(privateText);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exports while disconnected without opening or waking a cloud runtime", async () => {
    const { sockets, environment } = runtime(cloudTarget());
    const text = await exported();
    expect(diagnostics(text)).toEqual([]);
    expect(sockets).toHaveLength(0);
    expect(environment.resolveEnginePort).not.toHaveBeenCalled();
    expect(nativeInvoke.mock.calls.every(([command]) => command === "log_submit")).toBe(true);
  });

  it("keeps older engine events useful without requiring new fields or capabilities", async () => {
    const { socket } = await connect();
    socket.receive({ type: "ENGINE_READY", root: privateText, version: privateText, framework: privateText, port: 42001 });
    socket.receive({ type: "AGENT_PROMPT_FAILED", agentId: "codex", sessionId: executionId, error: privateText });
    const events = diagnostics(await exported());
    expect(events.at(-2)).toMatchObject({ type: "ENGINE_READY", protocolVersion: null, minProtocolVersion: null });
    expect(events.at(-1)).toMatchObject({ type: "AGENT_PROMPT_FAILED", failureKind: "other", stage: "other" });
    expect(readRecentLogs()).not.toContain(privateText);
  });
});
