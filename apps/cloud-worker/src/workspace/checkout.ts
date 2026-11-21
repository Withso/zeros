import { spawn } from "node:child_process";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { workerChildEnvironment, mergeGitEnvironment } from "../drivers/shared/agent-environment";
import { WorkspaceError, type WorkerConfig } from "./scope";
import { measureStartup, recordStartupTiming, type StartupTimingObserver } from "../startup-timings";
import { operationEnvironment } from "../sharing/operation-environment";

export interface CheckoutRefresh {
  readonly mayFastForward: boolean;
  readonly runtimeBusy?: boolean;
  start(): Promise<void>;
  /** Refuse future automatic moves; join one already admitted before work starts. */
  touch(): Promise<void>;
  /** Stop must join Git and its children before the VM disk is checkpointed. */
  dispose(): Promise<void>;
}
export type CheckoutResult = { createdBranch: boolean; refresh?: CheckoutRefresh };
type Git = (args: string[], signal?: AbortSignal) => Promise<string>;

/** No shell or stderr in errors. Background Git owns a process group so a
 * cancelled fetch cannot leave a remote helper writing the checkout at Stop. */
function git(cwd: string, environment: NodeJS.ProcessEnv, timeoutMs = 120_000): Git {
  // Activated: the bootstrap lease's person and context (team sharing); none otherwise.
  const operation = operationEnvironment.getStore();
  const env = operation ? workerChildEnvironment(undefined, mergeGitEnvironment(environment, operation.git), {}, operation.zeros) : workerChildEnvironment(undefined, environment);
  return (args, signal) => new Promise((resolve, reject) => {
    const failure = (code = -1) => Object.assign(new Error("Git command failed."), { code });
    if (signal?.aborted) { reject(failure()); return; }
    const child = spawn("git", args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let failed = false, bytes = 0, escalation: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const kill = (value: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, value); } catch { /* Already exited. */ } } };
    const cancel = () => {
      failed = true; kill("SIGTERM");
      escalation ??= setTimeout(() => kill("SIGKILL"), 2000); escalation.unref();
    };
    const timeout = setTimeout(cancel, timeoutMs); timeout.unref();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) cancel();
      else chunks.push(chunk);
    });
    child.once("error", () => { failed = true; });
    child.once("close", code => {
      if (failed) kill("SIGKILL");
      clearTimeout(timeout); clearTimeout(escalation); signal?.removeEventListener("abort", cancel);
      if (failed || code !== 0) reject(failure(code ?? -1));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

class BackgroundRefresh implements CheckoutRefresh {
  private readonly controller = new AbortController();
  private operation?: Promise<void>;
  private updating?: Promise<void>;
  private touched = false;
  private running = false;
  get runtimeBusy(): boolean { return this.running; }

  constructor(readonly mayFastForward: boolean, private readonly run: Git,
    private readonly branch: string, private readonly baseBranch: string, private readonly startCommit: string | undefined,
    private readonly timing?: StartupTimingObserver) {}

  start(): Promise<void> {
    // Refresh failure is never a workspace/configuration failure.
    if (this.operation) return this.operation;
    this.running = true;
    return this.operation = this.refresh().catch(() => {}).finally(() => { this.running = false; });
  }

  touch(): Promise<void> {
    this.touched = true;
    // The network step never holds up work. Only a local move already admitted
    // before this activity must finish before a tool can touch the checkout.
    return this.updating?.catch(() => {}) ?? Promise.resolve();
  }

  async dispose(): Promise<void> {
    this.touched = true; this.controller.abort(); await this.operation;
  }

  private async refresh(): Promise<void> {
    const started = performance.now();
    // Auto-maintenance may detach its own process after fetch exits. Keep all
    // refresh work within the process group Stop can cancel and join.
    try { await this.run(["fetch", "--no-auto-maintenance", "origin"], this.controller.signal); }
    finally { recordStartupTiming("worker_checkout_fetch", started, this.timing); }
    if (!this.mayFastForward || this.touched || this.controller.signal.aborted) return;
    this.updating = this.fastForward();
    try { await this.updating; } finally { this.updating = undefined; }
  }

  private async fastForward(): Promise<void> {
    const run = (args: string[]) => this.run(args, this.controller.signal);
    if ((await run(["symbolic-ref", "--quiet", "HEAD"])).trim() !== `refs/heads/${this.branch}`) return;
    if ((await run(["rev-parse", "HEAD"])).trim() !== this.startCommit) return;
    const target = (await run(["rev-parse", "--verify", `refs/remotes/origin/${this.baseBranch}^{commit}`])).trim();
    if (target === this.startCommit || (await run(["status", "--porcelain", "--untracked-files=no"])).trim()) return;
    await run(["merge-base", "--is-ancestor", this.startCommit!, target]);
    if (this.touched || this.controller.signal.aborted) return;
    // Git also refuses an untracked-file collision or a non-fast-forward.
    await run(["merge", "--ff-only", "--no-edit", target]);
  }
}

/** Run only for the first config in a worker process. Existing branches and
 * dirty files remain owned by the user; Git refuses an unsafe switch itself. */
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Generous for a large repository; Stop still cancels it through the process group. */
const CLONE_TIMEOUT_MS = 15 * 60_000;

/**
 * A repository after the first of a workspace of several that is not on disk
 * yet, cloned into its folder. That happens when a shared-execution create (or
 * one from a Cloud Computer that holds only the first repository) had no
 * project build to fork. Git asks the broker for this repository's own token by
 * name (credential.useHttpPath); activated, it runs as the starter, from the
 * bootstrap lease. An existing checkout is left alone, and a folder that holds
 * anything else is never cloned over. True when it cloned.
 */
export async function cloneMissingCheckout(workspace: WorkerConfig["workspace"], repository: string, gitEnvironment: NodeJS.ProcessEnv = {},
  origin = `https://github.com/${repository}.git`): Promise<boolean> {
  if (!REPOSITORY.test(repository)) throw new WorkspaceError("VALIDATION_FAILED", "Invalid repository.");
  const present = await lstat(`${workspace.checkoutPath}/.git`).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (present) return false;
  const contents = await readdir(workspace.checkoutPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (contents.length) throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "This repository's folder already holds other files.");
  const parent = dirname(workspace.checkoutPath);
  await mkdir(parent, { recursive: true });
  try {
    await git(parent, gitEnvironment, CLONE_TIMEOUT_MS)(
      ["clone", "--quiet", "--no-recurse-submodules", "--template=", "--origin", "origin", "--", origin, workspace.checkoutPath]);
  } catch { throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "This repository could not be cloned. Check that its GitHub connection can read it."); }
  return true;
}

export async function prepareCheckout(workspace: WorkerConfig["workspace"], gitEnvironment: NodeJS.ProcessEnv = {}, timing?: StartupTimingObserver): Promise<CheckoutResult> {
  const run = git(workspace.checkoutPath, gitEnvironment), { branch, baseBranch, baseCommit } = workspace;
  for (const name of [branch, baseBranch]) {
    if (name.startsWith("-")) throw new WorkspaceError("VALIDATION_FAILED", "Invalid workspace branch.");
    try { await run(["check-ref-format", `refs/heads/${name}`]); }
    catch { throw new WorkspaceError("VALIDATION_FAILED", "Invalid workspace branch."); }
  }
  if (baseCommit !== undefined && !/^[0-9a-f]{40}$/.test(baseCommit)) throw new WorkspaceError("VALIDATION_FAILED", "Invalid workspace base commit.");
  try {
    const exists = await run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, (error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === 1) return false;
      throw error;
    });
    const pinned = !exists && baseCommit !== undefined && await run(["cat-file", "-e", `${baseCommit}^{commit}`]).then(() => true, () => false);
    const startCommit = exists ? undefined : pinned ? baseCommit
      : (await run(["rev-parse", "--verify", `refs/remotes/origin/${baseBranch}^{commit}`])).trim();
    // A resumed disk already has its branch checked out. A no-op switch would
    // still refresh the whole index, which is slow on a freshly restored disk.
    const current = exists ? await run(["symbolic-ref", "-q", "HEAD"]).then(value => value.trim(), () => "") : "";
    await measureStartup("worker_checkout_switch", () => !exists
      ? run(["switch", "--no-track", "-c", branch, startCommit!])
      : current === `refs/heads/${branch}` ? Promise.resolve("") : run(["switch", "--", branch]), timing);
    return { createdBranch: !exists, refresh: new BackgroundRefresh(!exists && !pinned, run, branch, baseBranch, startCommit, timing) };
  } catch { throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "Could not prepare the workspace branch. Existing work has been retained."); }
}
