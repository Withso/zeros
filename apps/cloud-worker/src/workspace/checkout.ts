import { spawn } from "node:child_process";
import { workerChildEnvironment } from "../drivers/shared/agent-environment";
import { WorkspaceError, type WorkerConfig } from "./scope";
import { measureStartup, recordStartupTiming, type StartupTimingObserver } from "../startup-timings";

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
function git(cwd: string, environment: NodeJS.ProcessEnv): Git {
  const env = workerChildEnvironment(undefined, environment);
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
    const timeout = setTimeout(cancel, 120_000); timeout.unref();
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
/** A create's VM restores its disk lazily from the Cloud Computer snapshot, so
 * the checkout's first Git commands wait on cold reads (1.9 s on Alpha). Stat
 * every tracked file while hello runs. Read-only: no branch change, hook or LFS
 * download; the checkout itself still waits for the configuration. */
export async function warmCheckout(checkoutPath: string, signal: AbortSignal): Promise<void> {
  // As the worker's other read-only Git: no optional index refresh, no
  // `git status` child per populated submodule, and no fsmonitor or hook command.
  await git(checkoutPath, { GIT_OPTIONAL_LOCKS: "0" })(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "diff-files", "--quiet", "--ignore-submodules"], signal).catch(() => {});
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
