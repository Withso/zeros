// A Local connection change is re-derived through the same projection a new
// spawn uses, from the private host seed: API key → saved account → CLI login →
// replacement API key, each reaching the live execution without a reconnect.

import { afterEach, describe, expect, it, vi } from "vitest";
import { seedProviderCredentials } from "../provider-credentials";
import { AgentGateway } from "../gateway";
import type { AgentAdapter, ProviderCredentialUpdate } from "../types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

const CONNECTION_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
];
const UNSET_PROFILES = { claude: null, codex: null, cursor: null };

function seed(selection: {
  method: "apiKey" | "account" | "cli";
  apiKey?: string;
  configDir?: string;
}) {
  expect(
    seedProviderCredentials({
      claude: selection.apiKey ? { apiKey: selection.apiKey } : null,
      codex: null,
      cursor: null,
      cursorSubscription: null,
      authMethods: { claude: selection.method },
      accountProfiles: selection.configDir
        ? {
            ...UNSET_PROFILES,
            claude: {
              id: "00000000-0000-4000-8000-00000000000b",
              revision: 1,
              state: "connected",
              configDir: selection.configDir,
            },
          }
        : UNSET_PROFILES,
    }),
  ).toBe(true);
}

afterEach(() => {
  seed({ method: "cli" });
  vi.unstubAllEnvs();
});

describe("Local provider connection projection", () => {
  it("hands the live execution exactly what a new spawn would receive", async () => {
    // The ambient shell must not leak into the projection under test.
    for (const name of CONNECTION_ENV) vi.stubEnv(name, undefined);
    seed({ method: "apiKey", apiKey: "first-fixture-key" });
    const gateway = new AgentGateway({
      projectRoot: "/tmp/zeros-connection-projection",
      executionBoundary: testExecutionBoundary(),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    const updates: ProviderCredentialUpdate[] = [];
    const internals = gateway as unknown as {
      adapters: Map<string, AgentAdapter>;
      executionToAgent: Map<string, string>;
      executionToCwd: Map<string, string>;
      executionAuthFingerprint: Map<string, string>;
      providerAuthConfigFingerprint: (agentId: string) => string;
    };
    internals.adapters.set("claude", {
      agentId: "claude",
      prompt: async () => ({ response: { stopReason: "end_turn" } }),
      dispose: async () => {},
      capabilityPorts: {
        runtimeConfiguration: {
          updateCredentials: async (update: ProviderCredentialUpdate) => {
            updates.push(update);
          },
        },
      },
    } as unknown as AgentAdapter);
    internals.executionToAgent.set("live", "claude");
    internals.executionToCwd.set("live", "/tmp/zeros-connection-projection");
    internals.executionAuthFingerprint.set("live", internals.providerAuthConfigFingerprint("claude"));
    const send = () => gateway.prompt("claude", "live", [{ type: "text", text: "next" }]);
    const blankedTokens = { ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "" };
    try {
      await send();
      expect(updates).toHaveLength(0);

      seed({ method: "account", apiKey: "first-fixture-key", configDir: "/tmp/zeros-connection-projection/account-b" });
      await send();
      expect(updates.at(-1)?.env).toEqual({
        ANTHROPIC_API_KEY: "",
        ...blankedTokens,
        CLAUDE_CONFIG_DIR: "/tmp/zeros-connection-projection/account-b",
      });

      seed({ method: "cli", apiKey: "first-fixture-key" });
      await send();
      // Leaving the account removes its root: the CLI uses its own login.
      expect(updates.at(-1)?.env).toEqual({ ANTHROPIC_API_KEY: "", ...blankedTokens });
      expect(updates.at(-1)?.keys).toContain("CLAUDE_CONFIG_DIR");

      seed({ method: "apiKey", apiKey: "replacement-fixture-key" });
      await send();
      expect(updates.at(-1)?.env).toEqual({
        ANTHROPIC_API_KEY: "replacement-fixture-key",
        ...blankedTokens,
      });
      expect(updates).toHaveLength(3);
    } finally {
      await gateway.dispose();
    }
  });
});
