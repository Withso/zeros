import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as commands from "../git-exec";
import { snapshotWorkingTree } from "../turns-git";

let root: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-snapshot-budget-"));
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await mkdir(path.join(root, "src"));
  await Promise.all(Array.from({ length: 400 }, (_, index) => writeFile(path.join(root, "src", `${index}.txt`), `file ${index}\n`)));
  git("add", "."); git("commit", "-qm", "initial");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("snapshot process budget", () => {
  it("reuses validated Local snapshot inputs", async () => {
    const first = await snapshotWorkingTree(root, "refs/zeros/test/first");
    const run = vi.spyOn(commands, "runGit");
    const started = performance.now();
    const next = await snapshotWorkingTree(root, "refs/zeros/test/next");
    console.info("snapshot process budget", JSON.stringify({ gitCalls: run.mock.calls.length, elapsedMs: Math.round(performance.now() - started) }));
    expect(git("rev-parse", `${next}^{tree}`)).toBe(git("rev-parse", `${first}^{tree}`));
    expect(run.mock.calls.filter(([, args]) => args[0] === "read-tree")).toHaveLength(1);
    expect(run.mock.calls.filter(([, args]) => args.join(" ") === "rev-parse --verify HEAD")).toHaveLength(0);
    expect(run.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it.each(["packed", "detached", "linked"])("keeps native snapshot contents for a %s HEAD", async (mode) => {
    let checkout = root;
    if (mode === "packed") git("pack-refs", "--all");
    if (mode === "detached") git("checkout", "-q", "--detach");
    if (mode === "linked") { checkout = path.join(root, "linked"); git("worktree", "add", "-q", "-b", "linked", checkout); }
    await snapshotWorkingTree(checkout, "refs/zeros/test/before");
    await writeFile(path.join(checkout, "src/0.txt"), "updated\n");
    const next = await snapshotWorkingTree(checkout, "refs/zeros/test/after");
    expect(git("show", `${next}:src/0.txt`)).toBe("updated");
  });

  it("recovers if the prior snapshot tree disappears between captures", async () => {
    await writeFile(path.join(root, "untracked.txt"), "keep this work\n");
    const previous = await snapshotWorkingTree(root, "refs/zeros/test/prunable");
    const tree = git("rev-parse", `${previous}^{tree}`);
    await rm(path.join(root, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
    const next = await snapshotWorkingTree(root, "refs/zeros/test/recovered");
    expect(next).toBeTruthy();
    expect(git("show", `${next}:untracked.txt`)).toBe("keep this work");
  });
});
