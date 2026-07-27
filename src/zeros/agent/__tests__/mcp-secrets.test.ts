import { describe, it, expect } from "vitest";

import {
  MCP_SECRET_SENTINEL,
  isSecretRef,
  looksSecretEnvName,
  mcpSecretAccount,
  secretEnvNamesFromDoc,
} from "../mcp-secrets";

describe("mcp-secrets helpers", () => {
  it("mcpSecretAccount keys by env var name under the allowlisted mcp:: prefix", () => {
    expect(mcpSecretAccount("GITHUB_TOKEN")).toBe("mcp::GITHUB_TOKEN");
    // Explicit user scope = the historical account shape (existing Keychain
    // entries keep working).
    expect(mcpSecretAccount("GITHUB_TOKEN", { kind: "user" })).toBe(
      "mcp::GITHUB_TOKEN",
    );
  });

  it("repo-scope accounts key by NORMALIZED main repo root, so two repos can hold different values for one name", () => {
    const a = mcpSecretAccount("GITHUB_TOKEN", {
      kind: "repo",
      repoRoot: "/Users/dev/proj-a",
    });
    const b = mcpSecretAccount("GITHUB_TOKEN", {
      kind: "repo",
      repoRoot: "/Users/dev/proj-b",
    });
    expect(a).not.toBe(b);
    expect(a.startsWith("mcp::repo::")).toBe(true); // stays inside the allowlisted mcp:: prefix
    expect(a.endsWith("::GITHUB_TOKEN")).toBe(true);
    // Trailing-slash variants normalize to the same account.
    expect(
      mcpSecretAccount("GITHUB_TOKEN", {
        kind: "repo",
        repoRoot: "/Users/dev/proj-a/",
      }),
    ).toBe(a);
  });

  it("isSecretRef matches only the sentinel", () => {
    expect(isSecretRef(MCP_SECRET_SENTINEL)).toBe(true);
    expect(isSecretRef("real-value")).toBe(false);
    expect(isSecretRef(undefined)).toBe(false);
  });

  it("collects distinct sentinel'd env var names across all servers", () => {
    const names = secretEnvNamesFromDoc({
      mcp: {
        servers: [
          { name: "gh", transport: "stdio", command: "npx", env: { GITHUB_TOKEN: MCP_SECRET_SENTINEL, LOG: "debug" } },
          { name: "sl", transport: "stdio", command: "npx", env: { SLACK_TOKEN: MCP_SECRET_SENTINEL } },
          { name: "dup", transport: "stdio", command: "npx", env: { GITHUB_TOKEN: MCP_SECRET_SENTINEL } },
          { name: "http", transport: "http", url: "https://x/mcp" },
        ],
      },
    });
    expect(names.sort()).toEqual(["GITHUB_TOKEN", "SLACK_TOKEN"]);
  });

  it("looksSecretEnvName flags token-shaped names (adopt-wizard auto-Keychain)", () => {
    for (const n of ["GITHUB_TOKEN", "API_KEY", "OPENAI_API_KEY", "DB_PASSWORD", "AUTH_SECRET", "ACCESS_KEY", "MY_KEY"]) {
      expect(looksSecretEnvName(n)).toBe(true);
    }
    for (const n of ["LOG_LEVEL", "ROOT", "PORT", "DEBUG", "NODE_ENV"]) {
      expect(looksSecretEnvName(n)).toBe(false);
    }
  });

  it("NEVER scans `headers` — an HTTP header secret must not leak into the agent's process env", () => {
    // Invariant: the env courier carries stdio `env` only. An http server's
    // header secret rides the gateway connection (not the process env), so a
    // sentinel in `headers` must NOT be picked up here — otherwise it would be
    // injected into every agent's env (readable by every tool it runs).
    const names = secretEnvNamesFromDoc({
      mcp: {
        servers: [
          { name: "h", transport: "http", url: "https://x/mcp", headers: { Authorization: MCP_SECRET_SENTINEL } },
        ],
      },
    });
    expect(names).toEqual([]);
  });

  it("returns [] for missing / malformed docs (never throws)", () => {
    expect(secretEnvNamesFromDoc(undefined)).toEqual([]);
    expect(secretEnvNamesFromDoc(null)).toEqual([]);
    expect(secretEnvNamesFromDoc({})).toEqual([]);
    expect(secretEnvNamesFromDoc({ mcp: { servers: "nope" } })).toEqual([]);
    expect(secretEnvNamesFromDoc({ mcp: { servers: [{ env: "bad" }, 7, null] } })).toEqual([]);
  });
});
