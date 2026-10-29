import { expect, it } from "vitest";
import { CursorHost } from "../host";
import type { HostEvent, NativeAgent, NativeResult, NativeRun, NativeSDK, NativeSend } from "../native-types";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const events: HostEvent[] = [], calls: Array<{ kind: string; options: unknown }> = [];
  const result = deferred<NativeResult>(), end = deferred<void>(); let cancels = 0;
  const run: NativeRun = { id: "run-one", async *stream() { await end.promise; yield { type: "request", request_id: "normal-ack" }; }, wait: () => result.promise,
    cancel: async () => { cancels++; end.resolve(); result.resolve({ id: "run-one", status: "cancelled" }); }, steer: async () => "complete_delivered" };
  const agent: NativeAgent = { agentId: "native-agent", send: async (_message, options) => { calls.push({ kind: "send", options }); return run; }, close() {}, getUsage: async () => ({ runs: [] }) };
  const sdk: NativeSDK = {
    create: async options => { calls.push({ kind: "create", options }); return agent; },
    resume: async (id, options) => { calls.push({ kind: id, options }); return agent; },
  };
  const host = new CursorHost(sdk, event => { events.push(event); return Promise.resolve(); }, "fixture-cursor",
    async () => [{ id: "composer-2.5" }, { id: "grok-4.7", parameters: [] }]);
  return { host, events, calls, agent, run, result, end, cancels: () => cancels };
}

it("pins native cwd, full permissions and a model at create, resume and every send", async () => {
  const f = fixture();
  await expect(f.host.open({ cwd: "/fixture", model: "composer-2.5", nativeSessionId: "native-agent" })).resolves.toMatchObject({ nativeSessionId: "native-agent" });
  expect(f.calls[0]).toMatchObject({ kind: "native-agent", options: { cwd: "/fixture", local: { cwd: "/fixture", autoReview: false, sandboxOptions: { enabled: false }, enableAgentRetries: false }, model: { id: "composer-2.5" }, disallowedTools: ["askQuestion"] } });
  await f.host.prompt({ turnId: "one", content: { text: "hello" }, model: "grok-4.7" });
  expect(f.calls[1]).toMatchObject({ kind: "send", options: { mode: "agent", model: { id: "grok-4.7" }, local: { force: true } } });
  await expect(f.host.steer("foreign", "do not send")).resolves.toBe("queued");
  await expect(f.host.steer("one", "follow up")).resolves.toBe("delivered");
  f.end.resolve(); f.result.resolve({ id: "run-one", status: "finished" }); await tick();
  expect(f.events.at(-1)).toMatchObject({ kind: "result", turnId: "one", value: { result: { status: "finished" } } }); await f.host.dispose();
});

it("passes admitted worker MCP servers into Cursor create and resume", async () => {
  for (const nativeSessionId of [undefined, "native-agent"]) {
    const f = fixture(), mcpServers = { tools: { type: "http" as const, url: "http://127.0.0.1:3222/mcp/fixture", headers: { Authorization: "Bearer fixture-mcp-secret" } } };
    await f.host.open({ cwd: "/fixture", model: "composer-2.5", nativeSessionId, mcpServers });
    expect(f.calls[0]).toMatchObject({ options: { mcpServers } });
    await f.host.dispose();
  }
});

it("records Stop while send is pending and cancels the run as soon as it becomes available", async () => {
  const f = fixture(), pending = deferred<NativeRun>(); f.agent.send = async () => pending.promise;
  await f.host.open({ cwd: "/fixture", model: "composer-2.5" });
  const sending = f.host.prompt({ turnId: "one", content: { text: "hello" }, model: "composer-2.5" });
  await f.host.interrupt("one"); pending.resolve(f.run); await sending; await tick();
  expect(f.cancels()).toBe(1); expect(f.events.at(-1)).toMatchObject({ kind: "result", value: { result: { status: "cancelled" } } }); await f.host.dispose();
});

