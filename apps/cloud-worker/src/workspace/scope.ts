import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CloudV2ControlFrame } from "@zeros/protocol/cloud-v2-relay";

export type WorkerConfig = Extract<CloudV2ControlFrame, { t: "config" }>;

export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export const unsupported = (): never => { throw new WorkspaceError("CLOUD_V2_UNSUPPORTED", "This operation is not available in cloud workspaces yet."); };
export function reqString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0")) throw new WorkspaceError("VALIDATION_FAILED", `Invalid ${key}.`);
  return value;
}

export type WorkerRepository = NonNullable<WorkerConfig["workspace"]["repositories"]>[number];

/** The renderer maps cloud keys to native paths before forwarding frames.
 * Keep a separate exact owner/placement key for durable worker isolation.
 *
 * A workspace of several repositories (workspace-repositories-v1) has a root,
 * the project folder, holding each repository's checkout. `root` is always
 * the first repository's checkout (Git runs there, as before); `workspaceRoot`
 * is where agents and terminals start; each repository has its own scope
 * (forRepository) whose root is its checkout. */
export class WorkspaceScope {
  readonly key: string;
  readonly root: string;
  readonly workspaceRoot: string;
  readonly repositories: readonly WorkerRepository[];
  private readonly folders: ReadonlySet<string>;
  constructor(readonly workspace: WorkerConfig["workspace"], within?: readonly string[]) {
    if (!isAbsolute(workspace.checkoutPath) || (workspace.root !== undefined && !isAbsolute(workspace.root)))
      throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Invalid workspace checkout.");
    this.key = `cloud://${workspace.organizationId}/${workspace.id}`;
    this.root = resolve(workspace.checkoutPath);
    this.workspaceRoot = workspace.root ? resolve(workspace.root) : this.root;
    const { root: _root, repositories, ...first } = workspace;
    this.repositories = repositories ?? [{ repository: first.repository, checkoutPath: first.checkoutPath, branch: first.branch, baseBranch: first.baseBranch,
      ...(first.github ? { github: first.github } : {}), ...(first.baseCommit ? { baseCommit: first.baseCommit } : {}),
      ...(first.setup !== undefined ? { setup: first.setup } : {}), ...(first.setupScript ? { setupScript: first.setupScript } : {}) }];
    const checkouts = this.repositories.map(entry => resolve(entry.checkoutPath));
    if (checkouts[0] !== this.root || this.repositories[0]!.repository !== workspace.repository || new Set(checkouts).size !== checkouts.length
      || checkouts.some(path => this.workspaceRoot !== this.root && relative(this.workspaceRoot, path).split(sep).length !== 1))
      throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Invalid workspace checkout.");
    this.folders = new Set([this.root, this.workspaceRoot, ...checkouts, ...(within ?? [])]);
  }

  /** Whether the workspace holds several repositories. */
  get several(): boolean { return this.repositories.length > 1; }

  /** One repository's own scope: its checkout is the root. */
  forRepository(entry: WorkerRepository): WorkspaceScope {
    const { root: _root, repositories: _repositories, ...rest } = this.workspace;
    const { github, baseCommit, setup, setupScript } = entry;
    const { github: _github, baseCommit: _baseCommit, setup: _setup, setupScript: _setupScript, ...shared } = rest;
    return new WorkspaceScope({ ...shared, repository: entry.repository, checkoutPath: entry.checkoutPath, branch: entry.branch, baseBranch: entry.baseBranch,
      ...(github ? { github } : {}), ...(baseCommit ? { baseCommit } : {}), ...(setup !== undefined ? { setup } : {}), ...(setupScript ? { setupScript } : {}) });
  }

  /** The workspace root's scope, for agents, terminals and chats: paths are
   * relative to the project folder, and each repository's folder is accepted. */
  atRoot(): WorkspaceScope {
    if (this.workspaceRoot === this.root) return this;
    const { root: _root, repositories: _repositories, github: _github, baseCommit: _baseCommit, setup: _setup, setupScript: _setupScript, ...shared } = this.workspace;
    return new WorkspaceScope({ ...shared, checkoutPath: this.workspaceRoot }, this.repositories.map(entry => resolve(entry.checkoutPath)));
  }

  /** The repository a request names (`repository`), or whose checkout its repoRoot, cwd or folder is; undefined for the first. */
  repositoryFor(params: Record<string, unknown>): WorkerRepository | undefined {
    // A named repository must be one of this workspace's own (GitHub compares names
    // case-insensitively), with one repository as with several: never served by another.
    if (params.repository !== undefined) {
      const name = typeof params.repository === "string" ? params.repository.toLowerCase() : null;
      const named = this.repositories.find(entry => entry.repository.toLowerCase() === name);
      if (!named) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "This request belongs to another workspace.");
      return this.several ? named : undefined;
    }
    if (!this.several) return undefined;
    for (const key of ["repoRoot", "cwd", "folder"]) {
      const value = params[key];
      if (typeof value !== "string" || !isAbsolute(value)) continue;
      const match = this.repositories.find(entry => resolve(entry.checkoutPath) === resolve(value));
      if (match) return match;
    }
    return undefined;
  }

  folder(value: unknown, optional = false): string {
    if (optional && value === undefined) return this.root;
    if (value === this.key) return this.root;
    if (typeof value === "string" && isAbsolute(value) && this.folders.has(resolve(value))) return resolve(value);
    throw new WorkspaceError("WORKSPACE_NOT_FOUND", "This request belongs to another workspace.");
  }
  assertId(value: unknown): void {
    if (value !== undefined && value !== this.workspace.id && value !== this.key) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "This request belongs to another workspace.");
  }

  /** Native wire values may be absolute or repo-relative. Git and file result
   * arrays use relative paths; only typed cwd/root fields use absolute paths. */
  path(value: unknown, allowRoot = false): string {
    if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0") || value.startsWith("cloud://")) throw new WorkspaceError("VALIDATION_FAILED", "Invalid workspace path.");
    const target = resolve(this.root, value);
    const rel = relative(this.root, target);
    if ((!allowRoot && !rel) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep).includes(".git")) throw new WorkspaceError("VALIDATION_FAILED", "The path is outside the workspace files.");
    return target;
  }

  relative(value: unknown, allowRoot = false): string { return relative(this.root, this.path(value, allowRoot)); }
}
