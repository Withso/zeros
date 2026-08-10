import { describe, expect, it } from "vitest";

import { CODEX_CAPABILITY_OPERATIONS } from "@zeros/protocol/messages";
import {
  CODEX_PLATFORM_CAPABILITIES,
  collectCodexApps,
  collectCodexExperiments,
  collectCodexMcpServers,
  collectCodexPlugins,
  collectCodexThreadSearchResults,
  collectCodexBackgroundTerminals,
  collectCodexForkedChat,
  collectCodexGoal,
  collectCodexMarketplaceNames,
  collectCodexAccount,
  collectCodexRateLimits,
  collectCodexUsage,
  collectCodexWorkspaceMessages,
  collectCodexThreadInspection,
  collectCodexLoadedThreadIds,
  collectCodexThreadOccurrences,
  collectCodexMcpResourcePreview,
  collectCodexMcpToolPreview,
  parseCodexMcpToolArguments,
  collectCodexAccountLogin,
  collectCodexRemoteControlStatus,
  collectCodexRemoteControlClients,
  collectCodexConfigSnapshot,
  collectCodexExternalMigrationItems,
  collectCodexExternalImportHistories,
  parseCodexConfigValue,
  parseCodexConfigEdits,
  getPluginMutation,
  summarizeCapabilityResult,
} from "../codex-platform-panel";

