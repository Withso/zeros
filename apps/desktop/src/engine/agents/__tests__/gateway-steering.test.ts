import { describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../gateway";
import { AgentSessionToolRegistry } from "../session-tools";

describe("gateway steering admission", () => {
  it.each(["claude", "codex", "cursor"])("returns %s preparation failures to the editable queue", async agentId => {
    const steer = vi.fn();
    const context = {
      awaitAdapterStartupSettled: async () => {},
      adapterForSession: () => ({ agentId, steer }),
      sessionTools: { preparePrompt: async () => { throw new Error("preparation failed"); } },
    };
    await expect(Reflect.apply(AgentGateway.prototype.steer, context, [
      agentId, "execution", [{ type: "text", text: "C" }], () => true,
    ])).resolves.toBe("queued");
    expect(steer).not.toHaveBeenCalled();
  });

  it.each(["cancel", "stop", "dispose"] as const)("settles preparation on %s without waiting for discovery", async action => {
    let finish!: (value: string) => void;
    const preparePrompt = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const tools = {
      env: {}, mcpServers: [], preparePrompt,
      revoke: vi.fn(), dispose: vi.fn(async () => {}),
    };
    const sessionTools = new AgentSessionToolRegistry(async () => tools);
    await sessionTools.admit({ executionId: "execution", cwd: "/workspace" }, [], {});
    const steer = vi.fn();
    const settled = vi.fn();
    const context = {
      awaitAdapterStartupSettled: async () => {},
      adapterForSession: () => ({ agentId: "claude", steer }),
      sessionTools,
    };
    const receipt = Reflect.apply(AgentGateway.prototype.steer, context, [
      "claude", "execution", [{ type: "text", text: "C" }], () => true,
    ]).then(settled);
    await vi.waitFor(() => expect(preparePrompt).toHaveBeenCalledOnce());
    if (action === "dispose") await sessionTools.dispose();
    else await sessionTools[action]("execution");
    try {
      await vi.waitFor(() => expect(settled).toHaveBeenCalledExactlyOnceWith("queued"), { timeout: 200 });
      expect(steer).not.toHaveBeenCalled();
    } finally {
      finish("late instructions");
      await receipt;
      await sessionTools.dispose();
    }
    expect(steer).not.toHaveBeenCalled();
  });

  it("rechecks the accepting turn after startup admission before resolving an adapter", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapterForSession = vi.fn(() => {
      throw new Error("stale adapter must not be used");
    });
    const context = {
      awaitAdapterStartupSettled: () => gate,
      adapterForSession,
    };
    let current = true;
    const receipt = Reflect.apply(AgentGateway.prototype.steer, context, [
      "claude",
      "execution",
      [{ type: "text", text: "C" }],
      () => current,
    ]);
    const result = expect(receipt).resolves.toBe("queued");
    current = false;
    release();
    await result;
    expect(adapterForSession).not.toHaveBeenCalled();
  });
});
