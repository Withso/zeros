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
