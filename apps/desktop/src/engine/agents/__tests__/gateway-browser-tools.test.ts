import { beforeEach, describe, expect, it, vi } from "vitest";

import { BROWSER_TOOL_DEFINITIONS } from "@zeros/protocol/browser-tools";
import type { AgentAdapter, AgentBrowserTools } from "../types";

const { acquire } = vi.hoisted(() => ({ acquire: vi.fn() }));

vi.mock("../../browser/browser-tool-client", () => ({
  acquireZerosBrowserTools: acquire,
  stripBrowserServiceCredentials: (env: Record<string, string> | undefined) =>
    env,
}));
vi.mock("../../git/state", () => ({
  getWorkspaceById: vi.fn(() => ({
    path: "/tmp/zeros-workspace-root",
    repoRoot: "/tmp",
  })),
}));
vi.mock("../../git/target-branch", () => ({
  resolveWorkspaceTargetRef: vi.fn(async () => null),
}));

import { AgentGateway } from "../gateway";

describe("AgentGateway Zeros browser ownership", () => {
  beforeEach(() => acquire.mockReset());

  it("passes an opaque conversation-owned binding without provider identity", async () => {
    const browserTools: AgentBrowserTools = {
      browserSessionId: "browser-opaque",
      definitions: BROWSER_TOOL_DEFINITIONS,
      execute: vi.fn(),
    };
    acquire.mockResolvedValue(browserTools);
    let received: AgentBrowserTools | undefined;
    const adapter = {
      agentId: "codex",
      newSession: async (opts: {
        executionId?: string;
        browserTools?: AgentBrowserTools;
      }) => {
        received = opts.browserTools;
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
      workspaceRoot: "/tmp/zeros-workspace-root",
      mainRepoRoot: "/tmp",
    });
    expect(received).toBe(browserTools);
    expect(acquire.mock.calls[0]?.[0]).not.toHaveProperty("executionId");
    expect(acquire.mock.calls[0]?.[0]).not.toHaveProperty("providerBinding");
  });
});
