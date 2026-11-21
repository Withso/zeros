// A cloud workspace of several repositories is rooted at its project folder:
// each repository is a folder of the workspace, and its key
// (`cloud://<org>/<workspace>/<folder>`) is what its Git, pull request and file
// requests target. The worker serves each repository from its own checkout and
// picks it by name, so a request for a repository's key goes out on the
// workspace's key with `repository` set, and a file path inside a repository's
// folder goes out relative to that repository. A project-wide file listing is
// read from every repository and returned with each repository's folder in
// front. A workspace of one repository is never rewritten.
import { cloudWorkspaceKey, parseCloudWorkspaceKey, type CloudWorkspaceTarget } from "./cloud-workspace-key";

export interface CloudRepositoryLayout {
  /** In order, the first being the workspace's own repository. */
  repositories: readonly { repository: string; folder: string }[];
}

let layouts = new Map<string, CloudRepositoryLayout>();

/** The catalog publishes every readable workspace of several repositories. */
export function publishCloudRepositoryLayouts(next: ReadonlyMap<string, CloudRepositoryLayout>): void {
  layouts = new Map(next);
}

export function cloudRepositoryLayout(target: CloudWorkspaceTarget): CloudRepositoryLayout | undefined {
  return layouts.get(cloudWorkspaceKey(target));
}

/** A workspace key's repository keys (`<key>/<folder>`); none for one repository or another key. */
export function cloudRepositoryTargets(value: string): string[] {
  const key = parseCloudWorkspaceKey(value);
  if (!key || key.relativePath) return [];
  const root = cloudWorkspaceKey(key);
  return cloudRepositoryLayout(key)?.repositories.map(entry => `${root}/${entry.folder}`) ?? [];
}

type Params = Record<string, unknown>;
export type CloudRepositoryRoute =
  | { kind: "same" }
  | { kind: "one"; params: Params }
  /** Read from each repository; `merge` puts the replies together in the project folder. */
  | { kind: "each"; requests: { folder: string; params: Params }[]; merge(results: unknown[]): unknown };

/** Ops whose `path` (or `dir`) is a file path in the workspace's files. */
const PATH_OPS = new Set(["file.read", "file.readRange", "file.write"]);
const LISTINGS = new Set(["file.tree", "file.ignored"]);

function split(path: string): { folder: string; rest: string } {
  const at = path.indexOf("/");
  return at < 0 ? { folder: path, rest: "" } : { folder: path.slice(0, at), rest: path.slice(at + 1) };
}

