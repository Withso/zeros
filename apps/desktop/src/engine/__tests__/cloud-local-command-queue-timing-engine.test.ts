import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudAgentTurnTimingsSchema, type CloudNativePromptStage } from "@zeros/protocol/cloud-events";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { CloudCommandClaim } from "@zeros/protocol/cloud-commands";
import type { AgentPromptMessage } from "@zeros/protocol/messages";
import { ZerosEngine } from "../zeros-engine";
import { CloudAgentTurnTimings } from "../cloud-local-command-queue-timings";
import { closeZerosDb, setZerosDbPathForTesting } from "../db";
import { upsertChat } from "../db/chats";
import type { TransportClient } from "../transport/types";

const methods = ZerosEngine.prototype as unknown as {
  handleCloudCommandOperation(this: unknown, op: string, params: Record<string, unknown>, client: TransportClient): Promise<unknown>;
  validateCloudCommand(this: unknown, conversationId: string): void;
  cloudNativePromptObserver(this: unknown, message: AgentPromptMessage, admitted: boolean, channel?: "stage" | "output"):
    ((stage: CloudNativePromptStage | "text" | "tool") => void) | undefined;
  handleConnect(this: unknown, client: TransportClient): Promise<void>;
  handleCloudRuntimeAuthorityLoss(this: unknown): void;
};
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-turn-timing-"));
  setZerosDbPathForTesting(path.join(root, "state.db"));
  await mkdir(path.join(root, "workspace"));
});
afterEach(async () => { closeZerosDb(); setZerosDbPathForTesting(null); await rm(root, { recursive: true, force: true }); });
function fixture() {
  const folder = path.join(root, "workspace"), conversationId = randomUUID();
  upsertChat({ id: conversationId, folder, agentId: "codex", agentName: "Codex", model: "test", effort: "high", permissionMode: "auto",
    lastModeId: null, prePlanModeId: null, fast: false, additionalDirectories: [], title: "test", createdAt: 1, updatedAt: 1,
    sessionId: null, providerBinding: null, providerMetadata: null, pinned: false, archived: false, sourceChatId: null, kind: "chat" });
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 2, engineInstanceId: randomUUID() };
  const timings = new CloudAgentTurnTimings({ scope, mode: "legacy", now: () => 100 });
  const claim: CloudCommandClaim = { commandId: randomUUID(), claimId: randomUUID(), conversationId, executionId: randomUUID(),
    payload: { agentId: "codex", model: "test", userMessageId: randomUUID(), modeRevision: 0, prompt: [{ type: "text", text: "synthetic" }] } };
  timings.receive({ commandId: claim.commandId, conversationId, turnId: claim.payload.userMessageId, provider: "codex" });
  timings.bindClaim({ commandId: claim.commandId, conversationId, turnId: claim.payload.userMessageId, executionId: claim.executionId, provider: "codex" });
  const record = { claim, controller: new AbortController() };
  const client: TransportClient = { id: "client", kind: "cloud", accountUserId: randomUUID(), authorityEpoch: 1,
    cloudActor: { sessionId: randomUUID(), deviceId: randomUUID(), role: "viewer", fingerprint: "a".repeat(64) },
    authorized: () => true, send: vi.fn(), close: vi.fn() };
  const engine = { root: folder, cloudCommands: { handle: vi.fn() }, cloudWorker: { version: 4 }, cloudAgentTurnTimings: timings,
    cloudRuntimeConfig: { execution: { organizationId: scope.organizationId, workspaceId: scope.workspaceId, generation: scope.generation },
      engine: { instanceId: scope.engineInstanceId } }, cloudRuntimeAuthorityStopping: false,
    workspace: { workspaceIdForCwd: () => "local-main" }, validateCloudCommand: methods.validateCloudCommand,
    cloudCommandSessions: new Map([[claim.commandId, record]]), conversationExecution: new Map([[conversationId, claim.executionId]]),
    sessionAgent: new Map([[claim.executionId, "codex"]]), sessionChat: new Map([[claim.executionId, conversationId]]),
    activePromptContexts: new Map([[claim.executionId, { turnId: claim.payload.userMessageId }]]) };
  const message: AgentPromptMessage = { type: "AGENT_PROMPT", id: claim.commandId, timestamp: 1, source: "engine", agentId: "codex",
    sessionId: claim.executionId, executionId: claim.executionId, prompt: claim.payload.prompt, userMessageId: claim.payload.userMessageId };
  const inspect = (params = { conversationId, agentTurnTimingsVersion: 1 }, peer = client) =>
    methods.handleCloudCommandOperation.call(engine, "cloudCommands.conversation", params, peer);
  return { scope, timings, claim, record, client, engine, message, conversationId, inspect };
}

