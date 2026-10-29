import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const sdk = require.resolve("@cursor/sdk");
const ripgrep = process.platform === "linux" ? path.join(path.dirname(createRequire(sdk).resolve("@cursor/sdk-linux-x64/package.json")), "bin/rg") : undefined;
const probe = fileURLToPath(new URL("./fixtures/native-mcp-probe.cjs", import.meta.url));
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-cursor-mcp-"));
  const home = path.join(root, "home"), cwd = path.join(root, "managed-worktree");
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  await mkdir(path.join(cwd, ".cursor"), { recursive: true });
  const marker = path.join(home, "unadmitted-marker");
  const server = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)},"started")`] };
  const run = (options: unknown) => {
    // Only the credential-free fixture uses a network namespace. Preserve the
    // engine's actual UID/GID; no agent mount, worker mapping or readonly HOME.
    const child = spawnSync("/usr/bin/setpriv", ["--inh-caps=-all", "--ambient-caps=-all",
      "unshare", "--user", "--map-current-user", "--net", "--",
      process.execPath, probe, sdk, JSON.stringify(options), "ordinary",
      String(process.getuid!()), String(process.getgid!())], {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: home, CURSOR_RIPGREP_PATH: ripgrep },
      encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024,
    });
    expect(child.status).toBe(0); expect(child.stdout).toMatch(/native_prewarm_ok$/);
    return child.stdout + child.stderr;
  };
  return { root, home, cwd, marker, server, run };
}

describe.skipIf(process.platform !== "linux")("pinned Cursor native MCP discovery", () => {

  it.each([
    { source: "project", sources: ["project"], project: true },
    { source: "user", sources: ["user"], project: false },
    { source: "none", sources: [], project: false },
    { source: "Local", sources: ["project", "user", "team", "mdm", "plugins"], project: true },
    { source: "cloud", sources: ["project", "user"], project: true },
  ])("assembles repo instructions during prewarm with $source sources", async ({ sources, project }) => {
    const f = await fixture();
    try {
      await mkdir(path.join(f.cwd, ".cursor/rules"));
      await writeFile(path.join(f.cwd, "AGENTS.md"), "CURSOR_AGENTS_SENTINEL");
      await writeFile(path.join(f.cwd, ".cursor/rules/always.mdc"), "---\nalwaysApply: true\n---\nCURSOR_RULE_SENTINEL");
      // An admitted server exercises workspace resource loading; this is the
      // real pinned SDK, without credentials or provider network access.
      const output = f.run({ cwd: f.cwd, local: { cwd: f.cwd, settingSources: sources }, mcpServers: { admitted: f.server } });
      expect(output).toContain(`"repoAgentsRead":${project}`);
      expect(output).toContain(`"repoRuleRead":${project}`);
      expect(output).toContain(`"repoAgentsRule":${project}`);
      expect(output).toContain(`"repoAlwaysRule":${project}`);
      expect(output).toContain(`"readApis":${project ? '["FileHandle.readFile"]' : '[]'}`);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it.each(["project", "user"])("proves %s source starts unadmitted native MCP despite an explicit empty snapshot", async source => {
    const f = await fixture();
    try {
      await writeFile(path.join(source === "user" ? f.home : f.cwd, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { excluded: f.server } }));
      f.run({ cwd: f.cwd, local: { cwd: f.cwd, settingSources: [source] }, mcpServers: {} });
      expect(await readFile(f.marker, "utf8")).toBe("started");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
