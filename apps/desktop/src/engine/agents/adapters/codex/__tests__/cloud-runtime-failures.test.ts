import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StdioAgentProcess } from "../../shared/stdio-process";
import type { CloudProviderExecution } from "../../../cloud-provider-execution";
import type { AgentAdapterContext } from "../../../types";
import {createCloudNativeHome,type CloudNativeHome} from "../../../containment/cloud-native-home";
let nativeDataRoot:string, nativeHome:CloudNativeHome;

const harness = vi.hoisted(() => ({
  proc: null as StdioAgentProcess | null,
  execution: null as CloudProviderExecution | null,
  executor: vi.fn(),
}));
vi.mock("../../shared/stdio-process", () => ({ spawnStdioAgent: vi.fn(() => harness.proc) }));
vi.mock("../binary-resolver", () => ({
  resolveCodexBinary: vi.fn(async () => ({ path: "/pinned/runtime/bin/codex", source: "bundled" })),
  resolveCloudCodexBinaryFromImage: vi.fn(async () => ({ path: "/pinned/runtime/bin/codex", source: "bundled" })),
}));
vi.mock("../../shared/login-shell-path", () => ({ buildSpawnEnvWithLoginPath: vi.fn(async () => ({})) }));
vi.mock("../../../containment/cloud-runtime-root.mjs", () => ({ resolveCloudRuntime: () => ({ workerRoot: "/pinned/runtime" }) }));
vi.mock("../../../cloud-provider-execution", () => ({
  cloudProviderExecution: () => harness.execution,
  cloudExecutionLifetime: (execution: CloudProviderExecution) => execution.lifetime,
  executionMcpServers: () => [],
}));
vi.mock("../cloud-exec-server", () => ({ CloudCodexExecServer: { start: harness.executor } }));
vi.mock("../../../session-paths", () => ({
  ensureSessionDir: vi.fn(async () => ({})),
  writeSessionMeta: vi.fn(async () => {}),
  removeSessionDir: vi.fn(async () => {}),
}));
vi.mock("../../shared/discovery", () => ({ discoverCommands: vi.fn(async () => []) }));

import { bootCodexAppServerRuntime } from "../app-server";
import { CodexAppServerAdapter } from "../app-server-adapter";
import { removeSessionDir } from "../../../session-paths";
import { spawnStdioAgent } from "../../shared/stdio-process";
import { CloudCommandFailureError, cloudCommandFailureFromCode } from "@zeros/protocol/cloud-commands";
import { CloudAgentLease } from "../../../cloud-agent-lease";
import type { CloudAgentExecutionRequest } from "@zeros/protocol/cloud-agent-execution";

type RpcFrame = { id?: number; method?: string; params?: unknown };
function installProcess(replies: Record<string, unknown> = {}, rejectMethod?: string, options: {
  holdMethod?: string;
  refusal?: { code: number; message: string; data?: unknown };
} = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: 12345, killed: false, exitCode: null as number | null, signalCode: null,
  });
  const frames: RpcFrame[] = [];
  const requestWaiters = new Map<string, Array<(frame: RpcFrame) => void>>();
  let buffer = "", finish!: (value: { code: number; signal: null }) => void;
  const exited = new Promise<{ code: number; signal: null }>(resolve => { finish = resolve; });
  const stop = vi.fn(async () => {
    if (child.killed) return;
    child.killed = true; child.exitCode = 0; finish({ code: 0, signal: null }); child.emit("exit", 0, null);
  });
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const frame = JSON.parse(buffer.slice(0, index)) as RpcFrame;
      buffer = buffer.slice(index + 1); frames.push(frame);
      if (frame.id === undefined) continue;
      for (const resolve of requestWaiters.get(frame.method!) ?? []) resolve(frame);
      requestWaiters.delete(frame.method!);
      if (frame.method === options.holdMethod) continue;
      const result = frame.method === "initialize"
        ? { userAgent: "codex_cli 0.160.0", codexHome: "/private/home/.codex", platformFamily: "unix", platformOs: "linux" }
        : frame.method === "environment/info" ? { cwd: "file:///srv/zeros/workspace" }
          : frame.method === "environment/status" ? { status: "ready" } : {};
      child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id,
        ...(frame.method === rejectMethod ? { error: options.refusal ?? { code: -32603, message: "private-token-and-provider-prose-sentinel" } }
          : { result: replies[frame.method!] ?? result }) }) + "\n");
    }
  });
  harness.proc = { child, processGroupId: child.pid, exited, stop } as unknown as StdioAgentProcess;
  return {
    frames, stop, child,
    send: (frame: unknown) => child.stdout.write(JSON.stringify(frame) + "\n"),
    waitFor: (method: string, ordinal = 0): Promise<RpcFrame> => {
      const existing = frames.filter(frame => frame.id !== undefined && frame.method === method)[ordinal];
      if (existing) return Promise.resolve(existing);
      return new Promise(resolve => {
        const waiting = requestWaiters.get(method) ?? [];
        waiting.push(resolve); requestWaiters.set(method, waiting);
      });
    },
  };
}
function installCloud(cwd="/srv/zeros/workspace", credentialKind: "codex-chatgpt" | "codex-api-key" = "codex-chatgpt") {
  const lease = {
    credentialKind,
    admission: { provider: "codex", model: "gpt-5.6-sol" }, assertLive: vi.fn(), validate: vi.fn(async () => {}),
    codexAuth: vi.fn(() => credentialKind === "codex-chatgpt"
      ? { credentialVersion: 1, material: { kind: "codex-chatgpt" as const, accessToken: "synthetic-access", accountId: "synthetic-account" } }
      : null),
    close: vi.fn(async () => { await harness.proc?.stop(); }), nativeCapabilities: undefined,
    refreshCodex: vi.fn(async () => { throw new Error("private-refresh-token-sentinel"); }),
  };
  harness.execution = { mode:"actor-grant-v1",cwd,lease,lifetime:lease,auth:lease,model:lease.admission.model,
    credentialKind,nativeCapabilities:null,environment:null,coordinator: { nativeHome, environment: () => nativeHome.environment() } } as unknown as CloudProviderExecution;
  return lease;
}
const boot = () => bootCodexAppServerRuntime({ cwd: "/srv/zeros/workspace", clientInfo: { name: "Zeros-test", version: "1" } });
const startupReplies = {
  "config/read": { config: {} },
  "plugin/installed": { marketplaces: [], marketplaceLoadErrors: [] },
  "thread/start": { thread: { id: "native-thread", sessionId: "native-scope" }, model: "gpt-5.6-sol" },
  "thread/resume": { thread: { id: "native-thread", sessionId: "native-scope" }, model: "gpt-5.6-sol" },
  "model/list": { data: [] },
  "skills/list": { data: [] },
  "turn/start": { turn: { id: "native-turn", status: "completed" } },
};
const adapters: CodexAppServerAdapter[] = [];
const realLeases: CloudAgentLease[] = [];
async function installRealCloud(attachProcess = true) {
  const origin = Date.parse("2026-01-01T00:00:00Z"); let elapsed = 0;
  const admission = {
    executionId: randomUUID(), delegationId: randomUUID(), provider: "codex" as const, model: "gpt-5.6-sol",
    source: { kind: "session" as const, actorSessionId: randomUUID() },
  };
  const grant = {
    leaseId: randomUUID(), authorityId: "a".repeat(64), expiresAt: new Date(origin + 45_000).toISOString(),
    credentialVersion: 1, credentialKind: "codex-api-key", provider: "codex", model: admission.model,
    material: { kind: "codex-api-key", apiKey: "synthetic-private-provider-key" },
  };
  const request = vi.fn(async (input: CloudAgentExecutionRequest): Promise<unknown> => input.kind === "admit" ? grant
    : input.kind === "release" ? { released: true }
      : { leaseId: grant.leaseId, expiresAt: grant.expiresAt, credentialVersion: 1 });
  const lease = await CloudAgentLease.admit(admission, request, new AbortController().signal,
    { onRetirementFailure: vi.fn() }, { wall: () => origin + elapsed, monotonic: () => elapsed });
  if (attachProcess) lease.attach({ stopAndProve: async () => { await harness.proc?.stop(); } });
  realLeases.push(lease);
  harness.execution = { mode:"actor-grant-v1",cwd: "/srv/zeros/workspace",lease,lifetime:lease,auth:lease,model:lease.admission.model,
    credentialKind:lease.credentialKind,nativeCapabilities:lease.nativeCapabilities,environment:lease.environment,
    coordinator: { nativeHome, environment: () => nativeHome.environment() } } as unknown as CloudProviderExecution;
  return { lease, request, advance: (ms: number) => { elapsed += ms; } };
}
function installAdapter() {
  const emit = {
    onSessionUpdate: vi.fn(), onPermissionRequest: vi.fn(), onQuestionRequest: vi.fn(),
    onAgentStderr: vi.fn(), onAgentExit: vi.fn(),
  };
  const adapter = new CodexAppServerAdapter({
    projectRoot: "/srv/zeros/workspace", mcpServers: [], sessionDirRoot: "/tmp/zeros-test-sessions", emit,
  } as unknown as AgentAdapterContext);
  adapters.push(adapter);
  return { adapter, emit };
}
function installOriginalLifetime(native: ReturnType<typeof installProcess>, credentialKind: "codex-chatgpt" | "codex-api-key" = "codex-api-key") {
  const auth = installCloud("/srv/zeros/workspace", credentialKind);
  const original = new AbortController();
  const lifetime = {
    signal: original.signal,
    assertLive: vi.fn(() => { if (original.signal.aborted) throw original.signal.reason; }),
    close: vi.fn(async () => {
      if (!original.signal.aborted) original.abort(new CloudCommandFailureError({ stage: "validation", category: "lifecycle_superseded" }));
      await native.stop();
    }),
  };
  Object.assign(harness.execution!, { mode: "boot-owner-v1", lifetime, auth });
  return { original, lifetime };
}
beforeEach(async () => { nativeDataRoot=await mkdtemp(path.join(os.tmpdir(),"zeros-codex-runtime-home-"));
  nativeHome=await createCloudNativeHome({dataRoot:nativeDataRoot,conversationId:"original-conversation",provider:"codex",executionId:"original-execution"});
  harness.execution = null; harness.proc = null; harness.executor.mockReset();
  vi.mocked(removeSessionDir).mockClear();
  harness.executor.mockResolvedValue({ environmentId: "synthetic-env", url: "ws://127.0.0.1/synthetic-capability" }); });
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose();
  for (const lease of realLeases.splice(0)) await lease.close();
  await harness.proc?.stop(); vi.clearAllTimers(); vi.useRealTimers();
  await rm(nativeDataRoot,{recursive:true,force:true});
});

