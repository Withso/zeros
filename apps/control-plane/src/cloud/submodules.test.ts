import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpError } from "../authz.js";
import {
  composeSubmodulePlan, parseGitHubSubmoduleUrl, parseGitmodules, readSubmoduleLevel, resolveRelativeSubmoduleUrl,
  submoduleGitDirName, submoduleNameProblem, submodulePathProblem, type SubmoduleLevel,
} from "./submodules.js";

const sha = (n: number) => n.toString(16).padStart(40, "0");

describe("the .gitmodules parser (Git's config syntax, path and url only)", () => {
  it("reads quoted sections, the deprecated form, escapes, continuations and comments", () => {
    expect(parseGitmodules([
      "# a comment", "[submodule \"lib/a\"]", "\tpath = lib/a ; trailing", "\turl = https://github.com/acme/a.git",
      "[submodule \"q\\\"uote\"]", "  path = \"with  space\"", "  url = ../b",
      "[submodule.Legacy]", "path=legacy", "url = git@github.com:acme/legacy",
      "[submodule \"c\"]", "  path = c\\", "ont", "  url = https://github.com/acme/c", "  update = !rm -rf /", "  branch = main",
    ].join("\n"))).toEqual([
      { name: "lib/a", path: "lib/a", url: "https://github.com/acme/a.git" },
      { name: "q\"uote", path: "with  space", url: "../b" },
      { name: "legacy", path: "legacy", url: "git@github.com:acme/legacy" },
      { name: "c", path: "cont", url: "https://github.com/acme/c" },
    ]);
  });

  it("keeps the last value Git would list, and ignores other sections and includes", () => {
    expect(parseGitmodules("[include]\npath = /etc/passwd\n[core]\nfsmonitor = evil\n[submodule \"a\"]\npath = one\npath = two\nurl=https://github.com/a/a"))
      .toEqual([{ name: "a", path: "two", url: "https://github.com/a/a" }]);
  });

  it.each([
    ["an unterminated section", "[submodule \"a\"\npath = a"],
    ["a newline inside a subsection", "[submodule \"a\nb\"]\npath = a"],
    ["an unknown escape", "[submodule \"a\"]\npath = a\\q"],
    ["an unterminated quote", "[submodule \"a\"]\npath = \"a"],
    ["a variable before any section", "path = a\n"],
    ["a bad variable name", "[submodule \"a\"]\n1path = a"],
    ["a NUL", "[submodule \"a\"]\npath = a\0b"],
  ])("refuses %s, as git config would", (_name, text) => { expect(parseGitmodules(text)).toBeNull(); });
});

describe("Local's rules", () => {
  it("follows only plain github.com URLs, over either form", () => {
    expect(parseGitHubSubmoduleUrl("https://github.com/acme/app.git")).toEqual({ owner: "acme", repo: "app" });
    expect(parseGitHubSubmoduleUrl("https://github.com/acme/app/")).toEqual({ owner: "acme", repo: "app" });
    expect(parseGitHubSubmoduleUrl("git@github.com:acme/app.git")).toEqual({ owner: "acme", repo: "app" });
    for (const url of ["https://user@github.com/acme/app", "https://github.com:443/acme/app", "https://GITHUB.com/acme/app", "http://github.com/acme/app",
      "ssh://git@github.com/acme/app", "file:///etc", "ext::sh -c id", "https://evil.example/acme/app", "https://github.com/acme/app?x=1",
      "https://github.com/acme/app#x", "https://github.com/acme/../../x", "https://github.com/-acme/app", "https://github.com/acme/app.git.git",
      "/local/path", "git@github.com:acme/app\n", "https://github.com/acme/a\\b"])
      expect(parseGitHubSubmoduleUrl(url), url).toBeNull();
  });

  it("resolves relative URLs against the parent and nowhere else", () => {
    expect(resolveRelativeSubmoduleUrl("../lib", { owner: "acme", repo: "app" })).toEqual({ owner: "acme", repo: "lib" });
    expect(resolveRelativeSubmoduleUrl("../../other/lib.git", { owner: "acme", repo: "app" })).toEqual({ owner: "other", repo: "lib" });
    expect(resolveRelativeSubmoduleUrl("../../../x", { owner: "acme", repo: "app" })).toBeNull();
    expect(resolveRelativeSubmoduleUrl("./x", { owner: "acme", repo: "app" })).toBeNull();
  });

  it("refuses unsafe paths and names", () => {
    expect(submodulePathProblem("lib/a")).toBeNull();
    for (const path of ["", "/abs", "../x", "a/../b", "a/./b", ".git", "a/.GIT", "a/.git. ", "git~1", "a/.Zeros/x", "a\\b", "a:b", "a\u0001b",
      "a/.g\u200cit", "x".repeat(1025)])
      expect(submodulePathProblem(path), JSON.stringify(path)).not.toBeNull();
    expect(submoduleNameProblem("a/b")).toBeNull();
    for (const name of ["", "../x", "a/../b", "a\\..\\b", "a\nb"]) expect(submoduleNameProblem(name), JSON.stringify(name)).not.toBeNull();
    expect(submoduleGitDirName("A")).not.toBe(submoduleGitDirName("a"));
    expect(submoduleGitDirName("a")).toMatch(/^[0-9a-f]{64}$/);
  });
});