describe("authenticated exact-conversation timing inspection", () => {
  it("advertises inspection only for a live cloud timing collector, without enabling local commands", async () => {
    const f = fixture();
    const connect = () => methods.handleConnect.call({ ...f.engine, framework: null, actualPort: 1234 }, f.client);
    await connect();
    expect(f.client.send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "ENGINE_READY",
      capabilities: expect.arrayContaining(["cloud.turnTimings.v1"]) }));
    expect((vi.mocked(f.client.send).mock.calls.at(-1)![0] as { capabilities: string[] }).capabilities)
      .not.toContain("cloud.localCommands.v1");
    f.timings.retire();
    await connect();
    expect((vi.mocked(f.client.send).mock.calls.at(-1)![0] as { capabilities: string[] }).capabilities)
      .not.toContain("cloud.turnTimings.v1");
    for (const owner of ["Personal", "organization"]) {
      await methods.handleConnect.call({ ...f.engine, cloudWorker: null, cloudRuntimeConfig: null,
        cloudCommands: null, cloudAgentTurnTimings: null, framework: null, actualPort: 1234, owner },
      { ...f.client, kind: "local" });
      expect(vi.mocked(f.client.send).mock.calls.at(-1)![0]).not.toHaveProperty("capabilities");
    }
  });
  it("clears timing ownership before even an already-stopped engine closes optional services", async () => {
    const f = fixture();
    const close = vi.fn(() => { expect(f.timings.sample(f.conversationId).coverage.retired).toBe(true); });
    await ZerosEngine.prototype.stop.call({ ...f.engine, running: false, cloudIdleStop: { close },
      cloudCommands: { close }, cloudActions: null, cloudEvents: null, activityHeartbeat: null,
      cloudCheckpointScheduler: null } as unknown as ZerosEngine);
    expect(f.timings.retainedCount()).toBe(0);
    expect(f.timings.lookupExecution(f.claim.executionId)).toBeNull();
  });
  it("retires observations synchronously on authority loss before an unresolved shutdown", () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const f = fixture(), stop = vi.fn(() => new Promise<void>(() => {}));
      methods.handleCloudRuntimeAuthorityLoss.call({ ...f.engine, stop,
        cloudCommands: { close: vi.fn() }, cloudCheckpointScheduler: null });
      expect(stop).toHaveBeenCalledOnce();
      expect(f.timings.sample(f.conversationId)).toMatchObject({ records: [], coverage: { retired: true } });
      expect(f.timings.lookupExecution(f.claim.executionId)).toBeNull();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); error.mockRestore(); }
  });
  it("returns opted-in engine clock evidence without a CP request and preserves legacy reads", async () => {
    const f = fixture();
    const legacy = await methods.handleCloudCommandOperation.call(f.engine, "cloudCommands.conversation", { conversationId: f.conversationId }, f.client);
    expect(legacy).not.toHaveProperty("agentTurnTimings");
    const read = await f.inspect() as { agentTurnTimings: unknown };
    expect(CloudAgentTurnTimingsSchema.parse(read.agentTurnTimings)).toMatchObject({ ...f.scope, conversationId: f.conversationId,
      clockId: f.timings.sample(f.conversationId).clockId, sampledAtMs: 100, mode: "legacy" });
    expect(f.engine.cloudCommands.handle).not.toHaveBeenCalled();
  });
  it.each(["local", "missing", "revoked", "retired", "authority-lost", "foreign-scope"] as const)("refuses %s timing inspection", async cause => {
    const f = fixture(); let client = f.client;
    if (cause === "local") client = { ...client, kind: "local" };
    if (cause === "missing") { const { cloudActor: _actor, ...peer } = client; client = peer; }
    if (cause === "revoked") client = { ...client, authorized: () => false };
    if (cause === "retired") f.timings.retire();
    if (cause === "authority-lost") f.engine.cloudRuntimeAuthorityStopping = true;
    if (cause === "foreign-scope") f.engine.cloudRuntimeConfig.execution.workspaceId = randomUUID();
    await expect(f.inspect(undefined, client)).rejects.toMatchObject({ code: expect.stringMatching(/authority_rejected|unavailable/) });
  });
  it("refuses a foreign conversation before sampling and accepts no actor or clock from params", async () => {
    const f = fixture(), sample = vi.spyOn(f.timings, "sample");
    await expect(f.inspect({ conversationId: randomUUID(), agentTurnTimingsVersion: 1 })).rejects.toMatchObject({ code: "command_not_found" });
    expect(sample).not.toHaveBeenCalled();
    for (const field of ["actorSessionId", "clockId", "engineInstanceId"])
      await expect(methods.handleCloudCommandOperation.call(f.engine, "cloudCommands.conversation",
        { conversationId: f.conversationId, agentTurnTimingsVersion: 1, [field]: randomUUID() }, f.client)).rejects.toMatchObject({ code: "invalid_command" });
  });
});