describe("Codex VM-only auth storage", () => {
  it("keeps cloud credentials in the original physical file store even without a kernel boundary",async()=>{
    installProcess(startupReplies);installCloud();const runtime=await boot();
    expect(vi.mocked(spawnStdioAgent).mock.calls.at(-1)?.[0].args).toEqual(expect.arrayContaining([
      'cli_auth_credentials_store="file"','mcp_oauth_credentials_store="file"',
    ]));
    expect(vi.mocked(spawnStdioAgent).mock.calls.at(-1)?.[0].env?.CODEX_HOME).toBe(nativeHome.paths.codexHome);
    await runtime.dispose();
  });
});

describe("Codex permission metadata by placement", () => {
  it.each([[false,"new"],[true,"new"],[false,"resume"],[true,"resume"]] as const)("keeps Local mode text and avoids a cloud workspace sandbox claim (cloud=%s, %s)", async (cloud,kind) => {
    installProcess(startupReplies); if(cloud)installCloud();
    const {adapter}=installAdapter();
    const modes=kind==="new"
      ? (await adapter.newSession({executionId:"mode-execution",cwd:"/srv/zeros/workspace"})).session.modes!.availableModes
      : (await adapter.loadSession({executionId:"mode-resume",sessionId:"native-thread",cwd:"/srv/zeros/workspace"})).modes!.availableModes;
    expect(modes.map(mode=>mode.id)).toEqual(["ask","auto-edit","full-access","read-only"]);
    if(cloud)expect(JSON.stringify(modes)).not.toMatch(/sandbox: workspace-write|keeping the workspace sandbox/);
    else {
      expect(modes.find(mode=>mode.id==="ask")?.description).toBe("Prompt before every tool call (sandbox: workspace-write).");
      expect(modes.find(mode=>mode.id==="auto-edit")?.description).toContain("keeping the workspace sandbox");
    }
  });
});

