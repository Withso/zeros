import { describe, expect, it, vi } from "vitest";
import {
  AgentSessionToolRegistry,
  composeAgentSessionToolFactories,
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
  it("isolates cancelled preparation and resumes only for a new prompt", async () => {
    let finish!: (value: string) => void;
    const first = {
      ...resource(),
      preparePrompt: vi.fn(() => new Promise<string>(resolve => { finish = resolve; })),
    };
    const second = { ...resource(), preparePrompt: vi.fn(async () => "other instructions") };
    const registry = new AgentSessionToolRegistry(async ({ executionId }) => executionId === "one" ? first : second);
    await registry.admit({ executionId: "one", cwd: "/a" }, [], {});
    await registry.admit({ executionId: "two", cwd: "/b" }, [], {});
    const pending = registry.preparePrompt("one");
    const rejected = expect(pending).rejects.toThrow(/abort/i);
    await vi.waitFor(() => expect(first.preparePrompt).toHaveBeenCalledOnce());
    registry.cancel("one");
    await rejected;
    await expect(registry.preparePrompt("one")).rejects.toThrow(/abort/i);
    await expect(registry.preparePrompt("two")).resolves.toBe("other instructions");
    finish("obsolete instructions");
    first.preparePrompt.mockResolvedValue("new instructions");
    registry.beginPrompt("one");
    await expect(registry.preparePrompt("one")).resolves.toBe("new instructions");
    expect(first.preparePrompt).toHaveBeenCalledTimes(2);
    await registry.dispose();
  });

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

  it("settles the turn for the exact execution and never lets a failure escape", async () => {
    const first = { ...resource(), endPrompt: vi.fn(async () => { throw new Error("handoff failed"); }) };
    const second = { ...resource(), endPrompt: vi.fn() };
    const registry = new AgentSessionToolRegistry(async ({ executionId }) =>
      executionId === "one" ? first : second,
    );
    await registry.admit({ executionId: "one", cwd: "/a" }, [], {});
    await registry.admit({ executionId: "two", cwd: "/b" }, [], {});
    await expect(registry.endPrompt("one")).resolves.toBeUndefined();
    expect(first.endPrompt).toHaveBeenCalledOnce();
    expect(second.endPrompt).not.toHaveBeenCalled();
    await expect(registry.endPrompt("missing")).resolves.toBeUndefined();
    await registry.dispose();
  });

  it("settles a turn only after every overlapping prompt for that execution has ended", async () => {
    const tools = { ...resource(), beginPrompt: vi.fn(), endPrompt: vi.fn() };
    const registry = new AgentSessionToolRegistry(async () => tools);
    await registry.admit({ executionId: "one", cwd: "/a" }, [], {});
    registry.beginPrompt("one");
    // A rejected double-send begins and ends while the first turn still runs.
    registry.beginPrompt("one");
    await registry.endPrompt("one");
    expect(tools.endPrompt).not.toHaveBeenCalled();
    await registry.endPrompt("one");
    expect(tools.endPrompt).toHaveBeenCalledOnce();
    await registry.dispose();
  });
});

describe("composed session tools", () => {
  const input = { executionId: "run", cwd: "/w", signal: new AbortController().signal };
  const named = (name: string, envName: string) => ({
    env: { [envName]: `Bearer ${name}` },
    mcpServers: [{ name, transport: "http" as const, url: `http://127.0.0.1:1/${name}`, headersFromEnv: { Authorization: envName } }],
    revoke: vi.fn(),
    dispose: vi.fn(async () => {}),
  });

  it("merges every admitted owner and fans out each lifecycle hook", async () => {
    const design = { ...named("design-draft", "DESIGN_CAP"), preparePrompt: vi.fn(async () => "design rules"), beginPrompt: vi.fn(), cancel: vi.fn(), suspend: vi.fn(() => vi.fn()) };
    const control = { ...named("zeros_browser", "CONTROL_CAP"), preparePrompt: vi.fn(() => ""), endPrompt: vi.fn(), cancel: vi.fn() };
    const factory = composeAgentSessionToolFactories([async () => design, async () => null, async () => control]);
    const tools = (await factory(input))!;
    expect(tools.env).toEqual({ DESIGN_CAP: "Bearer design-draft", CONTROL_CAP: "Bearer zeros_browser" });
    expect(tools.mcpServers.map((server) => server.name)).toEqual(["design-draft", "zeros_browser"]);
    await expect(tools.preparePrompt?.()).resolves.toBe("design rules");
    tools.beginPrompt?.();
    tools.cancel?.();
    await tools.endPrompt?.();
    const resume = tools.suspend?.();
    resume?.();
    expect(design.beginPrompt).toHaveBeenCalledOnce();
    expect(design.cancel).toHaveBeenCalledOnce();
    expect(control.cancel).toHaveBeenCalledOnce();
    expect(control.endPrompt).toHaveBeenCalledOnce();
    expect(design.suspend.mock.results[0]?.value).toHaveBeenCalledOnce();
    tools.revoke();
    expect(design.revoke).toHaveBeenCalledOnce();
    expect(control.revoke).toHaveBeenCalledOnce();
    await tools.dispose();
    expect(design.dispose).toHaveBeenCalledOnce();
    expect(control.dispose).toHaveBeenCalledOnce();
  });

  it("returns null when no owner admits tools", async () => {
    await expect(composeAgentSessionToolFactories([async () => null])(input)).resolves.toBeNull();
  });

  it("retires already-admitted owners when another owner fails or collides", async () => {
    const design = named("design-draft", "DESIGN_CAP");
    const failing = composeAgentSessionToolFactories([async () => design, async () => { throw new Error("boom"); }]);
    await expect(failing(input)).rejects.toThrow("boom");
    expect(design.revoke).toHaveBeenCalled();
    expect(design.dispose).toHaveBeenCalledOnce();

    const left = named("zeros_browser", "SAME_CAP");
    const right = named("zeros_computer", "SAME_CAP");
    await expect(composeAgentSessionToolFactories([async () => left, async () => right])(input)).rejects.toThrow(/same/i);
    expect(left.dispose).toHaveBeenCalledOnce();
    expect(right.dispose).toHaveBeenCalledOnce();
  });
});
