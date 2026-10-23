import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createMessage, type BridgeMessage } from "@zeros/protocol/messages";
import { commandRunner, type CommandRunner } from "./commands";
import { FileService } from "./files";
import { GitService } from "./git";
import { unsupported, WorkspaceError, type WorkerConfig, type WorkspaceScope } from "./scope";
import { CheckoutWatch } from "./watch";

export interface PrSummary { prNumber: number | null; prState: "draft" | "ready" | "merged" | "closed" | null; prUrl: string | null }
const EMPTY_PR: PrSummary = { prNumber: null, prState: null, prUrl: null };
interface State { workspaceId: string; root: string; baseBranch: string; configuredBase: string; createdAt: number }
export interface WorkspaceServiceOptions {
  run?: CommandRunner;
  publish?: (frame: BridgeMessage) => void;
  lookupPr?: (branch: string) => Promise<PrSummary>;
  watch?: boolean;
  historyDiff?: (params: Record<string, unknown>) => Promise<unknown>;
}

/** Native wire contract from engine/workspace/service.ts and git/types.ts,
 * snapshot be2801b9. One primary row; the renderer owns cloud key translation. */
export class WorkspaceService {
  readonly git: GitService;
  readonly files: FileService;
  private readonly run: CommandRunner;
  private readonly watcher?: CheckoutWatch;
  private state!: State;
  private metadataQueue = Promise.resolve();
  private signature?: string;
  private readonly prs = new Map<string, { value: PrSummary; time: number }>();
  private readonly prFlights = new Map<string, Promise<PrSummary>>();
  private prEpoch = 0;
  private disposed = false;

  private constructor(readonly scope: WorkspaceScope, private readonly directory: string, private readonly options: WorkspaceServiceOptions) {
    this.run = options.run ?? commandRunner(scope.root);
    this.git = new GitService(scope, { run: this.run, historyDiff: options.historyDiff, baseBranch: () => this.state.baseBranch,
      setBaseBranch: branch => this.update(state => ({ ...state, baseBranch: branch })), changed: () => this.invalidate(true) });
    this.files = new FileService(scope, this.run, () => this.invalidate(false));
    if (options.watch !== false) this.watcher = new CheckoutWatch(scope, this.run, content => this.poll(content));
  }