/** A GitHub that answers contents reads from a map of repository → commit → files, and counts every request. */
function github(tree: Record<string, Record<string, { gitmodules?: string; links?: Record<string, string>; raw?: unknown }>>) {
  const requests: string[] = [];
  const http = {
    async json<T>(path: string, schema: z.ZodType<T>): Promise<T> {
      requests.push(path);
      const match = /^\/repositories\/([^/]+)\/contents\/(.+)\?ref=([0-9a-f]+)$/.exec(path)!;
      const [, id, file, ref] = match as unknown as [string, string, string, string];
      const at = tree[id]?.[ref];
      if (!at) throw new HttpError(404, "not_found", "Not found");
      if (file === ".gitmodules") {
        if (at.raw) return schema.parse(at.raw);
        if (at.gitmodules === undefined) throw new HttpError(404, "not_found", "Not found");
        const content = Buffer.from(at.gitmodules).toString("base64");
        return schema.parse({ type: "file", size: Buffer.byteLength(at.gitmodules), encoding: "base64", content });
      }
      const link = at.links?.[decodeURIComponent(file)];
      if (!link) throw new HttpError(404, "not_found", "Not found");
      return schema.parse({ type: "submodule", sha: link, path: decodeURIComponent(file) });
    },
  };
  return { http, requests };
}
const modules = (entries: [string, string, string][]) => entries.map(([name, path, url]) => `[submodule "${name}"]\n\tpath = ${path}\n\turl = ${url}\n`).join("");

describe("reading one level", () => {
  it("reads .gitmodules and one request per accepted path, and skips what Local skips", async () => {
    const { http, requests } = github({ "1": { [sha(1)]: {
      gitmodules: modules([["a", "lib/a", "https://github.com/acme/a"], ["b", "lib/b", "../b"], ["evil", "../x", "https://github.com/acme/x"],
        ["host", "h", "https://gitlab.com/acme/h"], ["dup", "LIB/A", "https://github.com/acme/d"], ["nolink", "n", "https://github.com/acme/n"]]),
      links: { "lib/a": sha(10), "lib/b": sha(11) } } } });
    const level = await readSubmoduleLevel(http, { repository: "acme/app", repositoryId: "1" }, sha(1));
    expect(level.entries).toEqual([
      { name: "a", path: "lib/a", repository: "acme/a", commit: sha(10) },
      { name: "b", path: "lib/b", repository: "acme/b", commit: sha(11) },
      { name: "evil", skipped: "path leaves the workspace" },
      { name: "host", path: "h", skipped: "only github.com submodules are followed" },
      { name: "dup", path: "LIB/A", skipped: "another submodule already uses this path" },
      { name: "nolink", path: "n", repository: "acme/n", skipped: "no submodule commit is recorded at this path" },
    ]);
    expect(requests).toEqual([`/repositories/1/contents/.gitmodules?ref=${sha(1)}`,
      ...["lib/a", "lib/b", "n"].map(path => `/repositories/1/contents/${path}?ref=${sha(1)}`)]);
  });

  it("uses no .gitmodules that is not a regular file, too large, unparseable or too long", async () => {
    const read = (raw: unknown) => readSubmoduleLevel(github({ "1": { [sha(1)]: { raw } } }).http, { repository: "acme/app", repositoryId: "1" }, sha(1));
    expect((await read({ type: "symlink", size: 10 })).notice).toBe(".gitmodules is not a regular file");
    expect((await read({ type: "file", size: 70_000, encoding: "base64", content: "" })).notice).toBe(".gitmodules is too large");
    expect((await read({ type: "file", size: 3, encoding: "base64", content: Buffer.from("[x").toString("base64") })).notice).toBe(".gitmodules could not be parsed");
    const many = modules(Array.from({ length: 257 }, (_v, n) => [`m${n}`, `m${n}`, `https://github.com/acme/m${n}`] as [string, string, string]));
    expect((await read({ type: "file", size: 10, encoding: "base64", content: Buffer.from(many).toString("base64") })).notice).toBe(".gitmodules declares too many submodules");
    expect(await readSubmoduleLevel(github({ "1": { [sha(1)]: {} } }).http, { repository: "acme/app", repositoryId: "1" }, sha(1))).toEqual({ entries: [] });
  });
});

