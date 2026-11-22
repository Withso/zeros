// A create's submodules (C4 change 5): what each repository's rows say, within the bound, and what it costs.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { readSubmoduleLevel, submoduleGitDirName, type SubmoduleLevel } from "./submodules.js";
import { resolveWorkspaceSubmodules, type WorkspaceSubmoduleRepository } from "./workspace-submodules.js";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const gitDir = (...paths: string[]) => paths.map(path => `modules/${submoduleGitDirName(path)}`).join("/");
const modules = (entries: [string, string][]) => entries.map(([name, url]) => `[submodule "${name}"]\n\tpath = ${name}\n\turl = ${url}\n`).join("");
type Tree = Record<string, Record<string, { gitmodules?: string; links?: Record<string, string> }>>;

/** A counting GitHub: contents reads from a tree, the creator's repository reads by name and by id. */
function github(tree: Tree, ids: (repository: string) => string, denied: ReadonlySet<string> = new Set()) {
  const requests: string[] = [];
  const http = { async json<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    requests.push(path);
    const [, id, file, ref] = /^\/repositories\/([^/]+)\/contents\/(.+)\?ref=([0-9a-f]+)$/.exec(path)! as unknown as [string, string, string, string];
    const at = tree[id]?.[ref];
    if (file === ".gitmodules") {
      if (at?.gitmodules === undefined) throw new HttpError(404, "not_found", "Not found");
      return schema.parse({ type: "file", size: at.gitmodules.length, encoding: "base64", content: Buffer.from(at.gitmodules).toString("base64") });
    }
    const link = at?.links?.[decodeURIComponent(file)];
    if (!link) throw new HttpError(404, "not_found", "Not found");
    return schema.parse({ type: "submodule", sha: link, path: decodeURIComponent(file) });
  } };
  const remembered = new Map<string, SubmoduleLevel>();
  const deps = {
    level: async (repository: { repository: string; repositoryId: string }, commit: string) => {
      const key = `${repository.repositoryId}:${commit}`;
      if (!remembered.has(key)) remembered.set(key, await readSubmoduleLevel(http, repository, commit));
      return remembered.get(key)!;
    },
    resolve: async (repository: string) => { requests.push(`/repos/${repository}`); return denied.has(repository) ? null : ids(repository); },
    readable: async (target: { repository: string; repositoryId: string }) => {
      requests.push(`/repositories/${target.repositoryId}`);
      if (denied.has(target.repository)) throw new HttpError(404, "not_found", "Not found");
    },
  };
  return { requests, deps, remembered };
}

const ROOT = { position: 0, repository: "acme/app", repositoryId: "1", fetchSubmodules: true };

