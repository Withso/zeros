import { describe, expect, it, vi } from "vitest";

import { AgentGateway } from "../gateway";
import type { AgentAdapter } from "../types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

function fixture(backend: "zeros-srt" | "cloud-worker") {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const pending = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  const order: string[] = [];
  const gateway = new AgentGateway({
    projectRoot: "/tmp/zeros-dispose-order",
    executionBoundary: { ...testExecutionBoundary(), backend },
    events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} },
  });
  const warmDispose = vi.fn(() => { order.push("warm"); return pending; });
  const internals = gateway as unknown as {
    warmSessionBoundariesInstance: { dispose(): Promise<void> };
    adapters: Map<string, AgentAdapter>;
  };
  internals.warmSessionBoundariesInstance = { dispose: warmDispose };
  internals.adapters.set("contained", { agentId: "contained", dispose: async () => { order.push("adapter"); } } as unknown as AgentAdapter);
  const retire = vi.spyOn(gateway, "retirePooledUtilityBoundaries").mockImplementation(async () => { order.push("utility"); });
  return { gateway, order, warmDispose, retire, resolve, reject };
}

describe.each(["zeros-srt", "cloud-worker"] as const)("gateway disposal order (%s)", (backend) => {
  it("awaits pending warm disposal before retiring utilities and adapters", async () => {
    const f = fixture(backend);
    const disposing = f.gateway.dispose();
    try {
      await vi.waitFor(() => expect(f.warmDispose).toHaveBeenCalledOnce());
      expect(f.order).toEqual(["warm"]);
      expect(f.retire).not.toHaveBeenCalled();
    } finally {
      f.resolve();
      await disposing;
    }
    expect(f.order).toEqual(["warm", "utility", "adapter"]);
  });

  it("reports warm disposal failure after retiring utilities and adapters", async () => {
    const f = fixture(backend);
    const failure = new Error("warm retirement refused");
    const result = f.gateway.dispose().then(() => null, error => error as unknown);
    try {
      await vi.waitFor(() => expect(f.warmDispose).toHaveBeenCalledOnce());
      expect(f.retire).not.toHaveBeenCalled();
    } finally {
      f.reject(failure);
    }
    const error = await result;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([failure]);
    expect(f.order).toEqual(["warm", "utility", "adapter"]);
  });
});
