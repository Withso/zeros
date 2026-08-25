import { describe, expect, it } from "vitest";

import { ClaudeSdkAdapter } from "../adapters/claude-sdk/adapter";
import { CodexAppServerAdapter } from "../adapters/codex/app-server-adapter";
import { CursorSdkAdapter } from "../adapters/cursor-sdk/adapter";
import type { AgentAdapterContext } from "../types";

function context(): AgentAdapterContext {
  return {
    projectRoot: "/tmp/zeros-capability-contract",
    sessionDirRoot: "/tmp/zeros-capability-contract/sessions",
    mcpServers: [],
    emit: {
      onSessionUpdate: () => undefined,
      onPermissionRequest: () => undefined,
      onQuestionRequest: () => undefined,
      onAgentStderr: () => undefined,
      onAgentExit: () => undefined,
    },
  };
}

describe("pinned harness capability contracts", () => {
  it("advertises Codex behavior through Zeros domains", async () => {
    const initialize = await new CodexAppServerAdapter(context()).initialize();
    const domains = initialize.agentCapabilities?.domains;

    expect(initialize.agentCapabilities?.loadSession).toBe(true);
    expect(domains?.conversation.fork.implementation).toBe("harness-native");
    expect(domains?.browser.nativeSession.implementation).toBe(
      "harness-native",
    );
    expect(domains?.interaction.permissionResponse.implementation).toBe(
      "harness-native",
    );
    expect(domains?.interaction.questionResponse.implementation).toBe(
      "harness-native",
    );
    expect(domains?.backgroundWork.stopTask).toEqual({
      implementation: "harness-native",
      availability: "available",
      requirements: ["live-session"],
    });
    expect(initialize.authMethods?.[0]?.type).toBe("terminal");
  });

  it("advertises Claude behavior without claiming native fork", async () => {
    const initialize = await new ClaudeSdkAdapter(context()).initialize();
    const domains = initialize.agentCapabilities?.domains;

    expect(domains?.conversation.fork.implementation).toBe("unavailable");
    expect(domains?.browser.nativeSession.implementation).toBe(
      "harness-native",
    );
    expect(domains?.backgroundWork.stopTask.implementation).toBe(
      "harness-native",
    );
    expect(domains?.turn.contextCompaction.implementation).toBe(
      "harness-native",
    );
    expect(domains?.interaction.permissionResponse.implementation).toBe(
      "harness-native",
    );
    expect(initialize.authMethods?.[0]?.type).toBe("terminal");
  });

  it("omits unsupported Cursor response channels instead of installing no-ops", async () => {
    const adapter = new CursorSdkAdapter(context());
    const initialize = await adapter.initialize();
    const domains = initialize.agentCapabilities?.domains;

    expect("respondToPermission" in adapter).toBe(false);
    expect("respondToQuestion" in adapter).toBe(false);
    expect(domains?.interaction.permissionResponse.implementation).toBe(
      "unavailable",
    );
    expect(domains?.interaction.questionResponse.implementation).toBe(
      "unavailable",
    );
    expect(domains?.browser.nativeSession.implementation).toBe("unavailable");
    expect(domains?.account.validateApiKey.implementation).toBe(
      "harness-native",
    );
    expect(initialize.authMethods?.[0]).toMatchObject({
      type: "env_var",
      vars: [{ name: "CURSOR_API_KEY", secret: true }],
    });
  });
});
