import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorSdkAdapter, type SdkRun } from "../adapter";
import type { AgentAdapterContext, SessionNotification } from "../../../types";

const spies = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn(), summarize: vi.fn(), models: vi.fn() }));
vi.mock("@cursor/sdk", () => ({
  Agent: { create: spies.create, resume: spies.create }, Cursor: { models: { list: spies.models } },
  JsonlLocalAgentStore: class { runs = { get: async () => null }; },
  getDefaultSdkStateRoot: () => "/synthetic/state",
}));
const adapters: CursorSdkAdapter[] = [];
beforeEach(() => {
  vi.stubEnv("CURSOR_RIPGREP_PATH", "/usr/bin/rg"); vi.stubEnv("CURSOR_API_KEY", "");
  spies.create.mockReset().mockResolvedValue({ agentId: "native", send: spies.send, summarize: spies.summarize, close() {} });
  spies.models.mockReset().mockResolvedValue([]);
  spies.send.mockReset().mockResolvedValue(run()); spies.summarize.mockReset().mockResolvedValue(run());
});
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.dispose(); vi.unstubAllEnvs(); });
function run(): SdkRun {
  return { id: "summary-run", cancel: vi.fn(async () => {}),
    async *stream() {
      yield { type: "summary", agent_id: "native", run_id: "summary-run", status: "running" };
      yield { type: "summary", agent_id: "native", run_id: "summary-run", status: "completed" };
    }, wait: async () => ({ status: "finished", result: "PRIVATE_SUMMARY" }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function promptRun(): SdkRun {
  return { id: "prompt-run", cancel: vi.fn(async () => {}),
    async *stream() { yield { type: "status", status: "finished" }; },
    wait: async () => ({ status: "finished" }) };
}
async function setup() {
  const events: SessionNotification[] = [];
  const ctx: AgentAdapterContext = { projectRoot: "/synthetic", mcpServers: [], sessionDirRoot: "/synthetic/sessions",
    emit: { onSessionUpdate: (_agent, event) => events.push(event), onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } };
  const adapter = new CursorSdkAdapter(ctx); adapters.push(adapter);
  const { session } = await adapter.newSession({ cwd: "/synthetic", env: { CURSOR_API_KEY: "fixture" } });
  events.length = 0;
  return { adapter, sessionId: session.sessionId, events };
}

describe("Cursor idle manual compaction", () => {
  it("calls summarize without sending a user prompt or publishing its private summary", async () => {
    const f = await setup();
    await f.adapter.compactContext({ sessionId: f.sessionId });
    expect(spies.summarize).toHaveBeenCalledExactlyOnceWith();
    expect(spies.send).not.toHaveBeenCalled();
    expect(f.events.map(event => event.update)).toMatchObject([
      { sessionUpdate: "tool_call", kind: "compaction", status: "in_progress", rawInput: { trigger: "manual" } },
      { sessionUpdate: "tool_call_update", status: "completed" },
    ]);
    expect(JSON.stringify(f.events)).not.toContain("PRIVATE_SUMMARY");
  });

  it("refuses compaction during a prompt's pending native send without aborting that prompt", async () => {
    const f = await setup(); let sent!: (run: SdkRun) => void;
    spies.send.mockImplementationOnce(() => new Promise<SdkRun>(resolve => { sent = resolve; }));
    const prompting = f.adapter.prompt({ sessionId: f.sessionId, prompt: [{ type: "text", text: "Continue" }] });
    await vi.waitFor(() => expect(spies.send).toHaveBeenCalled());
    try {
      await expect(f.adapter.compactContext({ sessionId: f.sessionId })).rejects.toThrow(/current.*run|busy/i);
      expect(spies.summarize).not.toHaveBeenCalled();
    } finally { sent(run()); await prompting; }
  });

  it("refuses a second compaction while summarize is starting", async () => {
    const f = await setup(); let finish!: (run: SdkRun) => void;
    spies.summarize.mockImplementationOnce(() => new Promise<SdkRun>(resolve => { finish = resolve; }));
    const compacting = f.adapter.compactContext({ sessionId: f.sessionId });
    await vi.waitFor(() => expect(spies.summarize).toHaveBeenCalled());
    try {
      await expect(f.adapter.compactContext({ sessionId: f.sessionId })).rejects.toThrow(/current.*run|busy/i);
      expect(spies.send).not.toHaveBeenCalled();
    } finally { finish(run()); await compacting; }
  });

  it.each(["finished", "error"] as const)("waits for summary status %s before sending the next prompt", async status => {
    const f = await setup(); const finished = deferred<void>();
    const native = run();
    native.stream = async function* () {
      yield { type: "summary", status: "running" };
      await finished.promise;
      yield { type: "summary", status: status === "finished" ? "completed" : "error" };
    };
    native.wait = async () => status === "finished" ? { status } : { status, error: { message: "Synthetic summary failure" } };
    spies.summarize.mockResolvedValueOnce(native); spies.send.mockResolvedValueOnce(promptRun());
    const compacting = f.adapter.compactContext({ sessionId: f.sessionId }).catch(error => error);
    await vi.waitFor(() => expect(f.events).toHaveLength(1));
    let settled = false;
    const prompting = f.adapter.prompt({ sessionId: f.sessionId, prompt: [{ type: "text", text: "Next" }] }).catch(error => error);
    void prompting.then(() => { settled = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(spies.send).not.toHaveBeenCalled();
      finished.resolve();
      const summaryResult = await compacting;
      if (status === "error") expect(summaryResult).toBeInstanceOf(Error);
      else expect(summaryResult).toBeUndefined();
      await expect(prompting).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(spies.send).toHaveBeenCalledOnce();
      expect(f.events.at(-1)?.update).toMatchObject({ status: status === "finished" ? "completed" : "failed" });
    } finally { finished.resolve(); await compacting; await prompting; }
  });

  it("Stop cancels a prompt waiting for a running summary without sending it", async () => {
    const f = await setup(); const finished = deferred<void>();
    const native = run();
    native.stream = async function* () { yield { type: "summary", status: "running" }; await finished.promise; };
    native.cancel = vi.fn(async () => { finished.resolve(); });
    spies.summarize.mockResolvedValueOnce(native);
    const compacting = f.adapter.compactContext({ sessionId: f.sessionId });
    await vi.waitFor(() => expect(f.events).toHaveLength(1));
    const prompting = f.adapter.prompt({ sessionId: f.sessionId, prompt: [{ type: "text", text: "Next" }] }).catch(error => error);
    try {
      await f.adapter.cancel({ sessionId: f.sessionId });
      await expect(prompting).resolves.toMatchObject({ stopReason: "cancelled", response: { stopReason: "cancelled" } });
      await compacting;
      expect(spies.send).not.toHaveBeenCalled();
      expect(f.events.at(-1)?.update).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
    } finally { finished.resolve(); await compacting; await prompting; }
  });

  it("Stop releases a waiting prompt even before summarize returns its native run", async () => {
    const f = await setup(); const started = deferred<SdkRun>();
    spies.summarize.mockReturnValueOnce(started.promise);
    const compacting = f.adapter.compactContext({ sessionId: f.sessionId });
    await vi.waitFor(() => expect(spies.summarize).toHaveBeenCalled());
    const prompting = f.adapter.prompt({ sessionId: f.sessionId, prompt: [{ type: "text", text: "Next" }] }).catch(error => error);
    try {
      await f.adapter.cancel({ sessionId: f.sessionId });
      await expect(prompting).resolves.toMatchObject({ stopReason: "cancelled" });
      expect(spies.send).not.toHaveBeenCalled();
    } finally { started.resolve(run()); await compacting; await prompting; }
    expect(f.events).toEqual([]);
  });

  it("runs a prompt sent after Stop once the stopped summary unwinds, and a second Stop still cancels it", async () => {
    const f = await setup(); const started = deferred<SdkRun>();
    spies.summarize.mockReturnValueOnce(started.promise);
    const compacting = f.adapter.compactContext({ sessionId: f.sessionId });
    await vi.waitFor(() => expect(spies.summarize).toHaveBeenCalled());
    const stopped = f.adapter.prompt({ sessionId: f.sessionId, prompt: [{ type: "text", text: "Stopped" }] }).catch(error => error);
    await f.adapter.cancel({ sessionId: f.sessionId });
    await expect(stopped).resolves.toMatchObject({ stopReason: "cancelled" });
    const next = f.adapter.prompt({ sessionId: f.sessionId, prompt: [{ type: "text", text: "Next" }] }).catch(error => error);
    const again = f.adapter.prompt({ sessionId: f.sessionId, prompt: [{ type: "text", text: "Again" }] }).catch(error => error);
    let againSettled = false;
    void again.then(() => { againSettled = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      // The earlier Stop belongs to the earlier prompt; these wait for the
      // stopped summary instead of inheriting its cancellation.
      expect(againSettled).toBe(false);
      expect(spies.send).not.toHaveBeenCalled();
      await f.adapter.cancel({ sessionId: f.sessionId });
      await expect(again).resolves.toMatchObject({ stopReason: "cancelled" });
      await expect(next).resolves.toMatchObject({ stopReason: "cancelled" });
      const following = f.adapter.prompt({ sessionId: f.sessionId, prompt: [{ type: "text", text: "Following" }] }).catch(error => error);
      spies.send.mockResolvedValueOnce(promptRun());
      started.resolve(run());
      await compacting;
      await expect(following).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(spies.send).toHaveBeenCalledOnce();
    } finally { started.resolve(run()); await compacting; await next; await again; }
  });

  it("admits a new prompt before a ghost settles and counts every remaining prompt for compaction", async () => {
    const f = await setup(); const ghostFinished = deferred<{ status: string }>();
    const nextStarted = deferred<SdkRun>(); const ghost = promptRun();
    ghost.wait = vi.fn(() => ghostFinished.promise);
    spies.send.mockResolvedValueOnce(ghost).mockReturnValueOnce(nextStarted.promise);
    const first = f.adapter.prompt({ sessionId: f.sessionId, prompt: [{ type: "text", text: "Ghost" }] });
    await vi.waitFor(() => expect(ghost.wait).toHaveBeenCalled());
    const second = f.adapter.prompt({ sessionId: f.sessionId, prompt: [{ type: "text", text: "Next" }] }).catch(error => error);
    try {
      await vi.waitFor(() => expect(spies.send).toHaveBeenCalledTimes(2));
      ghostFinished.resolve({ status: "finished" });
      await expect(first).resolves.toMatchObject({ stopReason: "end_turn" });
      await expect(f.adapter.compactContext({ sessionId: f.sessionId })).rejects.toThrow(/current.*run|busy/i);
      expect(spies.summarize).not.toHaveBeenCalled();
      nextStarted.resolve(promptRun());
      await expect(second).resolves.toMatchObject({ stopReason: "end_turn" });
      await f.adapter.compactContext({ sessionId: f.sessionId });
      expect(spies.summarize).toHaveBeenCalledOnce();
    } finally { ghostFinished.resolve({ status: "finished" }); nextStarted.resolve(promptRun()); await first; await second; }
  });

  it("refuses compaction while a prompt prepares its native configuration", async () => {
    const f = await setup(); const agent = await spies.create.mock.results[0]!.value;
    const resumed = deferred<typeof agent>(); spies.create.mockReturnValueOnce(resumed.promise);
    await f.adapter.setMode({ sessionId: f.sessionId, modeId: "agent" });
    const prompting = f.adapter.prompt({ sessionId: f.sessionId, prompt: [{ type: "text", text: "Next" }] });
    await vi.waitFor(() => expect(spies.create).toHaveBeenCalledTimes(2));
    try {
      await expect(f.adapter.compactContext({ sessionId: f.sessionId })).rejects.toThrow(/current.*run|busy/i);
      expect(spies.summarize).not.toHaveBeenCalled();
      expect(spies.send).not.toHaveBeenCalled();
    } finally { resumed.resolve(agent); await prompting; }
  });

  it.each(["disposeSession", "dispose"] as const)("%s settles a published summary before fencing late completion", async action => {
    const f = await setup(); const finished = deferred<void>();
    const native = run();
    native.stream = async function* () {
      yield { type: "summary", status: "running" };
      await finished.promise;
      yield { type: "summary", status: "completed" };
    };
    spies.summarize.mockResolvedValueOnce(native);
    const compacting = f.adapter.compactContext({ sessionId: f.sessionId });
    await vi.waitFor(() => expect(f.events).toHaveLength(1));
    const opening = f.events[0]!.update;
    try {
      if (action === "disposeSession") await f.adapter.disposeSession(f.sessionId); else await f.adapter.dispose();
      expect(f.events).toHaveLength(2);
      expect(f.events.at(-1)?.update).toMatchObject({
        sessionUpdate: "tool_call_update", toolCallId: "toolCallId" in opening ? opening.toolCallId : undefined, status: "failed",
        rawOutput: { error: "Cursor stopped before confirming context compaction completed." },
      });
      expect(native.cancel).toHaveBeenCalledOnce();
    } finally { finished.resolve(); await compacting; }
    expect(f.events).toHaveLength(2);
    expect(f.events.at(-1)?.update).toMatchObject({ status: "failed" });
  });

  it.each(["cancel", "dispose"] as const)("%s retires a pending summary before it can publish or target another session", async action => {
    const f = await setup(); let finish!: (run: SdkRun) => void;
    spies.summarize.mockImplementationOnce(() => new Promise<SdkRun>(resolve => { finish = resolve; }));
    const compacting = f.adapter.compactContext({ sessionId: f.sessionId });
    await vi.waitFor(() => expect(spies.summarize).toHaveBeenCalled());
    if (action === "cancel") await f.adapter.cancel({ sessionId: f.sessionId }); else await f.adapter.dispose();
    const native = run(); finish(native); await compacting;
    expect(native.cancel).toHaveBeenCalledOnce();
    expect(f.events).toEqual([]);
  });

  it("keeps the conversation usable after the SDK refuses a conversation with no saved history", async () => {
    const f = await setup(); spies.summarize.mockRejectedValueOnce(new Error("No saved conversation to summarize."));
    await expect(f.adapter.compactContext({ sessionId: f.sessionId })).rejects.toThrow("No saved conversation");
    expect(f.events).toEqual([]);
    await f.adapter.prompt({ sessionId: f.sessionId, prompt: [{ type: "text", text: "First prompt" }] });
    expect(spies.send).toHaveBeenCalledOnce();
    await f.adapter.compactContext({ sessionId: f.sessionId });
  });

  it("does not steer a summary run, and Stop settles its unfinished row", async () => {
    const f = await setup(); let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const native = run();
    native.steer = vi.fn(async () => "complete_delivered" as const);
    native.stream = async function* () { yield { type: "summary", status: "running" }; await gate; };
    native.cancel = vi.fn(async () => { finish(); });
    spies.summarize.mockResolvedValue(native);
    const compacting = f.adapter.compactContext({ sessionId: f.sessionId });
    await vi.waitFor(() => expect(f.events).toHaveLength(1));
    try {
      expect(await f.adapter.steer({ sessionId: f.sessionId, prompt: [{ type: "text", text: "Next" }] })).toBe("queued");
      expect(native.steer).not.toHaveBeenCalled();
    } finally { await f.adapter.cancel({ sessionId: f.sessionId }); await compacting; }
    expect(f.events.at(-1)?.update).toMatchObject({ status: "failed" });
  });

  it("settles a started row and reports a native run failure", async () => {
    const f = await setup(); const native = run();
    native.stream = async function* () { yield { type: "summary", status: "running" }; };
    native.wait = async () => ({ status: "error", error: { message: "Synthetic summary failure" } });
    spies.summarize.mockResolvedValue(native);
    await expect(f.adapter.compactContext({ sessionId: f.sessionId })).rejects.toThrow("Synthetic summary failure");
    expect(f.events.at(-1)?.update).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
  });
});
