import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { installNativeDevScripts } from "../dev-environment/setup-native";
import { opSettingsRead, opSettingsWrite } from "../../apps/desktop/src/engine/settings/ops";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-dev-setup-")); roots.push(dir);
  const root = path.join(dir, "repo"); fs.mkdirSync(root);
  vi.stubEnv("ZEROS_USER_SETTINGS_DIR", path.join(dir, "user"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  git("init", "-q", "-b", "main"); fs.writeFileSync(path.join(root, "README.md"), "test\n"); git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial");
  return { root, dir, git };
}

it("installs private repository defaults inherited by future worktrees, idempotently", () => {
  const f = fixture(); installNativeDevScripts(f.root);
  const first = opSettingsRead("repo-local", f.root);
  expect(first.doc?.scripts).toMatchObject({ archive: expect.stringContaining("hook.sh archive"), archive_required: true, archive_timeout_seconds: 1800 });
  const before = fs.readFileSync(first.path, "utf8"); installNativeDevScripts(f.root);
  expect(fs.readFileSync(first.path, "utf8")).toBe(before);
  expect(f.git("status", "--porcelain")).toBe("");
  const worktree = path.join(f.dir, "linked"); f.git("worktree", "add", "-qb", "feature", worktree);
  expect(opSettingsRead("repo-local", worktree).doc).toEqual(first.doc);
});

it("preserves existing setup, run commands, comments and unrelated keys", () => {
  const f = fixture();
  opSettingsWrite("repo-local", { scripts: { setup: "custom install", run: "custom run" } }, f.root);
  const file = opSettingsRead("repo-local", f.root).path;
  fs.appendFileSync(file, '\n# retain me\n[custom]\nvalue = "retained"\n');
  installNativeDevScripts(f.root);
  expect(opSettingsRead("repo-local", f.root).doc?.scripts).toMatchObject({ setup: "custom install", run: "custom run", archive_required: true });
  expect(fs.readFileSync(file, "utf8")).toContain("# retain me");
  expect(opSettingsRead("repo-local", f.root).doc?.custom).toEqual({ value: "retained" });
});

it("refuses to silently replace or make a custom archive command retryable", () => {
  const f = fixture(); opSettingsWrite("repo-local", { scripts: { archive: "custom cleanup" } }, f.root);
  const file = opSettingsRead("repo-local", f.root).path, before = fs.readFileSync(file);
  expect(() => installNativeDevScripts(f.root)).toThrow(/existing native Zeros archive command/i);
  expect(fs.readFileSync(file)).toEqual(before);
});

it("preserves old-branch Local run and setup without the hosted hook", () => {
  const f = fixture(); installNativeDevScripts(f.root);
  const tools = path.join(f.dir, "bin"), log = path.join(f.dir, "commands"); fs.mkdirSync(tools);
  for (const command of ["pnpm", "npm"]) fs.writeFileSync(path.join(tools, command), `#!/bin/sh\nprintf '%s\\n' '${command}' >> "$ZEROS_NATIVE_TEST_LOG"\n`, { mode: 0o755 });
  const scripts = opSettingsRead("repo-local", f.root).doc!.scripts as any;
  const run = (command: string) => spawnSync("/bin/sh", ["-c", command], { cwd: f.root, env: { HOME: f.dir, PATH: tools + ":/usr/bin:/bin", ZEROS_NATIVE_TEST_LOG: log } });
  expect(run(scripts.setup).status).toBe(0);
  for (const action of scripts.run_actions) expect(run(action.command).status).toBe(0);
  expect(scripts.run_actions.find((action: any) => action.id === "zeros-dev-backend").one_shot).not.toBe(true);
  expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(5);
});
