import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { workerChildEnvironment } from "../drivers/shared/agent-environment";
import type { WorkerConfig } from "./scope";
import { ApplicationEnvironment } from "../credentials/application-environment";

const MAX_LOG_BYTES = 256 * 1024;
const SETUP_TIMEOUT_MS = 3_600_000;
export type SetupRunner = (file: string, args: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; output(chunk: Buffer): void;
}) => Promise<number | null>;

const runSetup: SetupRunner = (file, args, options) => new Promise((resolve, reject) => {
  if (options.signal.aborted) { resolve(null); return; }
  // A separate process group lets Stop or the deadline cancel descendants too.
  const child = spawn(file, [...args], { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* The group already exited. */ } }
  };
  const abort = () => { kill("SIGTERM"); escalation ??= setTimeout(() => kill("SIGKILL"), 2000); escalation.unref(); };
  const cleanup = () => { clearTimeout(escalation); options.signal.removeEventListener("abort", abort); };
  child.stdout.on("data", options.output); child.stderr.on("data", options.output);
  child.once("error", error => { cleanup(); reject(error); });
  child.once("close", code => {
    if (options.signal.aborted) kill("SIGKILL");
    cleanup(); resolve(code);
  });
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
});

type SetupStatus = {
  workspaceId: string; state: "running" | "succeeded" | "failed" | "interrupted";
  startedAt: string; finishedAt?: string; exitCode?: number | null; reason?: "timed_out";
};
interface SetupOptions {
  directory: string; workspace: WorkerConfig["workspace"]; gitEnvironment: NodeJS.ProcessEnv;
  application?: ApplicationEnvironment;
  runner?: SetupRunner; activity(): void; onStorageError?(): void;
  beforeRun?(): Promise<void>;
  onAdmitted?(): Promise<void>;
}

/** A clone made without git-lfs holds pointer files. Fetch the real files
 * with the VM's git-lfs when the recipe installs it; otherwise say how. */
const GIT_LFS_SETUP_STEP = [
  "if command -v git-lfs >/dev/null 2>&1; then",
  "  git lfs pull || echo \"Zeros: git lfs pull failed. Run it in the terminal to download this repository's Git LFS files.\" >&2",
  "else",
  "  echo \"Zeros: this repository uses Git LFS, but git-lfs isn't installed on this Cloud Computer, so large files are placeholders. Add git-lfs to the Cloud Computer recipe, then run: git lfs pull\" >&2",
  "fi",
].join("\n");

/** Only a small regular root `.gitattributes` is read, so a planted symlink or
 * device cannot redirect or stall setup admission. */
function usesGitLfs(checkoutPath: string): boolean {
  let fd: number | undefined;
  try {
    // One descriptor for check and read: no symlink, no blocking FIFO open.
    fd = openSync(join(checkoutPath, ".gitattributes"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 1024 * 1024) return false;
    return /\bfilter=lfs\b/.test(readFileSync(fd, "utf8"));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Admission is durable before execution. An interrupted or failed script is
 * left for the user to inspect; worker restarts never execute it again. */
export class WorkspaceSetup {
  private readonly controller = new AbortController();
  private operation?: Promise<void>;
  private running = false;
  get busy(): boolean { return this.running; }

  constructor(private readonly options: SetupOptions) {}

  private script?: string;

  start(createdBranch: boolean): void {
    if (this.operation || this.controller.signal.aborted || !createdBranch) return;
    const setup = this.options.workspace.setup?.trim();
    const lfs = usesGitLfs(this.options.workspace.checkoutPath);
    this.script = lfs ? (setup ? `${GIT_LFS_SETUP_STEP}\n${setup}` : GIT_LFS_SETUP_STEP) : setup;
    if (!this.script) return;
    this.running = true; this.options.activity();
    this.operation = this.execute().finally(() => { this.running = false; this.options.activity(); });
  }

  async dispose(): Promise<void> { this.controller.abort(); await this.operation; }

  private async execute(): Promise<void> {
    const { workspace } = this.options;
    const directory = join(this.options.directory, "workspace-setup");
    let statusFile: FileHandle | undefined, log: FileHandle | undefined;
    let writes = Promise.resolve(), bytes = 0, received = 0, truncated = false;
    const output = (this.options.application ?? new ApplicationEnvironment()).stream(text => {
      if (bytes >= MAX_LOG_BYTES) return;
      const bounded = Buffer.from(text).subarray(0, MAX_LOG_BYTES - bytes); bytes += bounded.length;
      writes = writes.then(async () => { await log!.write(bounded); }).catch(() => { this.options.onStorageError?.(); });
    });
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { statusFile = await open(join(directory, `${workspace.id}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") { await this.options.onAdmitted?.(); return; }
        throw error;
      }
      const status: SetupStatus = { workspaceId: workspace.id, state: "running", startedAt: new Date().toISOString() };
      await this.persist(statusFile, status);
      // The restore marker can be removed only after both the admission file
      // and its directory entries are durable.
      for (const path of [directory, this.options.directory]) {
        const parent = await open(path, "r");
        try { await parent.sync(); } finally { await parent.close(); }
      }
      await this.options.onAdmitted?.();
      // Keep descriptors throughout execution: a checkout cannot redirect an
      // already admitted status/log write by replacing its pathname.
      log = await open(join(directory, `${workspace.id}.log`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let code: number | null = null, failed = false, timedOut = false;
      if (!this.controller.signal.aborted) await this.options.beforeRun?.();
      if (!this.controller.signal.aborted) {
        const deadline = setTimeout(() => {
          if (this.controller.signal.aborted) return;
          timedOut = true; this.controller.abort();
        }, SETUP_TIMEOUT_MS);
        deadline.unref();
        try {
          code = await (this.options.runner ?? runSetup)("bash", ["-lc", this.script!], {
            cwd: workspace.checkoutPath, env: workerChildEnvironment(undefined, this.options.gitEnvironment, this.options.application?.variables), signal: this.controller.signal,
            output: chunk => {
              if (chunk.length > MAX_LOG_BYTES - received) truncated = true;
              if (received >= MAX_LOG_BYTES) return;
              const bounded = chunk.subarray(0, MAX_LOG_BYTES - received); received += bounded.length;
              output.push(bounded);
            },
          });
        } catch { failed = true; }
        finally { clearTimeout(deadline); }
      }
      output.end(truncated); await writes;
      status.state = timedOut ? "failed" : this.controller.signal.aborted ? "interrupted" : !failed && code === 0 ? "succeeded" : "failed";
      status.finishedAt = new Date().toISOString(); status.exitCode = timedOut ? null : code;
      if (timedOut) status.reason = "timed_out";
      await this.persist(statusFile, status);
    } catch { this.options.onStorageError?.(); }
    finally { await writes; await log?.close().catch(() => {}); await statusFile?.close().catch(() => {}); }
  }

  private async persist(file: FileHandle, status: SetupStatus): Promise<void> {
    const body = Buffer.from(`${JSON.stringify(status)}\n`);
    await file.write(body, 0, body.length, 0); await file.truncate(body.length); await file.sync();
  }
}
