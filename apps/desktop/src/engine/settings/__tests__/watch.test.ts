import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startSettingsWatcher, type SettingsWatcher } from "../watch";

const roots: string[] = [];
const watchers: SettingsWatcher[] = [];
const previousUserSettingsDir = process.env.ZEROS_USER_SETTINGS_DIR;

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for change");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.stop();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  if (previousUserSettingsDir === undefined) {
    delete process.env.ZEROS_USER_SETTINGS_DIR;
  } else {
    process.env.ZEROS_USER_SETTINGS_DIR = previousUserSettingsDir;
  }
});

describe("startSettingsWatcher", () => {
  it("detects a same-size atomic replacement even when mtime is preserved", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-settings-watch-"));
    roots.push(root);
    const user = path.join(root, "user");
    const repo = path.join(root, "repo");
    await mkdir(user, { recursive: true });
    await mkdir(path.join(repo, ".zeros"), { recursive: true });
    process.env.ZEROS_USER_SETTINGS_DIR = user;

    const settings = path.join(repo, ".zeros", "settings.toml");
    await writeFile(settings, "a = 1\n");
    const before = await stat(settings);
    const changes: string[][] = [];
    const watcher = startSettingsWatcher(
      () => [repo],
      (changed) => changes.push(changed),
      { pollIntervalMs: 20 },
    );
    watchers.push(watcher);

    const replacement = `${settings}.replacement`;
    await writeFile(replacement, "b = 2\n");
    await utimes(replacement, before.atime, before.mtime);
    await rename(replacement, settings);

    await waitFor(() => changes.some((changed) => changed.includes(settings)));
    expect(changes.flat()).toContain(settings);
  });
});
