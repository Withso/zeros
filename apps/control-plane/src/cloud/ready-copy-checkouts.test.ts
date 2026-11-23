// The checkouts read a copy build and a workspace fork rely on, run for real against Git (the Boat fake only answers it).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkoutsMatch, readyCopyCheckoutsCommand } from "./ready-copies.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: tmpdir(),
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };

function repository(root: string, name: string): string {
  const dir = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env });
  writeFileSync(join(dir, "file.txt"), `${name}\n`);
  execFileSync("git", ["-C", dir, "add", "."], { env });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", name], { env });
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { env, encoding: "utf8" }).trim();
}
const read = (dirs: string[]) => spawnSync("bash", ["-c", readyCopyCheckoutsCommand(dirs).join("\n")], { env, encoding: "utf8" }).stdout;

it("reads each checkout's HEAD for real: present at its commit, missing, or at another commit", () => {
  const root = mkdtempSync(join(tmpdir(), "ready-copy-checkouts-")); roots.push(root);
  const one = repository(root, "one"), two = repository(root, "two");
  const dirs = [join(root, "one"), join(root, "two")];
  expect(checkoutsMatch(read(dirs), [{ commit: one }, { commit: two }])).toBe(true);
  // No recorded commit: any commit will do.
  expect(checkoutsMatch(read(dirs), [{ commit: null }, { commit: null }])).toBe(true);
  // Missing: its folder is gone.
  expect(checkoutsMatch(read([dirs[0]!, join(root, "absent")]), [{ commit: one }, { commit: two }])).toBe(false);
  // Another commit than the one recorded.
  expect(checkoutsMatch(read(dirs), [{ commit: one }, { commit: one }])).toBe(false);
  // A folder without its .git, and an empty read, are never a match.
  rmSync(join(root, "two", ".git"), { recursive: true, force: true });
  expect(checkoutsMatch(read(dirs), [{ commit: one }, { commit: null }])).toBe(false);
  expect(checkoutsMatch("", [{ commit: null }])).toBe(false);
});
