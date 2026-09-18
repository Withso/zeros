import { describe, expect, it, vi } from "vitest";
import {
  AgentSessionToolRegistry,
  type AgentSessionTools,
} from "../session-tools";

const server = {
  name: "design-draft",
  transport: "http" as const,
  url: "http://127.0.0.1:4321/mcp",
  headersFromEnv: { Authorization: "TEST_PRODUCT_BEARER" },
};
function resource() {
  return {
    env: { TEST_PRODUCT_BEARER: "test-only" },
    mcpServers: [server],
    revoke: vi.fn(),
    dispose: vi.fn(async () => {}),
  } satisfies AgentSessionTools;
}

describe("session tool ownership", () => {
  it("merges a reserved product server with ordinary user MCP and keeps credentials per execution", async () => {
    const tools = resource();
    const factory = vi.fn(async () => tools);
    const registry = new AgentSessionToolRegistry(factory);
    const env = { USER_SETTING: "retained" };
    const userServer = {
      name: "user-tools",
      transport: "http" as const,
      url: "https://example.invalid/mcp",
    };
    const result = await registry.admit(
      {
        executionId: "run-1",
        cwd: "/workspace",
        workspaceId: "owner",
        conversationId: "chat",
      },
      [{ ...userServer, name: "design-draft" }, userServer],
      env,
    );
    expect(result).toEqual([server, userServer]);
    expect(env).toEqual({
      USER_SETTING: "retained",
      TEST_PRODUCT_BEARER: "test-only",
    });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "run-1",
        workspaceId: "owner",
        conversationId: "chat",
      }),
    );
    const stop = registry.stop("run-1");
    expect(tools.revoke).toHaveBeenCalled();
    await stop;
    expect(tools.dispose).toHaveBeenCalledTimes(1);
    await registry.dispose();
  });

  it.each(["stop", "abort", "dispose"] as const)(
    "retires a late admission after %s without publishing its environment",
    async (action) => {
      const tools = resource();
      let finish!: (value: AgentSessionTools) => void;
      const ready = new Promise<AgentSessionTools>((resolve) => {
        finish = resolve;
      });
      const registry = new AgentSessionToolRegistry(async () => ready);
      const signal = new AbortController();
      const env = {};
      const pending = registry
        .admit(
          { executionId: "run-1", cwd: "/workspace", signal: signal.signal },
          [],
          env,
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      await Promise.resolve();
      const stopped =
        action === "dispose"
          ? registry.dispose()
          : action === "stop"
            ? registry.stop("run-1")
            : (signal.abort(), Promise.resolve());
      finish(tools);
      await stopped;
      expect(await pending).toBeInstanceOf(Error);
      expect(env).toEqual({});
      expect(tools.revoke).toHaveBeenCalled();
      expect(tools.dispose).toHaveBeenCalledTimes(1);
      await registry.dispose();
    },
  );

  it("keeps an unrelated execution alive and closes every resource even if one teardown fails", async () => {
    const first = resource();
    const second = resource();
    const registry = new AgentSessionToolRegistry(async ({ executionId }) =>
      executionId === "one" ? first : second,
    );
    await registry.admit({ executionId: "one", cwd: "/a" }, [], {});
    await registry.admit({ executionId: "two", cwd: "/b" }, [], {});
    first.dispose.mockRejectedValueOnce(new Error("teardown failed"));
    await expect(registry.dispose()).rejects.toThrow("retire");
    expect(first.revoke).toHaveBeenCalled();
    expect(second.dispose).toHaveBeenCalledTimes(1);
    await expect(
      registry.admit({ executionId: "three", cwd: "/a" }, [], {}),
    ).rejects.toThrow("cancelled");
  });

  it("cancels tools admitted after Stop and only resumes them at a new prompt", async () => {
    const tools = { ...resource(), cancel: vi.fn(), beginPrompt: vi.fn() };
    let ready!: (value: AgentSessionTools) => void;
    const registry = new AgentSessionToolRegistry(() => new Promise((resolve) => { ready = resolve; }));
    const pending = registry.admit({ executionId: "late", cwd: "/workspace" }, [], {});
    await Promise.resolve();
    registry.cancel("late");
    ready(tools);
    await pending;
    expect(tools.cancel).toHaveBeenCalledOnce();
    expect(tools.revoke).not.toHaveBeenCalled();
    registry.beginPrompt("late");
    expect(tools.beginPrompt).toHaveBeenCalledOnce();
    await registry.dispose();
  });
});