/** How a request on a workspace of several repositories goes out; `same` for every other request. */
export function cloudRepositoryRoute(op: string, params: Params, layout: (target: CloudWorkspaceTarget) => CloudRepositoryLayout | undefined = cloudRepositoryLayout): CloudRepositoryRoute {
  const key = parseCloudWorkspaceKey(params.workspaceId);
  if (!key) return { kind: "same" };
  const found = layout(key);
  if (!found) return { kind: "same" };
  const workspaceId = cloudWorkspaceKey(key);
  const byFolder = (folder: string) => found.repositories.find(entry => entry.folder === folder);
  if (key.relativePath) {
    // A repository's own key: only a repository folder itself is a target.
    const entry = byFolder(key.relativePath);
    if (!entry) throw new Error("This folder is not one of the workspace's repositories.");
    return { kind: "one", params: { ...params, workspaceId, repository: entry.repository } };
  }
  if (typeof params.repository === "string") return { kind: "same" };
  if (PATH_OPS.has(op) && typeof params.path === "string") {
    const { folder, rest } = split(params.path);
    const entry = byFolder(folder);
    if (!entry || !rest) throw new Error("Choose a file inside one of the workspace's repositories.");
    return { kind: "one", params: { ...params, workspaceId, repository: entry.repository, path: rest } };
  }
  // A Git request about paths in the project folder: the repository that holds them, relative to it.
  if (op.startsWith("git.") && (typeof params.path === "string" || Array.isArray(params.paths))) {
    const paths = typeof params.path === "string" ? [params.path] : (params.paths as unknown[]).filter((value): value is string => typeof value === "string");
    const folders = new Set(paths.map(path => split(path).folder));
    const entry = folders.size === 1 ? byFolder([...folders][0]!) : undefined;
    if (!entry || paths.some(path => !split(path).rest)) throw new Error("Choose files inside one of the workspace's repositories.");
    const strip = (path: string) => split(path).rest;
    return { kind: "one", params: { ...params, workspaceId, repository: entry.repository,
      ...(typeof params.path === "string" ? { path: strip(params.path) } : {}),
      ...(Array.isArray(params.paths) ? { paths: paths.map(strip) } : {}),
      ...(typeof params.oldPath === "string" && split(params.oldPath).folder === entry.folder ? { oldPath: strip(params.oldPath) } : {}) } };
  }
  // The project folder's status: every repository's, each path under its folder.
  if (op === "git.status") {
    return {
      kind: "each",
      requests: found.repositories.map(entry => ({ folder: entry.folder, params: { ...params, workspaceId, repository: entry.repository } })),
      merge: results => {
        const rows = results.map(result => result && typeof result === "object" ? result as Params : {});
        const changes = (field: string) => rows.flatMap((row, index) => {
          const folder = found.repositories[index]!.folder;
          return (Array.isArray(row[field]) ? row[field] as Params[] : []).map(change => ({ ...change,
            ...(typeof change.path === "string" ? { path: `${folder}/${change.path}` } : {}),
            ...(typeof change.oldPath === "string" ? { oldPath: `${folder}/${change.oldPath}` } : {}) }));
        });
        return { ...rows[0], staged: changes("staged"), unstaged: changes("unstaged"), conflicted: changes("conflicted"),
          untracked: rows.flatMap((row, index) => (Array.isArray(row.untracked) ? row.untracked as unknown[] : [])
            .filter((path): path is string => typeof path === "string").map(path => `${found.repositories[index]!.folder}/${path}`)) };
      },
    };
  }
  if (op === "file.ignored" && typeof params.dir === "string" && params.dir) {
    const { folder, rest } = split(params.dir);
    const entry = byFolder(folder);
    if (!entry) throw new Error("Choose a folder inside one of the workspace's repositories.");
    const { dir: _dir, ...others } = params;
    return {
      kind: "each",
      requests: [{ folder, params: { ...others, workspaceId, repository: entry.repository, ...(rest ? { dir: rest } : {}) } }],
      merge: ([result]) => prefixed(result, "entries", folder),
    };
  }
  // The workspace as a whole: has-changes is any repository's, counts are every repository's summed.
  if (op === "git.hasChanges" || op === "git.changeCounts" || op === "git.changeLineCounts") {
    return {
      kind: "each",
      requests: found.repositories.map(entry => ({ folder: entry.folder, params: { ...params, workspaceId, repository: entry.repository } })),
      merge: results => {
        const rows = results.map(result => result && typeof result === "object" ? result as Params : {});
        if (op === "git.hasChanges") return { hasChanges: rows.some(row => row.hasChanges === true) };
        const fields = op === "git.changeCounts" ? ["all", "uncommitted", "staged", "unstaged"] : ["additions", "deletions"];
        return Object.fromEntries(fields.map(field => [field, rows.reduce((sum, row) => sum + (typeof row[field] === "number" ? row[field] as number : 0), 0)]));
      },
    };
  }
  if (LISTINGS.has(op)) {
    const field = op === "file.tree" ? "files" : "entries";
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    return {
      kind: "each",
      requests: found.repositories.map(entry => ({ folder: entry.folder, params: { ...params, workspaceId, repository: entry.repository } })),
      merge: results => {
        const merged: Params = {};
        const rows: string[] = [];
        const design: string[] = [];
        results.forEach((result, index) => {
          const folder = found.repositories[index]!.folder;
          const one = prefixed(result, field, folder);
          rows.push(...(one[field] as string[]));
          if (Array.isArray(one.designDirectories)) design.push(...(one.designDirectories as string[]));
        });
        merged[field] = limit !== undefined ? rows.slice(0, limit) : rows;
        if (op === "file.tree" && params.includeDesignDirectories === true) merged.designDirectories = design;
        return merged;
      },
    };
  }
  return { kind: "same" };
}

function prefixed(result: unknown, field: string, folder: string): Params {
  const row = result && typeof result === "object" ? result as Params : {};
  const list = Array.isArray(row[field]) ? (row[field] as unknown[]).filter((value): value is string => typeof value === "string") : [];
  const design = Array.isArray(row.designDirectories)
    ? (row.designDirectories as unknown[]).filter((value): value is string => typeof value === "string").map(path => `${folder}/${path}`) : undefined;
  return { ...row, [field]: list.map(path => `${folder}/${path}`), ...(design ? { designDirectories: design } : {}) };
}
