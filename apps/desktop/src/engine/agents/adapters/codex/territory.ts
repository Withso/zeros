import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

import type { AgentFilesystemTerritory } from "../../types";
import { buildSpawnEnvWithLoginPath } from "../shared/login-shell-path";
import { resolveCodexBinary } from "./binary-resolver";
import type { JsonValue } from "./generated/serde_json/JsonValue";

const execFileAsync = promisify(execFile);

/** Private profile id injected into each territory-bound app-server thread. */
export const CODEX_CODE_TERRITORY_PROFILE = "zeros_code_territory";

function protectedPaths(territory: AgentFilesystemTerritory): string[] {
  if (territory.agentRole !== "code") {
    throw new Error("Codex Design territory requires a code actor.");
  }
  const workspaceRoot = path.resolve(territory.workspaceRoot);
  const output = new Set<string>([
    path.resolve(territory.designDirectory),
    ...territory.protectedDesignDirectories.map((candidate) =>
      path.resolve(candidate),
    ),
  ]);
  for (const candidate of territory.writeCapabilities.deniedPaths) {
    const absolute = path.resolve(candidate);
    const relative = path.relative(workspaceRoot, absolute);
    // A policy directory outside the writable root is already read-only. Do
    // not add it as a runtime workspace root, which would accidentally widen
    // read authority merely to restate that fact.
    if (
      !relative ||
      relative === "." ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      continue;
    }
    output.add(absolute);
  }
  return [...output].sort();
}

function protectedFilesystemEntries(
  territory: AgentFilesystemTerritory,
): Record<string, "read"> {
  return Object.fromEntries(
    protectedPaths(territory).map((absolute) => [absolute, "read"] as const),
  );
}

/** Thread-scoped, highest-precedence config. A more-specific `read` entry
 * carves the Design subtree out of the workspace's `write` entry. Exact paths
 * (not globs) have equivalent enforcement on Seatbelt and Linux bubblewrap. */
export function codexTerritoryConfig(
  territory: AgentFilesystemTerritory,
  mcpServerNames: readonly string[] = [],
): Record<string, JsonValue> {
  const disabledMcp = Object.fromEntries(
    mcpServerNames
      .filter((name) => /^[A-Za-z0-9_-]+$/.test(name))
      .map((name) => [name, { enabled: false }]),
  );
  return {
    permissions: {
      [CODEX_CODE_TERRITORY_PROFILE]: {
        description: "Zeros code actor: workspace write with Design read-only",
        workspace_roots: { [path.resolve(territory.workspaceRoot)]: true },
        filesystem: {
          ":minimal": "read",
          ":workspace_roots": "write",
          ...protectedFilesystemEntries(territory),
        },
        // Design containment is a filesystem/authority boundary, not an
        // offline mode. Engine credentials are stripped and MCP/app surfaces
        // are disabled below; preserve the coding agent's normal network use.
        network: { enabled: true },
      },
    },
    // These surfaces can invoke host-authority code independently of the
    // shell/apply-patch sandbox. The coding agent does not need them while a
    // protected Design territory exists; future design orchestration is a
    // separate Zeros capability, not an MCP/file mutation backdoor.
    features: {
      apps: false,
      browser_use: false,
      code_mode: false,
      computer_use: false,
      hooks: false,
      image_generation: false,
      in_app_browser: false,
      js_repl: false,
      multi_agent: false,
      plugins: false,
      remote_plugin: false,
      skill_mcp_dependency_install: false,
      collab: false,
      connectors: false,
      enable_mcp_apps: false,
      multi_agent_v2: false,
      recommended_plugins: false,
      request_permissions: false,
      request_permissions_tool: false,
      skill_search: false,
      tool_call_mcp_elicitation: false,
      tool_search: false,
    },
    ...(Object.keys(disabledMcp).length > 0
      ? { mcp_servers: disabledMcp }
      : {}),
  };
}