  static async open(scope: WorkspaceScope, directory: string, options: WorkspaceServiceOptions = {}): Promise<WorkspaceService> {
    const service = new WorkspaceService(scope, directory, options);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const state = JSON.parse(await readFile(join(directory, "workspace.json"), "utf8")) as State;
      if (state.workspaceId !== scope.workspace.id || state.root !== scope.root || typeof state.baseBranch !== "string" || typeof state.configuredBase !== "string" || !Number.isSafeInteger(state.createdAt)) throw new Error("Invalid workspace state.");
      service.state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "The saved workspace identity could not be loaded.");
      service.state = { workspaceId: scope.workspace.id, root: scope.root, baseBranch: scope.workspace.baseBranch, configuredBase: scope.workspace.baseBranch, createdAt: Date.now() };
      await service.update(state => state);
    }
    await service.configure(scope.workspace);
    await service.poll();
    await service.watcher?.start();
    return service;
  }

  configure(workspace: WorkerConfig["workspace"]): Promise<void> {
    return this.update(state => state.configuredBase === workspace.baseBranch ? state : { ...state, configuredBase: workspace.baseBranch, baseBranch: workspace.baseBranch });
  }

  async handle(op: string, params: Record<string, unknown>): Promise<unknown> {
    this.scope.assertId(params.workspaceId);
    for (const key of ["cwd", "folder", "repoRoot"]) if (params[key] !== undefined) this.scope.folder(params[key]);
    if (op.startsWith("git.")) return this.git.handle(op, params);
    if (op.startsWith("file.") || op.startsWith("fs.")) return this.files.handle(op, params);
    switch (op) {
      case "workspace.list": {
        if (params.archived === true || (params.status !== undefined && params.status !== "in-progress") || (params.repoSlug !== undefined && params.repoSlug !== this.scope.workspace.repository)) return { workspaces: [] };
        return { workspaces: [await this.row(params.withChanges === true)] };
      }
      case "workspace.get": return this.row();
      default: return unsupported();
    }
  }

  async poll(content = false): Promise<void> {
    if (this.disposed) return;
    const [branch, head, refs] = await Promise.all([this.git.branch(), this.git.head(),
      this.run("git", ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/", "refs/remotes/"], { readOnly: true }).then(result => result.stdout, () => ""),
    ]);
    const signature = JSON.stringify([branch, head, refs]), refsChanged = this.signature !== undefined && signature !== this.signature;
    this.signature = signature;
    if (refsChanged) { this.prEpoch++; this.prs.clear(); }
    if (refsChanged || content) this.publish(refsChanged);
  }
  async flush(): Promise<void> { await this.git.flush(); await this.metadataQueue; await this.watcher?.flush(); }
  githubChanged(): void { this.invalidate(true); }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; await this.watcher?.dispose(); await this.git.flush(); await this.metadataQueue; }

  private invalidate(refs: boolean): void {
    if (refs) { this.prEpoch++; this.prs.clear(); }
    this.publish(refs); this.watcher?.schedule(true);
  }
  private publish(gitRefsChanged: boolean): void {
    if (!this.disposed) this.options.publish?.(createMessage({ type: "DB_CHANGED", source: "engine", kinds: ["workspaces"], workspaceIds: [this.scope.workspace.id], ...(gitRefsChanged ? { gitRefsChanged: true } : {}) }));
  }

  private async row(withChanges = false, retries = 2): Promise<Record<string, unknown>> {
    const branch = await this.git.branch(), pr = await this.pr(branch);
    if (await this.git.branch() !== branch) {
      if (retries) return this.row(withChanges, retries - 1);
      throw new WorkspaceError("GIT_STATE_CHANGED", "The branch changed while reading it. Try again.");
    }
    const present = await this.git.head() !== null;
    const hasChanges = withChanges ? (await this.git.handle("git.hasChanges", {}) as { hasChanges: boolean }).hasChanges : undefined;
    return { id: this.scope.workspace.id, canonicalId: this.scope.workspace.id, path: this.scope.root, repoRoot: this.scope.root,
      repoSlug: this.scope.workspace.repository, branch, baseBranch: this.state.baseBranch, status: "in-progress", kind: "code", viewMode: "code",
      placement: "cloud", organizationId: this.scope.workspace.organizationId, createdAt: this.state.createdAt, archivedAt: null, stashRef: null,
      agentId: null, lastActiveAt: null, present, ...pr, ...(withChanges ? { hasChanges } : {}) };
  }

  private async pr(branch: string): Promise<PrSummary> {
    if (branch === "HEAD") return EMPTY_PR;
    const cached = this.prs.get(branch); if (cached && Date.now() - cached.time < 30_000) return cached.value;
    const key = `${this.prEpoch}:${branch}`, existing = this.prFlights.get(key); if (existing) return existing;
    const epoch = this.prEpoch;
    const pending = (this.options.lookupPr ? this.options.lookupPr(branch) : this.lookupPr(branch)).catch(() => cached?.value ?? EMPTY_PR).then(value => {
      if (this.prEpoch === epoch) { this.prs.set(branch, { value, time: Date.now() }); if (this.prs.size > 32) this.prs.delete(this.prs.keys().next().value!); }
      return value;
    }).finally(() => { this.prFlights.delete(key); });
    this.prFlights.set(key, pending); return pending;
  }
  private async lookupPr(branch: string): Promise<PrSummary> {
    const { stdout } = await this.run("gh", ["pr", "view", branch, "--repo", this.scope.workspace.repository, "--json", "number,state,url,isDraft"], { readOnly: true, timeout: 15_000, maxBuffer: 128 * 1024 });
    const result: unknown = JSON.parse(stdout);
    if (!result || typeof result !== "object") return EMPTY_PR;
    const raw = result as Record<string, unknown>;
    if (!Number.isSafeInteger(raw.number) || typeof raw.url !== "string" || !raw.url.startsWith("https://github.com/")) return EMPTY_PR;
    const prState = raw.state === "MERGED" ? "merged" : raw.state === "CLOSED" ? "closed" : raw.isDraft === true ? "draft" : "ready";
    return { prNumber: raw.number as number, prState, prUrl: raw.url };
  }

  private update(update: (state: State) => State): Promise<void> {
    const pending = this.metadataQueue.then(async () => {
      const state = update(this.state), path = join(this.directory, "workspace.json"), temp = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temp, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
        await rename(temp, path);
        const directory = await open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); }
        this.state = state;
      } finally { await rm(temp, { force: true }).catch(() => {}); }
    });
    this.metadataQueue = pending.catch(() => {}); return pending;
  }
}
