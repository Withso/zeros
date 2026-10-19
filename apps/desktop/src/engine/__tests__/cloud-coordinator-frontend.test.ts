import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessage, type BridgeMessage } from "@zeros/protocol/messages";
import type { CloudCommandClaim, CloudCommandSnapshot } from "@zeros/protocol/cloud-commands";
import type { CloudEventClientRequestSchema, CloudEventCursor } from "@zeros/protocol/cloud-events";
import type { z } from "zod";
import { CloudExecutionBoundary } from "../agents/containment/cloud-execution-boundary";
import { portableCloudWorkloads } from "../agents/containment/__tests__/helpers/portable-cloud-custody";
import { CloudTransport } from "../transport/cloud";
import { cloudCoordinatorFrontendSpawner } from "../cloud-coordinator-frontend";
import { CloudExecutionCoordinator } from "../cloud-execution-coordinator";
import { CloudActorAuthorityRegistry } from "../agents/cloud-actor-authority";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { CloudLocalCommandEventStore } from "../cloud-local-command-queue-events";
import { CloudEventRuntime } from "../cloud-event-runtime";
import { CloudCommandRuntime } from "../cloud-command-runtime";
import { CloudEventReader } from "../../renderer/platform/bridge/cloud-event-reader";
import type { ConnectionStatus, RuntimeClient } from "../../renderer/platform/bridge/ws-client";
import { applyUpdate, type AgentMessage } from "../../renderer/features/agent/use-agent-session";

