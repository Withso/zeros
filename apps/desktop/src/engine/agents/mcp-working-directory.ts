import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerRegistration } from "./types";
import { McpServerStartError } from "./mcp-registration";
import { mcpServerPath } from "./mcp-process-env";
import { SCRUBBED_COMMAND_ENV_NAMES } from "../env/launcher-env";
export class McpWorkingDirectoryError extends McpServerStartError {}

/** Resolve against the owning session, never the engine's process cwd. */
export function mcpWorkingDirectory(value: string, workspace: string): string {
  if (!value.trim() || value.includes("\0") || value.length > 4096)
    throw new McpWorkingDirectoryError("Invalid MCP working directory.");
  const expanded =
    value === "~"
      ? os.homedir()
      : value.startsWith("~/")
        ? path.join(os.homedir(), value.slice(2))
        : value;
  return path.resolve(workspace, expanded);
}

export async function validateMcpWorkingDirectory(
  value: string,
  workspace: string,
): Promise<string> {
  const folder = mcpWorkingDirectory(value, workspace);
  try {
    const canonical = await realpath(folder);
    if (!(await stat(canonical)).isDirectory())
      throw new Error("not a directory");
    await access(canonical, constants.R_OK | constants.X_OK);
    return canonical;
  } catch {
    throw new McpWorkingDirectoryError(
      "MCP working directory must be an existing, accessible folder on the machine running the server.",
    );
  }
}

// $1 lists the names to keep as "=A=B=" (a name never contains "="), $2 is
// the folder or empty, the rest is the command. Every other variable is
// listed from env's own output; a multi-line value can only add a spurious
// name there, never hide a real one. The command goes through an inner shell
// when it contains "=", which env would read as an assignment. Claude expands
// ${NAME} in arguments, so the script never uses that syntax.
const CLAUDE_MCP_LAUNCHER = [
  "keep=$1 dir=$2",
  "shift 2",
  'if [ -n "$dir" ]; then cd -- "$dir" || exit; fi',
  "case $1 in *=*) set -- /bin/sh -c 'exec \"$@\"' zeros-mcp \"$@\" ;; esac",
  'set -- -- "$@"',
  "IFS='",
  "'",
  "set -f",
  "for name in $(command -p env | LC_ALL=C command -p sed -n 's/^\\([^=][^=]*\\)=.*/\\1/p'); do",
  '  case $keep in *"=$name="*) ;; *) set -- -u "$name" "$@" ;; esac',
  "done",
  'exec /usr/bin/env "$@"',
].join("\n");

/** Claude starts a stdio server with its own whole environment (the chat's
 * provider keys, Zeros tokens and every other server's variables) plus the
 * server's, and its public MCP config has neither a cwd nor an allowlist. A
 * fixed POSIX launcher keeps only the scrubbed command basics and the
 * server's own variables, changes folder when asked and execs argv literally;
 * no configured value is evaluated as shell source. exec keeps signals, stdio,
 * exit status and the existing execution boundary intact. */
export function claudeMcpStdio(
  server: Extract<McpServerRegistration, { transport: "stdio" }>,
  workspace: string,
  sessionPath: string | undefined,
) {
  const pathValue = mcpServerPath(sessionPath);
  const env = { ...(pathValue ? { PATH: pathValue } : {}), ...server.env };
  const keep = new Set([...SCRUBBED_COMMAND_ENV_NAMES, ...Object.keys(env)].filter(name => name && !name.includes("=")));
  return {
    type: "stdio" as const,
    command: "/bin/sh",
    args: [
      "-c",
      CLAUDE_MCP_LAUNCHER,
      "zeros-mcp",
      `=${[...keep].join("=")}=`,
      server.cwd ? mcpWorkingDirectory(server.cwd, workspace) : "",
      server.command,
      ...(server.args ?? []),
    ],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}
