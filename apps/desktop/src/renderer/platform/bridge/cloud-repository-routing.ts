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
  // A repository root (branch catalogs, init, publish, owner avatar) is one checkout; a workspace of several has none to name.
  const repoRoot = parseCloudWorkspaceKey(params.repoRoot);
  if (repoRoot && layout(repoRoot)) throw new Error("This isn't available for a workspace of several repositories.");
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
  const single = ["path", "filePath", "oldFilePath"].filter(field => typeof params[field] === "string");
  const lists = ["paths", "files"].filter(field => Array.isArray(params[field]));
  if (op.startsWith("git.") && (single.length || lists.length)) {
    const named = [...single.map(field => params[field] as string),
      ...lists.flatMap(field => (params[field] as unknown[]).filter((value): value is string => typeof value === "string"))];
    const folders = new Set(named.map(path => split(path).folder));
    const entry = folders.size === 1 ? byFolder([...folders][0]!) : undefined;
    if (!entry || named.some(path => !split(path).rest)) throw new Error("Choose files inside one of the workspace's repositories.");
    const strip = (path: string) => split(path).rest;
    const routed = { ...params, workspaceId, repository: entry.repository,
      ...Object.fromEntries(single.map(field => [field, strip(params[field] as string)])),
      ...Object.fromEntries(lists.map(field => [field, (params[field] as unknown[]).map(value => typeof value === "string" ? strip(value) : value)])) };
    // Asked in the project folder, answered in it: the reply's paths get the repository's folder back.
    return { kind: "each", requests: [{ folder: entry.folder, params: routed }], merge: ([result]) => inFolder(result, entry.folder) };
  }
  // The project folder's status: every repository's, each path under its folder.
  if (op === "git.status") {
    return {
      kind: "each",
      requests: found.repositories.map(entry => ({ folder: entry.folder, params: { ...params, workspaceId, repository: entry.repository } })),
      merge: results => {
        const rows = results.map((result, index) => inFolder(result, found.repositories[index]!.folder) as Params ?? {});
        const all = (field: string) => rows.flatMap(row => Array.isArray(row[field]) ? row[field] as unknown[] : []);
        // The project folder has no tracking of its own: one repository's ahead, behind,
        // upstream and branch summary are omitted (unknown), never shown as the folder's.
        const { ahead: _ahead, behind: _behind, upstream: _upstream, summary: _summary, shallow: _shallow, ...first } = rows[0] ?? {};
        const operation = rows.map(row => row.conflictState).find(state => state != null && state !== "none");
        return { ...first, staged: all("staged"), unstaged: all("unstaged"), conflicted: all("conflicted"), untracked: all("untracked"),
          ...(operation !== undefined ? { conflictState: operation } : {}),
          ...(rows.some(row => row.shallow === true) ? { shallow: true } : {}) };
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

/** A repository's reply with its paths in the project folder: status changes
 * and untracked paths, a diff's file list, and the paths a clean removed. */
function inFolder<T>(result: T, folder: string): T | Params {
  if (!result || typeof result !== "object") return result;
  const row = result as Params;
  const at = (path: unknown) => typeof path === "string" ? `${folder}/${path}` : path;
  const change = (value: unknown) => value && typeof value === "object"
    ? { ...value as Params, ...("path" in (value as Params) ? { path: at((value as Params).path) } : {}),
      ...(typeof (value as Params).oldPath === "string" ? { oldPath: at((value as Params).oldPath) } : {}) } : value;
  const out: Params = { ...row };
  for (const field of ["staged", "unstaged", "conflicted", "files"]) if (Array.isArray(row[field])) out[field] = (row[field] as unknown[]).map(change);
  for (const field of ["untracked", "removed"]) if (Array.isArray(row[field])) out[field] = (row[field] as unknown[]).map(at);
  return out;
}
