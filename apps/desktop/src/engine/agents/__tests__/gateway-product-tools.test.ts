import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../gateway";
import type { AgentAdapter } from "../types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";
import type { AgentSessionTools } from "../session-tools";

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
});
