import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudNativeHome, isCloudNativeHome } from "../cloud-native-home";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(path.join(os.tmpdir(), "zeros-native-home-")); roots.push(value); return value; }

describe("physical cloud native HOME", () => {
  it.each(["claude", "codex", "cursor"] as const)("creates actual engine-owned %s directories and selected env", async (provider) => {
    const dataRoot = await root();
    const home = await createCloudNativeHome({ dataRoot, provider, conversationId: randomUUID(), executionId: randomUUID() });
    expect(isCloudNativeHome(home)).toBe(true);
    expect(isCloudNativeHome({ ...home })).toBe(false);
    for (const directory of Object.values(home.paths)) {
      const stat = await lstat(directory);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.uid).toBe(process.getuid?.());
      expect(stat.gid).toBe(process.getgid?.());
      expect(stat.mode & 0o077).toBe(0);
      expect(directory.startsWith(dataRoot + path.sep)).toBe(true);
    }
    expect(home.environment()).toEqual({
      HOME: home.paths.home, TMPDIR: home.paths.tmp,
      XDG_CONFIG_HOME: home.paths.xdgConfigHome, XDG_CACHE_HOME: home.paths.xdgCacheHome,
      XDG_DATA_HOME: home.paths.xdgDataHome, XDG_STATE_HOME: home.paths.xdgStateHome,
      CLAUDE_CONFIG_DIR: home.paths.claudeConfigDir, CODEX_HOME: home.paths.codexHome,
    });
    expect(home.paths.cursorHome).toBe(path.join(home.paths.home, ".cursor"));
  });

  it("separates conversation and native execution state physically", async () => {
    const dataRoot = await root(), conversationId = randomUUID();
    const first = await createCloudNativeHome({ dataRoot, provider: "claude", conversationId, executionId: randomUUID() });
    const next = await createCloudNativeHome({ dataRoot, provider: "claude", conversationId, executionId: randomUUID() });
    const sibling = await createCloudNativeHome({ dataRoot, provider: "claude", conversationId: randomUUID(), executionId: randomUUID() });
    expect(new Set([first.paths.home, next.paths.home, sibling.paths.home]).size).toBe(3);
    expect(path.dirname(path.dirname(first.paths.directory))).toBe(path.dirname(path.dirname(next.paths.directory)));
    expect(path.dirname(path.dirname(first.paths.directory))).not.toBe(path.dirname(path.dirname(sibling.paths.directory)));
  });

  it.each(["../outside", "/absolute", ".", "bad\0id"])("refuses escaping execution identity %s", async (executionId) => {
    const dataRoot = await root();
    await expect(createCloudNativeHome({ dataRoot, provider: "claude", conversationId: "conversation", executionId })).rejects.toThrow();
    expect(await readdir(dataRoot)).toEqual([]);
  });

  it("refuses a symlinked data root and an existing symlink in the owned subtree", async () => {
    const dataRoot = await root(), outside = await root(), alias = path.join(dataRoot, "alias");
    await symlink(outside, alias);
    await expect(createCloudNativeHome({ dataRoot: alias, provider: "claude", conversationId: "conversation", executionId: randomUUID() })).rejects.toThrow();
    await symlink(outside, path.join(dataRoot, "native-agent-homes"));
    await expect(createCloudNativeHome({ dataRoot, provider: "claude", conversationId: "conversation", executionId: randomUUID() })).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });
});
