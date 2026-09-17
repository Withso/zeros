import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerRegistration } from "./types";
export class McpWorkingDirectoryError extends Error {}

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

/** Claude's public MCP config has no cwd. Pass literal argv through a fixed
 * POSIX launcher; no configured value is evaluated as shell source. exec keeps
 * signals, stdio, exit status and the existing execution boundary intact. */
export function claudeMcpStdio(
  server: Extract<McpServerRegistration, { transport: "stdio" }>,
  workspace: string,
) {
  return {
    type: "stdio" as const,
    command: server.cwd ? "/bin/sh" : server.command,
    ...(server.cwd
      ? {
          args: [
            "-c",
            'cd -- "$1" && shift && exec "$@"',
            "zeros-mcp",
            mcpWorkingDirectory(server.cwd, workspace),
            server.command,
            ...(server.args ?? []),
          ],
        }
      : server.args
        ? { args: server.args }
        : {}),
    ...(server.env ? { env: server.env } : {}),
  };
}
