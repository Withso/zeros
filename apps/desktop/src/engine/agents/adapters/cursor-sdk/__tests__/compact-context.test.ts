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

  it("refuses a second compaction and another prompt while summarize is starting", async () => {
    const f = await setup(); let finish!: (run: SdkRun) => void;
    spies.summarize.mockImplementationOnce(() => new Promise<SdkRun>(resolve => { finish = resolve; }));
    const compacting = f.adapter.compactContext({ sessionId: f.sessionId });
    await vi.waitFor(() => expect(spies.summarize).toHaveBeenCalled());
    try {
      await expect(f.adapter.compactContext({ sessionId: f.sessionId })).rejects.toThrow(/current.*run|busy/i);
      await expect(f.adapter.prompt({ sessionId: f.sessionId, prompt: [{ type: "text", text: "Next" }] })).rejects.toThrow(/compact|busy/i);
      expect(spies.send).not.toHaveBeenCalled();
    } finally { finish(run()); await compacting; }
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