describe("original native prompt observation ownership", () => {
  it("observes the ORIGINAL local-pump claim without a legacy command session", () => {
    const f = fixture(); f.engine.cloudCommandSessions.clear();
    const record = vi.fn((claim: CloudCommandClaim) => claim === f.claim ? f.record : null);
    const engine = { ...f.engine,cloudLocalNativePump: { claimForExecution: () => f.claim,record } };
    const observe = methods.cloudNativePromptObserver.call(engine,f.message,true);
    expect(observe).toBeTypeOf("function"); observe!("native_write");
    expect(f.timings.sample(f.conversationId).records.at(-1)).toMatchObject({ stage: "native_write" });
    record.mockReturnValue(null); observe!("native_acceptance_ack");
    expect(f.timings.sample(f.conversationId).records.at(-1)).toMatchObject({ stage: "native_write" });
  });
  it("requests original credential-use only at native write/SDK start, never a later ACK", () => {
    const f = fixture(); f.engine.cloudCommandSessions.clear();
    const metadata = { synthetic: "cached exact scope" },credentialUse = vi.fn(() => null);
    const engine = { ...f.engine,cloudLocalNativePump: { claimForExecution: () => f.claim,record: () => f.record },
      cloudAgentBoot: { active: true,metadata },cloudLocalEvents: { credentialUse },broadcast: vi.fn() };
    const observe = methods.cloudNativePromptObserver.call(engine,f.message,true)!;
    expect(observe).toBeTypeOf("function");
    observe("native_acceptance_ack"); expect(credentialUse).not.toHaveBeenCalled();
    observe("native_write");
    expect(credentialUse).toHaveBeenCalledExactlyOnceWith(f.claim,metadata,"native_write");
    f.engine.activePromptContexts.set(f.claim.executionId,{ turnId: "new-warm-turn" });
    observe("sdk_run_created"); expect(credentialUse).toHaveBeenCalledTimes(1);
  });
  it("observes only the admitted exact command/turn and never a Local or foreign prompt", () => {
    const f = fixture();
    expect(methods.cloudNativePromptObserver.call(f.engine, f.message, false)).toBeUndefined();
    expect(methods.cloudNativePromptObserver.call(f.engine, { ...f.message, id: randomUUID() }, true)).toBeUndefined();
    expect(methods.cloudNativePromptObserver.call(f.engine, { ...f.message, userMessageId: "other" }, true)).toBeUndefined();
    const observe = methods.cloudNativePromptObserver.call(f.engine, f.message, true)!;
    observe("native_write"); observe("native_acceptance_ack");
    expect(f.timings.sample(f.conversationId).records.map(row => row.stage)).toEqual([
      "engine_received", "dispatch_committed", "native_write", "native_acceptance_ack",
    ]);
  });
  it("drops a held old callback after command retirement or a newer warm turn owns the same execution", () => {
    const f = fixture(), observe = methods.cloudNativePromptObserver.call(f.engine, f.message, true)!;
    f.engine.activePromptContexts.set(f.claim.executionId, { turnId: "new-turn" });
    observe("native_write"); expect(f.timings.sample(f.conversationId).records).toHaveLength(2);
    f.engine.activePromptContexts.set(f.claim.executionId, { turnId: f.claim.payload.userMessageId });
    f.engine.cloudCommandSessions.delete(f.claim.commandId);
    observe("native_acceptance_ack"); expect(f.timings.sample(f.conversationId).records).toHaveLength(2);
  });
  it("drops callbacks after Stop/authority loss and contains observer exceptions", () => {
    const f = fixture(), observe = methods.cloudNativePromptObserver.call(f.engine, f.message, true)!;
    f.record.controller.abort(); observe("native_write");
    expect(f.timings.sample(f.conversationId).records).toHaveLength(2);
    const live = fixture(), liveObserve = methods.cloudNativePromptObserver.call(live.engine, live.message, true)!;
    vi.spyOn(live.timings, "native").mockImplementation(() => { throw new Error("synthetic observer failure"); });
    expect(() => liveObserve("native_write")).not.toThrow();
    live.engine.cloudRuntimeAuthorityStopping = true;
    expect(() => liveObserve("native_acceptance_ack")).not.toThrow();
  });
});

