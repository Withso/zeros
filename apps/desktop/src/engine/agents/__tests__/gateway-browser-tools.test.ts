import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentAdapter, AgentBrowserUse } from "../types";

const { acquire, enabled } = vi.hoisted(() => ({
  acquire: vi.fn(),
  enabled: vi.fn(
    (
      _workspaceRoot: string,
      _mainRepoRoot?: string,
      _provider: "codex" | "claude" = "codex",
    ) => true,
  ),
}));

vi.mock("../../browser/browser-tool-client", () => ({
  acquireZerosBrowserHost: acquire,
  browserUseEnabledForWorkspace: enabled,
  stripBrowserServiceCredentials: (env: Record<string, string> | undefined) =>
    env,
}));
vi.mock("../../git/state", () => ({
  // The mocked canonical workspace path must contain the cwd these tests pass:
  // admission refuses a cwd outside its canonical workspace before any
  // browser capability is resolved.
  getWorkspaceById: vi.fn(() => ({
    path: "/tmp",
    repoRoot: "/tmp",
  })),
  listWorkspaces: vi.fn(() => []),
}));
vi.mock("../../git/target-branch", () => ({
  resolveWorkspaceTargetRef: vi.fn(async () => null),
}));

import { AgentGateway } from "../gateway";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

describe("AgentGateway Zeros browser ownership", () => {
  beforeEach(() => {
    acquire.mockReset();
    enabled.mockReset();
    enabled.mockReturnValue(true);
  });

  it("binds Codex to the native app-server Browser host without exposing Zeros tools", async () => {
    acquire.mockResolvedValue({ browserSessionId: "browser-opaque" });
    let received: AgentBrowserUse | undefined;
    const adapter = {
      agentId: "codex",
      newSession: async (opts: {
        executionId?: string;
        browserUse?: AgentBrowserUse;
      }) => {
        received = opts.browserUse;
        return {
          session: {
            executionId: opts.executionId,
            sessionId: opts.executionId,
          },
          initialize: {},
        };
      },
    } as unknown as AgentAdapter;
    const gateway = new AgentGateway({
      projectRoot: "/tmp",
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    }) as unknown as {
      adapters: Map<string, AgentAdapter>;
      newSession(
        agentId: string,
        opts: {
          cwd: string;
          workspaceId: string;
          conversationId: string;
        },
      ): Promise<unknown>;
    };
    gateway.adapters.set("codex", adapter);

    await gateway.newSession("codex", {
      cwd: "/tmp",
      workspaceId: "workspace-zeros",
      conversationId: "conversation-zeros",
    });

    expect(acquire).toHaveBeenCalledWith({
      workspaceId: "workspace-zeros",
      conversationId: "conversation-zeros",
      workspaceRoot: "/tmp",
      mainRepoRoot: "/tmp",
    });
    expect(received).toEqual({
      kind: "codex-app-server",
      browserSessionId: "browser-opaque",
    });
    expect(acquire.mock.calls[0]?.[0]).not.toHaveProperty("executionId");
    expect(acquire.mock.calls[0]?.[0]).not.toHaveProperty("providerBinding");
  });

  it.each([
    ["claude", { kind: "claude-agent-sdk" }],
    ["cursor", undefined],
  ] as const)(
    "uses only the provider-native Browser capability for %s",
    async (agentId, expected) => {
      let received: AgentBrowserUse | undefined;
      const adapter = {
        agentId,
        newSession: async (opts: {
          executionId?: string;
          browserUse?: AgentBrowserUse;
        }) => {
          received = opts.browserUse;
          return {
            session: {
              executionId: opts.executionId,
              sessionId: opts.executionId,
            },
            initialize: {},
          };
        },
      } as unknown as AgentAdapter;
      const gateway = new AgentGateway({
        projectRoot: "/tmp",
        executionBoundary: testExecutionBoundary(),
        events: {
          onSessionUpdate: () => {},
          onPermissionRequest: () => {},
          onQuestionRequest: () => {},
          onAgentStderr: () => {},
          onAgentExit: () => {},
        },
      }) as unknown as {
        adapters: Map<string, AgentAdapter>;
        newSession(
          id: string,
          opts: {
            cwd: string;
            workspaceId: string;
            conversationId: string;
          },
        ): Promise<unknown>;
      };
      gateway.adapters.set(agentId, adapter);

      await gateway.newSession(agentId, {
        cwd: "/tmp",
        workspaceId: "workspace-zeros",
        conversationId: "conversation-zeros",
      });

      expect(received).toEqual(expected);
      expect(acquire).not.toHaveBeenCalled();
      if (agentId === "claude") {
        expect(enabled).toHaveBeenCalledWith("/tmp", "/tmp", "claude");
      }
    },
  );

  it("enables Claude's native Chrome capability for a plain-folder chat", async () => {
    let received: AgentBrowserUse | undefined;
    const adapter = {
      agentId: "claude",
      newSession: async (opts: {
        executionId?: string;
        browserUse?: AgentBrowserUse;
      }) => {
        received = opts.browserUse;
        return {
          session: {
            executionId: opts.executionId,
            sessionId: opts.executionId,
          },
          initialize: {},
        };
      },
    } as unknown as AgentAdapter;
    const gateway = new AgentGateway({
      projectRoot: "/tmp",
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    }) as unknown as {
      adapters: Map<string, AgentAdapter>;
      newSession(id: string, opts: { cwd: string }): Promise<unknown>;
    };
    gateway.adapters.set("claude", adapter);

    await gateway.newSession("claude", { cwd: "/tmp" });

    expect(enabled).toHaveBeenCalledWith("/tmp", undefined, "claude");
    expect(received).toEqual({ kind: "claude-agent-sdk" });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("reconciles Claude's latest Chrome switch before an unbound first prompt", async () => {
    enabled.mockReturnValue(false);
    const updateBrowserUse = vi.fn();
    const prompt = vi.fn(async () => ({
      stopReason: "end_turn",
      response: { stopReason: "end_turn" },
    }));
    const adapter = {
      agentId: "claude",
      newSession: async (opts: { executionId?: string }) => ({
        session: {
          executionId: opts.executionId,
          sessionId: opts.executionId,
        },
        initialize: {},
      }),
      updateBrowserUse,
      prompt,
    } as unknown as AgentAdapter;
    const gateway = new AgentGateway({
      projectRoot: "/tmp",
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    }) as unknown as {
      adapters: Map<string, AgentAdapter>;
      newSession(
        id: string,
        opts: { cwd: string },
      ): Promise<{
        executionId?: string;
        sessionId: string;
      }>;
      prompt(
        id: string,
        sessionId: string,
        blocks: Array<{ type: "text"; text: string }>,
      ): Promise<unknown>;
    };
    gateway.adapters.set("claude", adapter);

    const created = await gateway.newSession("claude", { cwd: "/tmp" });
    enabled.mockReturnValue(true);
    const executionId = created.executionId ?? created.sessionId;
    await gateway.prompt("claude", executionId, [
      { type: "text", text: "Open the browser" },
    ]);

    expect(updateBrowserUse).toHaveBeenCalledWith({
      sessionId: executionId,
      browserUse: { kind: "claude-agent-sdk" },
    });
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("fails Claude Chrome closed but still sends when the latest policy cannot be read", async () => {
    enabled.mockReturnValueOnce(true).mockImplementation(() => {
      throw new Error("settings temporarily unavailable");
    });
    const updateBrowserUse = vi.fn();
    const prompt = vi.fn(async () => ({
      stopReason: "end_turn",
      response: { stopReason: "end_turn" },
    }));
    const stderr = vi.fn();
    const adapter = {
      agentId: "claude",
      newSession: async (opts: { executionId?: string }) => ({
        session: {
          executionId: opts.executionId,
          sessionId: opts.executionId,
        },
        initialize: {},
      }),
      updateBrowserUse,
      prompt,
    } as unknown as AgentAdapter;
    const gateway = new AgentGateway({
      projectRoot: "/tmp",
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: stderr,
        onAgentExit: () => {},
      },
    }) as unknown as {
      adapters: Map<string, AgentAdapter>;
      newSession(
        id: string,
        opts: { cwd: string },
      ): Promise<{
        executionId?: string;
        sessionId: string;
      }>;
      prompt(
        id: string,
        sessionId: string,
        blocks: Array<{ type: "text"; text: string }>,
      ): Promise<unknown>;
    };
    gateway.adapters.set("claude", adapter);

    const created = await gateway.newSession("claude", { cwd: "/tmp" });
    const executionId = created.executionId ?? created.sessionId;
    await gateway.prompt("claude", executionId, [
      { type: "text", text: "Continue without browser access" },
    ]);

    expect(updateBrowserUse).toHaveBeenCalledWith({ sessionId: executionId });
    expect(prompt).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(
      "claude",
      expect.stringContaining("settings temporarily unavailable"),
    );
  });

  it("resolves each provider's Browser switch independently", async () => {
    enabled.mockImplementation((_root, _mainRoot, provider) => {
      return provider === "claude";
    });
    const received = new Map<string, AgentBrowserUse | undefined>();
    const gateway = new AgentGateway({
      projectRoot: "/tmp",
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    }) as unknown as {
      adapters: Map<string, AgentAdapter>;
      newSession(
        id: string,
        opts: {
          cwd: string;
          workspaceId: string;
          conversationId: string;
        },
      ): Promise<unknown>;
    };
    for (const agentId of ["codex", "claude"]) {
      gateway.adapters.set(agentId, {
        agentId,
        newSession: async (opts: {
          executionId?: string;
          browserUse?: AgentBrowserUse;
        }) => {
          received.set(agentId, opts.browserUse);
          return {
            session: {
              executionId: opts.executionId,
              sessionId: opts.executionId,
            },
            initialize: {},
          };
        },
      } as unknown as AgentAdapter);
      await gateway.newSession(agentId, {
        cwd: "/tmp",
        workspaceId: `workspace-${agentId}`,
        conversationId: `conversation-${agentId}`,
      });
    }

    expect(received.get("codex")).toBeUndefined();
    expect(received.get("claude")).toEqual({ kind: "claude-agent-sdk" });
    expect(enabled.mock.calls.map((call) => call[2])).toEqual([
      "codex",
      "claude",
    ]);
    expect(acquire).not.toHaveBeenCalled();
  });
});
