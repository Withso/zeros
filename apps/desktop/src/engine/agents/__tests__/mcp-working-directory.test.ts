import { describe, expect, it } from "vitest";
import { mcpServerSchema } from "../../settings/schema";
import { dedupeMcpServers, mcpServersFromSettings } from "../mcp-registry";
import { buildMcpServerOverrides } from "../adapters/codex/app-server";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  claudeMcpStdio,
  validateMcpWorkingDirectory,
} from "../mcp-working-directory";
import { SCRUBBED_COMMAND_ENV_NAMES } from "../../env/launcher-env";

const server = {
  name: "files",
  transport: "stdio" as const,
  command: "node",
  args: ["server.js"],
  cwd: "/tmp/mcp tools",
};
describe("MCP per-server working directory", () => {
  it("validates relative directories, canonicalizes symlinks and rejects missing folders/files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-cwd-"));
    try {
      await mkdir(path.join(root, "tools"));
      await symlink(path.join(root, "tools"), path.join(root, "alias"));
      await writeFile(path.join(root, "file"), "content");
      expect(await validateMcpWorkingDirectory("alias", root)).toBe(
        await realpath(path.join(root, "tools")),
      );
      await expect(
        validateMcpWorkingDirectory("missing", root),
      ).rejects.toThrow(/accessible folder/);
      await expect(validateMcpWorkingDirectory("file", root)).rejects.toThrow(
        /accessible folder/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("launches Claude MCP in the requested directory without evaluating path or argument syntax", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-cwd-"));
    try {
      const name = "with spaces ' $(no-command);";
      await mkdir(path.join(root, name));
      const config = claudeMcpStdio(
        {
          ...server,
          cwd: name,
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write(JSON.stringify([process.cwd(),process.argv[1]]))",
            "literal $HOME ' ;",
          ],
        },
        root,
        process.env.PATH,
      );
      const result = await promisify(execFile)(
        config.command,
        config.args ?? [],
        { cwd: root },
      );
      expect(JSON.parse(result.stdout)).toEqual([
        await realpath(path.join(root, name)),
        "literal $HOME ' ;",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("starts a Claude MCP server with the scrubbed base environment and only its own variables", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-env-"));
    try {
      const shim = path.join(root, "zeros-git-auth-fixture");
      await mkdir(shim);
      // A command path containing "=" must not be read as an assignment.
      const bin = path.join(root, "with=equals");
      await mkdir(bin);
      await symlink(process.execPath, path.join(bin, "node"));
      const sessionPath = [shim, "/usr/bin", "/bin"].join(path.delimiter);
      const config = claudeMcpStdio(
        {
          name: "probe",
          transport: "stdio",
          command: path.join(bin, "node"),
          args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
          env: { OWN_TOKEN: "own-secret" },
        },
        root,
        sessionPath,
      );
      // Claude starts each server with its own whole environment plus the
      // server's configured variables.
      const claudeEnv = {
        HOME: root,
        LANG: "en_US.UTF-8",
        PATH: sessionPath,
        ZEROS_LOCAL_TOKEN: "engine-secret",
        ZEROS_GIT_AUTH_SOCKET: "/tmp/broker.sock",
        ZEROS_MCP_0123456789ABCDEF0123456789ABCDEF_TOKEN: "other-server-secret",
        ANTHROPIC_API_KEY: "provider-secret",
        "odd.name": "odd-secret",
        MULTILINE: "first\nHOME=/forged\n=x",
      };
      const { stdout } = await promisify(execFile)(config.command, config.args, {
        cwd: root,
        env: { ...claudeEnv, ...config.env },
      });
      const env = JSON.parse(stdout) as Record<string, string>;
      expect(env).toMatchObject({ HOME: root, LANG: "en_US.UTF-8", OWN_TOKEN: "own-secret", PATH: "/usr/bin:/bin" });
      // The shell that runs a command path containing "=" adds its own bookkeeping.
      const allowed = new Set<string>([...SCRUBBED_COMMAND_ENV_NAMES, "OWN_TOKEN", "PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"]);
      expect(Object.keys(env).filter((name) => !allowed.has(name))).toEqual([]);
      // Claude expands ${NAME} in server arguments; the launcher must not use it.
      expect(config.args[1]).not.toContain("${");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("preserves the folder through validation and registry projection", () => {
    expect(mcpServerSchema.parse(server)).toEqual(server);
    expect(mcpServersFromSettings({ mcp: { servers: [server] } })).toEqual([
      server,
    ]);
  });
  it("does not collapse equal commands operating on different directories", () => {
    const other = { ...server, name: "other", cwd: "/tmp/other" };
    expect(dedupeMcpServers([server, other])).toEqual([server, other]);
  });
  it("passes the directory to Codex as a quoted native override", () => {
    expect(buildMcpServerOverrides([server])).toContain(
      'mcp_servers.files.cwd="/tmp/mcp tools"',
    );
  });
});