describe("a create's submodules, per repository", () => {
  const tree: Tree = { "1": {
    [sha(1)]: { gitmodules: modules([["lib", "https://github.com/acme/lib"], ["secret", "git@github.com:acme/secret.git"]]), links: { lib: sha(10), secret: sha(20) } },
    [sha(2)]: { gitmodules: modules([["lib", "https://github.com/acme/lib"], ["new", "../new"]]), links: { lib: sha(11), new: sha(30) } } } };
  const ids = (repository: string) => ({ "acme/lib": "501", "acme/secret": "502", "acme/new": "503" })[repository]!;
  /** The project's copy, built at sha(1) by someone who could read both. */
  const copy: WorkspaceSubmoduleRepository["copy"] = { commit: sha(1), submodules: [
    { path: "lib", repository: "acme/lib", repositoryId: "501", commit: sha(10), gitDir: gitDir("lib"), fetched: true },
    { path: "secret", repository: "acme/secret", repositoryId: "502", commit: sha(20), gitDir: gitDir("secret"), fetched: true },
    { path: "gone", repository: "acme/gone", fetched: false, reason: "no access" }] };

  it("makes no request at all with the setting off", async () => {
    const gh = github(tree, ids);
    expect(await resolveWorkspaceSubmodules({ ...ROOT, fetchSubmodules: false, baseCommit: sha(2), copy }, gh.deps)).toEqual([]);
    expect(gh.requests).toEqual([]);
  });

  it("on the copy's commit takes the copy's plan, checking only that the creator can read each submodule it holds", async () => {
    const gh = github(tree, ids, new Set(["acme/secret"]));
    expect(await resolveWorkspaceSubmodules({ ...ROOT, baseCommit: sha(1), copy }, gh.deps)).toEqual([
      { position: 0, path: "lib", status: "fetch", repository: "acme/lib", repositoryId: "501", commit: sha(10), gitDir: gitDir("lib") },
      { position: 0, path: "secret", status: "skipped", repository: "acme/secret", repositoryId: "502", reason: "no access" },
      { position: 0, path: "gone", status: "skipped", repository: "acme/gone", reason: "no access" }]);
    expect(gh.requests).toEqual(["/repositories/501", "/repositories/502"]);
  });

  it("resolves a base that moved with the creator's access: the new plan, and the copy's other submodules checked by id", async () => {
    const gh = github(tree, ids);
    expect(await resolveWorkspaceSubmodules({ ...ROOT, baseCommit: sha(2), copy }, gh.deps)).toEqual([
      { position: 0, path: "lib", status: "fetch", repository: "acme/lib", repositoryId: "501", commit: sha(11), gitDir: gitDir("lib") },
      { position: 0, path: "new", status: "fetch", repository: "acme/new", repositoryId: "503", commit: sha(30), gitDir: gitDir("new") },
      // Still in the copy, no longer at this commit: readable, so the copy may be forked.
      { position: 0, path: "secret", status: "readable", repository: "acme/secret", repositoryId: "502" }]);
    // acme/lib is known from the copy: one check by id serves the plan and the copy alike. acme/new is resolved by name.
    expect(gh.requests.filter(path => !path.includes("/contents/")).sort()).toEqual(["/repos/acme/new", "/repositories/501", "/repositories/502"]);
  });

  it("past the bound keeps the copy's commits for what the creator can read, and says so", async () => {
    const gh = github(tree, ids);
    const hung = { ...gh.deps, level: () => new Promise<SubmoduleLevel>(() => {}), boundMs: 20 };
    expect(await resolveWorkspaceSubmodules({ ...ROOT, baseCommit: sha(2), copy }, hung)).toEqual([
      { position: 0, path: ".gitmodules", status: "skipped", reason: "kept at the project's build: GitHub could not be read in time" },
      { position: 0, path: "lib", status: "fetch", repository: "acme/lib", repositoryId: "501", commit: sha(10), gitDir: gitDir("lib") },
      { position: 0, path: "secret", status: "fetch", repository: "acme/secret", repositoryId: "502", commit: sha(20), gitDir: gitDir("secret") },
      { position: 0, path: "gone", status: "skipped", repository: "acme/gone", reason: "no access" }]);
    // An access check that doesn't answer in time counts as no access: skipped, and the copy is not forked.
    const slow = { ...gh.deps, readable: () => new Promise<void>(() => {}), boundMs: 20 };
    expect((await resolveWorkspaceSubmodules({ ...ROOT, baseCommit: sha(1), copy }, slow)).filter(row => row.path !== "gone")).toEqual([
      { position: 0, path: "lib", status: "skipped", repository: "acme/lib", repositoryId: "501", reason: "access could not be checked in time" },
      { position: 0, path: "secret", status: "skipped", repository: "acme/secret", repositoryId: "502", reason: "access could not be checked in time" }]);
  });

  it("on a GitHub failure keeps the copy's commits and names it; with no copy there is nothing to keep", async () => {
    const gh = github(tree, ids);
    const failing = { ...gh.deps, level: async () => { throw new HttpError(503, "github_unavailable", "GitHub could not be reached."); } };
    expect((await resolveWorkspaceSubmodules({ ...ROOT, baseCommit: sha(2), copy }, failing))[0])
      .toEqual({ position: 0, path: ".gitmodules", status: "skipped", reason: "kept at the project's build: GitHub could not be read" });
    expect(await resolveWorkspaceSubmodules({ ...ROOT, baseCommit: sha(2), copy: null }, failing))
      .toEqual([{ position: 0, path: ".gitmodules", status: "skipped", reason: "kept at the project's build: GitHub could not be read" }]);
  });
});

