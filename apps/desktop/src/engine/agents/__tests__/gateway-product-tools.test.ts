import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../gateway";
import type { AgentAdapter } from "../types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";
import type { AgentSessionTools } from "../session-tools";
import { ConversationDesignTools } from "../../design/conversation-tools";

describe("native Code product tool admission", () => {
  let root: string;
  let gateway: AgentGateway;
  let admitted: AgentSessionTools[];
  let starts: Array<{
    executionId?: string;
    env?: Record<string, string>;
    mcpServers?: unknown[];
  }>;
  let failStart: boolean;
  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-product-tools-")),
    );
    starts = [];
    admitted = [];
    failStart = false;
    gateway = new AgentGateway({
      projectRoot: root,
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate() {},
        onPermissionRequest() {},
        onQuestionRequest() {},
        onAgentStderr() {},
        onAgentExit() {},
      },
      sessionToolFactory: async (input) => {
        expect(input.agentId).toBe("fixture");
        expect(input.conversationId).toBe("durable-chat");
        const tools = {
          env: { TEST_SESSION_TOOL_AUTHORITY: input.executionId },
          mcpServers: [
            {
              name: "product-tool",
              transport: "http" as const,
              url: "http://127.0.0.1:49321/mcp",
            },
          ],
          revoke: vi.fn(),
          dispose: vi.fn(async () => {}),
          preparePrompt: vi.fn(() => "<system_instruction>Current composer mode: Design.</system_instruction>"),
          cancel: vi.fn(),
          endPrompt: vi.fn(async () => {}),
        };
        admitted.push(tools);
        return tools;
      },
    });
    const adapter = {
      agentId: "fixture",
      newSession: async (options: (typeof starts)[number]) => {
        starts.push(options);
        if (failStart) throw new Error("Provider failed");
        return {
          session: {
            sessionId: options.executionId,
            executionId: options.executionId,
          },
          initialize: {},
        };
      },
      loadSession: async (options: (typeof starts)[number]) => {
        starts.push(options);
        return { modes: { currentModeId: "default", availableModes: [] } };
      },
      disposeSession: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({ response: { stopReason: "end_turn" } })),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as AgentAdapter;
    (
      gateway as unknown as { adapters: Map<string, AgentAdapter> }
    ).adapters.set("fixture", adapter);
  });
  afterEach(async () => {
    await gateway.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("admits tools for new and resumed Code sessions without selecting the Design actor", async () => {
    const created = await gateway.newSession("fixture", {
      cwd: root,
      conversationId: "durable-chat",
    });
    expect(gateway.sessionActor(created.executionId)).toBe("agent-code");
    expect(starts[0]!.env?.TEST_SESSION_TOOL_AUTHORITY).toBe(
      created.executionId,
    );
    expect(starts[0]!.mcpServers).toContainEqual(
      expect.objectContaining({ name: "product-tool" }),
    );
    await gateway.endSession("fixture", created.executionId);
    expect(admitted[0]!.revoke).toHaveBeenCalled();
    expect(admitted[0]!.dispose).toHaveBeenCalledOnce();
    const resumed = await gateway.loadSession("fixture", "provider-session", {
      cwd: root,
      conversationId: "durable-chat",
    });
    expect(gateway.sessionActor(resumed.executionId!)).toBe("agent-code");
    expect(starts[1]!.env?.TEST_SESSION_TOOL_AUTHORITY).toBe(
      resumed.executionId,
    );
    expect(resumed.executionId).not.toBe(created.executionId);
    expect(admitted[1]!.dispose).not.toHaveBeenCalled();
  });

  it("revokes and closes tools when provider startup fails", async () => {
    failStart = true;
    await expect(
      gateway.newSession("fixture", {
        cwd: root,
        conversationId: "durable-chat",
      }),
    ).rejects.toThrow("Provider failed");
    expect(admitted[0]!.revoke).toHaveBeenCalled();
    expect(admitted[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("refreshes product instructions on every native prompt and fences tools on Stop", async () => {
    const created = await gateway.newSession("fixture", { cwd: root, conversationId: "durable-chat" });
    const adapter = (gateway as unknown as { adapters: Map<string, AgentAdapter> }).adapters.get("fixture")!;
    await gateway.prompt("fixture", created.executionId, [{ type: "text", text: "Create a page" }]);
    expect(adapter.prompt).toHaveBeenLastCalledWith(expect.objectContaining({
      prompt: expect.arrayContaining([{ type: "text", text: "<system_instruction>Current composer mode: Design.</system_instruction>" }]),
    }));
    await gateway.prompt("fixture", created.executionId, [{ type: "text", text: "Continue" }]);
    expect(admitted[0]!.preparePrompt).toHaveBeenCalledTimes(2);
    await gateway.cancel("fixture", created.executionId);
    expect(admitted[0]!.cancel).toHaveBeenCalledOnce();
    expect(admitted[0]!.dispose).not.toHaveBeenCalled();
  });

  it("settles product tools after every native prompt, including failed ones", async () => {
    const created = await gateway.newSession("fixture", { cwd: root, conversationId: "durable-chat" });
    const adapter = (gateway as unknown as { adapters: Map<string, AgentAdapter> }).adapters.get("fixture")!;
    await gateway.prompt("fixture", created.executionId, [{ type: "text", text: "Open the site" }]);
    expect(admitted[0]!.endPrompt).toHaveBeenCalledOnce();
    vi.mocked(adapter.prompt).mockRejectedValueOnce(new Error("Provider failed"));
    await expect(
      gateway.prompt("fixture", created.executionId, [{ type: "text", text: "Again" }]),
    ).rejects.toThrow("Provider failed");
    expect(admitted[0]!.endPrompt).toHaveBeenCalledTimes(2);
    expect(admitted[0]!.dispose).not.toHaveBeenCalled();
  });
});

describe("native Code prompts across Design directory transitions", () => {
  let root: string;
  let gateway: AgentGateway;
  let adapter: AgentAdapter;
  const unsettled = async () => {
    for (let turn = 0; turn < 5; turn += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
  };
  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-product-transition-")),
    );
    gateway = new AgentGateway({
      projectRoot: root,
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate() {},
        onPermissionRequest() {},
        onQuestionRequest() {},
        onAgentStderr() {},
        onAgentExit() {},
      },
      sessionToolFactory: async () => {
        const design = new ConversationDesignTools({
          mode: {
            get: () => ({ mode: "code", revision: 0 }),
            set: () => {
              throw new Error("unused");
            },
          },
          assertOwner: () => {},
          resolveTarget: async () => null,
        });
        return {
          env: {},
          mcpServers: [],
          preparePrompt: () => design.preparePrompt(),
          beginPrompt: () => design.beginPrompt(),
          cancel: () => design.cancel(),
          suspend: () => design.suspend(),
          revoke: () => design.dispose(),
          dispose: async () => design.dispose(),
        };
      },
    });
    adapter = {
      agentId: "fixture",
      newSession: async (options: { executionId?: string }) => ({
        session: {
          sessionId: options.executionId,
          executionId: options.executionId,
        },
        initialize: {},
      }),
      disposeSession: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({ response: { stopReason: "end_turn" } })),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as AgentAdapter;
    (
      gateway as unknown as { adapters: Map<string, AgentAdapter> }
    ).adapters.set("fixture", adapter);
  });
  afterEach(async () => {
    await gateway.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("holds a prompt while every workspace's grants are suspended, then sends it", async () => {
    const created = await gateway.newSession("fixture", {
      cwd: root,
      conversationId: "branch-review",
      workspaceId: "ws_sending-owner",
    });
    // A registry-wide owner change suspends grants in every workspace.
    const resume = gateway.suspendSessionTools();
    const pending = gateway.prompt("fixture", created.executionId, [
      { type: "text", text: "/review the branch changes" },
    ]);
    const outcome = vi.fn();
    pending.then(
      () => outcome("sent"),
      (error: unknown) => outcome(error),
    );
    await unsettled();
    expect(outcome).not.toHaveBeenCalled();
    expect(adapter.prompt).not.toHaveBeenCalled();
    resume();
    await expect(pending).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(adapter.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("Current composer mode: Code"),
          }),
        ]),
      }),
    );
  });

  it("does not hold a prompt for another workspace's lifecycle", async () => {
    const created = await gateway.newSession("fixture", {
      cwd: root,
      conversationId: "branch-review",
      workspaceId: "ws_sending-owner",
    });
    const resume = gateway.suspendSessionTools("ws_archived-owner");
    try {
      await expect(
        gateway.prompt("fixture", created.executionId, [
          { type: "text", text: "/review the branch changes" },
        ]),
      ).resolves.toMatchObject({ stopReason: "end_turn" });
    } finally {
      resume();
    }
  });
});
