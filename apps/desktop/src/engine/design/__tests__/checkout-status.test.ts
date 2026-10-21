import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as commands from "../../git/git-exec";
import { readDesignCheckoutStatus } from "../checkout-status";

let root: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-design-checkout-cache-"));
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await writeFile(path.join(root, "file"), "original\n"); git("add", "."); git("commit", "-qm", "initial");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("Local Design checkout observations", () => {
  it("shares concurrent conflict scans and uses an index fingerprint for warm reads", async () => {
    const read = vi.spyOn(commands, "runGit");
    const values = await Promise.all(Array.from({ length: 4 }, () => readDesignCheckoutStatus(root)));
    expect(values).toEqual(Array.from({ length: 4 }, () => ({ conflicts: [], operation: null })));
    expect(read).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 10; index += 1) await readDesignCheckoutStatus(root);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("sees conflicts and their resolution immediately after an external index change", async () => {
    await readDesignCheckoutStatus(root);
    git("checkout", "-qb", "topic"); await writeFile(path.join(root, "file"), "topic\n"); git("commit", "-qam", "topic");
    git("checkout", "-q", "main"); await writeFile(path.join(root, "file"), "main\n"); git("commit", "-qam", "main");
    try { git("merge", "topic"); } catch { /* expected conflict */ }
    expect(await readDesignCheckoutStatus(root)).toEqual({ conflicts: ["file"], operation: "merge" });
    await writeFile(path.join(root, "file"), "resolved\n"); git("add", "file");
    expect(await readDesignCheckoutStatus(root)).toEqual({ conflicts: [], operation: "merge" });
    git("merge", "--abort");
    expect(await readDesignCheckoutStatus(root)).toEqual({ conflicts: [], operation: null });
  });

  it("does not retain a result when the index changes while its scan is pending", async () => {
    const original = commands.runGit;
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.spyOn(commands, "runGit").mockImplementationOnce(async (...args) => {
      const result = await original(...args); entered(); await gate; return result;
    });
    const pending = readDesignCheckoutStatus(root);
    await started;
    await writeFile(path.join(root, "file"), "new\n"); git("add", "file");
    release(); await pending;
    await readDesignCheckoutStatus(root);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
