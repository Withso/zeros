import { describe, expect, it, vi } from "vitest";
import {
  readClaudeSessionTools,
  claudeSessionPluginGroup,
} from "../session-tools";

describe("Claude session tool connections", () => {
  it("groups apps by verified provider provenance while leaving native browser and imported MCPs separate", async () => {
    const query = {
      mcpServerStatus: vi.fn().mockResolvedValue([
        {
          name: "claude.ai local-name",
          status: "connected",
          scope: "local",
          config: { type: "http", url: "SECRET" },
        },
        { name: "claude-in-chrome", status: "connected" },
        {
          name: "Calendar",
          status: "needs-auth",
          scope: "claudeai",
          config: { type: "claudeai-proxy", id: "calendar", url: "SECRET" },
        },
        {
          name: "Never connected",
          status: "needs-auth",
          scope: "claudeai",
          config: { type: "claudeai-proxy", id: "catalogue", url: "SECRET" },
        },
      ]),
    };
    const result = await readClaudeSessionTools(query, {
      includeInventory: true,
      plugins: claudeSessionPluginGroup([
        { name: "Helper", path: "/private/plugin" },
      ]),
      readConnectorMembership: vi.fn().mockResolvedValue({
        memberships: new Map([
          ["calendar", "connected"],
          ["catalogue", "not-connected"],
        ]),
        complete: true,
      }),
    });
    expect(query.mcpServerStatus).toHaveBeenCalledOnce();
    expect(
      result.groups?.find((group) => group.kind === "apps")?.entries,
    ).toEqual([
      expect.objectContaining({ name: "Calendar", status: "needs-auth" }),
    ]);
    expect(
      result.groups?.find((group) => group.kind === "mcp")?.entries,
    ).toHaveLength(3);
    expect(
      result.groups?.find((group) => group.kind === "plugins")?.entries[0],
    ).toMatchObject({ name: "Helper", status: "loaded" });
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET|private\/plugin|Never connected|canAuthenticate/,
    );
  });

  it("does not turn a missing plugin receipt into an empty loaded-plugin inventory", () => {
    expect(claudeSessionPluginGroup(undefined).state).toBe("unsupported");
    expect(claudeSessionPluginGroup([])).toEqual({
      kind: "plugins",
      state: "ready",
      entries: [],
    });
    const group = claudeSessionPluginGroup([
      { name: "Helper", path: "/private/plugin" },
      { name: "Incomplete" },
    ]);
    expect(group.state).toBe("partial");
    expect(group.entries).toHaveLength(1);
    expect(JSON.stringify(group)).not.toContain("/private/");
  });
  it("excludes never-connected catalogue entries but keeps connected account services with errors", async () => {
    const cloud = (id: string, status: string) => ({
      name: `claude.ai ${id}`,
      scope: "claudeai",
      config: { type: "claudeai-proxy", id, url: "https://example.com/mcp" },
      status,
    });
    const result = await readClaudeSessionTools(
      {
        mcpServerStatus: vi
          .fn()
          .mockResolvedValue([
            { name: "claude-in-chrome", status: "connected" },
            { name: "imported", status: "failed" },
            cloud("unconnected", "needs-auth"),
            cloud("unconnected-error", "failed"),
            cloud("working", "connected"),
            cloud("expired", "needs-auth"),
            cloud("offline", "failed"),
            cloud("starting", "pending"),
          ]),
      },
      {
        readConnectorMembership: vi.fn().mockResolvedValue({
          memberships: new Map([
            ["unconnected", "not-connected"],
            ["unconnected-error", "not-connected"],
            ["working", "connected"],
            ["expired", "connected"],
            ["offline", "connected"],
            ["starting", "connected"],
          ]),
          complete: true,
        }),
      },
    );
    expect(result.state).toBe("ready");
    expect(result.entries.map((entry) => [entry.name, entry.status])).toEqual([
      ["claude-in-chrome", "connected"],
      ["imported", "error"],
      ["claude.ai working", "connected"],
      ["claude.ai expired", "needs-auth"],
      ["claude.ai offline", "error"],
      ["claude.ai starting", "connecting"],
    ]);
  });

  it("does not call a known unconnected catalogue an account discovery failure", async () => {
    const result = await readClaudeSessionTools(
      {
        mcpServerStatus: vi.fn().mockResolvedValue([
          {
            name: "catalogue",
            status: "needs-auth",
            scope: "claudeai",
            config: { type: "claudeai-proxy", id: "catalogue", url: "SECRET" },
          },
        ]),
      },
      {
        readConnectorMembership: vi.fn().mockResolvedValue({
          memberships: new Map([["catalogue", "not-connected"]]),
          complete: true,
        }),
      },
    );
    expect(result).toEqual({ state: "ready", entries: [] });
  });

  it("keeps verified errors and local tools when account membership is temporarily unavailable", async () => {
    const result = await readClaudeSessionTools(
      {
        mcpServerStatus: vi.fn().mockResolvedValue([
          { name: "imported", status: "failed" },
          {
            name: "known",
            status: "failed",
            config: { type: "claudeai-proxy", id: "known", url: "SECRET" },
          },
          {
            name: "unknown",
            status: "needs-auth",
            config: { type: "claudeai-proxy", id: "unknown", url: "SECRET" },
          },
        ]),
      },
      {
        readConnectorMembership: vi.fn().mockResolvedValue({
          memberships: new Map([["known", "connected"]]),
          complete: false,
        }),
      },
    );
    expect(result).toMatchObject({
      state: "partial",
      entries: [
        { name: "imported", status: "error" },
        { name: "known", status: "error" },
      ],
      detail: expect.stringContaining("connected services"),
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("bounds a stalled account read without losing confirmed imported connections", async () => {
    vi.useFakeTimers();
    try {
      const pending = readClaudeSessionTools({
        mcpServerStatus: vi
          .fn()
          .mockResolvedValue([{ name: "imported", status: "connected" }]),
        accountInfo: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({
        state: "partial",
        entries: [{ name: "imported", status: "connected" }],
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled status read and clears its timers", async () => {
    vi.useFakeTimers();
    try {
      const pending = readClaudeSessionTools({
        mcpServerStatus: vi
          .fn()
          .mockImplementation(() => new Promise(() => {})),
        accountInfo: vi.fn().mockResolvedValue({ tokenSource: "none" }),
      });
      const rejected = expect(pending).rejects.toThrow(
        "Tool status timed out.",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains missing subscription login while retaining imported MCP status", async () => {
    const result = await readClaudeSessionTools({
      mcpServerStatus: vi
        .fn()
        .mockResolvedValue([{ name: "imported", status: "connected" }]),
      accountInfo: vi.fn().mockResolvedValue({
        tokenSource: "none",
        apiProvider: "firstParty",
        email: "SECRET",
      }),
    });
    expect(result).toMatchObject({
      state: "partial",
      detail: expect.stringContaining("Sign in to Claude Code"),
      entries: [{ name: "imported", status: "connected" }],
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it.each([
    {
      tokenSource: "none",
      apiKeySource: "ANTHROPIC_API_KEY",
      apiProvider: "firstParty",
    },
    { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" },
    { apiProvider: "bedrock" },
  ])(
    "explains credentials that cannot establish account connector access: %j",
    async (account) => {
      const result = await readClaudeSessionTools({
        mcpServerStatus: vi.fn().mockResolvedValue([]),
        accountInfo: vi.fn().mockResolvedValue(account),
      });
      expect(result).toMatchObject({
        state: "partial",
        detail: expect.stringContaining("subscription login"),
        entries: [],
      });
    },
  );

  it("does not certify an empty account while cloud discovery may still be pending", async () => {
    const result = await readClaudeSessionTools({
      mcpServerStatus: vi.fn().mockResolvedValue([]),
      accountInfo: vi.fn().mockResolvedValue({
        tokenSource: "/login",
        apiProvider: "firstParty",
      }),
    });
    expect(result).toMatchObject({
      state: "partial",
      detail: expect.stringContaining("not reported"),
      entries: [],
    });
  });

  it("keeps a confirmed cloud connection authoritative even if account metadata is unavailable", async () => {
    const result = await readClaudeSessionTools({
      mcpServerStatus: vi
        .fn()
        .mockResolvedValue([
          { name: "cloud", scope: "claudeai", status: "connected" },
        ]),
      accountInfo: vi.fn().mockRejectedValue(new Error("SECRET")),
    });
    expect(result).toMatchObject({
      state: "ready",
      entries: [{ name: "cloud", status: "connected" }],
    });
    expect(result.detail).toBeUndefined();
  });

  it("does not suggest signing in when account connectors are intentionally excluded", async () => {
    const result = await readClaudeSessionTools(
      {
        mcpServerStatus: vi.fn().mockResolvedValue([]),
        accountInfo: vi.fn().mockResolvedValue({ tokenSource: "none" }),
      },
      { accountConnectorsEnabled: false },
    );
    expect(result).toEqual({ state: "ready", entries: [] });
  });

  it("reports live connections without inventing a browser login API or leaking config/errors", async () => {
    const result = await readClaudeSessionTools({
      mcpServerStatus: vi.fn().mockResolvedValue([
        {
          name: "cloud",
          status: "connected",
          config: { type: "claudeai-proxy", url: "SECRET" },
        },
        { name: "login", status: "needs-auth", error: "SECRET" },
        { name: "pending", status: "pending" },
        { name: "bad", status: "failed" },
        { name: "disabled", status: "disabled" },
      ]),
    });
    expect(result.entries.map((e) => [e.name, e.status])).toEqual([
      ["cloud", "connected"],
      ["login", "needs-auth"],
      ["pending", "connecting"],
      ["bad", "error"],
    ]);
    expect(result.entries.some((e) => e.canAuthenticate)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
