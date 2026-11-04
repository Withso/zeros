import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { GitService, isGitMutation } from "../git";
import { commandRunner } from "../commands";
import { repositoryFixture } from "./repository-fixture";

it.each(["soft", "mixed", "hard"])("preserves Local %s reset semantics", async mode => {
  const { root, scope, git } = await repositoryFixture(), service = new GitService(scope);
  const target = await git("rev-parse", "HEAD");
  await writeFile(join(root, "readme.txt"), "committed\n"); await git("commit", "-am", "second");
  await writeFile(join(root, "readme.txt"), "staged\n"); await git("add", "readme.txt");
  await writeFile(join(root, "readme.txt"), "working\n"); await writeFile(join(root, "untracked.txt"), "keep\n");
  expect(await service.handle("git.reset", { ref: target, mode, confirm: mode === "hard" })).toEqual({ ok: true });
  expect(await git("rev-parse", "HEAD")).toBe(target);
  expect(await git("branch", "--show-current")).toBe("workspace/fixture");
  expect(await git("show", ":readme.txt")).toBe(mode === "soft" ? "staged" : "initial");
  expect(await readFile(join(root, "readme.txt"), "utf8")).toBe(mode === "hard" ? "initial\n" : "working\n");
  expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("keep\n");
});

it.each([
  { mode: "merge" }, { mode: "keep" }, { mode: "hard" }, { mode: "hard", confirm: "true" },
  { mode: "mixed", ref: "--hard" }, { mode: "soft", ref: "HEAD\0ignored" },
])("refuses invalid reset before any Git invocation: %j", async params => {
  const { root, scope } = await repositoryFixture(), run = vi.fn(commandRunner(root));
  await writeFile(join(root, "readme.txt"), "preserve\n");
  await expect(new GitService(scope, { run }).handle("git.reset", params)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(run).not.toHaveBeenCalled();
  expect(await readFile(join(root, "readme.txt"), "utf8")).toBe("preserve\n");
});

it.each([undefined, false])("restores literal paths from a ref and preserves unrelated staging (staged=%s)", async staged => {
  const { root, scope, git } = await repositoryFixture(), service = new GitService(scope);
  const name = ":(glob)*.txt";
  await writeFile(join(root, name), "first\n"); await git("add", "--", `:(literal)${name}`); await git("commit", "-m", "literal first");
  const source = await git("rev-parse", "HEAD");
  await writeFile(join(root, name), "second\n"); await git("add", "--", `:(literal)${name}`); await git("commit", "-m", "literal second");
  await writeFile(join(root, "readme.txt"), "unrelated staged\n"); await git("add", "readme.txt");
  await writeFile(join(root, "readme.txt"), "unrelated work\n"); await writeFile(join(root, name), "dirty\n");
  expect(await service.handle("git.restore", { paths: [name], source, ...(staged === undefined ? {} : { staged }) })).toEqual({ ok: true });
  expect(await readFile(join(root, name), "utf8")).toBe("first\n");
  expect(await git("show", `:${name}`)).toBe(staged === false ? "second" : "first");
  expect(await readFile(join(root, "readme.txt"), "utf8")).toBe("unrelated work\n");
  expect(await git("show", ":readme.txt")).toBe("unrelated staged");
});

it.each([
  { paths: [], source: "HEAD" }, { paths: ["../outside"], source: "HEAD" },
  { paths: [".git/config"], source: "HEAD" }, { paths: ["--help"], source: "HEAD" },
  { paths: ["readme.txt"], source: "--worktree" }, { paths: ["readme.txt"], source: "" },
])("refuses invalid restore before mutation: %j", async params => {
  const { root, scope } = await repositoryFixture(), run = vi.fn(commandRunner(root));
  await expect(new GitService(scope, { run }).handle("git.restore", params)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(run).not.toHaveBeenCalled();
});

it("lists full local refs without tag collisions or foreign worktree paths", async () => {
  const { directory, root, scope, git } = await repositoryFixture();
  await git("tag", "main"); await git("branch", "side"); await git("branch", "other");
  await git("worktree", "add", join(directory, "other-checkout"), "other");
  const result = await new GitService(scope).handle("git.listAllBranches", { repoRoot: root, repoSlug: "Owner/Project" }) as Array<Record<string, unknown>>;
  expect(result.map(row => row.name).sort()).toEqual(["main", "other", "side", "workspace/fixture"]);
  expect(result.find(row => row.name === "workspace/fixture")).toMatchObject({ isCheckedOut: true, worktreePath: root, origin: "zeros", prUrl: null });
  expect(result.find(row => row.name === "other")).toMatchObject({ isCheckedOut: true, worktreePath: null, origin: "unknown" });
  expect(result.every(row => row.worktreePath === null || row.worktreePath === root)).toBe(true);
});

it("retains a valid pipe-containing branch name and commit identity in the full branch list", async () => {
  const { scope, git } = await repositoryFixture();
  const name = "topic|review";
  await git("branch", name);
  const sha = await git("rev-parse", `refs/heads/${name}`), service = new GitService(scope);
  expect(await service.handle("git.repoBranchCatalog", {})).toMatchObject({ branches: expect.arrayContaining([{ name, lastCommitDate: expect.any(Number) }]) });
  const rows = await service.handle("git.listAllBranches", {}) as Array<Record<string, unknown>>;
  expect(rows.find(row => row.name === name)).toMatchObject({ name, tipSha: sha, isCheckedOut: false, worktreePath: null });
});

it("keeps a local catalog instant, falls back before fetch, and refreshes spaced remote paths explicitly", async () => {
  const { directory, root, scope, git } = await repositoryFixture();
  const remote = join(directory, "remote with spaces.git"); await git("init", "--bare", "--initial-branch=main", remote);
  await git("remote", "add", "origin", remote); await git("remote", "add", "github", "https://github.com/Owner/Project.git");
  const run = vi.fn(commandRunner(root)), service = new GitService(scope, { run, baseBranch: () => "chosen-base" });
  const before = await service.handle("git.repoBranchCatalog", { repoRoot: root }) as Record<string, unknown>;
  expect(before).toMatchObject({ remoteExists: true, effectiveRemote: "origin", effectiveBase: "chosen-base", baseExplicit: true, branchSource: "local", listedRemote: null });
  expect(before.remotes).toEqual([{ name: "github", url: "https://github.com/Owner/Project.git", isGitHub: true }, { name: "origin", url: remote, isGitHub: false }]);
  expect(run.mock.calls.some(([, args]) => ["fetch", "ls-remote"].includes(args[0]))).toBe(false);
  await git("push", "origin", "main"); await git("update-ref", "-d", "refs/remotes/origin/main");
  await git("tag", "main"); await git("branch", "origin/main");
  const after = await service.handle("git.repoBranchCatalog", { repoRoot: root, fetch: true }) as Record<string, unknown>;
  expect(after).toMatchObject({ branchSource: "remote", listedRemote: "origin", detectedDefault: "main", effectiveBase: "chosen-base", branches: [{ name: "main", lastCommitDate: expect.any(Number) }] });
  expect(run.mock.calls.find(([, args]) => args[0] === "fetch")?.[2]).toMatchObject({ timeout: 8000 });
  expect(await service.handle("git.repoBranchCatalog", { repoRoot: root, remote: "absent" })).toMatchObject({ branchSource: "local", listedRemote: null, remoteExists: false });
});

it("serializes restore/reset and catalog refresh while plain catalog reads remain independent", async () => {
  const { root, scope } = await repositoryFixture(), actual = commandRunner(root);
  let entered = false, released = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run = vi.fn(async (program: Parameters<typeof actual>[0], args: string[], options?: Parameters<typeof actual>[2]) => {
    if (args[0] === "restore") { entered = true; await gate; return { stdout: "", code: 0 }; }
    if (args[0] === "reset") { expect(released).toBe(true); return { stdout: "", code: 0 }; }
    return actual(program, args, options);
  });
  const changed = vi.fn(), service = new GitService(scope, { run, changed });
  const first = service.handle("git.restore", { paths: ["readme.txt"], source: "HEAD" });
  const second = service.handle("git.reset", { mode: "mixed" });
  const fresh = service.handle("git.repoBranchCatalog", { fetch: true });
  const all = Promise.allSettled([first, second, fresh]);
  try {
    await expect.poll(() => entered).toBe(true);
    expect(await service.handle("git.repoBranchCatalog", {})).toMatchObject({ branchSource: "local" });
    expect(run.mock.calls.filter(([, args]) => args[0] === "reset")).toHaveLength(0);
    expect(changed).not.toHaveBeenCalled();
  } finally { released = true; release(); }
  expect((await all).every(result => result.status === "fulfilled")).toBe(true);
  expect(changed).toHaveBeenCalledTimes(3);
  expect(isGitMutation("git.repoBranchCatalog", { fetch: true })).toBe(true);
  expect(isGitMutation("git.repoBranchCatalog", { fetch: false })).toBe(false);
});
