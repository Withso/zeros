import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GitService } from "../git";
import { repositoryFixture } from "./repository-fixture";
import { commandRunner } from "../commands";

it("computes each Changes scope independently for staged-then-deleted files", async () => {
  const { root, scope, git } = await repositoryFixture(); const service = new GitService(scope);
  await writeFile(join(root, "added then deleted.txt"), "staged\n");
  await git("add", "--", "added then deleted.txt"); await rm(join(root, "added then deleted.txt"));
  expect(await service.handle("git.changeCounts", {})).toEqual({ all: 0, uncommitted: 0, staged: 1, unstaged: 1 });
  expect(await service.handle("git.changeLineCounts", {})).toEqual({ additions: 0, deletions: 0 });
  expect(await service.handle("git.hasChanges", {})).toEqual({ hasChanges: false });
  expect(await service.handle("git.status", {})).toMatchObject({ staged: [{ path: "added then deleted.txt", status: "added" }], unstaged: [{ path: "added then deleted.txt", status: "deleted" }], untracked: [], conflicted: [], conflictState: null, ahead: null, behind: null, upstream: null });
});

it("includes committed, worktree and untracked changes from the fork point", async () => {
  const { root, scope, git } = await repositoryFixture(); const service = new GitService(scope);
  await writeFile(join(root, "committed.txt"), "one\n"); await git("add", "."); await git("commit", "-m", "work");
  await writeFile(join(root, "readme.txt"), "initial\nworking\n"); await writeFile(join(root, "untracked.txt"), "new\n");
  expect(await service.handle("git.changeCounts", {})).toEqual({ all: 3, uncommitted: 2, staged: 0, unstaged: 2 });
  expect(await service.handle("git.changeLineCounts", {})).toEqual({ additions: 3, deletions: 0 });
  const diff = await service.handle("git.diff", { mode: "worktree-vs-base", rawPatch: true }) as { patch: string; hunks: Array<{ filePath: string }> };
  expect(diff.patch).toContain("+working"); expect(diff.patch).toContain("+one");
  expect(diff.hunks.map(hunk => hunk.filePath)).toContain("committed.txt");
  expect(await service.handle("git.diff", { mode: "worktree-vs-base", summaryLimit: 0 })).toMatchObject({ summary: true, hunks: [], files: expect.arrayContaining([{ path: "committed.txt", status: "added", additions: 1, deletions: 0, binary: false }]) });
});

it("uses literal paths so a magic-looking file stages only itself", async () => {
  const { root, scope } = await repositoryFixture(); const service = new GitService(scope);
  await writeFile(join(root, ":(glob)*.txt"), "literal\n"); await writeFile(join(root, "other.txt"), "other\n");
  await service.handle("git.stage", { paths: [":(glob)*.txt"] });
  expect(await service.handle("git.status", {})).toMatchObject({ staged: [{ path: ":(glob)*.txt", status: "added" }], untracked: ["other.txt"] });
  await expect(service.handle("git.stage", { paths: ["../outside"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(service.handle("git.diff", { mode: "refs", base: "--output=/tmp/outside" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
});

it("serializes mutations, commits selected files, and publishes branch changes", async () => {
  const { root, scope, git } = await repositoryFixture(); const changes: string[] = [];
  const service = new GitService(scope, { changed: () => { changes.push("changed"); } });
  await writeFile(join(root, "one.txt"), "one\n"); await writeFile(join(root, "two.txt"), "two\n");
  await Promise.all([service.handle("git.stage", { paths: ["one.txt"] }), service.handle("git.stage", { paths: ["two.txt"] })]);
  const committed = await service.handle("git.commit", { message: "selected", files: ["one.txt"] });
  expect(committed).toMatchObject({ sha: expect.stringMatching(/^[a-f0-9]{40}$/), branch: "workspace/fixture" });
  expect(await git("diff", "--cached", "--name-only")).toBe("two.txt");
  expect(await service.handle("git.renameBranch", { newName: "workspace/renamed" })).toEqual({ ok: true, branch: "workspace/renamed" });
  expect(await service.handle("git.branches", {})).toMatchObject({ branches: expect.arrayContaining([expect.objectContaining({ name: "workspace/renamed", isCheckedOut: true })]) });
  expect(changes.length).toBe(4);
});

it("keeps target selection metadata-only with a dirty checkout", async () => {
  const { root, scope, git } = await repositoryFixture(); let target = scope.workspace.baseBranch;
  const service = new GitService(scope, { baseBranch: () => target, setBaseBranch: async value => { target = value; } });
  const before = await git("rev-parse", "HEAD");
  await writeFile(join(root, "readme.txt"), "dirty\n");
  expect(await service.handle("git.changeTarget", { newTarget: "release" })).toEqual({ baseBranch: "release", conflicts: [] });
  expect(target).toBe("release"); expect(await git("rev-parse", "HEAD")).toBe(before);
  expect(await git("diff", "--", "readme.txt")).toContain("+dirty");
  expect(await git("stash", "list")).toBe("");
});

it("uses the deepest local/remote base and preserves contributions after merge", async () => {
  const { root, scope, git } = await repositoryFixture(); const service = new GitService(scope);
  await git("switch", "-c", "upstream");
  await writeFile(join(root, "upstream.txt"), "upstream\n"); await git("add", "."); await git("commit", "-m", "upstream");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  // Start a fresh feature at the newer remote base; the stale local main is
  // deliberately retained, exactly as a cloned Cloud Computer may contain it.
  await git("switch", "-c", "workspace/fresh");
  expect(await service.handle("git.changeCounts", {})).toMatchObject({ all: 0 });
  await writeFile(join(root, "feature.txt"), "feature\n"); await git("add", "."); await git("commit", "-m", "feature");
  expect(await service.handle("git.changeCounts", {})).toMatchObject({ all: 1 });
  await git("update-ref", "refs/heads/main", "HEAD");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  expect(await service.handle("git.changeCounts", {})).toMatchObject({ all: 1 });
  await git("switch", "main");
  expect(await service.handle("git.changeCounts", {})).toMatchObject({ all: 0 });
});

it("does not block status reads behind a pending mutation", async () => {
  const { root, scope } = await repositoryFixture(); const actual = commandRunner(root);
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = new GitService(scope, { run: async (program, args, options) => {
    if (args[0] === "add") { entered = true; await gate; }
    return actual(program, args, options);
  } });
  await writeFile(join(root, "new.txt"), "new\n");
  const mutation = service.handle("git.stage", { paths: ["new.txt"] });
  await expect.poll(() => entered).toBe(true);
  expect(await service.handle("git.status", {})).toMatchObject({ untracked: ["new.txt"] });
  release(); await mutation;
});

it("includes an unresolved UU path in every Changes scope and hasChanges", async () => {
  const { root, scope, git } = await repositoryFixture();
  await git("switch", "main");
  await writeFile(join(root, "readme.txt"), "upstream\n");
  await git("add", "."); await git("commit", "-m", "upstream");
  await git("switch", "workspace/fixture");
  await writeFile(join(root, "readme.txt"), "feature\n");
  await git("add", "."); await git("commit", "-m", "feature");
  await expect(git("merge", "main")).rejects.toThrow();
  expect(await git("status", "--porcelain=v1")).toBe("UU readme.txt");
  const service = new GitService(scope);
  expect(await service.handle("git.changeCounts", {})).toEqual({ all: 1, uncommitted: 1, staged: 1, unstaged: 1 });
  expect(await service.handle("git.hasChanges", {})).toEqual({ hasChanges: true });
});
