import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentGateway } from "../gateway";
import { seedProviderCredentials } from "../provider-credentials";
import * as probes from "../probes";
import { cloudAgentManifest } from "../registry";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

const empty = {
  claude: null,
  codex: null,
  cursor: null,
  cursorSubscription: null,
};
const providers = [
  ["claude", "ANTHROPIC_API_KEY"],
  ["codex", "OPENAI_API_KEY"],
  ["cursor", "CURSOR_API_KEY"],
] as const;
let directory: string;
let gateway: AgentGateway;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "zeros-api-key-source-"));
  vi.stubEnv("ZEROS_USER_SETTINGS_DIR", directory);
  for (const [, variable] of providers) vi.stubEnv(variable, "");
  seedProviderCredentials(empty);
  vi.spyOn(probes, "probeCliInstalled").mockResolvedValue(new Set());
  vi.spyOn(probes, "probeCliVersion").mockResolvedValue(null);
  vi.spyOn(probes, "evaluateAuthProbe").mockResolvedValue(false);
  vi.spyOn(probes, "latestAuthFileMtimeMs").mockResolvedValue(0);
  vi.spyOn(probes, "secretAccountFingerprint").mockResolvedValue(null);
  gateway = new AgentGateway({
    projectRoot: directory,
    executionBoundary: testExecutionBoundary(),
    events: {
      onSessionUpdate() {},
      onPermissionRequest() {},
      onQuestionRequest() {},
      onAgentStderr() {},
      onAgentExit() {},
    },
  });
  // This regression concerns credential selection, not provider account I/O.
  vi.spyOn(
    gateway as unknown as { fetchAccountInfo(): Promise<Map<string, never>> },
    "fetchAccountInfo",
  ).mockResolvedValue(new Map<string, never>());
});

afterEach(async () => {
  await gateway.dispose();
  seedProviderCredentials(empty);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function select(provider: string, auth: "api-key" | "subscription") {
  writeFileSync(
    path.join(directory, "settings.toml"),
    `[providers.${provider}]\nauth = "${auth}"\n`,
  );
}

async function agent(provider = "cursor") {
  return (await gateway.refreshRegistry()).find(
    (entry) => entry.id === provider,
  )!;
}

describe("registry API key source", () => {
  it.each(providers)(
    "reports an inherited %s key without exposing its value",
    async (provider, variable) => {
      select(provider, "api-key");
      vi.stubEnv(variable, "environment-fixture-key");
      const result = await agent(provider);
      expect(result).toMatchObject({
        authenticated: true,
        apiKeySource: "environment",
      });
      expect(JSON.stringify(result)).not.toContain("environment-fixture-key");
    },
  );

  it("recognizes Cursor's legacy API default without an explicit method", async () => {
    vi.stubEnv("CURSOR_API_KEY", "environment-fixture-key");
    expect(await agent()).toMatchObject({
      authenticated: true,
      apiKeySource: "environment",
    });
  });

  it.each(providers)(
    "reports the saved %s key that overrides the environment",
    async (provider, variable) => {
      select(provider, "api-key");
      vi.stubEnv(variable, "environment-fixture-key");
      seedProviderCredentials({
        ...empty,
        [provider]: { apiKey: "saved-fixture-key" },
      });
      const result = await agent(provider);
      expect(result).toMatchObject({
        authenticated: true,
        apiKeySource: "saved",
      });
      expect(JSON.stringify(result)).not.toContain("fixture-key");
    },
  );

  it("does not report an ambient key after explicit removal", async () => {
    vi.stubEnv("CURSOR_API_KEY", "environment-fixture-key");
    seedProviderCredentials({ ...empty, authMethods: { cursor: "apiKey" } });
    expect(await agent()).toMatchObject({
      authenticated: false,
      apiKeySource: "none",
    });
  });

  it("does not mislabel a subscription credential as a pasted API key", async () => {
    select("cursor", "subscription");
    vi.stubEnv("CURSOR_API_KEY", "environment-fixture-key");
    seedProviderCredentials({
      ...empty,
      cursorSubscription: { apiKey: "subscription-fixture-key" },
    });
    const result = await agent();
    expect(result.authenticated).toBe(true);
    expect(result.apiKeySource).toBeUndefined();
  });

  it("keeps key presence separate from a provider's authentication rejection", async () => {
    vi.stubEnv("CURSOR_API_KEY", "environment-fixture-key");
    expect((await agent()).authenticated).toBe(true);
    gateway.markAuthFailed("cursor");
    expect(await agent()).toMatchObject({
      authenticated: false,
      apiKeySource: "environment",
    });
  });

  it("never projects a Local key source into the cloud manifest", () => {
    vi.stubEnv("CURSOR_API_KEY", "environment-fixture-key");
    seedProviderCredentials({
      ...empty,
      cursor: { apiKey: "saved-fixture-key" },
    });
    for (const entry of cloudAgentManifest())
      expect(entry.apiKeySource).toBeUndefined();
    expect(JSON.stringify(cloudAgentManifest())).not.toContain("fixture-key");
  });
});
