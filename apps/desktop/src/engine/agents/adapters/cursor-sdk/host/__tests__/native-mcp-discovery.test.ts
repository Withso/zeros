import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { CloudProviderExecution } from "../../../../cloud-provider-execution";
import { cloudCursorRequest } from "../cloud-policy";
import { prepareCloudCursorConfigView } from "../../../../containment/cloud-native-boundary";
import { materializeCloudSkills } from "../../../../cloud-skills";

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
  const run = (options: unknown, engineHome = false) => {
    let selectedHome = home;
    if (engineHome) {
      selectedHome = path.join(root, "engine-home");
      mkdirSync(selectedHome, { mode: 0o700 });
      cpSync(path.join(root, "cursor-config"), path.join(selectedHome, ".cursor"), { recursive: true });
      cpSync(path.join(root, "skills"), path.join(selectedHome, ".cursor/skills"), { recursive: true });
    }
    // Only the credential-free fixture uses a network namespace. Preserve the
    // engine's actual UID/GID; no agent mount, worker mapping or readonly HOME.
    const child = spawnSync("/usr/bin/setpriv", ["--inh-caps=-all", "--ambient-caps=-all",
      "unshare", "--user", "--map-current-user", "--net", "--",
      process.execPath, probe, sdk, JSON.stringify(options), engineHome ? "engine-home" : "ordinary",
      String(process.getuid!()), String(process.getgid!())], {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: selectedHome, CURSOR_RIPGREP_PATH: ripgrep },
      encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024,
    });
    expect(child.status).toBe(0); expect(child.stdout).toMatch(/native_prewarm_ok$/);
    return child.stdout + child.stderr;
  };
  return { root, home, cwd, marker, server, run };
}

describe.skipIf(process.platform !== "linux")("pinned Cursor native MCP discovery", () => {
  it("shares engine identity and initializes an ordinary writable provider HOME", async () => {
    const f = await fixture();
    try {
      await prepareCloudCursorConfigView(f.root);
      await mkdir(path.join(f.root, "history"));
      await mkdir(path.join(f.root, "skills"));
      const output = f.run({ cwd: f.cwd, local: { cwd: f.cwd, settingSources: ["user"] }, mcpServers: {} }, true);
      expect(output).toContain('"sameEngineIdentity":true');
      expect(output).toContain('"stateWritable":true');
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it.each(["project", "user", "none"])("records repo instruction sentinels with the %s source", async source => {
    const f = await fixture();
    try {
      await mkdir(path.join(f.cwd, ".cursor/rules"));
      await writeFile(path.join(f.cwd, "AGENTS.md"), "CURSOR_AGENTS_SENTINEL");
      await writeFile(path.join(f.cwd, ".cursor/rules/always.mdc"), "---\nalwaysApply: true\n---\nCURSOR_RULE_SENTINEL");
      // An admitted server exercises workspace resource loading; this is the
      // real pinned SDK, without credentials or provider network access.
      const output = f.run({ cwd: f.cwd, local: { cwd: f.cwd, settingSources: source === "none" ? [] : [source] }, mcpServers: { admitted: f.server } });
      expect(output).toContain(`"repoAgentsRead":${source === "project"}`);
      expect(output).toContain(`"repoRuleRead":${source === "project"}`);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it.each(["empty", "admitted"])("initializes engine-owned user config with the %s MCP snapshot", async snapshot => {
    const f = await fixture();
    try {
      await prepareCloudCursorConfigView(f.root);
      await mkdir(path.join(f.root, "history"));
      await materializeCloudSkills(f.root, [{ name: "admitted-skill", description: "Engine-admitted fixture skill", content: "Use only for the synthetic fixture." }]);
      await writeFile(path.join(f.home, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { excluded: f.server } }));
      const admittedMarker = path.join(f.home, "admitted-engine-home-marker");
      const admitted = { command: process.execPath, cwd: f.cwd,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(admittedMarker)},"started")`] };
      const stdout = f.run({ cwd: f.cwd, local: { cwd: f.cwd, settingSources: ["user"] }, mcpServers: snapshot === "admitted" ? { admitted } : {} }, true);
      if (snapshot === "admitted") {
        expect(stdout).toContain('"skillRead":true');
        expect(await readFile(admittedMarker, "utf8")).toBe("started");
      } else await expect(readFile(admittedMarker)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("keeps cloud project discovery off while starting admitted MCP in a nonprimary worktree cwd", async () => {
    const f = await fixture();
    try {
      await writeFile(path.join(f.cwd, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { excluded: f.server } }));
      const admittedMarker = path.join(f.root, "admitted-marker"), tools = path.join(f.cwd, "tools");
      await mkdir(tools);
      const execution = { cwd: f.cwd, model: "qualified-model", lease: { assertLive: vi.fn(), admission: { model: "qualified-model" } },
        coordinator: { environment: () => ({ CURSOR_API_KEY: "synthetic-admitted-key" }) }, productServers: [],
        userServers: [{ name: "admitted", transport: "stdio", cwd: tools, command: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(admittedMarker)},process.cwd())`] }] } as unknown as CloudProviderExecution;
      for (const operation of ["platform.prewarm", "agent.create", "agent.resume"]) {
        const raw = { cwd: "/untrusted-root", local: { settingSources: ["project", "plugins", "all"] }, mcpServers: {} };
        const request = cloudCursorRequest(execution, operation, operation === "agent.resume" ? { agentId: "saved", opts: raw } : raw) as { opts?: unknown };
        // Native workspace startup is the side-effecting phase shared by these
        // three operations; no model turn/provider authentication is claimed.
        f.run(operation === "agent.resume" ? request.opts : request);
        expect(await readFile(admittedMarker, "utf8")).toBe(tools);
        await rm(admittedMarker);
        await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