describe("Codex real native prompt observation", () => {
  it.each([false, true])("separates stdin write from awaited turn ACK (cloud=%s)", async cloud => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" });
    if (cloud) installCloud("/srv/zeros/workspace", "codex-api-key");
    const runtime = await boot(), stages: string[] = [];
    const result = runtime.runTurn({ threadId: "native-thread", input: [{ type: "text", text: "fixture", text_elements: [] }] }, {
      onNativePromptStage: stage => {
        expect(native.frames.some(frame => frame.method === "turn/start")).toBe(true);
        stages.push(stage);
      },
    });
    // The RED assertion may precede the held ACK; teardown still owns and
    // settles this request without an unhandled rejection.
    void result.catch(() => {});
    const frame = await native.waitFor("turn/start");
    expect(stages).toEqual(["native_write"]);
    native.send({ jsonrpc: "2.0", id: frame.id, result: { turn: { id: "native-turn", status: "completed" } } });
    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(stages).toEqual(["native_write", "native_acceptance_ack"]);
    await runtime.dispose();
  });

  it("records a refused native turn write without fabricating acceptance", async () => {
    installProcess(startupReplies, "turn/start"); installCloud("/srv/zeros/workspace", "codex-api-key");
    const runtime = await boot(), observe = vi.fn();
    await expect(runtime.runTurn({ threadId: "native-thread", input: [{ type: "text", text: "fixture", text_elements: [] }] },
      { onNativePromptStage: observe })).rejects.toMatchObject({ code: -32603, method: "turn/start" });
    expect(observe.mock.calls).toEqual([["native_write"]]); await runtime.dispose();
  });

  it.each([undefined, "", "native\nturn", 123])("does not label an unusable turn id as native acceptance (%s)", async id => {
    installProcess({ ...startupReplies, "turn/start": { turn: { id, status: "completed" } } });
    const runtime = await boot(), observe = vi.fn();
    await runtime.runTurn({ threadId: "native-thread", input: [{ type: "text", text: "fixture", text_elements: [] }] }, { onNativePromptStage: observe });
    expect(observe.mock.calls).toEqual([["native_write"]]); await runtime.dispose();
  });

  it("does not label a different RPC response as this prompt's native acknowledgement", async () => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" }), runtime = await boot(), observe = vi.fn();
    const result = runtime.runTurn({ threadId: "native-thread", input: [{ type: "text", text: "fixture", text_elements: [] }] }, { onNativePromptStage: observe });
    void result.catch(() => {});
    const frame = await native.waitFor("turn/start");
    native.send({ jsonrpc: "2.0", id: (frame.id ?? 0) + 100, result: { turn: { id: "native-turn", status: "completed" } } });
    await Promise.resolve(); expect(observe.mock.calls).toEqual([["native_write"]]);
    native.send({ jsonrpc: "2.0", id: frame.id, result: { turn: { id: "native-turn", status: "completed" } } });
    await result; expect(observe.mock.calls).toEqual([["native_write"], ["native_acceptance_ack"]]); await runtime.dispose();
  });

  it("preserves the lease preflight before any native-write observation", async () => {
    const native = installProcess(startupReplies), lease = installCloud();
    const runtime = await boot(), observe = vi.fn();
    lease.validate.mockRejectedValueOnce(new CloudCommandFailureError({ stage: "validation", category: "access_denied" }));
    await expect(runtime.runTurn({ threadId: "native-thread", input: [{ type: "text", text: "fixture", text_elements: [] }] },
      { onNativePromptStage: observe })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    expect(observe).not.toHaveBeenCalled();
    expect(native.frames.some(frame => frame.method === "turn/start")).toBe(false); await runtime.dispose();
  });

  it("contains observation errors and preserves native completion", async () => {
    installProcess(startupReplies); installCloud("/srv/zeros/workspace", "codex-api-key");
    const runtime = await boot(), observe = vi.fn(() => { throw new Error("synthetic-observer-refusal"); });
    await expect(runtime.runTurn({ threadId: "native-thread", input: [{ type: "text", text: "fixture", text_elements: [] }] },
      { onNativePromptStage: observe })).resolves.toMatchObject({ status: "completed" });
    expect(observe.mock.calls).toEqual([["native_write"], ["native_acceptance_ack"]]); await runtime.dispose();
  });

  it("contains asynchronous native-stage observation rejection", async () => {
    installProcess(startupReplies); const runtime=await boot();
    await expect(runtime.runTurn({threadId:"native-thread",input:[{type:"text",text:"fixture",text_elements:[]}]},
      {onNativePromptStage:async()=>{throw new Error("synthetic async stage observer refusal");}})).resolves.toMatchObject({status:"completed"});
    await new Promise(resolve=>setTimeout(resolve,0)); await runtime.dispose();
  });

  it("observes inline review at its real review/start transport boundary", async () => {
    installProcess({ ...startupReplies, "review/start": { turn: { id: "native-review", status: "completed" } } });
    const runtime = await boot(), observe = vi.fn();
    await expect(runtime.runReview({ threadId: "native-thread", target: { type: "uncommittedChanges" }, delivery: "inline" },
      { onNativePromptStage: observe })).resolves.toMatchObject({ turnId: "native-review", status: "completed" });
    expect(observe.mock.calls).toEqual([["native_write"], ["native_acceptance_ack"]]); await runtime.dispose();
  });

  it("passes the adapter's trusted callback to native turn transport without observing startup metadata", async () => {
    installProcess(startupReplies); installCloud("/srv/zeros/workspace", "codex-api-key");
    const { adapter } = installAdapter(), observe = vi.fn();
    await adapter.newSession({ executionId: "observed-execution", cwd: "/srv/zeros/workspace" });
    await adapter.prompt({ sessionId: "observed-execution", prompt: [{ type: "text", text: "fixture" }], onNativePromptStage: observe });
    expect(observe.mock.calls).toEqual([["native_write"], ["native_acceptance_ack"]]);
  });
});

