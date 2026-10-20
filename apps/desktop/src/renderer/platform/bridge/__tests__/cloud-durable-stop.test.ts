import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudAgentConnection } from "../cloud-agent-connection";
import { WorkspaceRuntimeClient, type CloudPeer, type WorkspaceRuntimeOptions } from "../workspace-runtime-client";
import { RuntimeClient } from "../ws-client";
import { cloudScopedId, cloudWorkspaceKey } from "../cloud-workspace-key";
import type { WireRecord } from "../cloud-runtime-wire";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const chat = "33333333-3333-4333-8333-333333333333";
const binding = { ...target, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", generation: 1, authorityEpoch: 1,
  engineInstanceId: "44444444-4444-4444-8444-444444444444", bootId: "55555555-5555-4555-8555-555555555555",
  writerEpoch: "66666666-6666-4666-8666-666666666666", fundingOwnerUserId: "77777777-7777-4777-8777-777777777777",
  fundingOwnerEpoch: 1, cacheRevision: 1, desiredCacheRevision: 1,
  initialAdoptions: ["claude", "codex", "cursor"].map(provider => ({ provider, status: "unknown" })) };
const route = cloudScopedId(target, `conversation:${chat}`), chatId = cloudScopedId(target, chat);
const prompt = { type: "AGENT_PROMPT", agentId: "codex", sessionId: route, executionId: route, chatId,
  userMessageId: "original-turn", prompt: [{ type: "text", text: "fixture prompt" }] };
const stop = { type: "AGENT_CANCEL", agentId: "codex", sessionId: route, executionId: route, chatId,
  id: "88888888-8888-4888-8888-888888888888" } as const;
const disposals: Array<() => void> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) dispose(); await vi.advanceTimersByTimeAsync(6000); vi.useRealTimers(); vi.restoreAllMocks(); });

/** Both production adapters are used; only the native authenticated transport
 * is replaced. A replacement peer reads the same durable queue. */