describe("Codex platform settings surface", () => {
  it("only exposes operations reviewed by the protocol allowlist", () => {
    for (const capability of CODEX_PLATFORM_CAPABILITIES) {
      expect(CODEX_CAPABILITY_OPERATIONS).toContain(capability.operation);
    }
    expect(CODEX_CAPABILITY_OPERATIONS).not.toContain("thread.rollback");
  });

  it("turns native result collections into concise human-readable summaries", () => {
    expect(
      summarizeCapabilityResult({ data: [{ id: "a" }, { id: "b" }] }),
    ).toBe("2 items");
    expect(summarizeCapabilityResult({ account: { email: "a@b.test" } })).toBe(
      "Account available",
    );
    expect(summarizeCapabilityResult({ enabled: true })).toBe("Enabled");
    expect(summarizeCapabilityResult(null)).toBe("No data returned");
  });

  it("normalizes product collections without trusting malformed app-server data", () => {
    expect(
      collectCodexPlugins({
        marketplaces: [
          {
            name: "official",
            path: null,
            plugins: [
              { id: "browser", name: "browser", installed: false, enabled: true },
              { id: 42, name: "invalid" },
            ],
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "browser",
        marketplaceName: "official",
        installed: false,
      }),
    ]);
    expect(collectCodexApps({ data: [{ id: "figma", name: "Figma", isEnabled: true }] })).toEqual([
      expect.objectContaining({ id: "figma", name: "Figma", enabled: true }),
    ]);
    expect(
      collectCodexMcpServers({ data: [{ name: "docs", authStatus: "notLoggedIn", tools: {} }] }),
    ).toEqual([
      expect.objectContaining({ name: "docs", authStatus: "notLoggedIn", toolCount: 0 }),
    ]);
    expect(
      collectCodexExperiments({
        data: [{ name: "fast_mode", enabled: true, defaultEnabled: false, stage: "beta" }],
      }),
    ).toEqual([
      expect.objectContaining({ name: "fast_mode", enabled: true, stage: "beta" }),
    ]);
  });

  it("builds explicit install and uninstall operations for plugin rows", () => {
    expect(
      getPluginMutation({
        id: "browser@official",
        name: "browser",
        label: "Browser",
        installed: false,
        enabled: true,
        marketplaceName: "official",
        marketplacePath: null,
      }),
    ).toEqual({
      operation: "plugins.install",
      params: {
        pluginName: "browser",
        marketplacePath: null,
        remoteMarketplaceName: "official",
      },
    });
    expect(
      getPluginMutation({
        id: "browser@official",
        name: "browser",
        label: "Browser",
        installed: true,
        enabled: true,
        marketplaceName: "official",
        marketplacePath: null,
      }),
    ).toEqual({ operation: "plugins.uninstall", params: { pluginId: "browser@official" } });
  });

  it("normalizes native thread search and terminal results", () => {
    expect(
      collectCodexThreadSearchResults({
        data: [{ thread: { id: "t1", name: "Browser QA", preview: "Test login", cwd: "/repo" }, snippet: "login" }],
      }),
    ).toEqual([
      { id: "t1", title: "Browser QA", preview: "Test login", cwd: "/repo", snippet: "login" },
    ]);
    expect(
      collectCodexBackgroundTerminals({
        data: [{ processId: "p1", command: "pnpm dev", cwd: "/repo", osPid: 123 }],
      }),
    ).toEqual([
      { processId: "p1", command: "pnpm dev", cwd: "/repo", osPid: 123 },
    ]);
    expect(
      collectCodexForkedChat(
        {
          zerosChat: {
            id: "chat-fork",
            sessionId: "zeros-fork",
            nativeSessionId: "native-fork",
            title: "Browser QA (fork)",
            createdAt: 100,
            updatedAt: 100,
          },
        },
        {
          id: "chat-source",
          folder: "/repo",
          agentId: "codex",
          agentName: "Codex",
          model: "gpt-5.6-sol",
          effort: "high",
          permissionMode: "tool-approval",
          additionalDirectories: [],
          title: "Browser QA",
          createdAt: 1,
          updatedAt: 2,
        },
      ),
    ).toEqual(
      expect.objectContaining({
        id: "chat-fork",
        sessionId: "zeros-fork",
        nativeSessionId: "native-fork",
        title: "Browser QA (fork)",
      }),
    );
  });

  it("normalizes marketplace names and durable task goals", () => {
    expect(collectCodexMarketplaceNames({ marketplaces: [
      { name: "personal" }, { name: "official" }, { name: "personal" }, { name: 42 },
    ] })).toEqual(["official", "personal"]);
    expect(collectCodexGoal({ goal: {
      objective: "Ship browser integration",
      status: "active",
      tokenBudget: 50_000,
      tokensUsed: 1_250,
    } })).toEqual({
      objective: "Ship browser integration",
      status: "active",
      tokenBudget: 50_000,
      tokensUsed: 1_250,
    });
    expect(collectCodexGoal({ goal: { objective: "bad", status: "unknown" } })).toBeNull();
  });

  it("normalizes actionable account, usage, limits, and workspace state", () => {
    expect(collectCodexAccountLogin({ type: "chatgpt", loginId: "login-1", authUrl: "https://auth.example.test" })).toEqual({
      loginId: "login-1",
      authUrl: "https://auth.example.test",
    });
    expect(collectCodexAccountLogin({ type: "apiKey" })).toBeNull();
    expect(collectCodexAccount({
      account: { type: "chatgpt", email: "person@example.test", planType: "pro" },
      requiresOpenaiAuth: true,
    })).toEqual({
      type: "chatgpt",
      email: "person@example.test",
      planType: "pro",
      credentialSource: null,
      requiresOpenaiAuth: true,
    });
    expect(collectCodexAccount({ account: null, requiresOpenaiAuth: false })).toEqual({
      type: null,
      email: null,
      planType: null,
      credentialSource: null,
      requiresOpenaiAuth: false,
    });

    expect(collectCodexRateLimits({
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_780_000_000 },
          secondary: null,
        },
      },
      rateLimitResetCredits: {
        availableCount: 2,
        credits: [{ id: "credit-1", title: "Reset", expiresAt: null }],
      },
    })).toEqual({
      buckets: [{
        id: "codex",
        label: "Codex",
        primaryUsedPercent: 25,
        primaryWindowMinutes: 300,
        primaryResetsAt: 1_780_000_000,
        secondaryUsedPercent: null,
        secondaryWindowMinutes: null,
        secondaryResetsAt: null,
        reachedType: null,
      }],
      availableResetCredits: 2,
      resetCreditId: "credit-1",
    });

    expect(collectCodexUsage({
      summary: { lifetimeTokens: 1234, peakDailyTokens: 100, currentStreakDays: 3 },
      dailyUsageBuckets: [{ startDate: "2026-08-08", tokens: 42 }],
    })).toEqual({
      lifetimeTokens: 1234,
      peakDailyTokens: 100,
      longestRunningTurnSec: null,
      currentStreakDays: 3,
      longestStreakDays: null,
      latestDate: "2026-08-08",
      latestTokens: 42,
    });

    expect(collectCodexWorkspaceMessages({
      featureEnabled: true,
      messages: [{ messageId: "m1", messageType: "headline", messageBody: "Maintenance", createdAt: 123 }],
    })).toEqual([{ id: "m1", type: "headline", body: "Maintenance", createdAt: 123 }]);
  });

  it("preserves MCP startup failure and reauthentication details", () => {
    expect(collectCodexMcpServers({ data: [{
      name: "docs",
      authStatus: "notLoggedIn",
      status: "failed",
      error: "credentials expired",
      failureReason: "reauthenticationRequired",
      tools: { search: {} },
      resources: [{ uri: "docs://index" }],
    }] })).toEqual([{
      name: "docs",
      authStatus: "notLoggedIn",
      startupStatus: "failed",
      error: "credentials expired",
      failureReason: "reauthenticationRequired",
      toolCount: 1,
      resourceCount: 1,
      toolNames: ["search"],
      resourceUris: ["docs://index"],
    }]);
  });

  it("validates MCP tool arguments and renders bounded resource/tool previews", () => {
    expect(parseCodexMcpToolArguments('{"query":"browser"}')).toEqual({ query: "browser" });
    expect(() => parseCodexMcpToolArguments("[]")).toThrow("JSON object");
    expect(() => parseCodexMcpToolArguments("not json")).toThrow("valid JSON");
    expect(collectCodexMcpResourcePreview({ contents: [
      { uri: "docs://index", mimeType: "text/plain", text: "Browser docs" },
      { uri: "docs://blob", blob: "AA==" },
    ] })).toBe("Browser docs\n[Binary resource: docs://blob]");
    expect(collectCodexMcpToolPreview({
      content: [{ type: "text", text: "Found 3 results" }],
      structuredContent: { total: 3 },
      isError: false,
    })).toBe('Found 3 results\n{"total":3}');
  });

  it("summarizes native thread metadata and fully paged history", () => {
    expect(collectCodexThreadInspection(
      { thread: { id: "t1", name: "QA", preview: "Test", isPinned: true, status: { type: "idle" }, gitInfo: { branch: "santhosh" } } },
      [{ id: "turn-2" }, { id: "turn-1" }],
      [{ id: "item-1" }, { id: "item-2" }, { id: "item-3" }],
    )).toEqual({
      threadId: "t1",
      title: "QA",
      preview: "Test",
      pinned: true,
      status: "idle",
      branch: "santhosh",
      turnCount: 2,
      itemCount: 3,
    });
  });

  it("normalizes loaded native tasks and bounded occurrence search results", () => {
    expect(collectCodexLoadedThreadIds({ data: ["thread-2", "thread-1", "thread-2", 42] }))
      .toEqual(["thread-2", "thread-1"]);
    expect(collectCodexThreadOccurrences({
      data: [
        {
          turnId: "turn-1",
          itemId: "item-1",
          snippet: "Open the browser and test login",
          snippetMatchRange: { start: 9, end: 16 },
          turnCursor: "cursor-1",
        },
        { turnId: 42, snippet: "invalid" },
      ],
    })).toEqual([{
      turnId: "turn-1",
      itemId: "item-1",
      snippet: "Open the browser and test login",
      matchStart: 9,
      matchEnd: 16,
      turnCursor: "cursor-1",
    }]);
  });

  it("normalizes remote-control status and connected clients", () => {
    expect(collectCodexRemoteControlStatus({
      status: "connected",
      serverName: "Codex",
      installationId: "install-1",
      environmentId: "env-1",
    })).toEqual({
      status: "connected",
      serverName: "Codex",
      installationId: "install-1",
      environmentId: "env-1",
    });
    expect(collectCodexRemoteControlClients({ data: [{
      clientId: "client-1",
      displayName: "Santhosh's iPhone",
      deviceType: "phone",
      platform: "ios",
      osVersion: "20.0",
      deviceModel: "iPhone",
      appVersion: "1.2.3",
      lastSeenAt: "1786000000",
    }] })).toEqual([{
      clientId: "client-1",
      displayName: "Santhosh's iPhone",
      deviceType: "phone",
      platform: "ios",
      osVersion: "20.0",
      deviceModel: "iPhone",
      appVersion: "1.2.3",
      lastSeenAt: 1786000000,
    }]);
  });

  it("validates native config edits and summarizes layered configuration", () => {
    expect(parseCodexConfigValue('{"enabled":true}')).toEqual({ enabled: true });
    expect(() => parseCodexConfigValue("undefined")).toThrow("valid JSON");
    expect(parseCodexConfigEdits('[{"keyPath":"features.browser","value":true,"mergeStrategy":"upsert"}]')).toEqual([
      { keyPath: "features.browser", value: true, mergeStrategy: "upsert" },
    ]);
    expect(() => parseCodexConfigEdits('[{"keyPath":"x","mergeStrategy":"delete"}]')).toThrow("replace or upsert");
    expect(collectCodexConfigSnapshot({
      config: { model: "gpt-5.6-sol", features: { browser: true } },
      origins: { model: { name: "user", version: "v1" } },
      layers: [
        { name: "user", version: "v1", config: {}, disabledReason: null },
        { name: "project", version: "v2", config: {}, disabledReason: "policy" },
      ],
    })).toEqual({
      config: { model: "gpt-5.6-sol", features: { browser: true } },
      originCount: 1,
      layers: [
        { name: "user", version: "v1", disabledReason: null },
        { name: "project", version: "v2", disabledReason: "policy" },
      ],
    });
  });

  it("normalizes external-agent migration candidates and import history", () => {
    expect(collectCodexExternalMigrationItems({ items: [
      { itemType: "SKILLS", description: "2 Claude skills", cwd: "/repo", details: { skills: [{ name: "qa" }] } },
      { itemType: 42, description: "invalid" },
    ] })).toEqual([expect.objectContaining({
      id: "SKILLS:/repo:0",
      itemType: "SKILLS",
      description: "2 Claude skills",
      cwd: "/repo",
      detailCount: 1,
    })]);
    expect(collectCodexExternalImportHistories({
      data: [{
        importId: "import-1",
        providerId: "claude-code",
        completedAtMs: "1786000000000",
        successes: [{ itemType: "SKILLS" }],
        failures: [{ itemType: "HOOKS", message: "unsupported" }],
      }],
      connectors: [{ name: "github", sessionCount: 3, source: "remoteMcpServersConfig" }],
    })).toEqual({
      histories: [{ importId: "import-1", providerId: "claude-code", completedAtMs: 1786000000000, successCount: 1, failureCount: 1 }],
      connectors: [{ name: "github", sessionCount: 3, source: "remoteMcpServersConfig" }],
    });
  });

});
