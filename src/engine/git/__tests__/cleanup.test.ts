import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  readdir,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  fastEvictHeavyDirs,
  fastRemoveWorktreeDir,
  prepareHeavyDirEviction,
  prepareWorktreeDirectoryEviction,
  pruneStaleHeavyDirTrash,
} from "../cleanup";

describe("cleanup", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-cleanup-test-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("evicts heavy dirs by rename", async () => {
    const wt = path.join(workdir, "wt");
    await mkdir(wt);
    await mkdir(path.join(wt, "node_modules"));
    await writeFile(path.join(wt, "node_modules", "pkg.json"), "{}");
    await mkdir(path.join(wt, "src"));
    await writeFile(path.join(wt, "src", "index.ts"), "");

    const moved = await fastEvictHeavyDirs(wt);
    expect(moved.length).toBe(1);
    expect(moved[0]).toMatch(/node_modules$/);

    // node_modules should be gone from wt
    const remaining = await readdir(wt);
    expect(remaining).toContain("src");
    expect(remaining).not.toContain("node_modules");
  });

  it("evicts multiple heavy dirs in one call", async () => {
    const wt = path.join(workdir, "wt");
    await mkdir(wt);
    for (const name of ["node_modules", "dist", ".next", "target"]) {
      await mkdir(path.join(wt, name));
    }
    const moved = await fastEvictHeavyDirs(wt);
    expect(moved.length).toBe(4);
  });

  it("returns empty array when nothing matches", async () => {
    const wt = path.join(workdir, "wt");
    await mkdir(wt);
    await mkdir(path.join(wt, "src"));
    const moved = await fastEvictHeavyDirs(wt);
    expect(moved).toEqual([]);
  });

  it("restores staged heavy directories when lifecycle removal fails", async () => {
    const wt = path.join(workdir, "wt");
    const dependency = path.join(wt, "node_modules", "pkg.json");
    await mkdir(path.dirname(dependency), { recursive: true });
    await writeFile(dependency, "{}");

    const prepared = await prepareHeavyDirEviction(wt);
    expect(prepared.moved).toHaveLength(1);
    await expect(readdir(path.join(wt, "node_modules"))).rejects.toThrow();

    await prepared.rollback();
    expect(await readdir(path.join(wt, "node_modules"))).toEqual(["pkg.json"]);
  });

  it("marks staged trash with its owning process and exact worktree", async () => {
    const wt = path.join(workdir, "wt");
    await mkdir(path.join(wt, "dist"), { recursive: true });
    const prepared = await prepareHeavyDirEviction(wt);
    const trashRoot = path.dirname(prepared.moved[0]!);
    const owner = JSON.parse(
      await readFile(path.join(trashRoot, ".zeros-trash-owner.json"), "utf8"),
    ) as { pid: number; worktreePath: string };

    expect(owner).toMatchObject({
      pid: process.pid,
      worktreePath: path.resolve(wt),
    });
    await prepared.rollback();
  });

  it("preserves both copies if a writer recreates a staged directory", async () => {
    const wt = path.join(workdir, "wt");
    const dependencyDir = path.join(wt, "node_modules");
    await mkdir(dependencyDir, { recursive: true });
    await writeFile(path.join(dependencyDir, "original.json"), "{}");

    const prepared = await prepareHeavyDirEviction(wt);
    await mkdir(dependencyDir, { recursive: true });
    await writeFile(path.join(dependencyDir, "replacement.json"), "{}");

    await expect(prepared.rollback()).rejects.toThrow(
      "another process recreated it",
    );
    expect(await readdir(dependencyDir)).toEqual(["replacement.json"]);
    expect(await readdir(prepared.moved[0]!)).toEqual(["original.json"]);
  });

  it("atomically stages the whole checkout beside its original path", async () => {
    const wt = path.join(workdir, "wt");
    await mkdir(path.join(wt, "node_modules"), { recursive: true });
    await writeFile(path.join(wt, "node_modules", "pkg.json"), "{}");
    await writeFile(path.join(wt, "tracked.txt"), "saved");

    const prepared = await prepareWorktreeDirectoryEviction(wt);
    const staged = prepared.moved[0]!;
    const trashRoot = path.dirname(staged);

    await expect(readdir(wt)).rejects.toThrow();
    expect(path.dirname(trashRoot)).toBe(path.resolve(workdir));
    expect(path.basename(trashRoot)).toMatch(/^\.zeros-trash-[0-9a-f]{8}$/);
    expect(await readFile(path.join(staged, "tracked.txt"), "utf8")).toBe(
      "saved",
    );
    expect(
      JSON.parse(
        await readFile(path.join(trashRoot, ".zeros-trash-owner.json"), "utf8"),
      ),
    ).toMatchObject({ pid: process.pid, worktreePath: path.resolve(wt) });

    await prepared.rollback();
    expect(await readFile(path.join(wt, "tracked.txt"), "utf8")).toBe("saved");
    await expect(readdir(trashRoot)).rejects.toThrow();
  });

  it("defers whole-checkout deletion until lifecycle commit", async () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));
    vi.stubGlobal("Bun", { spawn });
    const wt = path.join(workdir, "wt");
    await mkdir(wt);
    await writeFile(path.join(wt, "tracked.txt"), "saved");

    const prepared = await prepareWorktreeDirectoryEviction(wt);
    const trashRoot = path.dirname(prepared.moved[0]!);
    prepared.commit();
    expect(spawn).not.toHaveBeenCalled();

    // Lifecycle closes the exact native root before rename; the additional
    // delay keeps recursive cleanup outside the response stack and lets queued
    // macOS FSEvents callbacks drain against the retired-root tombstone.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn).toHaveBeenCalledWith(["rm", "-rf", "--", trashRoot], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(unref).toHaveBeenCalledOnce();
    await rm(trashRoot, { recursive: true, force: true });
  });

  it("defers native Bun cleanup until after lifecycle commit returns", async () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));
    vi.stubGlobal("Bun", { spawn });

    const wt = path.join(workdir, "wt");
    await mkdir(path.join(wt, "node_modules"), { recursive: true });
    await writeFile(path.join(wt, "node_modules", "pkg.json"), "{}");
    const prepared = await prepareHeavyDirEviction(wt);
    const trashRoot = path.dirname(prepared.moved[0]!);

    prepared.commit();
    // Starting a potentially long recursive delete is not part of the
    // destructive lifecycle's synchronous commit stack.
    expect(spawn).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(spawn).toHaveBeenCalledWith(["rm", "-rf", "--", trashRoot], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(unref).toHaveBeenCalledOnce();

    // The fake subprocess deliberately did not remove its target.
    await rm(trashRoot, { recursive: true, force: true });
  });

  it("prunes dead-process trash but protects live and journal-owned trash", async () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));
    vi.stubGlobal("Bun", { spawn });
    const deadPath = path.join(workdir, "dead-worktree");
    const protectedPath = path.join(workdir, "protected-worktree");
    const livePath = path.join(workdir, "live-worktree");
    const makeTrash = async (
      name: string,
      owner: { pid: number; worktreePath: string },
    ) => {
      const root = path.join(workdir, name);
      await mkdir(path.join(root, "dist"), { recursive: true });
      await writeFile(
        path.join(root, ".zeros-trash-owner.json"),
        JSON.stringify({ ...owner, createdAt: 1 }),
      );
      return root;
    };
    const deadRoot = await makeTrash("zeros-trash-deadbeef", {
      pid: 2_147_483_647,
      worktreePath: deadPath,
    });
    await makeTrash("zeros-trash-cafebabe", {
      pid: 2_147_483_647,
      worktreePath: protectedPath,
    });
    await makeTrash("zeros-trash-facefeed", {
      pid: process.pid,
      worktreePath: livePath,
    });

    await expect(
      pruneStaleHeavyDirTrash({
        root: workdir,
        protectedWorktreePaths: [protectedPath],
      }),
    ).resolves.toBe(1);
    expect(spawn).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(spawn).toHaveBeenCalledWith(["rm", "-rf", "--", deadRoot], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(unref).toHaveBeenCalledOnce();
  });

  it("keeps fresh markerless trash and prunes only aged legacy trash", async () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));
    vi.stubGlobal("Bun", { spawn });
    const now = Date.now();
    const freshRoot = path.join(workdir, "zeros-trash-aabbccdd");
    const agedRoot = path.join(workdir, "zeros-trash-11223344");
    await mkdir(path.join(freshRoot, "dist"), { recursive: true });
    await mkdir(path.join(agedRoot, "dist"), { recursive: true });
    await utimes(freshRoot, new Date(now - 1_000), new Date(now - 1_000));
    await utimes(agedRoot, new Date(now - 120_000), new Date(now - 120_000));

    await expect(
      pruneStaleHeavyDirTrash({
        root: workdir,
        legacyMinAgeMs: 60_000,
        now,
      }),
    ).resolves.toBe(1);
    expect(spawn).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(spawn).toHaveBeenCalledWith(["rm", "-rf", "--", agedRoot], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(spawn).not.toHaveBeenCalledWith(
      ["rm", "-rf", "--", freshRoot],
      expect.anything(),
    );
  });

  it("finds abandoned whole-checkout trash beside managed workspaces", async () => {
    vi.useFakeTimers();
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));
    vi.stubGlobal("Bun", { spawn });
    const managedRoot = path.join(workdir, "managed");
    const repoDir = path.join(managedRoot, "repo");
    const trashRoot = path.join(repoDir, ".zeros-trash-deadbeef");
    const original = path.join(repoDir, "workspace");
    await mkdir(path.join(trashRoot, "worktree"), { recursive: true });
    await writeFile(
      path.join(trashRoot, ".zeros-trash-owner.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        worktreePath: original,
        createdAt: 1,
      }),
    );

    await expect(
      pruneStaleHeavyDirTrash({
        root: path.join(workdir, "empty-temp"),
        managedRoots: [managedRoot],
      }),
    ).resolves.toBe(1);
    expect(spawn).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(spawn).toHaveBeenCalledWith(["rm", "-rf", "--", trashRoot], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(unref).toHaveBeenCalledOnce();
  });

  it("fastRemoveWorktreeDir removes the whole tree", async () => {
    const wt = path.join(workdir, "wt");
    await mkdir(wt);
    await mkdir(path.join(wt, "node_modules"));
    await writeFile(path.join(wt, "file.txt"), "");

    await fastRemoveWorktreeDir(wt);
    let exists = true;
    try {
      await readdir(wt);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});
