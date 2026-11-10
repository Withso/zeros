import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createMessage, type BridgeMessage } from "@zeros/protocol/messages";
import { commandRunner, type CommandRunner } from "./commands";
import { FileService } from "./files";
import { AttachmentTransfers } from "./attachments";
import { GitService } from "./git";
import { unsupported, WorkspaceError, type WorkerConfig, type WorkspaceScope } from "./scope";
import { CheckoutWatch } from "./watch";
import { listWorkspaceSkills } from "./skills";
import { GithubCheckoutReporter, type ReportGithubCheckout } from "./github-checkout";
import { reconcileGithubRemote } from "./github-remote";
import type { WorkerCodeReview } from "./code-review";
import { recordStartupTiming, type StartupTimingObserver } from "../startup-timings";
import { ResourceSampler } from "../resources/sampler";

export interface PrSummary { prNumber: number | null; prState: "draft" | "ready" | "merged" | "closed" | null; prUrl: string | null }
const EMPTY_PR: PrSummary = { prNumber: null, prState: null, prUrl: null };
interface State { workspaceId: string; root: string; baseBranch: string; configuredBase: string; createdAt: number }
export interface WorkspaceServiceOptions {
  run?: CommandRunner;
  publish?: (frame: BridgeMessage) => void;
  lookupPr?: (branch: string) => Promise<PrSummary>;
  watch?: boolean;
  historyDiff?: (params: Record<string, unknown>) => Promise<unknown>;
  reportGithubCheckout?: ReportGithubCheckout;
  nextCheckoutSequence?: () => number;
  codeReview?: WorkerCodeReview;
  pollingAllowed?(): boolean;
  activity?(): void;
  onStartupTiming?: StartupTimingObserver;
  resources?: Pick<ResourceSampler, "sample">;
}

/** Native wire contract from engine/workspace/service.ts and git/types.ts,
 * snapshot be2801b9. One primary row; the renderer owns cloud key translation. */
export class WorkspaceService {
  readonly git: GitService;
  private resources?: Pick<ResourceSampler, "sample">;
  readonly files: FileService;
  private readonly attachments: AttachmentTransfers;
  private readonly run: CommandRunner;
  private readonly watcher?: CheckoutWatch;
  private state!: State;
  private persistedStateJson?: string;
  private metadataQueue = Promise.resolve();
  private signature?: string;
  private refChange = 0;
  private publishedRefChange = 0;
  private checkoutFlight?: Promise<void>;
  private readonly prs = new Map<string, { value: PrSummary; time: number }>();
  private readonly prFlights = new Map<string, Promise<PrSummary>>();
  private prEpoch = 0;
  private disposed = false;
  private readonly githubCheckout?: GithubCheckoutReporter;
  private configurationEpoch = 0;
  private githubRepository?: string;