describe("what a create costs in GitHub requests", () => {
  /** N submodules at depth 1, or a chain to depth 3 under each; the root at sha(1) (the build's) and sha(2) (moved, same gitlinks). */
  function project(n: number, depth: 1 | 3) {
    const top = { gitmodules: modules(Array.from({ length: n }, (_v, i) => [`m${i}`, `https://github.com/acme/m${i}`] as [string, string])),
      links: Object.fromEntries(Array.from({ length: n }, (_v, i) => [`m${i}`, sha(100 + i)])) };
    const tree: Tree = { "1": { [sha(1)]: top, [sha(2)]: top } };
    for (let i = 0; i < n; i++) {
      tree[String(1000 + i)] = { [sha(100 + i)]: depth === 1 ? {} : { gitmodules: modules([["inner", `https://github.com/acme/inner${i}`]]), links: { inner: sha(200 + i) } } };
      if (depth === 3) {
        tree[String(2000 + i)] = { [sha(200 + i)]: { gitmodules: modules([["deep", `https://github.com/acme/deep${i}`]]), links: { deep: sha(300 + i) } } };
        tree[String(3000 + i)] = { [sha(300 + i)]: {} };
      }
    }
    const ids = (repository: string) => { const m = /^acme\/(m|inner|deep)(\d+)$/.exec(repository)!; return String({ m: 1000, inner: 2000, deep: 3000 }[m[1] as "m"] + Number(m[2])); };
    return github(tree, ids);
  }
  /** The copy the build made at sha(1), with its levels remembered, as a create finds it. */
  async function built(n: number, depth: 1 | 3) {
    const gh = project(n, depth);
    const rows = await resolveWorkspaceSubmodules({ ...ROOT, baseCommit: sha(1), copy: null }, gh.deps);
    const copy = { commit: sha(1), submodules: rows.filter(row => row.status === "fetch").map(row => ({ path: row.path, repository: row.repository!,
      repositoryId: row.repositoryId!, commit: row.commit!, gitDir: row.gitDir!, fetched: true })) };
    gh.requests.length = 0;
    return { gh, copy };
  }

  // Counted: per submodule the copy holds, one access check (the source authority's; cached for 10 minutes, so a
  // second create within that costs none of them). A moved base adds its own level (.gitmodules and one gitlink
  // read per path); deeper levels at unchanged gitlinks are remembered. Nothing remembered costs what the build does.
  it.each([
    [1, 1, 1, 3, 4], [8, 1, 8, 17, 25], [32, 1, 32, 65, 97],
    [1, 3, 3, 5, 9], [8, 3, 24, 33, 65], [32, 3, 32, 65, 129],
  ] as const)("%i submodules at depth %i: %i on the copy's commit, %i when the base moved, %i cold", async (n, depth, same, moved, cold) => {
    const unchanged = await built(n, depth);
    const rows = await resolveWorkspaceSubmodules({ ...ROOT, baseCommit: sha(1), copy: unchanged.copy }, unchanged.gh.deps);
    expect(rows.filter(row => row.status === "fetch")).toHaveLength(Math.min(32, n * depth));
    expect(unchanged.gh.requests).toHaveLength(same);
    expect(unchanged.gh.requests.some(path => path.includes("/contents/"))).toBe(false);

    const later = await built(n, depth);
    expect((await resolveWorkspaceSubmodules({ ...ROOT, baseCommit: sha(2), copy: later.copy }, later.gh.deps))
      .filter(row => row.status === "fetch")).toHaveLength(Math.min(32, n * depth));
    expect(later.gh.requests).toHaveLength(moved);

    const fresh = project(n, depth);
    await resolveWorkspaceSubmodules({ ...ROOT, baseCommit: sha(2), copy: null }, fresh.deps);
    expect(fresh.requests).toHaveLength(cold);
  });
});