describe("Codex original native turn output", () => {
  const input = { threadId: "native-thread", input: [{ type: "text" as const, text: "fixture", text_elements: [] }] };
  const begin = async (native: ReturnType<typeof installProcess>, runtime: Awaited<ReturnType<typeof boot>>, output: (kind: "text" | "tool") => void, ordinal = 0) => {
    let bind!: (id: string) => void;
    const started = new Promise<string>(resolve => { bind = resolve; });
    const options = { onTurnStarted: bind, onNativeOutput: output };
    const result = runtime.runTurn(input, options);
    void result.catch(() => {});
    const frame = await native.waitFor("turn/start", ordinal);
    return { result, started, ack: (id = "native-turn") => native.send({ jsonrpc: "2.0", id: frame.id,
      result: { turn: { id, status: "inProgress" } } }), frame };
  };
  const text = (native: ReturnType<typeof installProcess>, turnId = "native-turn", threadId = "native-thread", delta = "native text") =>
    native.send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "native-item", delta } });
  const complete = (native: ReturnType<typeof installProcess>, turnId = "native-turn") =>
    native.send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "native-thread", turn: { id: turnId, status: "completed" } } });

  it.each([false, true])("observes only the ACK-owned native thread/turn text (cloud=%s)", async cloud => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" });
    if (cloud) installCloud("/srv/zeros/workspace", "codex-api-key");
    const runtime = await boot(), output = vi.fn(), turn = await begin(native, runtime, output);
    turn.ack(); await turn.started;
    text(native, "other-turn"); text(native, "native-turn", "other-thread"); text(native);
    complete(native); await turn.result;
    expect(output.mock.calls.map(([kind])=>[kind])).toEqual([["text"]]); await runtime.dispose();
  });

  it("waits for exact matched ACK before attributing an early frame", async () => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" }), runtime = await boot(), output = vi.fn();
    const turn = await begin(native, runtime, output);
    text(native, "old-turn"); text(native);
    expect(output).not.toHaveBeenCalled();
    turn.ack(); await turn.started;
    expect(output.mock.calls.map(([kind])=>[kind])).toEqual([["text"]]); complete(native); await turn.result; await runtime.dispose();
  });

  it("preserves native arrival40ms through ownership ACK200ms", async () => {
    const native=installProcess(startupReplies,undefined,{holdMethod:"turn/start"}),runtime=await boot(),output=vi.fn();
    const turn=await begin(native,runtime,output), clock=vi.spyOn(performance,"now");
    try {
      clock.mockReturnValue(40); text(native); expect(output).not.toHaveBeenCalled();
      clock.mockReturnValue(200); turn.ack(); await turn.started;
      expect(output.mock.calls).toEqual([["text",40]]); complete(native); await turn.result;
    } finally {clock.mockRestore(); await runtime.dispose();}
  });

  it("observes real tool items, excluding thoughts, guidance, empty text and generic session updates", async () => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" }), runtime = await boot(), output = vi.fn();
    const turn = await begin(native, runtime, output); turn.ack(); await turn.started;
    text(native, "native-turn", "native-thread", "");
    for (const type of ["reasoning", "userMessage", "unknown"])
      native.send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "native-thread", turnId: "native-turn", item: { id: "native-item", type } } });
    native.send({ jsonrpc: "2.0", method: "session/update", params: { text: "guidance" } });
    native.send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "unowned" } });
    expect(output).not.toHaveBeenCalled();
    native.send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "native-thread", turnId: "native-turn", item: { id: "tool-item", type: "commandExecution" } } });
    text(native); text(native); complete(native); await turn.result;
    expect(output.mock.calls.map(([kind])=>[kind])).toEqual([["tool"], ["text"]]); await runtime.dispose();
  });

  it("never assigns held old warm-turn output to a later send on the same native thread", async () => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" }), runtime = await boot();
    const firstOutput = vi.fn(), first = await begin(native, runtime, firstOutput);
    first.ack("native-first"); await first.started; text(native, "native-first"); complete(native, "native-first"); await first.result;
    const secondOutput = vi.fn(), second = await begin(native, runtime, secondOutput, 1);
    text(native, "native-first"); second.ack("native-second"); await second.started;
    text(native, "native-first"); text(native, "native-second"); complete(native, "native-second"); await second.result;
    expect(firstOutput.mock.calls.map(([kind])=>[kind])).toEqual([["text"]]); expect(secondOutput.mock.calls.map(([kind])=>[kind])).toEqual([["text"]]); await runtime.dispose();
  });

  it("excludes late frames after native terminal even when terminal precedes ACK", async () => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" }), runtime = await boot(), output = vi.fn();
    const turn = await begin(native, runtime, output);
    complete(native); text(native); turn.ack(); await turn.result;
    expect(output).not.toHaveBeenCalled(); text(native); expect(output).not.toHaveBeenCalled(); await runtime.dispose();
  });

  it("does not fabricate output ownership from a refused or unusable ACK", async () => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" }), runtime = await boot(), output = vi.fn();
    const turn = await begin(native, runtime, output); text(native);
    native.send({ jsonrpc: "2.0", id: turn.frame.id, error: { code: -32603, message: "synthetic native refusal" } });
    await expect(turn.result).rejects.toMatchObject({ code: -32603 });
    expect(output).not.toHaveBeenCalled(); text(native); expect(output).not.toHaveBeenCalled(); await runtime.dispose();
  });

  it("keeps malformed ACK status inert without throwing from the passive observer", async () => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" }), runtime = await boot(), output = vi.fn();
    const turn = await begin(native, runtime, output); text(native); complete(native);
    native.send({ jsonrpc: "2.0", id: turn.frame.id, result: { turn: { id: "native-turn", status: { toString: null } } } });
    await expect(turn.result).resolves.toMatchObject({ status: "completed" });
    expect(output).not.toHaveBeenCalled(); await runtime.dispose();
  });

  it("does not reopen native output after an unscoped terminal error precedes ACK", async () => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" }), runtime = await boot(), output = vi.fn();
    const result = runtime.runTurn(input, { onNativeOutput: output, onTurnStarted: () => text(native) });
    void result.catch(() => {});
    const frame = await native.waitFor("turn/start");
    native.send({ jsonrpc: "2.0", method: "error", params: { willRetry: false, error: { message: "synthetic terminal refusal" } } });
    native.send({ jsonrpc: "2.0", id: frame.id, result: { turn: { id: "native-turn", status: "inProgress" } } });
    await expect(result).resolves.toMatchObject({ status: "failed" });
    expect(output).not.toHaveBeenCalled(); await runtime.dispose();
  });

  it("contains synchronous and asynchronous observer failures", async () => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" }), runtime = await boot();
    const turn = await begin(native, runtime, () => { throw new Error("synthetic observer refusal"); });
    turn.ack(); await turn.started; text(native); complete(native); await turn.result;
    const next = await begin(native, runtime, async () => { throw new Error("synthetic async observer refusal"); }, 1);
    next.ack("native-next"); await next.started; text(native, "native-next"); complete(native, "native-next");
    await expect(next.result).resolves.toMatchObject({ status: "completed" }); await runtime.dispose();
  });

  it("bounds early foreign-turn candidates and still permits later exact output", async () => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" }), runtime = await boot(), output = vi.fn();
    const turn = await begin(native, runtime, output);
    for (let index = 0; index < 128; index++) text(native, `foreign-${index}`);
    turn.ack(); await turn.started; expect(output).not.toHaveBeenCalled();
    text(native); complete(native); await turn.result; expect(output.mock.calls.map(([kind])=>[kind])).toEqual([["text"]]); await runtime.dispose();
  });

  it("passes the original adapter callback to the native turn without synthetic startup/session evidence", async () => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" }); installCloud("/srv/zeros/workspace", "codex-api-key");
    const { adapter } = installAdapter(), output = vi.fn();
    await adapter.newSession({ executionId: "output-execution", cwd: "/srv/zeros/workspace" });
    expect(output).not.toHaveBeenCalled();
    const options = { sessionId: "output-execution", prompt: [{ type: "text" as const, text: "fixture" }], onNativeOutput: output };
    const result = adapter.prompt(options); void result.catch(() => {});
    const frame = await native.waitFor("turn/start");
    native.send({ jsonrpc: "2.0", id: frame.id, result: { turn: { id: "native-turn", status: "inProgress" } } });
    text(native); complete(native); await result;
    expect(output.mock.calls.map(([kind])=>[kind])).toEqual([["text"]]);
  });

  it("contains a rejecting observer through the adapter forwarding layer", async () => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" }); installCloud("/srv/zeros/workspace", "codex-api-key");
    const { adapter } = installAdapter();
    await adapter.newSession({ executionId: "rejecting-output", cwd: "/srv/zeros/workspace" });
    const options = { sessionId: "rejecting-output", prompt: [{ type: "text" as const, text: "fixture" }],
      onNativeOutput: async () => { throw new Error("synthetic adapter observer refusal"); } };
    const result = adapter.prompt(options); void result.catch(() => {});
    const frame = await native.waitFor("turn/start");
    native.send({ jsonrpc: "2.0", id: frame.id, result: { turn: { id: "native-turn", status: "inProgress" } } });
    text(native); complete(native);
    await expect(result).resolves.toMatchObject({ stopReason: "end_turn" });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});