function escapeTomlString(value: string): string {
  let escaped = "";
  for (const char of value) {
    switch (char) {
      case "\\":
        escaped += "\\\\";
        break;
      case '"':
        escaped += '\\"';
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\t":
        escaped += "\\t";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case "\f":
        escaped += "\\f";
        break;
      default: {
        const code = char.charCodeAt(0);
        escaped +=
          code <= 8 || code === 11 || (code >= 14 && code <= 31) || code === 127
            ? `\\u${code.toString(16).padStart(4, "0")}`
            : char;
      }
    }
  }
  return escaped;
}

/** Single TOML override used by the admission probe. Keeping it identical in
 * meaning to `codexTerritoryConfig` prevents a parse-only probe from proving a
 * weaker profile than the live thread receives. */
export function codexTerritoryProfileOverride(
  territory: AgentFilesystemTerritory,
): string {
  const protectedEntries = Object.keys(protectedFilesystemEntries(territory))
    .map((absolute) => `"${escapeTomlString(absolute)}"="read"`)
    .join(",");
  return (
    `permissions.${CODEX_CODE_TERRITORY_PROFILE}={` +
    `description="Zeros code actor: workspace write with Design read-only",` +
    `workspace_roots={"${escapeTomlString(path.resolve(territory.workspaceRoot))}"=true},` +
    `filesystem={":minimal"="read",":workspace_roots"="write",` +
    `${protectedEntries}},network={enabled=true}}`
  );
}

export interface CodexTerritoryCommandResult {
  stdout: string;
  stderr: string;
}

/** Run one command under the exact profile used by live Codex threads. This is
 * shared by admission and the adversarial release gate so tests cannot prove a
 * look-alike sandbox while production uses something else. */
export async function runCodexTerritoryCommand(
  territory: AgentFilesystemTerritory,
  commandArgs: readonly string[],
  opts: { cliBinary?: string; timeoutMs?: number } = {},
): Promise<CodexTerritoryCommandResult> {
  const binary = await resolveCodexBinary({ override: opts.cliBinary });
  if (binary.source !== "bundled") {
    throw new Error(
      "Codex Design containment requires the Codex runtime pinned and " +
        "shipped with this Zeros build; custom and PATH runtimes are not qualified.",
    );
  }
  const [command, baseArgs] = binary.path.endsWith(".js")
    ? [process.execPath, [binary.path]]
    : [binary.path, []];
  const env = await buildSpawnEnvWithLoginPath();
  const { stdout, stderr } = await execFileAsync(
    command,
    [
      ...baseArgs,
      "sandbox",
      "-C",
      territory.workspaceRoot,
      "-c",
      codexTerritoryProfileOverride(territory),
      "-P",
      CODEX_CODE_TERRITORY_PROFILE,
      ...commandArgs,
    ],
    {
      cwd: territory.workspaceRoot,
      env,
      timeout: opts.timeoutMs ?? 10_000,
    },
  );
  return { stdout, stderr };
}

/** Prove the pinned/current Codex binary can instantiate the exact split-write
 * profile on this host. Codex itself owns Seatbelt/bubblewrap selection; a
 * missing primitive, blocked namespace, or unsupported profile exits non-zero
 * and therefore rejects agent admission. */
export async function probeCodexTerritoryRuntime(
  territory: AgentFilesystemTerritory,
  opts: { cliBinary?: string } = {},
): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(
      `Codex filesystem containment is unsupported on ${process.platform}`,
    );
  }
  await runCodexTerritoryCommand(
    territory,
    [process.platform === "darwin" ? "/usr/bin/true" : "/bin/true"],
    opts,
  );
}

/** Never retain values from config/read; only copy valid MCP identifiers so
 * the session flags can turn each inherited server off without exposing URLs,
 * commands, environment values, or credentials to logs/state. */
export function codexConfiguredMcpNames(config: unknown): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const raw = (config as Record<string, unknown>).mcp_servers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.keys(raw).filter((name) => /^[A-Za-z0-9_-]+$/.test(name));
}