describe("original native output timing classification", () => {
  it.each(["text", "tool"] as const)("marks only original-flight native %s output", kind => {
    const f = fixture(), output = methods.cloudNativePromptObserver.call(f.engine, f.message, true, "output")!;
    output(kind);
    expect(f.timings.sample(f.conversationId).records.at(-1)).toMatchObject({ stage: "first_delta", outputKind: kind });
  });
  it("excludes non-output labels and a held callback from an older command on the same warm execution", () => {
    const f = fixture(), output = methods.cloudNativePromptObserver.call(f.engine, f.message, true, "output")!;
    for (const kind of ["native_write", "native_acceptance_ack", "thought", "guidance", "", { kind: "text" }])
      Reflect.apply(output, undefined, [kind]);
    const next = { ...f.claim, commandId: randomUUID(), claimId: randomUUID(),
      payload: { ...f.claim.payload, userMessageId: randomUUID() } };
    f.timings.receive({ commandId: next.commandId, conversationId: next.conversationId, turnId: next.payload.userMessageId, provider: "codex" });
    f.timings.bindClaim({ commandId: next.commandId, conversationId: next.conversationId, turnId: next.payload.userMessageId,
      executionId: next.executionId, provider: "codex" });
    f.engine.cloudCommandSessions.set(next.commandId, { claim: next, controller: new AbortController() });
    f.engine.activePromptContexts.set(next.executionId, { turnId: next.payload.userMessageId });
    output("text"); output("tool");
    expect(f.timings.sample(f.conversationId).records.some(row => row.stage === "first_delta")).toBe(false);
  });
  it("never treats an output callback as native acceptance or a stage callback as first output", () => {
    const f = fixture(), stage = methods.cloudNativePromptObserver.call(f.engine, f.message, true)!;
    stage("text"); stage("tool");
    expect(f.timings.sample(f.conversationId).records).toHaveLength(2);
  });
  it("passes the trusted same-process native arrival time through the original output observer", () => {
    const f = fixture(), output = methods.cloudNativePromptObserver.call(f.engine, f.message, true, "output")!;
    Reflect.apply(output, undefined, ["text", 99]);
    expect(f.timings.sample(f.conversationId).records.some(row => row.stage === "first_delta")).toBe(false);
    Reflect.apply(output, undefined, ["text", 100]);
    expect(f.timings.sample(f.conversationId).records.at(-1)).toMatchObject({ stage: "first_delta", outputKind: "text", atMs: 100 });
  });
});

/** Evaluate the actual gateway invocation from the production method. The
 * bounded ports replace native work, not its real argument/wiring seam. */
function promptInvocation() {
  const source = ts.createSourceFile("zeros-engine.ts", readFileSync(new URL("../zeros-engine.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "prompt" &&
        node.expression.expression.getText(source) === "this.agents") calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(calls).toHaveLength(1);
  const compiled = ts.transpileModule(`const invoke = function(msg, activePrompt, fromCloudCommand) { return ${calls[0]!.getText(source)}; };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(`${compiled}\nreturn invoke;`)() as
    (this: unknown, message: AgentPromptMessage, active: { turnId: string }, admitted: boolean) => unknown;
}
describe("actual engine native gateway call wiring", () => {
  it("passes exact admitted original stage and output callbacks to the real prompt call site", () => {
    const f = fixture(), prompt = vi.fn((_agent, _execution, _payload, _turn,
      stage?: (kind: CloudNativePromptStage) => void, output?: (kind: "text" | "tool") => void) => {
      output?.("text"); stage?.("native_write"); stage?.("native_acceptance_ack");
    });
    const engine = { ...f.engine, agents: { prompt }, cloudNativePromptObserver: methods.cloudNativePromptObserver };
    promptInvocation().call(engine, f.message, { turnId: f.claim.payload.userMessageId }, true);
    expect(f.timings.sample(f.conversationId).records.map(row => row.stage))
      .toEqual(["engine_received", "dispatch_committed", "first_delta", "native_write", "native_acceptance_ack"]);
  });
  it.each(["Personal", "organization"])("preserves the exact four-argument %s Local gateway invocation", () => {
    const f = fixture(), prompt = vi.fn();
    const engine = { ...f.engine, cloudWorker: null, agents: { prompt }, cloudNativePromptObserver: methods.cloudNativePromptObserver };
    promptInvocation().call(engine, f.message, { turnId: f.claim.payload.userMessageId }, false);
    expect(prompt).toHaveBeenCalledExactlyOnceWith("codex", f.claim.executionId, f.message.prompt, f.claim.payload.userMessageId);
    expect(f.timings.sample(f.conversationId).records).toHaveLength(2);
  });
});
