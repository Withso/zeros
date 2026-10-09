import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorSdkAdapter, type CursorSdkSendOptions } from "../adapter";
import type { AgentAdapterContext } from "../../../types";

const sdk = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn() }));
vi.mock("@cursor/sdk", () => ({ Agent: { create: sdk.create, resume: vi.fn(), list: vi.fn() },
  Cursor: { models: { list: vi.fn(async () => []) } }, JsonlLocalAgentStore: class { runs = { get: async () => null }; },
  getDefaultSdkStateRoot: () => "/synthetic-cursor-output-state" }));
const adapters: CursorSdkAdapter[] = [];
beforeEach(() => {
  vi.stubEnv("CURSOR_API_KEY", ""); vi.stubEnv("CURSOR_RIPGREP_PATH", "/usr/bin/rg");
  sdk.create.mockReset().mockResolvedValue({ agentId: "native", send: sdk.send, close() {} }); sdk.send.mockReset();
});
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.dispose(); vi.unstubAllEnvs(); });
async function setup() {
  const ctx: AgentAdapterContext = { projectRoot: "/tmp/cursor-output-fixture", sessionDirRoot: "/tmp/cursor-output-sessions",
    mcpServers: [], emit: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } };
  const adapter = new CursorSdkAdapter(ctx); adapters.push(adapter);
  const { session } = await adapter.newSession({ cwd: ctx.projectRoot, env: { CURSOR_API_KEY: "synthetic" } });
  return { adapter, sessionId: session.sessionId };
}
function run(onStream: () => Promise<void>) {
  return { id: "native-run", stream: async function* () { await onStream(); yield { type: "status", status: "FINISHED" }; },
    wait: async () => ({ status: "finished" }), cancel: async () => {} };
}
const blocks = [{ type: "text" as const, text: "Synthetic" }];
describe("Cursor original native SDK output", () => {
  it.each(["text", "tool"] as const)("observes %s from the original send delta, never from gateway dispatch", async kind => {
    const f = await setup(), output = vi.fn(), stages = vi.fn();
    let callbacks!: CursorSdkSendOptions;
    sdk.send.mockImplementation(async (_message, options) => {
      callbacks = options; expect(output).not.toHaveBeenCalled();
      return run(async () => { await callbacks.onDelta?.({ update: kind === "text"
        ? { type: "text-delta", text: "Actual SDK text" }
        : { type: "tool-call-started", callId: "read", toolCall: { type: "read", args: { path: "file" } } } }); });
    });
    await f.adapter.prompt({ sessionId: f.sessionId, turnId: "turn", prompt: blocks, onNativeOutput: output, onNativePromptStage: stages });
    expect(output).toHaveBeenCalledExactlyOnceWith(kind); expect(stages).not.toHaveBeenCalled();
    expect(callbacks).not.toHaveProperty("onNativeOutput");
  });
  it("excludes empty/malformed text, thought, guidance, child/background and control packets", async () => {
    const f = await setup(), output = vi.fn();
    sdk.send.mockImplementation(async (_message, options: CursorSdkSendOptions) => run(async () => {
      for (const update of [{ type: "text-delta", text: "" }, { type: "text-delta", text: 1 },
        { type: "thinking-delta", text: "Reasoning" }, { type: "guidance", text: "Instructions" }, { type: "status", status: "RUNNING" },
        { type: "tool-call-delta", callId: "child", taskUpdate: { type: "text-delta", text: "Child" } },
        { type: "tool-call-started", callId: "", toolCall: { type: "read" } },
        { type: "tool-call-started", callId: "read", toolCall: { type: "" } }]) await options.onDelta?.({ update });
    }));
    await f.adapter.prompt({ sessionId: f.sessionId, prompt: blocks, onNativeOutput: output }); expect(output).not.toHaveBeenCalled();
  });
  it("does not count a late prior native run callback while a newer warm send is active", async () => {
    const f = await setup(), first = vi.fn(), second = vi.fn();
    let prior!: CursorSdkSendOptions;
    sdk.send.mockImplementationOnce(async (_message, options) => { prior = options; return run(async () => {}); });
    await f.adapter.prompt({ sessionId: f.sessionId, turnId: "turn-1", prompt: blocks, onNativeOutput: first });
    sdk.send.mockImplementationOnce(async (_message, options: CursorSdkSendOptions) => run(async () => {
      await prior.onDelta?.({ update: { type: "text-delta", text: "Old background output" } });
      await options.onDelta?.({ update: { type: "text-delta", text: "Current output" } });
    }));
    await f.adapter.prompt({ sessionId: f.sessionId, turnId: "turn-2", prompt: blocks, onNativeOutput: second });
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledExactlyOnceWith("text");
  });
  it("keeps output observer errors inert and late disposed callbacks silent", async () => {
    const f = await setup(), output = vi.fn(() => { throw new Error("Synthetic observer error"); });
    let callbacks!: CursorSdkSendOptions;
    sdk.send.mockImplementation(async (_message, options) => { callbacks = options; return run(async () => {
      await options.onDelta?.({ update: { type: "text-delta", text: "Actual text" } });
    }); });
    await expect(f.adapter.prompt({ sessionId: f.sessionId, prompt: blocks, onNativeOutput: output })).resolves.toMatchObject({ stopReason: "end_turn" });
    await f.adapter.dispose(); await callbacks.onDelta?.({ update: { type: "text-delta", text: "Late" } });
    expect(output).toHaveBeenCalledExactlyOnceWith("text");
  });
});