async function harness(options: { exactStop?: boolean; target?: typeof target; attach?: boolean } = {}) {
  vi.useFakeTimers();
  const scope = options.target ?? target;
  const route = cloudScopedId(scope, `conversation:${chat}`), chatId = cloudScopedId(scope, chat);
  const scopedPrompt = { ...prompt, sessionId: route, executionId: route, chatId };
  let command: WireRecord | undefined, paused = false, revision = 0;
  let disconnected = false, loseEnqueue = false, lostStops = 0, terminalGeneration = 1;
  let hiddenReads = 0, lostRemovals = 0, claimOnRemoval = false, execution: string | null = "native-execution";
  let nextBinding: Partial<typeof binding> = {};
  const readGate: { wait?: Promise<void> } = {};
  const state = { value: "dispatching" };
  const requests: WireRecord[] = [], grants = vi.fn(async () => "fixture-grant");
  const peers: Array<{ peer: CloudPeer; client: { status: string; executionIdentity: typeof binding & { kind: "cloud" }; send: ReturnType<typeof vi.fn> }; binding: typeof binding }> = [];
  const receipt = () => ({ conversationId: chat, commandId: command?.commandId, position: 1, state: state.value,
    payload: ["queued", "dispatching"].includes(state.value) ? command?.payload : null,
    executionId: state.value === "queued" ? null : execution, generation: terminalGeneration, resultCode: null,
    createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:01Z" });
  const snapshotEntry = () => { const { conversationId: _chat, ...entry } = receipt(); return entry; };
  const snapshot = () => ({ version: 1, conversationId: chat, revision, paused,
    pending: command && ["queued", "dispatching"].includes(state.value) ? [snapshotEntry()] : [],
    receipts: command && !["queued", "dispatching"].includes(state.value) ? [snapshotEntry()] : [] });
  const makePeer = () => {
    const currentBinding = { ...binding, ...scope, ...nextBinding };
    const client = { status: "connected", executionIdentity: { kind: "cloud" as const, ...currentBinding }, send: vi.fn(),
      supportsEngineCapability: (capability: string) => capability !== "cloud.commandStop.v1" || options.exactStop !== false,
      on: () => () => {}, onStatusChange: () => () => {},
      request: vi.fn(async (message: WireRecord) => {
        requests.push(message);
        const input = (message.params as { request?: WireRecord } | undefined)?.request;
        let result: unknown = {};
        if (message.op === "chats.list") result = { chats: [], chatDeletions: [] };
        if (["cloudCommands.conversation", "cloudCommands.createConversation"].includes(String(message.op)))
          result = { conversationId: chat, modeRevision: 0, nativeCommandsVersion: 1, permissionModeVersion: 1,
            cloudTurnProtocolVersion: 1, cloudLocalCommands: currentBinding };
        if (message.op === "cloudEvents.request") result = { snapshot: { conversationId: chat,
          executionId: command && state.value !== "queued" ? "native-execution" : undefined,
          activeTurn: command && state.value === "dispatching" ? { turnId: (command.payload as WireRecord)?.userMessageId, startedAt: 42 } : null,
          messages: [], permissions: [], questions: [] } };
        if (message.op === "cloudCommands.request") {
          if (input?.kind === "snapshot") result = snapshot();
          if (input?.kind === "mutate") {
            const mutation = input.mutation as WireRecord, action = mutation.action as WireRecord;
            if (action.kind === "enqueue") {
              command = action; revision++;
              if (loseEnqueue) { loseEnqueue = false; throw new Error("Connection closed before acknowledgement"); }
            } else if (action.kind === "remove") {
              if (claimOnRemoval) { state.value = "dispatching"; claimOnRemoval = false; throw new Error("command_conflict"); }
              if (lostRemovals-- > 0) throw new Error("Network disconnected before removal acknowledgement");
              state.value = "cancelled"; revision++;
            }
            else if (action.kind === "resume") { paused = false; revision++; }
            result = snapshot();
          }
          if (input?.kind === "stop") {
            if (lostStops-- > 0) throw new Error("Network disconnected before Stop acknowledgement");
            paused = true; revision++; result = snapshot();
          }
          if (input?.kind === "read") {
            if (disconnected && peers[0]?.client === client) { client.status = "disconnected"; throw new Error("Cloud transport disconnected"); }
            await readGate.wait;
            if (hiddenReads-- > 0) throw new Error("command_not_found");
            result = receipt();
          }
        }
        return { type: "WORKSPACE_RESPONSE", op: message.op, result };
      }),
    };
    const agents = new CloudAgentConnection(client as unknown as RuntimeClient, "local-main", grants);
    const peer = { client: client as unknown as RuntimeClient, agents, generation: 1,
      scope: { ...scope, root: "/workspace/repo", engineWorkspaceId: "local-main" }, release: () => agents.dispose() };
    peers.push({ peer, client, binding: currentBinding });
    return peer;
  };
  const open = vi.fn<WorkspaceRuntimeOptions["open"]>(async () => makePeer());
  const bridge = new WorkspaceRuntimeClient({ open, workspaces: () => [], readHistory: async () => ({ chats: [], chatDeletions: [] }) });
  disposals.push(() => bridge.dispose());
  if (options.attach !== false)
    await bridge.request({ type: "AGENT_NEW_SESSION", chatId, agentId: "codex", cwd: cloudWorkspaceKey(scope), env: { OPENAI_MODEL: "test-model" } });
  const request = (message: WireRecord) => {
    const outcome: { result?: unknown; error?: unknown } = {};
    const pending = bridge.request(message as Parameters<WorkspaceRuntimeClient["request"]>[0], { timeoutMs: 0 })
      .then(result => { outcome.result = result; }, error => { outcome.error = error; });
    return { outcome, pending };
  };
  const calls = (kind: string) => requests.filter(message => message.op === "cloudCommands.request" &&
    (message.params as { request: WireRecord }).request.kind === kind);
  const tick = async (ms = 1000) => { await vi.advanceTimersByTimeAsync(ms); };
  const start = async () => { const running = request(scopedPrompt); await vi.waitFor(() => expect(command).toBeDefined()); await tick(); return running; };
  return { bridge, request, start, calls, tick, state, grants, peers, open, get command() { return command; },
    disconnect: () => { disconnected = true; }, loseEnqueue: () => { loseEnqueue = true; },
    loseStops: (n: number) => { lostStops = n; }, generation: (n: number) => { terminalGeneration = n; },
    replaceBinding: (patch: Partial<typeof binding>) => { nextBinding = patch; },
    hideReads: (n: number) => { hiddenReads = n; }, loseRemovals: (n: number) => { lostRemovals = n; },
    claimOnRemoval: () => { claimOnRemoval = true; }, execution: (id: string | null) => { execution = id; }, readGate,
    remoteTurn: (commandId: string, turnId: string) => {
      command = { ...command, commandId, payload: { ...(command?.payload as WireRecord), userMessageId: turnId } }; state.value = "dispatching";
    },
    prompt: scopedPrompt, stop: { ...stop, sessionId: route, executionId: route, chatId }, makePeer };
}

describe("durable cloud Stop", () => {
  it.each(["dispatching", "uncertain"])("does not retire Stop on a paused ACK while the exact command is %s", async state => {
    const h = await harness(); const running = await h.start();
    h.state.value = state; const stopping = h.request(stop); await h.tick();
    expect(stopping.outcome).toEqual({});
    h.state.value = "cancelled"; await h.tick(); await Promise.all([running.pending, stopping.pending]);
    expect(stopping.outcome.result).toMatchObject({ type: "WORKSPACE_RESPONSE" });
    expect(h.calls("stop")).toHaveLength(1);
  });

  it("keeps one Stop operation through lost acknowledgements beyond the old retry limit", async () => {
    const h = await harness(); const running = await h.start(); h.loseStops(4);
    const stopping = h.request(stop), duplicate = h.request(stop); await h.tick(20_000);
    expect(stopping.outcome).toEqual({});
    h.state.value = "cancelled"; await h.tick(6000); await Promise.all([running.pending, stopping.pending, duplicate.pending]);
    expect(stopping.outcome.result).toEqual(duplicate.outcome.result);
    const operations = h.calls("stop").map(message => (message.params as { request: WireRecord }).request.operationId);
    expect(operations.length).toBeGreaterThan(3); expect(new Set(operations)).toEqual(new Set([stop.id]));
  });

  it("does not accept a terminal receipt from a different generation", async () => {
    const h = await harness(); await h.start();
    const stopping = h.request(stop); await h.tick(); h.generation(2); h.state.value = "cancelled";
    await h.tick(6000);
    expect(stopping.outcome.result).toBeUndefined();
    expect(stopping.outcome.error).toMatchObject({ code: "cloud_stop_target_changed" });
    expect(h.calls("mutate")).toHaveLength(1);
  });

  it("removes a paused unclaimed command by its exact receipt before reporting Stop complete", async () => {
    const h = await harness(); h.state.value = "queued"; const running = await h.start();
    const original = h.command?.commandId, stopping = h.request(stop); await h.tick(2000);
    expect(h.calls("mutate").map(message => ((message.params as { request: WireRecord }).request.mutation as WireRecord).action))
      .toContainEqual({ kind: "remove", commandId: original });
    await Promise.all([running.pending, stopping.pending]);
    expect(h.state.value).toBe("cancelled");
  });

  it("cancels an ambiguously accepted queued prompt without resubmitting it", async () => {
    const h = await harness(); h.state.value = "queued"; h.loseEnqueue();
    const running = await h.start(); const stopping = h.request(stop); await h.tick(4000);
    await Promise.all([running.pending, stopping.pending]);
    expect(stopping.outcome.result).toMatchObject({ result: { commandId: h.command?.commandId, state: "cancelled" } });
    const actions = h.calls("mutate").map(message => ((message.params as { request: WireRecord }).request.mutation as WireRecord).action);
    expect(actions).toHaveLength(2); expect(actions[1]).toEqual({ kind: "remove", commandId: h.command?.commandId });
  });

  it("keeps an older worker's strict Stop wire and waits for terminal proof after its acknowledgement", async () => {
    const h = await harness({ exactStop: false }); await h.start();
    const stopping = h.request(stop); await h.tick(4000);
    expect(stopping.outcome).toEqual({});
    expect((h.calls("stop")[0]!.params as { request: WireRecord }).request).not.toHaveProperty("commandId");
    h.state.value = "cancelled"; await h.tick(); await stopping.pending;
    expect(stopping.outcome.error).toBeUndefined(); expect(h.calls("stop")).toHaveLength(1);
  });

  it("reports an older worker's lost Stop reply without replaying a conversation-wide cancellation", async () => {
    const h = await harness({ exactStop: false }); await h.start(); h.loseStops(1);
    const stopping = h.request(stop); await h.tick(4000); await stopping.pending;
    expect(stopping.outcome.result).toBeUndefined();
    expect(stopping.outcome.error).toMatchObject({ code: "cloud_runtime_feature_unavailable" });
    expect(h.calls("stop")).toHaveLength(1); expect(h.calls("mutate")).toHaveLength(1);
  });

  it("transport/app disposal never synthesizes Stop or an enqueue", async () => {
    const h = await harness(); await h.start(); h.bridge.dispose(); await h.tick();
    expect(h.calls("stop")).toHaveLength(0); expect(h.calls("mutate")).toHaveLength(1);
  });

  it("keeps the acknowledged Stop above a replacement peer and only reads its original command", async () => {
    const h = await harness(); await h.start();
    const stopping = h.request(stop); await h.tick(); h.disconnect(); await h.tick(3000);
    expect(h.open).toHaveBeenCalledTimes(2);
    expect(h.open.mock.calls.every(([, options]) => !options?.wake)).toBe(true);
    expect(h.grants).toHaveBeenCalledTimes(0); // Boot-owned commands do not mint grants.
    expect(h.calls("stop")).toHaveLength(1); expect(h.calls("mutate")).toHaveLength(1);
    h.state.value = "cancelled"; await h.tick(); await stopping.pending;
    expect(stopping.outcome.result).toMatchObject({ type: "WORKSPACE_RESPONSE", result: { commandId: h.command?.commandId, state: "cancelled" } });
  });

  it("replays a lost Stop with the same command and operation after peer replacement", async () => {
    const h = await harness(); await h.start(); h.loseStops(1);
    const stopping = h.request(stop); await h.tick(1); h.disconnect(); await h.tick(4000);
    const operations = h.calls("stop").map(message => (message.params as { request: WireRecord }).request);
    expect(operations).toHaveLength(2);
    expect(operations[0]).toEqual(operations[1]);
    expect(operations[1]).toMatchObject({ operationId: stop.id, commandId: h.command?.commandId });
    h.state.value = "cancelled"; await h.tick(); await stopping.pending;
    expect(stopping.outcome.error).toBeUndefined();
  });

  it.each(["bootId", "writerEpoch", "engineInstanceId", "authorityEpoch"] as const)("refuses a replacement with changed %s", async field => {
    const h = await harness(); await h.start(); const stopping = h.request(stop); await h.tick();
    h.replaceBinding({ [field]: field === "authorityEpoch" ? 2 : "99999999-9999-4999-8999-999999999999" });
    h.disconnect(); await h.tick(3000); h.state.value = "cancelled"; await h.tick();
    expect(stopping.outcome.result).toBeUndefined(); expect(stopping.outcome.error).toBeDefined();
    expect(h.calls("stop")).toHaveLength(1); expect(h.calls("mutate")).toHaveLength(1);
  });

  it("rechecks the live authority before accepting a terminal receipt on the same peer", async () => {
    const h = await harness(); await h.start(); const stopping = h.request(stop); await h.tick();
    h.peers[0]!.client.executionIdentity.authorityEpoch++;
    h.state.value = "cancelled"; await h.tick();
    expect(stopping.outcome.result).toBeUndefined();
    expect(stopping.outcome.error).toMatchObject({ code: "cloud_stop_target_changed" });
  });

  it("does not reuse a cached terminal Stop after the peer's writer changes", async () => {
    const h = await harness(), running = await h.start();
    const first = h.request(stop); await h.tick(); h.state.value = "cancelled"; await h.tick();
    await Promise.all([running.pending, first.pending]);
    expect(first.outcome.error).toBeUndefined();
    h.replaceBinding({ writerEpoch: "99999999-9999-4999-8999-999999999999" });
    h.peers[0]!.client.status = "disconnected";
    const repeated = h.request(stop); await h.tick(); await repeated.pending;
    expect(h.open).toHaveBeenCalledTimes(2);
    expect(repeated.outcome.result).toBeUndefined();
    expect(repeated.outcome.error).toMatchObject({ code: "cloud_stop_target_changed" });
    expect(h.calls("stop")).toHaveLength(1);
  });

  it("waits for a submitted command's late acceptance without issuing a conversation-wide Stop", async () => {
    const h = await harness(); await h.start(); h.hideReads(3);
    const stopping = h.request(stop); await h.tick(3000);
    expect(stopping.outcome).toEqual({});
    await h.tick(2000); expect(h.calls("stop")).toHaveLength(1);
    expect((h.calls("stop")[0]!.params as { request: WireRecord }).request.commandId).toBe(h.command?.commandId);
    h.state.value = "cancelled"; await h.tick(); await stopping.pending;
    expect(stopping.outcome.error).toBeUndefined(); expect(h.calls("mutate")).toHaveLength(1);
  });

  it("keeps the original Stop when an accepted command binds its execution late", async () => {
    const h = await harness(); h.execution(null); await h.start();
    const stopping = h.request(stop); await h.tick();
    h.execution("native-execution");
    h.peers[0]!.peer.agents!.incoming({ type: "AGENT_SESSION_CREATED", agentId: "codex", chatId: chat, session: { sessionId: "native-execution" } });
    await h.tick(); expect(stopping.outcome).toEqual({});
    h.state.value = "cancelled"; await h.tick(); await stopping.pending;
    expect(stopping.outcome.error).toBeUndefined(); expect(h.calls("stop")).toHaveLength(1);
  });

  it("retains the exact removal mutation and revision across a lost acknowledgement", async () => {
    const h = await harness(); h.state.value = "queued"; await h.start(); h.loseRemovals(1);
    const stopping = h.request(stop); await h.tick(4000); await stopping.pending;
    const mutations = h.calls("mutate").map(message => (message.params as { request: { mutation: WireRecord } }).request.mutation);
    expect(mutations).toHaveLength(3); expect(mutations[1]).toEqual(mutations[2]);
    expect(stopping.outcome.result).toMatchObject({ result: { commandId: h.command?.commandId, state: "cancelled" } });
  });

  it("does not rewrite a removal when the exact command has already been claimed", async () => {
    const h = await harness(); h.state.value = "queued"; await h.start(); h.claimOnRemoval();
    const stopping = h.request(stop); await h.tick(4000);
    expect(stopping.outcome).toEqual({}); expect(h.calls("mutate")).toHaveLength(2);
    h.state.value = "cancelled"; await h.tick(); await stopping.pending;
    expect(stopping.outcome.error).toBeUndefined(); expect(h.calls("stop")).toHaveLength(1);
  });

  it("cannot bypass acknowledged Stop with the outgoing fire-and-forget route", async () => {
    const h = await harness(); await h.start();
    expect(() => h.bridge.send(stop)).toThrow(/acknowledged/);
    expect(h.peers[0]!.client.send).not.toHaveBeenCalled(); expect(h.calls("stop")).toHaveLength(0);
  });

  it("does not settle after account loss while a receipt read is pending", async () => {
    const h = await harness(); await h.start(); let release!: () => void;
    h.readGate.wait = new Promise<void>(resolve => { release = resolve; });
    const stopping = h.request(stop); await h.tick(); h.bridge.clearCloudConnections();
    h.state.value = "cancelled"; release(); await h.tick(); await stopping.pending;
    expect(stopping.outcome.result).toBeUndefined(); expect(stopping.outcome.error).toBeDefined();
    expect(h.calls("stop")).toHaveLength(0);
  });

  it("ends a missing receipt wait at the Stop deadline and keeps a visible error", async () => {
    const h = await harness(); await h.start(); h.hideReads(1000);
    const stopping = h.request(stop); await h.tick(59_000); expect(stopping.outcome).toEqual({});
    await h.tick(2000); await stopping.pending;
    expect(stopping.outcome.result).toBeUndefined(); expect(stopping.outcome.error).toBeInstanceOf(Error);
    expect(h.calls("stop")).toHaveLength(0); expect(h.calls("mutate")).toHaveLength(1);
  });

  it("includes initial passive reconnection in the Stop deadline", async () => {
    const h = await harness(); await h.start(); h.peers[0]!.client.status = "disconnected";
    let rejectOpen!: (error: Error) => void;
    h.open.mockImplementationOnce(() => new Promise((_, reject) => { rejectOpen = reject; }));
    const stopping = h.request(stop);
    try {
      await h.tick(61_000);
      expect(stopping.outcome.result).toBeUndefined(); expect(stopping.outcome.error).toBeInstanceOf(Error);
      expect(h.calls("stop")).toHaveLength(0);
    } finally { rejectOpen(new Error("Fixture connection closed")); await stopping.pending; }
  });

  it("can Stop an authoritative successor from another device without reusing the previous operation", async () => {
    const h = await harness(); const first = await h.start();
    const previous = h.request(stop); await h.tick(); h.state.value = "cancelled"; await h.tick();
    await Promise.all([previous.pending, first.pending]);
    const nextCommand = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", nextOperation = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    h.remoteTurn(nextCommand, "next-turn");
    h.peers[0]!.peer.agents!.incoming({ type: "AGENT_SESSION_UPDATE", agentId: "codex", chatId: chat,
      notification: { sessionId: "native-execution", update: { sessionUpdate: "turn_state", turnId: "next-turn", state: "running", startedAt: 84 } } });
    const stopping = h.request({ ...stop, id: nextOperation }); await h.tick();
    expect(stopping.outcome).toEqual({}); expect(h.calls("stop")).toHaveLength(2);
    expect((h.calls("stop")[1]!.params as { request: WireRecord }).request).toMatchObject({ commandId: nextCommand, operationId: nextOperation });
    h.state.value = "cancelled"; await h.tick(); await stopping.pending;
    expect(stopping.outcome.error).toBeUndefined();
  });

  it("keeps a pending Stop on A isolated through A to B to A with equal native command IDs", async () => {
    const a = await harness(), other = { ...target, organizationId: "99999999-9999-4999-8999-999999999999" };
    const b = await harness({ target: other, attach: false });
    a.open.mockImplementationOnce(async requested => { expect(requested).toMatchObject(other); return b.makePeer(); });
    await a.start(); const stopping = a.request(a.stop); await a.tick();
    await a.bridge.request({ type: "AGENT_NEW_SESSION", chatId: b.prompt.chatId, agentId: "codex", cwd: cloudWorkspaceKey(other), env: { OPENAI_MODEL: "test-model" } });
    const bRun = a.request(b.prompt); await a.tick(2000);
    expect(a.command?.commandId).toBe(b.command?.commandId);
    b.state.value = "cancelled"; await a.tick(); await bRun.pending;
    expect(stopping.outcome).toEqual({}); expect(b.calls("stop")).toHaveLength(0);
    const duplicate = a.request(a.stop); await a.tick();
    a.state.value = "cancelled"; await a.tick(); await Promise.all([stopping.pending, duplicate.pending]);
    expect(stopping.outcome.result).toEqual(duplicate.outcome.result);
    expect(a.calls("stop")).toHaveLength(1); expect(b.calls("stop")).toHaveLength(0);
    expect(a.calls("mutate")).toHaveLength(1); expect(b.calls("mutate")).toHaveLength(1);
  });

  it.each(["/personal/project", "/organization/project"])("keeps Local request routing unchanged for %s", async cwd => {
    vi.useFakeTimers();
    const local = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue({ type: "AGENT_PROMPT_COMPLETE" } as never);
    const open = vi.fn(), bridge = new WorkspaceRuntimeClient({ open, workspaces: () => [] }); disposals.push(() => bridge.dispose());
    await bridge.request({ type: "AGENT_PROMPT", agentId: "codex", sessionId: "local", cwd, prompt: [] } as never);
    expect(local).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
  });
});