describe("composing a plan per caller", () => {
  /** N submodules at depth 1, or a chain to depth 3 under each, over a counting GitHub with a repository GET per access check. */
  function project(n: number, depth: 1 | 3) {
    const tree: Parameters<typeof github>[0] = { "1": { [sha(1)]: { gitmodules: modules(Array.from({ length: n }, (_v, i) => [`m${i}`, `m${i}`, `https://github.com/acme/m${i}`] as [string, string, string])),
      links: Object.fromEntries(Array.from({ length: n }, (_v, i) => [`m${i}`, sha(100 + i)])) } } };
    for (let i = 0; i < n; i++) {
      const id = String(1000 + i);
      tree[id] = { [sha(100 + i)]: depth === 1 ? {} : { gitmodules: modules([["inner", "inner", `https://github.com/acme/inner${i}`]]), links: { inner: sha(200 + i) } } };
      if (depth === 3) {
        tree[String(2000 + i)] = { [sha(200 + i)]: { gitmodules: modules([["deep", "deep", `https://github.com/acme/deep${i}`]]), links: { deep: sha(300 + i) } } };
        tree[String(3000 + i)] = { [sha(300 + i)]: {} };
      }
    }
    const { http, requests } = github(tree);
    const ids = (repository: string) => { const m = /^acme\/(m|inner|deep)(\d+)$/.exec(repository)!; return String({ m: 1000, inner: 2000, deep: 3000 }[m[1] as "m"] + Number(m[2])); };
    const access = async (repository: string) => { requests.push(`/repos/${repository}`); return ids(repository); };
    return { requests, compose: (level = (r: { repository: string; repositoryId: string }, c: string) => readSubmoduleLevel(http, r, c)) =>
      composeSubmodulePlan({ root: { repository: "acme/app", repositoryId: "1", commit: sha(1) }, level, access }) };
  }

  // Cold: the top .gitmodules and one gitlink read per path; per submodule, its access check (a repository
  // read) and its own level (.gitmodules, then its gitlinks). A chain's last level is never read (depth 3).
  it.each([[1, 1, 4], [8, 1, 25], [32, 1, 97], [1, 3, 9], [8, 3, 65], [32, 3, 129]] as const)(
    "%i submodules at depth %i cost %i GitHub requests", async (n, depth, expected) => {
      const p = project(n, depth);
      const plan = await p.compose();
      expect(plan.submodules).toHaveLength(Math.min(32, depth === 1 ? n : n * 3));
      expect(p.requests).toHaveLength(expected);
    });

  it("reads a level only after access, and composes each caller's own tree from the same remembered levels", async () => {
    const remembered = new Map<string, SubmoduleLevel>(), reads: string[] = [];
    const { http } = github({ "1": { [sha(1)]: { gitmodules: modules([["a", "a", "https://github.com/acme/a"]]), links: { a: sha(2) } } },
      "10": { [sha(2)]: { gitmodules: modules([["n", "n", "https://github.com/secret/n"]]), links: { n: sha(3) } } }, "20": { [sha(3)]: {} } });
    const level = async (r: { repository: string; repositoryId: string }, c: string) => {
      const key = `${r.repositoryId}:${c}`;
      if (!remembered.has(key)) { reads.push(key); remembered.set(key, await readSubmoduleLevel(http, r, c)); }
      return remembered.get(key)!;
    };
    const root = { repository: "acme/app", repositoryId: "1", commit: sha(1) };
    // A personal project's member, without access to the nested repository, resolves first.
    const member = await composeSubmodulePlan({ root, level, access: async repository => repository === "acme/a" ? "10" : null });
    expect(member.submodules.map(entry => entry.path)).toEqual(["a"]);
    expect(member.skipped).toEqual([{ path: "a/n", repository: "secret/n", reason: "no access" }]);
    expect(reads).toEqual([`1:${sha(1)}`, `10:${sha(2)}`]);
    // An organization build with access then gets it: nothing about the member's access was remembered.
    const build = await composeSubmodulePlan({ root, level, access: async repository => ({ "acme/a": "10", "secret/n": "20" } as Record<string, string>)[repository] ?? null });
    expect(build.submodules.map(entry => [entry.path, entry.depth, entry.gitDir.split("/").length])).toEqual([["a", 1, 2], ["a/n", 2, 4]]);
    // And the reverse leaks nothing: a later caller without access is refused at the same point.
    const later = await composeSubmodulePlan({ root, level, access: async () => null });
    expect(later).toEqual({ submodules: [], skipped: [{ path: "a", repository: "acme/a", reason: "no access" }], notices: [] });
    expect(reads).toEqual([`1:${sha(1)}`, `10:${sha(2)}`, `20:${sha(3)}`]);
  });
});
