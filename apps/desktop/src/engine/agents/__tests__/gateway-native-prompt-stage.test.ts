import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../gateway";
import type { AgentAdapter, NativePromptStage } from "../types";
import type { PreparedBoundary } from "../containment/types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

const promptBlocks = [{ type: "text" as const, text: "Synthetic prompt" }];
const completed = { stopReason: "end_turn" as const, response: { stopReason: "end_turn" as const } };
const gateways: AgentGateway[] = [];
afterEach(async () => { for (const gateway of gateways.splice(0)) await gateway.dispose(); vi.restoreAllMocks(); });

function setup() {
  const gateway = new AgentGateway({ projectRoot: "/tmp/zeros-native-stage-test", executionBoundary: testExecutionBoundary(),
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

describe("trusted native prompt stage forwarding", () => {
  it("does not treat gateway dispatch as a native stage, then forwards only the native closed labels", async () => {
    const f = setup(), observer = vi.fn();
    let resolve!: (value: typeof completed) => void;
    f.prompt.mockImplementation(opts => {
      expect(observer).not.toHaveBeenCalled();
      for (const stage of ["native_write", "native_acceptance_ack", "sdk_run_created"] as const) opts.onNativePromptStage?.(stage);
      return new Promise(done => { resolve = done; });
    });
    const pending = f.gateway.prompt("fixture", "execution", promptBlocks, "turn", observer);
    void pending.catch(() => {});
    try {
      await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
      expect(observer.mock.calls).toEqual([["native_write"], ["native_acceptance_ack"], ["sdk_run_created"]]);
    } finally { resolve(completed); await pending; }
  });

  it("keeps observer failures and unknown labels out of provider behavior", async () => {
    const f = setup(), observer = vi.fn(() => { throw new Error("Synthetic observer failure"); });
    f.prompt.mockImplementation(async opts => {
      opts.onNativePromptStage?.("native_write");
      opts.onNativePromptStage?.("untrusted_label" as NativePromptStage);
      return completed;
    });
    await expect(f.gateway.prompt("fixture", "execution", promptBlocks, undefined, observer)).resolves.toEqual(completed.response);
    expect(observer).toHaveBeenCalledExactlyOnceWith("native_write");
  });

  it("ignores late callbacks after the original prompt has settled", async () => {
    const f = setup(), observer = vi.fn();
    let nativeCallback: ((stage: NativePromptStage) => void) | undefined;
    f.prompt.mockImplementation(async opts => { nativeCallback = opts.onNativePromptStage; return completed; });
    await f.gateway.prompt("fixture", "execution", promptBlocks, undefined, observer);
    expect(nativeCallback).toBeTypeOf("function");
    nativeCallback?.("native_write");
    expect(observer).not.toHaveBeenCalled();
  });

  it("rejects callbacks from a replaced boundary with the same execution/provider identity", async () => {
    const f = setup(), observer = vi.fn();
    const request = { executionId: "execution", actor: "agent-code" as const,
      cwd: "/tmp/zeros-native-stage-test", workspaceRoot: "/tmp/zeros-native-stage-test" };
    const first = await testExecutionBoundary().prepare(request);
    f.internal.executionBoundaries.set("execution", first);
    let resolve!: (value: typeof completed) => void;
    let nativeCallback: ((stage: NativePromptStage) => void) | undefined;
    f.prompt.mockImplementation(opts => { nativeCallback = opts.onNativePromptStage;
      return new Promise(done => { resolve = done; }); });
    const pending = f.gateway.prompt("fixture", "execution", promptBlocks, "turn", observer);
    void pending.catch(() => {});
    try {
      await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
      expect(nativeCallback).toBeTypeOf("function");
      f.internal.executionBoundaries.set("execution", await testExecutionBoundary().prepare(request));
      nativeCallback?.("native_write");
      expect(observer).not.toHaveBeenCalled();
    } finally { resolve(completed); await pending; await first.stopAndProve(); }
  });

  it("does not attach an observer to ordinary Local or organization-local prompts", async () => {
    const f = setup(); f.prompt.mockResolvedValue(completed);
    await f.gateway.prompt("fixture", "execution", promptBlocks, "turn");
    expect(f.prompt).toHaveBeenCalledExactlyOnceWith({ sessionId: "execution", turnId: "turn", prompt: promptBlocks });
  });
});