  private constructor(readonly scope: WorkspaceScope, private readonly directory: string, private readonly options: WorkspaceServiceOptions) {
    this.run = options.run ?? commandRunner(scope.root);
    this.git = new GitService(scope, { run: this.run, historyDiff: options.historyDiff, baseBranch: () => this.state.baseBranch,
      githubRepository: () => this.githubRepository ?? this.scope.workspace.repository,
      setBaseBranch: branch => this.update(state => ({ ...state, baseBranch: branch })), changed: () => this.invalidate(true) });
    this.files = new FileService(scope, this.run, () => this.invalidate(false));
    this.attachments = new AttachmentTransfers(scope, join(directory, "attachment-uploads"), () => this.invalidate(false));
    if (options.reportGithubCheckout) this.githubCheckout = new GithubCheckoutReporter(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const branch = await this.git.branch(), headSha = await this.git.head(), baseBranch = this.state.baseBranch;
        if (branch === await this.git.branch() && headSha === await this.git.head() && baseBranch === this.state.baseBranch)
          return { branch: branch === "HEAD" ? null : branch, headSha, baseBranch };
      }
      throw new WorkspaceError("GIT_STATE_CHANGED", "The checkout changed while confirming its branch.");
    }, options.reportGithubCheckout, options.nextCheckoutSequence);
    if (options.watch !== false) this.watcher = new CheckoutWatch(scope, this.run, content => this.poll(content), options);
  }

  static async open(scope: WorkspaceScope, directory: string, options: WorkspaceServiceOptions = {}): Promise<WorkspaceService> {
    const service = new WorkspaceService(scope, directory, options);
    try {
      const stateStarted = performance.now();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        const state = JSON.parse(await readFile(join(directory, "workspace.json"), "utf8")) as State;
        if (state.workspaceId !== scope.workspace.id || state.root !== scope.root || typeof state.baseBranch !== "string" || typeof state.configuredBase !== "string" || !Number.isSafeInteger(state.createdAt)) throw new Error("Invalid workspace state.");
        service.state = state;
        service.persistedStateJson = JSON.stringify(state);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "The saved workspace identity could not be loaded.");
        service.state = { workspaceId: scope.workspace.id, root: scope.root, baseBranch: scope.workspace.baseBranch, configuredBase: scope.workspace.baseBranch, createdAt: Date.now() };
        await service.update(state => state);
      }
      recordStartupTiming("worker_workspace_state", stateStarted, options.onStartupTiming);
      await service.configure(scope.workspace, options.onStartupTiming);
      const pollStarted = performance.now();
      await service.poll(false, { waitForCheckoutReport: false });
      recordStartupTiming("worker_workspace_poll", pollStarted, options.onStartupTiming);
      const watchStarted = performance.now();
      await service.watcher?.start();
      recordStartupTiming("worker_workspace_watch", watchStarted, options.onStartupTiming);
      return service;
    } catch (error) {
      await service.dispose().catch(() => {});
      throw error;
    }
  }

  async configure(workspace: WorkerConfig["workspace"], timing?: StartupTimingObserver): Promise<void> {
    const epoch = ++this.configurationEpoch;
    const metadataStarted = performance.now();
    await this.update(state => state.configuredBase === workspace.baseBranch ? state : { ...state, configuredBase: workspace.baseBranch, baseBranch: workspace.baseBranch });
    recordStartupTiming("worker_workspace_metadata", metadataStarted, timing);
    const remoteStarted = performance.now();
    if (workspace.github) await reconcileGithubRemote(this.scope.root,workspace.github,this.run,() => !this.disposed && epoch === this.configurationEpoch);
    recordStartupTiming("worker_workspace_remote", remoteStarted, timing);
    if (!this.disposed && epoch === this.configurationEpoch) this.githubRepository = workspace.github?.repository;
  }

  async handle(op: string, params: Record<string, unknown>): Promise<unknown> {
    this.scope.assertId(params.workspaceId);
    for (const key of ["cwd", "folder", "repoRoot"]) if (params[key] !== undefined) this.scope.folder(params[key]);
    if (op.startsWith("codeReview.")) return this.options.codeReview ? this.options.codeReview.handle(op, params) : unsupported();
    if (op.startsWith("git.")) return this.git.handle(op, params);
    if (op.startsWith("file.") || op.startsWith("fs.")) return this.files.handle(op, params);
    switch (op) {
      case "attachment.write": return this.attachments.write(params);
      case "workspace.prepareGithub": {
        if (!this.githubCheckout) return unsupported();
        const published = await this.git.handle("git.prepareGithub", params) as { branch: string; baseBranch: string; headSha: string };
        const confirmed = await this.githubCheckout.fresh();
        if (published.branch !== confirmed.branch || published.baseBranch !== confirmed.baseBranch || published.headSha !== confirmed.headSha)
          throw new WorkspaceError("GIT_STATE_CHANGED", "The branch changed after publication. Refresh before creating the pull request.");
        return published;
      }
      case "skills.list": return listWorkspaceSkills(this.scope, params.agentId);
      case "workspace.list": {
        if (params.archived === true || (params.status !== undefined && params.status !== "in-progress") || (params.repoSlug !== undefined && params.repoSlug !== this.scope.workspace.repository)) return { workspaces: [] };
        return { workspaces: [await this.row(params.withChanges === true)] };
      }
      case "workspace.get": return this.row();
      case "workspace.resources": return (this.resources ??= this.options.resources ?? new ResourceSampler(this.scope.root)).sample();
      default: return unsupported();
    }
  }

  async poll(content = false, options: { waitForCheckoutReport?: boolean } = {}): Promise<void> {
    if (this.disposed || this.options.pollingAllowed?.() === false) return;
    const [branch, head, refs] = await Promise.all([this.git.branch(), this.git.head(),
      this.run("git", ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/", "refs/remotes/"], { readOnly: true }).then(result => result.stdout, () => ""),
    ]);
    if (this.disposed) return;
    const signature = JSON.stringify([branch, head, refs]), refsChanged = this.signature !== undefined && signature !== this.signature;
    this.signature = signature;
    if (refsChanged) this.invalidatePr();
    if (refsChanged || content) this.publish(false);
    const reporting = this.reportCheckout();
    if (options.waitForCheckoutReport !== false) await reporting;
  }
  async flush(): Promise<void> { await this.git.flush(); await this.metadataQueue; await this.watcher?.flush(); await this.checkoutFlight; await this.githubCheckout?.flush(); }
  get uploading(): boolean { return this.attachments.busy; }
  stopAttachmentTransfers(): Promise<void> { return this.attachments.dispose(); }
  githubChanged(): void { this.invalidate(true); }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const closed = await Promise.allSettled([this.watcher?.dispose(), this.attachments.dispose(), this.git.flush(), this.metadataQueue, this.checkoutFlight, this.githubCheckout?.dispose()]);
    for (const result of closed) if (result.status === "rejected") throw result.reason;
  }

  private invalidate(refs: boolean): void {
    if (refs) this.invalidatePr();
    this.publish(false); this.watcher?.schedule(true);
    if (refs && !this.watcher) void this.reportCheckout();
  }
  private invalidatePr(): void {
    this.prEpoch++; this.prs.clear(); this.refChange++;
  }
  private reportCheckout(): Promise<void> {
    if (this.checkoutFlight) return this.checkoutFlight;
    const flight = (async () => {
      while (!this.disposed) {
        const revision = this.refChange;
        // The app's next GitHub read must see the acknowledged checkout, even
        // when an older report was already in flight at the time of the push.
        await this.githubCheckout?.fresh();
        if (this.disposed) return;
        if (revision !== this.refChange) continue;
        if (this.publishedRefChange !== revision) {
          this.publishedRefChange = revision;
          this.publish(true);
        }
        if (revision === this.refChange) return;
      }
    })().catch(() => {
      // Keep the pending ref revision for the next existing watcher observation.
    }).finally(() => {
      if (this.checkoutFlight === flight) this.checkoutFlight = undefined;
    });
    this.checkoutFlight = flight;
    return flight;
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
    if (this.githubCheckout) return EMPTY_PR;
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
      const state = update(this.state), json = JSON.stringify(state);
      if (json === this.persistedStateJson) return;
      // A failed directory sync can leave renamed bytes that the next write must repair.
      this.persistedStateJson = undefined;
      const path = join(this.directory, "workspace.json"), temp = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temp, "wx", 0o600);
        try { await file.writeFile(json); await file.sync(); } finally { await file.close(); }
        await rename(temp, path);
        const directory = await open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); }
        this.state = state;
        this.persistedStateJson = json;
      } finally { await rm(temp, { force: true }).catch(() => {}); }
    });
    this.metadataQueue = pending.catch(() => {}); return pending;
  }
}
