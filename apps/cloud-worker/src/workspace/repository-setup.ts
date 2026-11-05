import { spawn } from "node:child_process";
import { constants, lstatSync, realpathSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { RepositorySetupPathSchema, REPOSITORY_SETUP_MAX_BYTES } from "@zeros/protocol/cloud-v2-relay";
import { workerChildEnvironment } from "../drivers/shared/agent-environment";

export class RepositorySetupError extends Error {
  constructor(readonly reason: "script_refused" | "source_changed" = "script_refused") {
    super("The selected repository setup script could not be admitted.");
  }
}

function readGit(cwd: string, environment: NodeJS.ProcessEnv, signal: AbortSignal, args: string[], limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new RepositorySetupError()); return; }
    const env = { ...workerChildEnvironment(undefined, environment), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" };
    const child = spawn("git", ["--no-replace-objects", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
      { cwd, env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let failed = false, bytes = 0, escalation: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const kill = (value: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, value); } catch { /* Already exited. */ } } };
    const cancel = () => {
      failed = true; kill("SIGTERM");
      escalation ??= setTimeout(() => kill("SIGKILL"), 2000); escalation.unref();
    };
    const deadline = setTimeout(cancel, 5000); deadline.unref();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) cancel();
      else chunks.push(chunk);
    });
    child.once("error", () => { failed = true; });
    child.once("close", code => {
      if (failed) kill("SIGKILL");
      clearTimeout(deadline); clearTimeout(escalation); signal.removeEventListener("abort", cancel);
      if (failed || code !== 0 || signal.aborted) reject(new RepositorySetupError());
      else resolve(Buffer.concat(chunks));
    });
  });
}

export class RepositorySetupSource {
  private constructor(readonly path: string, readonly commit: string, readonly blob: string, readonly bytes: Buffer,
    readonly cwd: string, private readonly root: string, private readonly handle: FileHandle,
    private readonly identity: Stats, private readonly signal: AbortSignal) {}

  static async read(root: string, path: string, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<RepositorySetupSource> {
    let handle: FileHandle | undefined;
    try {
      if (signal.aborted || !RepositorySetupPathSchema.safeParse(path).success) throw new RepositorySetupError();
      handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const identity = await handle.stat();
      const cwd = `/proc/${process.pid}/fd/${handle.fd}`;
      const run = (args: string[], limit = 4096) => readGit(cwd, environment, signal, args, limit);
      const top = (await run(["rev-parse", "--show-toplevel"])).toString("utf8").trim();
      if (top !== resolve(root)) throw new RepositorySetupError("source_changed");
      const commit = (await run(["rev-parse", "--verify", "HEAD^{commit}"])).toString("utf8").trim();
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) throw new RepositorySetupError();
      const entry = (await run(["ls-tree", "-z", commit, "--", path])).toString("utf8");
      const match = /^(?:100644|100755) blob ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t([^\0]+)\0$/.exec(entry);
      if (!match || match[2] !== path) throw new RepositorySetupError();
      const blob = match[1]!;
      const size = Number((await run(["cat-file", "-s", blob], 64)).toString("ascii").trim());
      if (!Number.isSafeInteger(size) || size < 1 || size > REPOSITORY_SETUP_MAX_BYTES) throw new RepositorySetupError();
      const bytes = await run(["cat-file", "blob", blob], REPOSITORY_SETUP_MAX_BYTES);
      if (bytes.length !== size || bytes.includes(0)) throw new RepositorySetupError();
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const source = new RepositorySetupSource(path, commit, blob, bytes, cwd, resolve(root), handle, identity, signal);
      source.assertCurrent();
      handle = undefined;
      return source;
    } catch (error) {
      await handle?.close();
      throw error instanceof RepositorySetupError ? error : new RepositorySetupError();
    }
  }

  assertCurrent(): void {
    if (this.signal.aborted) throw new RepositorySetupError();
    try {
      const current = lstatSync(this.root);
      if (realpathSync(this.root) !== this.root || !current.isDirectory() || current.dev !== this.identity.dev || current.ino !== this.identity.ino)
        throw new RepositorySetupError("source_changed");
    } catch { throw new RepositorySetupError("source_changed"); }
  }

  close(): Promise<void> { return this.handle.close(); }
}
