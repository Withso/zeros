import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../gateway";
import type { AgentAdapter, NativePromptOutputKind } from "../types";
import type { PreparedBoundary } from "../containment/types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

const blocks = [{ type: "text" as const, text: "Synthetic" }];
const completed = { stopReason: "end_turn" as const, response: { stopReason: "end_turn" as const } };
const gateways: AgentGateway[] = [];
afterEach(async () => { for (const gateway of gateways.splice(0)) await gateway.dispose(); });
function setup() {
  const gateway = new AgentGateway({ projectRoot: "/tmp/zeros-output-fixture", executionBoundary: testExecutionBoundary(),
    events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} } });
  gateways.push(gateway);
  const prompt = vi.fn<AgentAdapter["prompt"]>();
  const internal = gateway as unknown as { adapters: Map<string, AgentAdapter>; executionToAgent: Map<string, string>;
    executionBoundaries: Map<string, PreparedBoundary> };
  const unused = async () => { throw new Error("Unexpected adapter startup in prompt fixture"); };
  const adapter: AgentAdapter = { agentId: "fixture", initialize: unused, newSession: unused, loadSession: unused, listSessions: unused,
    cancel: async () => {}, prompt, disposeSession: async () => {}, dispose: async () => {} };
  internal.adapters.set("fixture", adapter);
  internal.executionToAgent.set("execution", "fixture");
  return { gateway, prompt, internal };
}
describe("original native prompt output observer", () => {
  it("keeps the trusted original frame arrival sample through a delayed ownership ACK", async () => {
    const f = setup(), output = vi.fn();
    f.prompt.mockImplementation(async opts => {
      // The native producer observed this original frame at40ms, and only
      // proved its ownership at200ms. Gateway must not resample it as200.
      opts.onNativeOutput?.("text", 40);
      return completed;
    });
    await f.gateway.prompt("fixture", "execution", blocks, "turn", undefined, output);
    expect(output).toHaveBeenCalledExactlyOnceWith("text", 40);
  });
  it("forwards only explicit text/tool observations, independently of credential-use stage", async () => {
    const f = setup(), output = vi.fn(), stage = vi.fn();
    f.prompt.mockImplementation(async opts => {
      expect(output).not.toHaveBeenCalled();
      opts.onNativeOutput?.("text"); opts.onNativeOutput?.("tool");
      opts.onNativeOutput?.("thought" as NativePromptOutputKind);
      return completed;
    });
    await f.gateway.prompt("fixture", "execution", blocks, "turn", stage, output);
    expect(output.mock.calls).toEqual([["text"], ["tool"]]); expect(stage).not.toHaveBeenCalled();
  });
  it("does not relabel a prior turn callback as the newer warm turn", async () => {
    const f = setup(), first = vi.fn(), second = vi.fn();
    let prior: AgentAdapter["prompt"] extends (opts: infer P) => unknown ? P : never;
    f.prompt.mockImplementationOnce(async opts => { prior = opts; return completed; });
    await f.gateway.prompt("fixture", "execution", blocks, "turn-1", undefined, first);
    f.prompt.mockImplementationOnce(async opts => {
      prior.onNativeOutput?.("text"); opts.onNativeOutput?.("tool"); return completed;
    });
    await f.gateway.prompt("fixture", "execution", blocks, "turn-2", undefined, second);
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledExactlyOnceWith("tool");
  });
  it("fences replaced execution/boundary ownership and keeps observer failures inert", async () => {
    const f = setup(), output = vi.fn(() => { throw new Error("Synthetic observer failure"); });
    f.prompt.mockImplementation(async opts => {
      opts.onNativeOutput?.("text"); f.internal.executionToAgent.set("execution", "replacement");
      opts.onNativeOutput?.("tool"); return completed;
    });
    await expect(f.gateway.prompt("fixture", "execution", blocks, "turn", undefined, output)).resolves.toEqual(completed.response);
    expect(output).toHaveBeenCalledExactlyOnceWith("text");
  });
  it("preserves ordinary Personal Local and organization-local prompt options", async () => {
    const f = setup(); f.prompt.mockResolvedValue(completed);
    await f.gateway.prompt("fixture", "execution", blocks, "turn");
    expect(f.prompt).toHaveBeenCalledExactlyOnceWith({ sessionId: "execution", turnId: "turn", prompt: blocks });
  });
});
