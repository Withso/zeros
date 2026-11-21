import { describe, expect, it } from "vitest";
import { cloudRepositoryRoute, type CloudRepositoryLayout } from "../cloud-repository-routing";
import { cloudRuntimeRoot } from "../open-cloud-v2-runtime";

const key = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const layout: CloudRepositoryLayout = { repositories: [{ repository: "withso/api", folder: "api" }, { repository: "withso/web", folder: "web" }] };
const several = () => layout, one = () => undefined;

describe("requests on a workspace of several repositories", () => {
  it("sends a repository's request on the workspace's key, naming the repository", () => {
    for (const op of ["git.status", "git.commit", "gh.prGet", "workspace.prepareGithub"])
      expect(cloudRepositoryRoute(op, { workspaceId: `${key}/web`, message: "m" }, several))
        .toEqual({ kind: "one", params: { workspaceId: key, repository: "withso/web", message: "m" } });
    expect(() => cloudRepositoryRoute("git.status", { workspaceId: `${key}/docs` }, several)).toThrow(/not one of the workspace's repositories/);
    expect(() => cloudRepositoryRoute("git.status", { workspaceId: `${key}/web/src` }, several)).toThrow();
  });

  it("sends a file path in a repository's folder to that repository, relative to it", () => {
    expect(cloudRepositoryRoute("file.read", { workspaceId: key, path: "web/src/app.ts" }, several))
      .toEqual({ kind: "one", params: { workspaceId: key, repository: "withso/web", path: "src/app.ts" } });
    expect(cloudRepositoryRoute("file.write", { workspaceId: `${key}/api`, path: "README.md", content: "x" }, several))
      .toEqual({ kind: "one", params: { workspaceId: key, repository: "withso/api", path: "README.md", content: "x" } });
    for (const path of ["AGENTS.md", "docs/x.md", "web"])
      expect(() => cloudRepositoryRoute("file.read", { workspaceId: key, path }, several)).toThrow();
  });

  it("lists the project folder from every repository, each under its folder", () => {
    const route = cloudRepositoryRoute("file.tree", { workspaceId: key, limit: 3, includeDesignDirectories: true }, several);
    if (route.kind !== "each") throw new Error("expected a fan-out");
    expect(route.requests.map(request => request.params)).toEqual([
      { workspaceId: key, limit: 3, includeDesignDirectories: true, repository: "withso/api" },
      { workspaceId: key, limit: 3, includeDesignDirectories: true, repository: "withso/web" }]);
    expect(route.merge([{ files: ["a.ts", "b.ts"], designDirectories: [] }, { files: ["c.ts"], designDirectories: ["Design"] }]))
      .toEqual({ files: ["api/a.ts", "api/b.ts", "web/c.ts"], designDirectories: ["web/Design"] });
    const ignored = cloudRepositoryRoute("file.ignored", { workspaceId: key, dir: "web/node_modules" }, several);
    if (ignored.kind !== "each") throw new Error("expected one repository");
    expect(ignored.requests).toEqual([{ folder: "web", params: { workspaceId: key, repository: "withso/web", dir: "node_modules" } }]);
    expect(ignored.merge([{ entries: ["node_modules/x"] }])).toEqual({ entries: ["web/node_modules/x"] });
  });

  it("sends a Git request about paths in a repository's folder to that repository, and reads the project folder's status from every one", () => {
    // One repository, asked in the project folder: its request relative to it, its reply back in the project folder.
    const one = (op: string, params: Record<string, unknown>) => {
      const route = cloudRepositoryRoute(op, { workspaceId: key, ...params }, several);
      if (route.kind !== "each" || route.requests.length !== 1) throw new Error("expected one repository");
      return { params: route.requests[0]!.params, merge: route.merge };
    };
    expect(one("git.diff", { path: "web/src/a.ts" }).params).toEqual({ workspaceId: key, repository: "withso/web", path: "src/a.ts" });
    expect(one("git.stage", { paths: ["api/a.ts", "api/b/c.ts"] }).params).toEqual({ workspaceId: key, repository: "withso/api", paths: ["a.ts", "b/c.ts"] });
    expect(() => cloudRepositoryRoute("git.stage", { workspaceId: key, paths: ["api/a.ts", "web/b.ts"] }, several)).toThrow();
    // The Diff view names its file filePath (and a rename's oldFilePath); commit names files.
    const diff = one("git.diff", { filePath: "web/new.ts", oldFilePath: "web/old.ts", against: "HEAD" });
    expect(diff.params).toEqual({ workspaceId: key, repository: "withso/web", filePath: "new.ts", oldFilePath: "old.ts", against: "HEAD" });
    expect(diff.merge([{ hunks: [], files: [{ path: "new.ts", oldPath: "old.ts" }] }])).toEqual({ hunks: [], files: [{ path: "web/new.ts", oldPath: "web/old.ts" }] });
    expect(one("git.commit", { message: "m", files: ["api/a.ts"] }).params).toEqual({ workspaceId: key, repository: "withso/api", message: "m", files: ["a.ts"] });
    expect(one("git.clean", { paths: ["api/n.ts"] }).merge([{ removed: ["n.ts"] }])).toEqual({ removed: ["api/n.ts"] });
    expect(one("git.stage", { paths: ["api/a.ts"] }).merge([undefined])).toBeUndefined();
    const status = cloudRepositoryRoute("git.status", { workspaceId: key }, several);
    if (status.kind !== "each") throw new Error("expected a fan-out");
    expect(status.merge([
      { staged: [{ path: "a.ts", status: "added" }], unstaged: [], untracked: ["n.ts"], conflicted: [], conflictState: "none", ahead: 1 },
      { staged: [], unstaged: [{ path: "new.ts", oldPath: "old.ts", status: "renamed" }], untracked: [], conflicted: [], conflictState: "none" }]))
      .toEqual({ staged: [{ path: "api/a.ts", status: "added" }], unstaged: [{ path: "web/new.ts", oldPath: "web/old.ts", status: "renamed" }],
        untracked: ["api/n.ts"], conflicted: [], conflictState: "none", ahead: 1 });
    // A repository's own key is never fanned out: its paths stay its own.
    expect(cloudRepositoryRoute("git.status", { workspaceId: `${key}/web` }, several)).toMatchObject({ kind: "one" });
  });

  it("answers for the whole workspace from every repository: has-changes is any one's, counts are summed", () => {
    const each = (op: string) => {
      const route = cloudRepositoryRoute(op, { workspaceId: key }, several);
      if (route.kind !== "each") throw new Error("expected a fan-out");
      expect(route.requests.map(request => request.params.repository)).toEqual(["withso/api", "withso/web"]);
      return route.merge;
    };
    expect(each("git.hasChanges")([{ hasChanges: false }, { hasChanges: true }])).toEqual({ hasChanges: true });
    expect(each("git.hasChanges")([{ hasChanges: false }, {}])).toEqual({ hasChanges: false });
    expect(each("git.changeCounts")([{ all: 2, uncommitted: 1, staged: 1, unstaged: 0 }, { all: 3, uncommitted: 3, staged: 0, unstaged: 3 }]))
      .toEqual({ all: 5, uncommitted: 4, staged: 1, unstaged: 3 });
    expect(each("git.changeLineCounts")([{ additions: 48, deletions: 6 }, { additions: 12, deletions: 0 }])).toEqual({ additions: 60, deletions: 6 });
    // A repository's own key reads only that repository.
    expect(cloudRepositoryRoute("git.hasChanges", { workspaceId: `${key}/web` }, several)).toMatchObject({ kind: "one", params: { repository: "withso/web" } });
  });

  it("leaves a workspace of one repository, a Local workspace and an already named request alone", () => {
    expect(cloudRepositoryRoute("git.status", { workspaceId: key }, one)).toEqual({ kind: "same" });
    expect(cloudRepositoryRoute("file.read", { workspaceId: key, path: "web/x" }, one)).toEqual({ kind: "same" });
    expect(cloudRepositoryRoute("git.status", { workspaceId: "local-workspace" }, several)).toEqual({ kind: "same" });
    expect(cloudRepositoryRoute("git.status", { workspaceId: key, repository: "withso/web" }, several)).toEqual({ kind: "same" });
    // Other requests on the workspace's own key, with no repository: the worker's first repository, as a released desktop sends them.
    expect(cloudRepositoryRoute("git.log", { workspaceId: key }, several)).toEqual({ kind: "same" });
  });
});

describe("the runtime root of a cloud workspace", () => {
  const document = { root: "/home/user/zeros-app", repositories: [
    { repository: "withso/api", checkoutPath: "/home/user/zeros-app/api", branch: "b", baseBranch: "main" },
    { repository: "withso/web", checkoutPath: "/home/user/zeros-app/web", branch: "b", baseBranch: "main" }] };
  it("is the project folder only when the confirmed checkout is the first repository directly inside it", () => {
    expect(cloudRuntimeRoot(document, "/home/user/zeros-app/api")).toBe("/home/user/zeros-app");
    expect(cloudRuntimeRoot(document, "/home/user/zeros-app/web")).toBe("/home/user/zeros-app/web");
    expect(cloudRuntimeRoot({ root: "/home/user/other", repositories: document.repositories }, "/home/user/zeros-app/api")).toBe("/home/user/zeros-app/api");
    expect(cloudRuntimeRoot(undefined, "/home/user/withso/zeros")).toBe("/home/user/withso/zeros");
    expect(cloudRuntimeRoot({}, "/home/user/withso/zeros")).toBe("/home/user/withso/zeros");
  });
});