const configuration = vi.hoisted(() => ({ uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
  version: 4 as const, backend: "cloud-worker" as const, profile: "zeros-cloud-worker-v4" as const,
  toolchain: { node: process.execPath, supervisor: `${process.cwd()}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } }));
vi.mock("../agents/containment/cloud-worker-config", () => ({ isCloudWorkerConfiguration: (value: unknown) => value === configuration }));
vi.mock("../agents/containment/cloud-runtime-root.mjs", async original => {
  const { testCloudRuntime } = await import("../agents/__tests__/helpers/test-cloud-runtime");
  return { ...await original<typeof import("../agents/containment/cloud-runtime-root.mjs")>(),
    resolveCloudRuntime: () => ({ ...testCloudRuntime(), node: process.execPath, workerRoot: process.cwd() }), assertCloudRuntimePath: vi.fn() };
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function fixture() {
  const directory = mkdtempSync("/tmp/zeros-frontend-test-");
  const reserve = net.createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as net.AddressInfo).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const socket = path.join(directory, "public.sock"), loopback = path.join(directory, "loopback.sock");
  const token = `zwr_${"a".repeat(43)}`;
  const transport = new CloudTransport({ port, token: "qualification-only-token", internalReadiness: { token,
    read: () => ({ version: 1, instanceId: "11111111-1111-4111-8111-111111111111", protocolVersion: 1, health: "ready", durableRecordConnected: true }) } });
  transport.useCoordinatorSocket(socket, loopback); await transport.start();
  cleanup.push(async () => { await transport.stop(); rmSync(directory, { recursive: true, force: true }); });
  const workloads = portableCloudWorkloads(configuration), boundary = new CloudExecutionBoundary({ configuration, workloads });
  cleanup.push(async () => { await workloads.drain(workloads.fence()); });
  const originalPrepare = boundary.prepareOwned.bind(boundary);
  const prepare = vi.spyOn(boundary, "prepareOwned").mockImplementation(async (...args) => {
    const prepared = await originalPrepare(...args); vi.spyOn(prepared, "spawn"); return prepared;
  });
  const frames: unknown[] = [], exited = vi.fn();
  const launch = { frontendId: randomUUID(), signal: new AbortController().signal, message: (value: unknown) => frames.push(value), exited };
  const child = await cloudCoordinatorFrontendSpawner(boundary, socket, loopback, port)(launch);
  if (!child) throw new Error("unfenced frontend was deferred");
  cleanup.push(() => child.stopAndProve());
  await expect.poll(() => frames).toContainEqual({ type: "ready", frontendId: launch.frontendId });
  const request = (pathname: string, localAddress = "127.0.0.1") => new Promise<number>((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: pathname, localAddress,
      headers: { "x-zeros-readiness-token": token } }, response => { response.resume(); resolve(response.statusCode!); });
    req.on("error", reject);
  });
  return { child, request, prepare, frames, launch, exited, workloads, port, directory, socket, loopback, boundary, transport };
}

/** Real WebSocket bytes, with only the desktop's native admission replaced by
 * the existing qualification token. This is not an S1/provider/base proof. */
function replayClient(port: number) {
  let socket: WebSocket | undefined;
  const listeners = new Map<string, Set<(frame: BridgeMessage) => void>>();
  const statuses = new Set<(status: ConnectionStatus) => void>();
  const request = vi.fn((input: object) => new Promise<BridgeMessage>((resolve, reject) => {
    const current = socket!, id = randomUUID();
    if (!current || current.readyState !== WebSocket.OPEN) { reject(new Error("Fixture transport disconnected")); return; }
    const done = () => { clearTimeout(timer); current.off("message", receive); current.off("close", closed); };
    const closed = () => { done(); reject(new Error("Fixture transport closed")); };
    const receive = (bytes: Buffer) => {
      const frame = JSON.parse(bytes.toString()) as BridgeMessage;
      if ("requestId" in frame && frame.requestId === id) { done(); resolve(frame); }
    };
    const timer = setTimeout(() => { done(); reject(new Error("Fixture request timed out")); }, 2_000);
    current.on("message", receive); current.on("close", closed);
    current.send(JSON.stringify({ ...input, id, source: "browser", timestamp: Date.now() }));
  }));
  const client = { request,
    on(type: string, listener: (frame: BridgeMessage) => void) {
      const callbacks = listeners.get(type) ?? new Set(); callbacks.add(listener); listeners.set(type, callbacks);
      return () => callbacks.delete(listener);
    },
    onStatusChange(listener: (status: ConnectionStatus) => void) { statuses.add(listener); return () => statuses.delete(listener); },
  } as unknown as RuntimeClient;
  cleanup.push(async () => { socket?.terminate(); });
  return { client, request, async connect() {
    const current = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["zeros-v1",
      `zeros-cloud-token.${Buffer.from("qualification-only-token").toString("base64url")}`]);
    socket = current;
    current.on("message", bytes => {
      if (socket !== current) return;
      const frame = JSON.parse(bytes.toString()) as BridgeMessage;
      for (const listener of listeners.get(frame.type) ?? []) listener(frame);
    });
    current.on("close", () => { if (socket === current) for (const listener of statuses) listener("disconnected"); });
    await new Promise<void>((resolve, reject) => { current.once("open", resolve); current.once("error", reject); });
    current.send(JSON.stringify(createMessage({ type: "CONNECTED", source: "browser", capabilities: [] })));
    for (const listener of statuses) listener("connected");
  } };
}

describe.skipIf(process.platform !== "linux")("Host-owned cloud frontend (portable custody fixture, real processes)", () => {
  it.each([8192, 1])("kill_frontend_mid_turn_then_reattach_without_redispatch (retained events=%s)", async maxEntries => {
    const f = await fixture(); await f.child.stopAndProve();
    const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
      bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
    const now = 1_000_000, actorSessionId = randomUUID(), conversationId = randomUUID(), executionId = randomUUID(), turnId = randomUUID();
    const engineLive = () => true;
    const actors = new CloudActorAuthorityRegistry({ scope, engineLive, time: { wall: () => now, monotonic: () => 0 } });
    actors.confirm({ scope, actorSessionId, authorityEpoch: 1, confirmedUntilMs: now + 9_000, fundingConsentVersion: 1,
      fundingGrant: { kind: "owner" }, actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 1,
        role: "owner", fingerprint: "a".repeat(64) } });
    const file = path.join(f.directory, "queue.sqlite");
    const queue = new CloudLocalCommandQueue({ file, scope, actors, engineLive, now: () => now,
      history: () => ({ recordSequence: 1, eventSequence: 0 }), ready: () => true, selectExecution: () => ({ executionId }) });
    const store = new CloudLocalCommandEventStore({ file, queue, engineLive, maxEntries });
    const unexpected = vi.fn(async () => { throw new Error("Unexpected control-plane event request"); });
    const events = new CloudEventRuntime(scope.engineInstanceId, { request: unexpected, onFailure: vi.fn() });
    let history: AgentMessage[] = [], displayed: AgentMessage[] = [];
    let activeTurn: { turnId: string; startedAt: number } | null = null;
    let complete!: () => void;
    const terminal = new Promise<void>(resolve => { complete = resolve; });
    let latestTurn: { turnId: string; status: "completed" } | null = null;
    const publish = (frame: BridgeMessage) => {
      if (frame.type === "AGENT_SESSION_UPDATE") history = applyUpdate(history, frame.notification);
      const retained = events.capture(frame); f.transport.broadcast(retained); return retained;
    };
    const text = (value: string) => publish(createMessage({ type: "AGENT_SESSION_UPDATE", source: "engine", chatId: conversationId,
      agentId: "codex", notification: { sessionId: executionId, update: { sessionUpdate: "agent_message_chunk", messageId: "answer",
        content: { type: "text", text: value } } } }));
    const dispatch = vi.fn(async (_claim: CloudCommandClaim) => {
      activeTurn = { turnId, startedAt: now }; text("Before restart. ");
      await terminal;
      activeTurn = null; latestTurn = { turnId, status: "completed" };
      return { state: "succeeded" as const, resultCode: null };
    });
    const commands = new CloudCommandRuntime({ request: unexpected, validate() {}, execution: () => executionId,
      dispatch, cancel: vi.fn(async () => {}), changed() {} });
    cleanup.push(async () => { complete(); commands.close(); events.close(); store.close(); queue.close(); actors.dispose(); });
    const initialize = vi.fn(async () => { commands.installLocalQueue(queue); events.start(); await events.installLocalStore(store); });
    const owner = new CloudExecutionCoordinator({ bootId: scope.bootId, initialize,
      spawn: cloudCoordinatorFrontendSpawner(f.boundary, f.socket, f.loopback, f.port), changed() {} });
    cleanup.push(() => owner.stop());
    await owner.start(); await expect.poll(() => owner.isInteractiveReady()).toBe(true);
    f.transport.onMessage(async (client, message) => {
      if (message.type !== "WORKSPACE_REQUEST" || message.op !== "cloudEvents.request") return;
      const input = (message.params as { request: z.infer<typeof CloudEventClientRequestSchema> }).request;
      try {
        const result = input.kind === "snapshot" ? await events.snapshot(() => ({ conversationId, executionId, history, activeTurn, latestTurn }))
          : await events.replay(input.cursor);
        client.send(createMessage({ type: "WORKSPACE_RESPONSE", source: "engine", requestId: message.id, op: message.op, result }));
      } catch (error) {
        client.send(createMessage({ type: "WORKSPACE_ERROR", source: "engine", requestId: message.id, op: message.op,
          code: (error as { code: string }).code, message: "Snapshot required" }));
      }
    });
    const peer = replayClient(f.port);
    let resnapshots = 0;
    const snapshot = async () => {
      const installation = reader.beginSnapshot({ conversationId, executionId });
      try {
        const response = await peer.client.request({ type: "WORKSPACE_REQUEST", op: "cloudEvents.request",
          params: { request: { kind: "snapshot", conversationId } } });
        const result = (response as unknown as { result: { cursor: CloudEventCursor; snapshot: { history: AgentMessage[] } } }).result;
        installation.install(result.cursor, { conversationId, executionId }, () => { displayed = result.snapshot.history; });
      } finally { installation.finish(); }
    };
    const reader = new CloudEventReader(peer.client, () => { resnapshots++; void snapshot(); });
    cleanup.push(async () => { reader.dispose(); });
    const updates = vi.fn((frame: BridgeMessage) => {
      if (frame.type === "AGENT_SESSION_UPDATE") displayed = applyUpdate(displayed, frame.notification);
    });
    reader.on("AGENT_SESSION_UPDATE", updates);
    await commands.handle({ kind: "mutate", mutation: { conversationId, operationId: randomUUID(), expectedRevision: 0,
      action: { kind: "enqueue", commandId: randomUUID(), payload: { agentId: "codex", model: "test-model", modeRevision: 0,
        userMessageId: turnId, prompt: [{ type: "text", text: "Synthetic" }] } } } }, actorSessionId);
    await expect.poll(() => dispatch.mock.calls.length).toBe(1);
    await peer.connect(); await snapshot();
    expect(displayed).toEqual(history);
    const original = owner.frontendId();
    const prepared = await f.prepare.mock.results.at(-1)!.value;
    const child = await vi.mocked(prepared.spawn).mock.results[0]!.value;
    await child.signal("SIGKILL");
    await expect.poll(() => owner.isInteractiveReady()).toBe(false);
    text("While disconnected. ");
    complete();
    await expect.poll(async () => (await commands.handle({ kind: "snapshot", conversationId }, actorSessionId) as CloudCommandSnapshot).receipts[0]?.state)
      .toBe("succeeded");
    const finalFrame = text("Completed once.");
    await expect.poll(() => owner.frontendId(), { timeout: 4_000 }).toSatisfy(value => !!value && value !== original);
    await peer.connect();
    // The reducer stamps delivery time, so compare transcript identity/content
    // before the authoritative snapshot restores the original timestamps.
    const transcript = (rows: AgentMessage[]) => rows.map(row => ({ id: row.id, kind: row.kind,
      ...(row.kind === "text" ? { text: row.text } : {}) }));
    await expect.poll(() => transcript(displayed)).toEqual(transcript(history));
    f.transport.broadcast(finalFrame); // An already replayed delivery cannot append again.
    // A response on the same ordered socket is a barrier for that delivery.
    await peer.client.request({ type: "WORKSPACE_REQUEST", op: "cloudEvents.request",
      params: { request: { kind: "replay", cursor: events.cursor } } });
    expect(transcript(displayed)).toEqual(transcript(history));
    expect(updates).toHaveBeenCalledTimes(maxEntries === 1 ? 0 : 2);
    await snapshot();
    expect(displayed).toEqual(history);
    expect(displayed.filter(row => row.kind === "text").map(row => row.text)).toEqual(["Before restart. While disconnected. Completed once."]);
    expect(resnapshots).toBe(maxEntries === 1 ? 1 : 0);
    expect(queue.turnJournal(0, 64).map(entry => [entry.state, entry.turnId])).toEqual([["started", turnId], ["completed", turnId]]);
    queue.acknowledgeTurnJournal(2); queue.acknowledgeTurnJournal(2); queue.acknowledgeTurnJournal(1);
    expect(queue.turnJournalAcked()).toBe(2);
    expect(dispatch).toHaveBeenCalledOnce(); expect(initialize).toHaveBeenCalledOnce(); expect(unexpected).not.toHaveBeenCalled();
  }, 15_000);

  it("forwards unchanged authenticated bytes, retains the loopback probe boundary and owns no credential", async () => {
    const f = await fixture();
    expect(await f.request("/health")).toBe(200);
    expect(await f.request("/internal/readiness")).toBe(200);
    expect(await f.request("/internal/readiness", "127.0.0.2")).toBe(404);
    const prepared = await f.prepare.mock.results[0]!.value;
    // Host custody supervises the exact original child, and infrastructure
    // does not manufacture an active user workload in the idle census.
    expect(f.prepare.mock.calls[0]![1]).toMatchObject({ kind: "service", role: "infrastructure" });
    const spawn = vi.mocked(prepared.spawn).mock.calls[0]![0];
    // Assert names only: a future accidental inheritance must not print the
    // parent's credential values in assertion diagnostics.
    expect(Object.keys(spawn.env).sort()).toEqual(["LANG", "PATH"]);
    expect(spawn.args).toEqual([path.join(process.cwd(), "apps/desktop/src/engine/cloud-interactive-frontend.mjs")]);
    for (const filename of [f.socket, f.loopback]) {
      expect(lstatSync(filename).isSocket()).toBe(true);
      expect(lstatSync(filename).uid).toBe(process.geteuid!());
      expect(lstatSync(filename).mode & 0o777).toBe(0o600);
    }
    await expect.poll(async () => (await f.workloads.inspect()).complete).toBe(true);
    const census = await f.workloads.inspect(); expect(census.workloadPids).toEqual([]);
    const scope = f.workloads.snapshot().scopes[0]!;
    for (const pid of scope.processGroups) {
      const environment = readFileSync(`/proc/${pid}/environ`).toString().split("\0").filter(Boolean).map(value => value.split("=")[0]);
      expect(environment).not.toContain("ZEROS_CLOUD_RUNTIME");
      expect(environment).not.toContain("ZEROS_CLOUD_TOKEN");
      expect(environment).not.toContain("HOME");
    }
    expect(prepared).toBeDefined();
    const challengeId = randomUUID(); f.child.challenge(challengeId);
    await expect.poll(() => f.frames).toContainEqual({ type: "pong", frontendId: f.launch.frontendId, challengeId });
    await f.child.stopAndProve();
    await expect.poll(() => f.exited.mock.calls.length).toBeGreaterThan(0);
    await expect(f.request("/health")).rejects.toThrow();
    expect((await f.workloads.inspect()).workloadPids).toEqual([]);
  });

  it("rejects a forged boundary and cannot adopt a Local process", () => {
    expect(() => cloudCoordinatorFrontendSpawner(null, "/tmp/public.sock", "/tmp/loopback.sock", 12345)).toThrow();
  });

  it("recovers ingress after a reversible Host admission fence without attempting a fenced preparation", async () => {
    const f = await fixture(); await f.child.stopAndProve();
    const fence = f.workloads.fence({ preserveActive: true });
    const initialize = vi.fn(async () => {});
    const owner = new CloudExecutionCoordinator({ bootId: randomUUID(), initialize,
      spawn: cloudCoordinatorFrontendSpawner(f.boundary, f.socket, f.loopback, f.port), changed() {} });
    cleanup.push(() => owner.stop());
    await owner.start();
    expect.soft(f.prepare).toHaveBeenCalledOnce();
    expect(owner.isInteractiveReady()).toBe(false);
    await f.workloads.joinPending(fence); f.workloads.resume(fence);
    await expect.poll(() => owner.isInteractiveReady(), { timeout: 3_000 }).toBe(true);
    expect(initialize).toHaveBeenCalledOnce();
    expect(await f.request("/health")).toBe(200);
  });

  it.each([true, false])("requires positive cleanup before retrying a failed native launch (proof=%s)", async proved => {
    const f = await fixture(); await f.child.stopAndProve();
    const originalPrepare = CloudExecutionBoundary.prototype.prepareOwned.bind(f.boundary);
    const retired = vi.fn();
    f.prepare.mockImplementation(async (...args) => {
      const prepared = await originalPrepare(...args), originalStop = prepared.stopAndProve.bind(prepared);
      vi.spyOn(prepared, "spawn").mockRejectedValue(new Error("native launch failed"));
      vi.spyOn(prepared, "stopAndProve").mockImplementation(async () => {
        retired();
        if (!proved) throw new Error("native retirement unknown");
        await originalStop();
      });
      return prepared;
    });
    const attempt = cloudCoordinatorFrontendSpawner(f.boundary, f.socket, f.loopback, f.port)({
      ...f.launch, frontendId: randomUUID() });
    if (proved) {
      await expect(attempt).resolves.toBeNull();
      expect(f.workloads.snapshot().scopes).toHaveLength(0);
    } else await expect(attempt).rejects.toThrow("native retirement unknown");
    expect(retired).toHaveBeenCalledOnce();
  });

  it("refuses a private socket directory readable by another UID", async () => {
    const f = await fixture(); chmodSync(f.directory, 0o750);
    expect(() => cloudCoordinatorFrontendSpawner(f.boundary, f.socket, f.loopback, f.port)).toThrow("private owner directory");
    chmodSync(f.directory, 0o700);
  });

  it.each(["parent pipe loss", "oversized control frame", "foreign frontend"])("closes public ingress on %s", async kind => {
    const f = await fixture(), prepared = await f.prepare.mock.results[0]!.value;
    const process = await vi.mocked(prepared.spawn).mock.results[0]!.value;
    if (kind === "parent pipe loss") process.stdin!.end();
    else process.stdin!.write(kind === "oversized control frame" ? "x".repeat(4097) :
      `${JSON.stringify({ type: "ping", frontendId: randomUUID(), challengeId: randomUUID() })}\n`);
    await expect.poll(() => f.exited.mock.calls.length).toBeGreaterThan(0);
    await expect(f.request("/health")).rejects.toThrow();
    await f.child.stopAndProve();
  });
});

it("cleans the first private listener when the second listener cannot start", async () => {
  const directory = mkdtempSync("/tmp/zeros-frontend-listen-");
  const socket = path.join(directory, "public.sock"), loopback = path.join(directory, "loopback.sock");
  const transport = new CloudTransport({ port: 23456, token: "qualification-only-token" });
  cleanup.push(async () => { await transport.stop(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(socket, "occupied", { mode: 0o600 }); transport.useCoordinatorSocket(socket, loopback);
  await expect(transport.start()).rejects.toThrow();
  expect(existsSync(loopback)).toBe(false);
  expect(readFileSync(socket, "utf8")).toBe("occupied");
});
