import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { selectRepositorySetup, type RepositorySetupSelection } from "@zeros/protocol/run-actions";
import { workerChildEnvironment } from "../drivers/shared/agent-environment";
import type { WorkerConfig } from "./scope";
import { ApplicationEnvironment } from "../credentials/application-environment";
import { RepositorySetupError, RepositorySetupSource } from "./repository-setup";

const MAX_LOG_BYTES = 256 * 1024;
const SETUP_TIMEOUT_MS = 3_600_000;
export type SetupRunner = (file: string, args: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; output(chunk: Buffer): void; scriptFd?: number;
}) => Promise<number | null>;

const runSetup: SetupRunner = (file, args, options) => new Promise((resolve, reject) => {
  if (options.signal.aborted) { resolve(null); return; }
  // A separate process group lets Stop or the deadline cancel descendants too.
  const child = spawn(file, [...args], { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe", ...(options.scriptFd !== undefined ? [options.scriptFd] : [])] });
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* The group already exited. */ } }
  };
  const abort = () => { kill("SIGTERM"); escalation ??= setTimeout(() => kill("SIGKILL"), 2000); escalation.unref(); };
  const cleanup = () => { clearTimeout(escalation); options.signal.removeEventListener("abort", abort); };
  child.stdout!.on("data", options.output); child.stderr!.on("data", options.output);
  child.once("error", error => { cleanup(); reject(error); });
  child.once("close", code => {
    // A completed setup shell can leave redirected background children alive.
    kill("SIGKILL");
    cleanup(); resolve(code);
  });
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
});

type SetupStatus = {
  workspaceId: string; state: "running" | "succeeded" | "failed" | "interrupted";
  startedAt: string; finishedAt?: string; exitCode?: number | null; reason?: "timed_out" | "script_refused" | "source_changed";
  source?: { path: string; commit: string; blob: string };
};
interface SetupOptions {
  directory: string; workspace: WorkerConfig["workspace"]; gitEnvironment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
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
/** The newest lines of this workspace's setup output, for agent tools. The
 * log was redacted as it was written and is capped at MAX_LOG_BYTES. */
export async function readSetupOutput(directory: string, workspaceId: string, maxLines: number, maxBytes = MAX_LOG_BYTES): Promise<{ lines: string[]; truncated: boolean } | undefined> {
  let file: FileHandle;
  try { file = await open(join(directory, "workspace-setup", `${workspaceId}.log`), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return undefined; }
  try {
    const { size, isFile } = await file.stat().then(stat => ({ size: stat.size, isFile: stat.isFile() }));
    if (!isFile) return undefined;
    const length = Math.min(size, maxBytes), buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, size - length);
    // A cut first line is partial; drop it unless it is the only one.
    let lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n").map(line => line.split("\r").filter(Boolean).at(-1) ?? "");
    let truncated = size > length;
    if (truncated && lines.length > 1) lines = lines.slice(1);
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    if (lines.length > maxLines) { lines = lines.slice(-maxLines); truncated = true; }
    return { lines, truncated };
  } finally { await file.close(); }
}

export class WorkspaceSetup {
  private readonly controller = new AbortController();
  private operation?: Promise<void>;
  private running = false;
  get busy(): boolean { return this.running; }

  private readonly cancel = () => { this.controller.abort(); };
  constructor(private readonly options: SetupOptions) {
    options.signal?.addEventListener("abort", this.cancel, { once: true });
    if (options.signal?.aborted) this.cancel();
  }

  private selection: RepositorySetupSelection | null = null;
  private lfs = false;

  start(createdBranch: boolean): void {
    if (this.operation || this.controller.signal.aborted || !createdBranch) return;
    this.selection = selectRepositorySetup({ setupScript: this.options.workspace.setupScript, inlineCommand: this.options.workspace.setup });
    this.lfs = usesGitLfs(this.options.workspace.checkoutPath);
    if (!this.selection && !this.lfs) return;
    this.running = true; this.options.activity();
    this.operation = this.execute().finally(() => { this.running = false; this.options.activity(); });
  }