it("accepts the SDK's request-id acknowledgement as ordinary run metadata", async () => {
  const f = fixture(); f.run.stream = async function* () { yield { type: "request", agent_id: "native-agent", run_id: "run-one", request_id: "request-one" }; };
  f.result.resolve({ id: "run-one", status: "finished" });
  await f.host.open({ cwd: "/fixture", model: "composer-2.5" }); await f.host.prompt({ turnId: "one", content: { text: "hello" }, model: "composer-2.5" }); await tick();
  expect(f.cancels()).toBe(0); expect(f.events.at(-1)).toMatchObject({ kind: "result", value: { result: { status: "finished" } } }); await f.host.dispose();
});

it("cancels an unexpected native question tool and reports a clean failure", async () => {
  const f = fixture(); f.run.stream = async function* () { yield { type: "tool_call", agent_id: "native-agent", run_id: "run-one", call_id: "ask", name: "askQuestion", status: "running" }; };
  await f.host.open({ cwd: "/fixture", model: "composer-2.5" }); await f.host.prompt({ turnId: "one", content: { text: "hello" }, model: "composer-2.5" }); await tick();
  expect(f.cancels()).toBe(1); expect(f.events.at(-1)).toMatchObject({ kind: "error", value: expect.stringMatching(/interactive/i) }); await f.host.dispose();
});

it("reports an unexpected question before an uncooperative stream iterator can block its return", async () => {
  const f = fixture();
  f.run.stream = () => ({ [Symbol.asyncIterator]: () => ({
    next: async () => ({ done: false, value: { type: "tool_call", name: "askQuestion", status: "running" } }),
    return: () => new Promise(() => {}),
  }) });
  await f.host.open({ cwd: "/fixture", model: "composer-2.5" }); await f.host.prompt({ turnId: "one", content: { text: "hello" }, model: "composer-2.5" }); await tick();
  expect(f.events.at(-1)).toMatchObject({ kind: "error", value: expect.stringMatching(/interactive/i) });
  await f.host.dispose();
});

it("rejects a child question callback before send returns, even if the SDK swallows the callback error", async () => {
  const f = fixture();
  f.agent.send = async (_message, options) => {
    await options.onDelta({ update: { type: "tool-call-delta", taskUpdate: { type: "tool-call-started", toolCall: { type: "askQuestion" } } } }).catch(() => {});
    return f.run;
  };
  await f.host.open({ cwd: "/fixture", model: "composer-2.5" });
  await expect(f.host.prompt({ turnId: "one", content: { text: "hello" }, model: "composer-2.5" })).rejects.toThrow(/closed/);
  expect(f.events[0]).toMatchObject({ kind: "error", value: expect.stringMatching(/interactive/i) }); expect(f.cancels()).toBe(1);
  await f.host.dispose();
});

it("owns callback events before send returns and fences callbacks after disposal", async () => {
  const f = fixture(); let callbacks!: NativeSend;
  f.agent.send = async (_message, options) => { callbacks = options; await options.onDelta({ update: { type: "text-delta", text: "Early" } }); return f.run; };
  await f.host.open({ cwd: "/fixture", model: "composer-2.5" }); await f.host.prompt({ turnId: "one", content: { text: "hello" }, model: "composer-2.5" });
  expect(f.events[0]).toMatchObject({ turnId: "one", kind: "delta", value: { text: "Early" } });
  await f.host.dispose(); const before = f.events.length; await callbacks.onDelta({ update: { type: "text-delta", text: "Late" } });
  expect(f.events).toHaveLength(before);
});

it("fences late native callbacks once the result is known, while billing is still pending", async () => {
  const f = fixture(), billing = deferred<unknown>(); let callbacks!: NativeSend;
  f.agent.getUsage = () => billing.promise;
  f.agent.send = async (_message, options) => { callbacks = options; return f.run; };
  await f.host.open({ cwd: "/fixture", model: "composer-2.5" }); await f.host.prompt({ turnId: "one", content: { text: "hello" }, model: "composer-2.5" });
  f.end.resolve(); f.result.resolve({ id: "run-one", status: "finished" }); await tick();
  await callbacks.onDelta({ update: { type: "text-delta", text: "Late after result" } });
  expect(f.events.some(event => event.kind === "delta")).toBe(false);
  billing.resolve({ runs: [] }); await tick(); await f.host.dispose();
});
