// The maintenance wake's change check (archive-scrub.ts), with a real shell, find and Git: only the person's work
// answers "changed", never the stop's own timing on a file system that keeps whole seconds, nor Git's bookkeeping.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changedSinceStopCommand, parseChangedSinceStop, stopMarkerCommand } from "./archive-scrub.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const run = (command: string) => spawnSync("bash", ["-c", `eval "$1"`, "check", command], { encoding: "utf8" });
const touchAt = (path: string, seconds: number) => execFileSync("touch", ["-h", "-d", `@${seconds.toFixed(3)}`, path]);

function workspace() {
  const home = mkdtempSync(join(tmpdir(), "zeros-change-check-")); dirs.push(home);
  const checkout = join(home, "acme", "app");
  mkdirSync(checkout, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd: checkout, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(checkout, "README.md"), "hello\n"); writeFileSync(join(checkout, "keep.txt"), "keep\n");
  git("add", "-A"); git("commit", "-q", "-m", "base");
  const marker = join(home, ".cache", "zeros-stop-marker");
  const stop = () => { expect(run(stopMarkerCommand(home)).status).toBe(0); return statSync(marker).mtimeMs / 1000; };
  const changed = () => parseChangedSinceStop(run(changedSinceStopCommand(home, [checkout])).stdout);
  return { home, checkout, git, marker, stop, changed };
}

describe("the stop's marker and the wake's change check", () => {
  it("marks the stop at the next whole second, so a file system that keeps whole seconds never makes an earlier write newer", () => {
    const f = workspace();
    const before = Date.now() / 1000;
    const at = f.stop();
    expect(Number.isInteger(at)).toBe(true);
    expect(at).toBeGreaterThan(before);
    // A write earlier in the stop's second, and the marker truncated to whole seconds as such a file system does.
    touchAt(join(f.checkout, "README.md"), Math.floor(before) + 0.5);
    touchAt(f.marker, Math.floor(at));
    expect(f.changed()).toBe(false);
  });

  it("never counts Git's own bookkeeping after the stop: the .git entry, its index, locks, FETCH_HEAD, ORIG_HEAD, in submodules too", () => {
    const f = workspace(), at = f.stop();
    const module = join(f.checkout, ".git", "modules", "d".repeat(64));
    mkdirSync(module, { recursive: true });
    for (const name of ["index.lock", "FETCH_HEAD", "ORIG_HEAD"]) writeFileSync(join(f.checkout, ".git", name), "");
    for (const name of ["index", "HEAD.lock", "FETCH_HEAD"]) writeFileSync(join(module, name), "");
    for (const path of [join(f.checkout, ".git"), ...["index", "index.lock", "FETCH_HEAD", "ORIG_HEAD"].map(name => join(f.checkout, ".git", name)),
      module, ...["index", "HEAD.lock", "FETCH_HEAD"].map(name => join(module, name))]) touchAt(path, at + 5);
    // .git/modules itself was created after the stop here; a real one was there before it.
    touchAt(join(f.checkout, ".git", "modules"), at - 5);
    expect(f.changed()).toBe(false);
  });

  it("never counts a git status after the stop, which rewrites the index", () => {
    const f = workspace(), at = f.stop();
    // Make the index stale so status rewrites it, without changing any file's content or time after the stop.
    touchAt(join(f.checkout, "README.md"), at - 1);
    touchAt(join(f.checkout, ".git", "index"), at - 3);
    execFileSync("bash", ["-c", 'sleep 1.1; git status --porcelain >/dev/null'], { cwd: f.checkout });
    expect(statSync(join(f.checkout, ".git", "index")).mtimeMs / 1000).toBeGreaterThan(at - 1);
    expect(f.changed()).toBe(false);
  });

  it.each([
    ["an edited file", (f: ReturnType<typeof workspace>, at: number) => { writeFileSync(join(f.checkout, "README.md"), "edited\n"); touchAt(join(f.checkout, "README.md"), at + 5); }],
    ["a new untracked file", (f: ReturnType<typeof workspace>, at: number) => { writeFileSync(join(f.checkout, "new.txt"), "new\n"); touchAt(join(f.checkout, "new.txt"), at + 5); }],
    ["a deleted file", (f: ReturnType<typeof workspace>, at: number) => { rmSync(join(f.checkout, "keep.txt")); touchAt(f.checkout, at + 5); }],
    // Staging writes the index (bookkeeping) and a new blob under .git/objects, which counts. A known limit: staging
    // content whose blob already exists leaves no newer file, and answers unchanged.
    ["a change staged with git add", (f: ReturnType<typeof workspace>, at: number) => { writeFileSync(join(f.checkout, "README.md"), "staged\n");
      touchAt(join(f.checkout, "README.md"), at - 2); execFileSync("bash", ["-c", "sleep 1.1; git add README.md"], { cwd: f.checkout }); }],
    // A real commit after the stop, past the marker's second: its new objects and refs are newer.
    ["a new commit", (f: ReturnType<typeof workspace>) => { execFileSync("sleep", ["1.1"]); writeFileSync(join(f.checkout, "c.txt"), "c\n");
      f.git("add", "c.txt"); f.git("commit", "-q", "-m", "c"); touchAt(join(f.checkout, "c.txt"), statSync(f.marker).mtimeMs / 1000 - 1); }],
  ])("still answers changed for %s after the stop", (_label, change) => {
    const f = workspace(), at = f.stop();
    change(f, at);
    expect(f.changed()).toBe(true);
  });
});