  async dispose(): Promise<void> {
    this.cancel(); this.options.signal?.removeEventListener("abort", this.cancel);
    await this.operation;
  }

  private async execute(): Promise<void> {
    const { workspace } = this.options;
    const directory = join(this.options.directory, "workspace-setup");
    let statusFile: FileHandle | undefined, log: FileHandle | undefined, snapshot: FileHandle | undefined, source: RepositorySetupSource | undefined;
    let writes = Promise.resolve(), bytes = 0, received = 0, truncated = false;
    const application = this.options.application ?? new ApplicationEnvironment();
    const writeOutput = (text: string) => {
      if (bytes >= MAX_LOG_BYTES) return;
      const bounded = Buffer.from(text).subarray(0, MAX_LOG_BYTES - bytes); bytes += bounded.length;
      writes = writes.then(async () => { await log!.write(bounded); }).catch(() => { this.options.onStorageError?.(); });
    };
    let output = application.stream(writeOutput);
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
          if (this.selection?.kind === "script") {
            source = await RepositorySetupSource.read(workspace.checkoutPath, this.selection.path, this.options.gitEnvironment, this.controller.signal);
            source.assertCurrent();
            // Bash syntax errors can quote the source line even without tracing.
            const body = source.bytes.toString("utf8");
            output = application.stream(writeOutput, [body, ...body.split(/\r?\n/).map(line => line.trim())]);
            snapshot = await open(join(directory, `${workspace.id}.script`), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            await snapshot.writeFile(source.bytes); await snapshot.sync();
            const parent = await open(directory, "r");
            try { await parent.sync(); } finally { await parent.close(); }
            status.source = { path: source.path, commit: source.commit, blob: source.blob };
            await this.persist(statusFile, status);
          }
          const command = source ? "source /dev/fd/3" : this.selection?.kind === "command" ? this.selection.command : "";
          const script = this.lfs ? `${GIT_LFS_SETUP_STEP}${command ? `\n${command}` : ""}` : command;
          const args = ["-lc", script, ...(source ? [join(workspace.checkoutPath, source.path)] : [])];
          if (this.controller.signal.aborted) throw new RepositorySetupError();
          source?.assertCurrent();
          code = await (this.options.runner ?? runSetup)("bash", args, {
            cwd: source?.cwd ?? workspace.checkoutPath, env: workerChildEnvironment(undefined, this.options.gitEnvironment, this.options.application?.variables), signal: this.controller.signal,
            ...(snapshot ? { scriptFd: snapshot.fd } : {}),
            output: chunk => {
              if (chunk.length > MAX_LOG_BYTES - received) truncated = true;
              if (received >= MAX_LOG_BYTES) return;
              const bounded = chunk.subarray(0, MAX_LOG_BYTES - received); received += bounded.length;
              output.push(bounded);
            },
          });
        } catch (error) { failed = true; if (error instanceof RepositorySetupError) status.reason = error.reason; }
        finally { clearTimeout(deadline); }
      }
      output.end(truncated); await writes;
      status.state = timedOut ? "failed" : this.controller.signal.aborted ? "interrupted" : !failed && code === 0 ? "succeeded" : "failed";
      status.finishedAt = new Date().toISOString(); status.exitCode = timedOut ? null : code;
      if (timedOut) status.reason = "timed_out";
      await this.persist(statusFile, status);
    } catch { this.options.onStorageError?.(); }
    finally { await writes; await source?.close().catch(() => {}); await snapshot?.close().catch(() => {}); await log?.close().catch(() => {}); await statusFile?.close().catch(() => {}); }
  }

  private async persist(file: FileHandle, status: SetupStatus): Promise<void> {
    const body = Buffer.from(`${JSON.stringify(status)}\n`);
    await file.write(body, 0, body.length, 0); await file.truncate(body.length); await file.sync();
  }
}
