import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ secret: vi.fn() }));
vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => ({ executionIdentity: { kind: "local" } }),
}));
vi.mock("../../../platform/secrets", () => ({
  getSecret: mocks.secret,
  SECRET_ACCOUNTS: {
    ANTHROPIC_API_KEY: "anthropic",
    OPENAI_API_KEY: "openai",
    CURSOR_API_KEY: "cursor",
  },
}));

describe("local provider preferences", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
      key: (index: number) => [...entries.keys()][index] ?? null,
      get length() {
        return entries.size;
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads acknowledged auth before accessing credentials and leaves native launch configuration to TOML", async () => {
    const prefs = await import("../provider-prefs");
    const outbox = await import("../../../platform/agent-preferences");
    prefs.setProviderPrefs("claude", {
      authMethod: "apiKey",
      binaryPath: "/stale/claude",
      gatewayBaseUrl: "https://stale.example",
    });
    const stop = outbox.registerAgentPreferencesFlush(async () => {
      prefs.hydrateProviderPreferences({
        claude: { auth: "cli", executable_path: "/current/claude" },
      });
    });
    try {
      expect(await prefs.deriveProviderEnv("claude")).toEqual({});
      expect(mocks.secret).not.toHaveBeenCalled();
      expect(prefs.getProviderBinaryOverride("claude")).toBeUndefined();
      expect(prefs.getProviderPrefs("claude")).toEqual({
        authMethod: "cli",
        binaryPath: "/current/claude",
      });
      prefs.hydrateProviderPreferences({});
      expect(prefs.getProviderPrefs("claude")).toEqual({ authMethod: "cli" });
    } finally {
      stop();
    }
  });

  it("does not derive credentials while the settings synchronizer is unavailable", async () => {
    const prefs = await import("../provider-prefs");
    prefs.setProviderPrefs("codex", { authMethod: "apiKey" });
    await expect(prefs.deriveProviderEnv("codex")).rejects.toThrow(
      /settings are still connecting/,
    );
    expect(mocks.secret).not.toHaveBeenCalled();
  });
});