describe("Codex original cloud lifetime retirement cause", () => {
  const turnInput = { threadId: "native-thread", input: [{ type: "text" as const, text: "fixture", text_elements: [] }] };
  const expiry = () => Object.assign(new Error("private-original-expiry-prose-sentinel"), { code: "cloud_validation_session_expired" });
  const beginPrompt = async (native: ReturnType<typeof installProcess>) => {
    const { adapter } = installAdapter();
    await adapter.newSession({ executionId: "original-execution", cwd: "/srv/zeros/workspace" });
    const prompt = adapter.prompt({ sessionId: "original-execution", prompt: [{ type: "text", text: "fixture" }] });
    void prompt.catch(() => {});
    await native.waitFor("turn/start");
    return { adapter, prompt };
  };

  it.each([false, true])("retains original expiry through native retirement (ACK received=%s)", async acknowledged => {
    const native = installProcess({ ...startupReplies, "turn/start": { turn: { id: "native-turn", status: "inProgress" } } },
      undefined, acknowledged ? {} : { holdMethod: "turn/start" });
    const { original } = installOriginalLifetime(native);
    const { prompt } = await beginPrompt(native);
    // Let the matched ACK install its waiter; the other case is a held
    // required RPC. Both are production retirement orderings.
    await new Promise(resolve => setTimeout(resolve, 0));
    original.abort(expiry()); await native.stop();
    const error = await prompt.catch(error => error);
    expect(error).toMatchObject({ code: "cloud_validation_session_expired" });
    expect(error.message).not.toContain("private-original");
  });

  it("captures expiry before EOF rejects the required RPC and before proc.exited runs", async () => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" });
    const { original } = installOriginalLifetime(native), runtime = await boot();
    const result = runtime.runTurn(turnInput).catch(error => error);
    await native.waitFor("turn/start"); original.abort(expiry());
    native.child.stdout.emit("end");
    await result;
    expect(runtime.cloudFailure).toMatchObject({ code: "cloud_validation_session_expired" });
    expect(runtime.cloudFailure?.message).not.toContain("private-original");
    await runtime.dispose();
  });

  it.each(["cloud_validation_environment_revoked", "cloud_agent_credential_revoked"])("retains only closed original authority metadata: %s", async code => {
    const native = installProcess(startupReplies, undefined, { holdMethod: "turn/start" });
    const { original } = installOriginalLifetime(native), { prompt } = await beginPrompt(native);
    original.abort(Object.assign(new Error("private-original-authority-sentinel"), { code })); await native.stop();
    const error = await prompt.catch(error => error);
    expect(error).toMatchObject({ code }); expect(error.message).not.toContain("private-original");
  });

  it("keeps a prior fatal native auth refusal ahead of the retirement cause it creates", async () => {
    const native = installProcess(startupReplies, "turn/start", {
      refusal: { code: -32603, message: "native-auth-refusal-sentinel", data: { codexErrorInfo: "unauthorized" } },
    });
    const { original } = installOriginalLifetime(native), runtime = await boot();
    const error = await runtime.runTurn(turnInput).catch(error => error);
    expect(runtime.cloudFailure).toBe(error);
    expect(error).toMatchObject({ code: -32603, method: "turn/start" });
    expect(original.signal.reason).toMatchObject({ code: "cloud_validation_lifecycle_superseded" });
    await runtime.dispose();
  });

  it("keeps an earlier native credential-refresh failure ahead of its generic lifetime close", async () => {
    const native = installProcess({ ...startupReplies, "turn/start": { turn: { id: "native-turn", status: "inProgress" } } });
    const { original } = installOriginalLifetime(native, "codex-chatgpt"), runtime = await boot();
    const result = runtime.runTurn(turnInput).catch(error => error);
    await native.waitFor("turn/start"); await new Promise(resolve => setTimeout(resolve, 0));
    native.send({ jsonrpc: "2.0", id: "original-refresh", method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized", previousAccountId: "synthetic-account" } });
    const error = await result;
    expect(error).toMatchObject({ code: "cloud_provider_prompt_credential_refresh_rejected" });
    expect(runtime.cloudFailure).toBe(error);
    expect(original.signal.reason).toMatchObject({ code: "cloud_validation_lifecycle_superseded" });
    await runtime.dispose();
  });

  it("does not mint an expiry from the generic close caused by a spontaneous native exit", async () => {
    const native = installProcess({ ...startupReplies, "turn/start": { turn: { id: "native-turn", status: "inProgress" } } });
    const { original } = installOriginalLifetime(native), { prompt } = await beginPrompt(native);
    await new Promise(resolve => setTimeout(resolve, 0)); await native.stop();
    await expect(prompt).rejects.toMatchObject({ failure: { kind: "transport-closed", stage: "prompt" } });
    expect(original.signal.reason).toMatchObject({ code: "cloud_validation_lifecycle_superseded" });
  });

  it("does not turn an unclassified original abort into an expiry or expose its prose", async () => {
    const native = installProcess({ ...startupReplies, "turn/start": { turn: { id: "native-turn", status: "inProgress" } } });
    const { original } = installOriginalLifetime(native), { prompt } = await beginPrompt(native);
    await new Promise(resolve => setTimeout(resolve, 0));
    original.abort(new Error("private-unclassified-original-sentinel")); await native.stop();
    const error = await prompt.catch(error => error);
    expect(error).toMatchObject({ failure: { kind: "transport-closed" } });
    expect(error.message).not.toContain("private-unclassified");
  });

  it("keeps explicit cancel ahead of original expiry and the process exit it causes", async () => {
    const native = installProcess({ ...startupReplies, "turn/start": { turn: { id: "native-turn", status: "inProgress" } } });
    const { original } = installOriginalLifetime(native), { adapter, prompt } = await beginPrompt(native);
    await new Promise(resolve => setTimeout(resolve, 0)); await adapter.cancel({ sessionId: "original-execution" });
    original.abort(expiry()); await native.stop();
    await expect(prompt).resolves.toMatchObject({ stopReason: "cancelled" });
  });

  it("removes the original abort observer before dispose closes the lifetime", async () => {
    const native = installProcess(startupReplies), { original } = installOriginalLifetime(native);
    const remove = vi.spyOn(original.signal, "removeEventListener"), runtime = await boot();
    await runtime.dispose();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(runtime.cloudFailure).toBeNull();
  });

  it.each(["Local Personal", "organization-local"])("keeps spontaneous %s exit as transport-closed", async () => {
    const native = installProcess({ ...startupReplies, "turn/start": { turn: { id: "native-turn", status: "inProgress" } } });
    const { prompt } = await beginPrompt(native);
    await new Promise(resolve => setTimeout(resolve, 0)); await native.stop();
    await expect(prompt).rejects.toMatchObject({ failure: { kind: "transport-closed", stage: "prompt" } });
    expect(harness.executor).not.toHaveBeenCalled();
  });
});

describe("Codex admitted native failure boundaries", () => {
  it("uses the captured common lifetime and auth while retaining genuine legacy validation", async () => {
    const native=installProcess(startupReplies), lease=installCloud();
    const assertLive=vi.fn(), close=vi.fn(async()=>{await native.stop();});
    const auth={codexAuth:vi.fn(()=>({credentialVersion:7,material:{kind:"codex-chatgpt",accessToken:"synthetic-captured-access",accountId:"captured-account"}})),
      refreshCodex:vi.fn(async()=>({credentialVersion:8,material:{kind:"codex-chatgpt",accessToken:"synthetic-captured-next",accountId:"captured-account"}}))};
    Object.assign(harness.execution!,{lifetime:{assertLive,close},auth,model:lease.admission.model,nativeCapabilities:null,environment:null});
    lease.assertLive.mockImplementation(()=>{throw new Error("retired legacy common read");});
    const runtime=await boot();
    expect(native.frames.find(frame=>frame.method==="account/login/start")?.params).toMatchObject({accessToken:"synthetic-captured-access",chatgptAccountId:"captured-account"});
    await expect(runtime.runTurn({threadId:"native-thread",input:[{type:"text",text:"fixture",text_elements:[]}]})).resolves.toMatchObject({status:"completed"});
    expect(lease.validate).toHaveBeenCalled(); expect(assertLive).toHaveBeenCalled();
    expect(lease.codexAuth).not.toHaveBeenCalled(); await runtime.dispose(); expect(close).toHaveBeenCalled();
  });
  it.each(["/srv/zeros/workspace", "/srv/zeros/workspace/packages/app", "/srv/zeros/worktrees/managed-checkout", "/srv/zeros/worktrees/checkout #1"])("boots in trusted %s despite a hostile caller cwd", async cwd => {
    installProcess({"environment/info":{cwd:pathToFileURL(cwd).href}});installCloud(cwd);
    const runtime=await bootCodexAppServerRuntime({cwd:"/private/caller",clientInfo:{name:"Zeros-test",version:"1"}});
    expect(vi.mocked(spawnStdioAgent).mock.calls.at(-1)![0].cwd).toBe(cwd);
    const args=vi.mocked(spawnStdioAgent).mock.calls.at(-1)![0].args;
    expect(args).toContain(`projects={ ${JSON.stringify(cwd)} = { trust_level = "untrusted" } }`);
    expect(args.join("\n")).not.toContain("/private/caller");await runtime.dispose();
  });
  it("projects safe repository settings while excluding auth/provider/MCP/state and permission traps", async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-codex-project-"));
    try {
      await mkdir(path.join(root,".codex"));
      await writeFile(path.join(root,".codex/config.toml"),[
        'developer_instructions="safe-project-instruction-sentinel"', 'model_verbosity="high"', 'model_reasoning_summary="concise"',
        'project_doc_max_bytes=4096', 'project_doc_fallback_filenames=["TEAM.md"]',
        'model="repo-model-trap"', 'model_provider="repo-provider-trap"', 'profile="repo-profile-trap"',
        'sqlite_home="/state-root-trap"', 'cli_auth_credentials_store="keyring"',
        'approval_policy="never"', 'sandbox_mode="danger-full-access"',
        '[model_providers.openai]', 'base_url="https://repo-endpoint-trap.invalid"', 'env_key="REPO_AUTH_TRAP"',
        '[profiles.repo-profile-trap]', 'model="repo-model-trap"', '[mcp_servers.excluded]', 'command="repo-mcp-trap"',
        '[shell_environment_policy.set]', 'OPENAI_API_KEY="repo-auth-trap"', 'HOME="/repo-home-trap"', 'PATH="/repo-path-trap"',
      ].join("\n"));
      const {frames}=installProcess({"environment/info":{cwd:`file://${root}`}});installCloud(root);
      const runtime=await bootCodexAppServerRuntime({cwd:root,clientInfo:{name:"Zeros-test",version:"1"}});
      const args=vi.mocked(spawnStdioAgent).mock.calls.at(-1)![0].args;
      expect(args).toContain('developer_instructions="safe-project-instruction-sentinel"');
      expect(args).toContain('model_verbosity="high"');
      expect(args.join("\n")).not.toMatch(/repo-(?:model|provider|profile|endpoint|auth|home|path|mcp)-trap|state-root-trap/);
      await runtime.request("thread/start",{approvalPolicy:"untrusted",sandbox:"read-only"});
      expect(frames.find(frame=>frame.method==="thread/start")?.params).toMatchObject({
        model:"gpt-5.6-sol",modelProvider:"openai",sandbox:"read-only",approvalPolicy:"untrusted",
        config:{developer_instructions:"safe-project-instruction-sentinel",model_verbosity:"high",project_doc_fallback_filenames:["TEAM.md"]},
      });
      await writeFile(path.join(root,".codex/config.toml"),'developer_instructions="late-instruction-trap"\n[model_providers.openai]\nbase_url="https://late-endpoint-trap.invalid"\n');
      await runtime.request("thread/resume",{threadId:"native",approvalPolicy:"untrusted",sandbox:"read-only"});
      const resumed=frames.find(frame=>frame.method==="thread/resume")!.params;
      expect(resumed).toMatchObject({config:{developer_instructions:"safe-project-instruction-sentinel"}});
      expect(JSON.stringify(resumed)).not.toContain("late-");await runtime.dispose();
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it("distinguishes executor launch from login and environment setup", async () => {
    installProcess(); const lease = installCloud();
    harness.executor.mockRejectedValueOnce(new Error("private-token-and-provider-prose-sentinel"));
    const error = await boot().catch(error => error);
    expect(error).toMatchObject({ code: "cloud_provider_start_executor_start_failed" });
    expect(error.message).not.toContain("private-token"); expect(lease.close).toHaveBeenCalledOnce();
  });
  it.each([
    ["account/login/start", "provider_login_failed"],
    ["environment/add", "environment_setup_failed"],
    ["environment/info", "environment_setup_failed"],
  ])("retains the closed boundary for %s", async (method, category) => {
    installProcess({}, method); const lease = installCloud();
    const error = await boot().catch(error => error);
    expect(error).toMatchObject({ code: `cloud_provider_start_${category}` });
    expect(error.message).not.toContain("private-token"); expect(lease.close).toHaveBeenCalledOnce();
  });
  it("labels executor cwd mismatch without retaining the foreign path", async () => {
    installProcess({ "environment/info": { cwd: "file:///private-foreign-workspace-sentinel" } }); const lease = installCloud();
    const error = await boot().catch(error => error);
    expect(error).toMatchObject({ code: "cloud_provider_start_environment_identity_mismatch" });
    expect(error.message).not.toContain("foreign-workspace"); expect(lease.close).toHaveBeenCalledOnce();
  });
  it("preserves an already typed inner failure", async () => {
    installProcess(); const lease = installCloud();
    harness.executor.mockRejectedValueOnce(new CloudCommandFailureError({ stage: "containment", category: "canary_failed" }));
    const error = await boot().catch(error => error);
    expect(error).toMatchObject({ code: "cloud_containment_canary_failed" }); expect(lease.close).toHaveBeenCalledOnce();
  });
  it.each(["thread/start", "thread/resume", "turn/start"])("fences %s on not-ready without sending native work", async method => {
    const { frames } = installProcess({ "environment/status": { status: "starting" } }); const lease = installCloud();
    const runtime = await boot();
    await expect(runtime.request(method, {})).rejects.toMatchObject({
      code: `cloud_${method === "turn/start" ? "provider_prompt" : "provider_start"}_environment_not_ready`,
    });
    expect(frames.some(frame => frame.method === method)).toBe(false); expect(lease.close).toHaveBeenCalled();
  });
  it("preserves a typed lease failure before a native thread request", async () => {
    const { frames } = installProcess(); const lease = installCloud(); const runtime = await boot();
    lease.validate.mockRejectedValueOnce(new CloudCommandFailureError({ stage: "validation", category: "authority_timeout" }));
    await expect(runtime.request("thread/start", {})).rejects.toMatchObject({ code: "cloud_validation_authority_timeout" });
    expect(frames.some(frame => frame.method === "thread/start")).toBe(false);
  });
  describe.each(["codex-api-key", "codex-chatgpt"] as const)("optional discovery with %s", credentialKind => {
    it.each(["model/list", "skills/list", "account/rateLimits/read"] as const)("keeps admission live after a refused %s RPC", async method => {
      const { child, frames } = installProcess(startupReplies, method);
      const lease = installCloud("/srv/zeros/workspace", credentialKind);
      const runtime = await boot();
      const error = await runtime.request(method, {}).catch(error => error);
      expect(error).toMatchObject({ code: -32603, method });
      expect(lease.close).not.toHaveBeenCalled();
      expect(child.killed).toBe(false);
      await runtime.startThread({ cwd: "/srv/zeros/workspace", approvalPolicy: "untrusted", sandbox: "read-only" });
      await expect(runtime.runTurn({ threadId: "native-thread", input: [{ type: "text", text: "fixture", text_elements: [] }] }))
        .resolves.toMatchObject({ status: "completed" });
      expect(frames.some(frame => frame.method === "turn/start")).toBe(true);
      expect(lease.close).not.toHaveBeenCalled();
      await runtime.dispose();
    });
    it.each(["model/list", "skills/list", "account/rateLimits/read"] as const)("survives a swallowed %s refusal during real adapter startup", async method => {
      vi.useFakeTimers();
      const { child, frames, waitFor } = installProcess(startupReplies, method);
      const lease = installCloud("/srv/zeros/workspace", credentialKind);
      const { adapter, emit } = installAdapter();
      const started = await adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" });
      // These are real requestTyped calls made by boot's quota/skill/model
      // discovery; a refused optional read must not invalidate the next send.
      await waitFor(method); await Promise.resolve();
      expect(frames.some(frame => frame.method === method)).toBe(true);
      expect(lease.close).not.toHaveBeenCalled();
      expect(child.killed).toBe(false);
      expect(emit.onAgentExit).not.toHaveBeenCalled();
      expect(started.session.executionId).toBe("zeros-execution");
      await expect(adapter.prompt({ sessionId: "zeros-execution", prompt: [{ type: "text", text: "fixture" }] }))
        .resolves.toMatchObject({ stopReason: "end_turn" });
      expect(frames.some(frame => frame.method === "turn/start")).toBe(true);
      expect(lease.close).not.toHaveBeenCalled();
    });
    it("keeps the real best-effort account panel read from retiring the next prompt", async () => {
      vi.useFakeTimers();
      const { child, frames } = installProcess(startupReplies, "account/read");
      const lease = installCloud("/srv/zeros/workspace", credentialKind);
      const { adapter } = installAdapter();
      await adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" });
      await expect(adapter.getAccountInfo({ liveOnly: true })).resolves.toBeNull();
      expect(frames.some(frame => frame.method === "account/read")).toBe(true);
      expect(lease.close).not.toHaveBeenCalled(); expect(child.killed).toBe(false);
      await expect(adapter.prompt({ sessionId: "zeros-execution", prompt: [{ type: "text", text: "fixture" }] }))
        .resolves.toMatchObject({ stopReason: "end_turn" });
    });
  });
  it.each([
    "account/read", "config/read", "configRequirements/read", "permissionProfile/list", "mcpServerStatus/list",
    "thread/read", "thread/list", "thread/loaded/list", "thread/backgroundTerminals/list",
  ])("keeps other admitted metadata failures scoped to %s", async method => {
    const { child } = installProcess(startupReplies, method);
    const lease = installCloud(); const runtime = await boot();
    await expect(runtime.request(method, { threadId: "native-thread" })).rejects.toMatchObject({ code: -32603, method });
    expect(lease.close).not.toHaveBeenCalled(); expect(child.killed).toBe(false);
    expect(runtime.cloudFailure).toBeNull();
    await runtime.startThread({ cwd: "/srv/zeros/workspace" }); await runtime.dispose();
  });
  it.each(["model/list", "thread/start"] as const)("keeps overload exhaustion scoped to the %s caller", async method => {
    vi.useFakeTimers();
    const { frames } = installProcess(startupReplies, method, { refusal: { code: -32001, message: "Server overloaded" } });
    const lease = installCloud(); const runtime = await boot();
    const request = method === "thread/start" ? runtime.startThread({ cwd: "/srv/zeros/workspace" }) : runtime.request(method, {});
    const result = request.catch(error => error);
    await vi.runAllTimersAsync(); const error = await result;
    expect(error).toMatchObject({ code: -32001, method });
    expect(frames.filter(frame => frame.method === method)).toHaveLength(4);
    if (method === "thread/start") {
      expect(lease.close).toHaveBeenCalled(); expect(runtime.cloudFailure).toBe(error);
    } else {
      expect(lease.close).not.toHaveBeenCalled(); expect(runtime.cloudFailure).toBeNull();
    }
    await runtime.dispose();
  });
  it.each(["thread/start", "thread/resume", "turn/start"] as const)("retires admission on a fatal %s RPC without replacing its native cause", async method => {
    installProcess(startupReplies, method);
    const lease = installCloud(); const runtime = await boot();
    const result = method === "thread/start"
      ? runtime.startThread({ cwd: "/srv/zeros/workspace" })
      : method === "thread/resume"
        ? runtime.resumeThread({ threadId: "native-thread", cwd: "/srv/zeros/workspace" })
        : runtime.runTurn({ threadId: "native-thread", input: [{ type: "text", text: "fixture", text_elements: [] }] });
    await expect(result).rejects.toMatchObject({ code: -32603, method });
    expect(lease.close).toHaveBeenCalled();
  });
  it("preserves the native foreground auth failure before retirement closes the child", async () => {
    vi.useFakeTimers();
    installProcess(startupReplies, "turn/start", {
      refusal: { code: -32603, message: "native-auth-refusal-sentinel", data: { codexErrorInfo: "unauthorized" } },
    });
    const lease = installCloud(); const { adapter } = installAdapter();
    await adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" });
    await expect(adapter.prompt({ sessionId: "zeros-execution", prompt: [{ type: "text", text: "fixture" }] }))
      .rejects.toMatchObject({ failure: { kind: "auth-required", stage: "prompt", agentId: "codex" } });
    expect(lease.close).toHaveBeenCalled();
  });
  it("rejects cloud newSession if the native process exits while model discovery is awaited", async () => {
    vi.useFakeTimers();
    const { stop, waitFor } = installProcess(startupReplies, undefined, { holdMethod: "model/list" });
    const lease = installCloud(); const { adapter, emit } = installAdapter();
    const result = adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" });
    await waitFor("model/list"); await stop();
    await expect(result).rejects.toMatchObject({ code: "cloud_provider_start_subprocess_exited" });
    expect(lease.close).toHaveBeenCalled();
    expect(emit.onAgentExit).toHaveBeenCalledWith("codex", 0, null, "zeros-execution");
    expect(removeSessionDir).toHaveBeenCalledWith("zeros-execution");
  });
  it("retains a known typed authority cause when the process dies during cloud startup discovery", async () => {
    vi.useFakeTimers();
    const { stop, waitFor } = installProcess(startupReplies, undefined, { holdMethod: "model/list" });
    const lease = installCloud(); const { adapter } = installAdapter();
    const result = adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" });
    await waitFor("model/list");
    const failure = new CloudCommandFailureError({ stage: "validation", category: "environment_revoked" });
    lease.assertLive.mockImplementation(() => { throw failure; }); await stop();
    await expect(result).rejects.toBe(failure);
    expect(removeSessionDir).toHaveBeenCalledWith("zeros-execution");
  });
  it.each([
    "cloud_validation_environment_revoked", "cloud_validation_lease_expired", "cloud_containment_timeout",
    "cloud_agent_credential_expired", "cloud_agent_credential_revoked", "cloud_runtime_upgrade_required",
  ])("retains the ordinary closed lease error shape at startup: %s", async code => {
    vi.useFakeTimers();
    const { send, waitFor } = installProcess(startupReplies, undefined, { holdMethod: "model/list" });
    const lease = installCloud(); const { adapter } = installAdapter();
    const result = adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" }).catch(error => error);
    const frame = await waitFor("model/list");
    const failure = Object.assign(new Error("private-lease-diagnostic-sentinel"), { code, failure: cloudCommandFailureFromCode(code) });
    lease.assertLive.mockImplementation(() => { throw failure; });
    send({ jsonrpc: "2.0", id: frame.id, result: { data: [] } });
    const error = await result;
    expect(error).toMatchObject({ code }); expect(error.message).not.toContain("private-lease");
    expect(removeSessionDir).toHaveBeenCalledWith("zeros-execution");
  });
  it("keeps the real expired lease cause across model discovery and native retirement", async () => {
    vi.useFakeTimers();
    const { waitFor } = installProcess(startupReplies, undefined, { holdMethod: "model/list" });
    const { lease, advance } = await installRealCloud(); const { adapter } = installAdapter();
    const result = adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" }).catch(error => error);
    await waitFor("model/list"); advance(44_000);
    expect(() => lease.assertLive()).toThrow(expect.objectContaining({ code: "cloud_validation_lease_expired" }));
    const error = await result;
    expect(error).toMatchObject({ code: "cloud_validation_lease_expired" });
    expect(lease.signal.aborted).toBe(true); await lease.close();
  });
  it("keeps real legacy credential revocation ahead of a discovery-time process exit", async () => {
    vi.useFakeTimers();
    const { waitFor } = installProcess(startupReplies, undefined, { holdMethod: "model/list" });
    const { lease, request } = await installRealCloud(); const { adapter } = installAdapter();
    const result = adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" }).catch(error => error);
    await waitFor("model/list");
    request.mockRejectedValueOnce(Object.assign(new Error("private-authority-sentinel"), { code: "cloud_agent_credential_revoked" }));
    await expect(lease.validate(true)).rejects.toMatchObject({ code: "cloud_agent_credential_revoked" });
    const error = await result;
    expect(error).toMatchObject({ code: "cloud_agent_credential_revoked" }); expect(error.message).not.toContain("private-authority");
    expect(lease.signal.aborted).toBe(true);
  });
  it("keeps an observed native exit ahead of the real lease close's default retirement cause", async () => {
    vi.useFakeTimers();
    const { stop, waitFor } = installProcess(startupReplies, undefined, { holdMethod: "model/list" });
    const { lease } = await installRealCloud(); const { adapter } = installAdapter();
    const result = adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" }).catch(error => error);
    await waitFor("model/list"); await stop();
    expect(await result).toMatchObject({ code: "cloud_provider_start_subprocess_exited" });
    expect(lease.signal.aborted).toBe(true); await lease.close();
  });
  it("retains explicit lease close without an observed native exit during discovery", async () => {
    vi.useFakeTimers();
    const { child, send, waitFor } = installProcess(startupReplies, undefined, { holdMethod: "model/list" });
    const { lease } = await installRealCloud(false); const { adapter } = installAdapter();
    const result = adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" }).catch(error => error);
    const frame = await waitFor("model/list"); await lease.close();
    expect(child.killed).toBe(false);
    send({ jsonrpc: "2.0", id: frame.id, result: { data: [] } });
    expect(await result).toMatchObject({ code: "cloud_validation_lifecycle_superseded" });
  });
  it("keeps explicit Stop ahead of the process exit it causes during startup discovery", async () => {
    vi.useFakeTimers();
    const { waitFor } = installProcess(startupReplies, undefined, { holdMethod: "model/list" });
    const { lease } = await installRealCloud(); const { adapter } = installAdapter();
    const result = adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" }).catch(error => error);
    await waitFor("model/list"); await adapter.cancel({ sessionId: "zeros-execution" }); await lease.close();
    expect(await result).toMatchObject({ code: "cloud_provider_start_lifecycle_superseded" });
  });
  it("rejects a replaced startup session with its lifecycle cause", async () => {
    vi.useFakeTimers();
    const { waitFor } = installProcess(startupReplies, undefined, { holdMethod: "model/list" });
    await installRealCloud(); const { adapter } = installAdapter();
    const result = adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" }).catch(error => error);
    await waitFor("model/list"); await adapter.disposeSession("zeros-execution");
    expect(await result).toMatchObject({ code: "cloud_provider_start_lifecycle_superseded" });
  });
  it("rejects a child that exits before the boot session object is registered", async () => {
    vi.useFakeTimers();
    const { send, stop, waitFor } = installProcess(startupReplies, undefined, { holdMethod: "thread/start" });
    const { lease } = await installRealCloud(); const { adapter } = installAdapter();
    const result = adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" }).catch(error => error);
    const frame = await waitFor("thread/start");
    send({ jsonrpc: "2.0", id: frame.id, result: startupReplies["thread/start"] }); await stop();
    expect(await result).toMatchObject({ code: "cloud_provider_start_subprocess_exited" });
    expect(lease.signal.aborted).toBe(true);
  });
  it("preserves ordinary failed-retirement proof ahead of the startup authority cause", async () => {
    vi.useFakeTimers();
    const { send, stop, waitFor } = installProcess(startupReplies, undefined, { holdMethod: "model/list" });
    const lease = installCloud(); const { adapter } = installAdapter();
    const result = adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" }).catch(error => error);
    const frame = await waitFor("model/list");
    lease.assertLive.mockImplementation(() => { throw Object.assign(new Error("private-lease-diagnostic-sentinel"), { code: "cloud_validation_lease_expired" }); });
    stop.mockRejectedValueOnce(Object.assign(new Error("private-proof-diagnostic-sentinel"), { code: "cloud_containment_attestation_failed" }));
    send({ jsonrpc: "2.0", id: frame.id, result: { data: [] } });
    const error = await result;
    expect(error).toMatchObject({ code: "cloud_containment_attestation_failed" });
    expect(error.message).not.toContain("private-proof");
  });
  it("keeps failed retirement proof ahead of a native thread-start refusal", async () => {
    vi.useFakeTimers();
    const { send, stop, waitFor } = installProcess(startupReplies, undefined, { holdMethod: "thread/start" });
    installCloud(); const { adapter } = installAdapter();
    const result = adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" }).catch(error => error);
    const frame = await waitFor("thread/start");
    const originalStop = stop.getMockImplementation()!;
    stop.mockRejectedValue(Object.assign(new Error("private-proof-diagnostic-sentinel"), { code: "cloud_containment_attestation_failed" }));
    try {
      send({ jsonrpc: "2.0", id: frame.id, error: { code: -32603, message: "native-auth-refusal-sentinel", data: { codexErrorInfo: "unauthorized" } } });
      const error = await result;
      expect(error).toMatchObject({ code: "cloud_containment_attestation_failed" });
      expect(error.message).not.toContain("private-proof");
    } finally { stop.mockImplementation(originalStop); }
  });
  it("preserves real grant revocation on foreground validation before sending native work", async () => {
    vi.useFakeTimers();
    const { frames, waitFor } = installProcess(startupReplies);
    const { lease, request } = await installRealCloud(); const { adapter } = installAdapter();
    await adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" });
    await waitFor("skills/list"); await Promise.resolve();
    request.mockImplementation(async input => {
      if (input.kind === "release") return { released: true };
      throw Object.assign(new Error("private-authority-sentinel"), { code: "cloud_agent_credential_revoked" });
    });
    const error = await adapter.prompt({ sessionId: "zeros-execution", prompt: [{ type: "text", text: "fixture" }] }).catch(error => error);
    expect(error).toMatchObject({ code: "cloud_agent_credential_revoked" });
    expect(error.message).not.toContain("private-authority");
    expect(frames.some(frame => frame.method === "turn/start")).toBe(false); expect(lease.signal.aborted).toBe(true);
  });
  it("retains a typed credential refresh cause if refresh retires startup during model discovery", async () => {
    vi.useFakeTimers();
    const { send, waitFor } = installProcess(startupReplies, undefined, { holdMethod: "model/list" });
    const lease = installCloud(); const { adapter } = installAdapter();
    const result = adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" });
    await waitFor("model/list");
    send({ jsonrpc: "2.0", id: "native-refresh", method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: "synthetic-account" } });
    await expect(result).rejects.toMatchObject({ code: "cloud_provider_prompt_credential_refresh_rejected" });
    expect(lease.close).toHaveBeenCalled();
    expect(removeSessionDir).toHaveBeenCalledWith("zeros-execution");
  });
  it("still retires cloud admission on a real native process exit", async () => {
    const { stop } = installProcess(); const lease = installCloud();
    await boot(); await stop();
    expect(lease.close).toHaveBeenCalled();
  });
  it.each(["Local Personal", "organization-local"])("keeps %s discovery errors and subsequent turns on the Local path", async () => {
    vi.useFakeTimers();
    const { child, frames } = installProcess(startupReplies, "model/list");
    const { adapter, emit } = installAdapter();
    const started = await adapter.newSession({ executionId: "zeros-execution", cwd: "/srv/zeros/workspace" });
    expect(started.session.executionId).toBe("zeros-execution");
    expect(harness.executor).not.toHaveBeenCalled();
    expect(child.killed).toBe(false); expect(emit.onAgentExit).not.toHaveBeenCalled();
    await expect(adapter.prompt({ sessionId: "zeros-execution", prompt: [{ type: "text", text: "fixture" }] }))
      .resolves.toMatchObject({ stopReason: "end_turn" });
    expect(frames.some(frame => frame.method === "environment/status")).toBe(false);
  });
  it("carries a native refresh callback failure through the pending foreground turn", async () => {
    const { send } = installProcess({ "turn/start": { turn: { id: "native-turn", status: "inProgress" } } });
    const lease = installCloud(); const runtime = await boot();
    const result = runtime.runTurn({ threadId: "native-thread", input: [{ type: "text", text: "fixture", text_elements: [] }] }).catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 0));
    send({ jsonrpc: "2.0", id: "native-refresh", method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: "synthetic-account" } });
    const error = await result;
    expect(error).toMatchObject({ code: "cloud_provider_prompt_credential_refresh_rejected" });
    expect(error.message).not.toContain("private-refresh"); expect(lease.close).toHaveBeenCalled();
  });
  it("keeps Local Personal and organization-local native errors on their existing path", async () => {
    const { frames } = installProcess({}, "thread/start"); const runtime = await boot();
    const error = await runtime.request("thread/start", {}).catch(error => error);
    expect(error).toMatchObject({ code: -32603 });
    expect(harness.executor).not.toHaveBeenCalled(); expect(frames.some(frame => frame.method === "environment/status")).toBe(false);
    await runtime.dispose();
  });
});
