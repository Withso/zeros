import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AgentFileStore, canonicalAgentFile } from "./agent-file.mjs";
import { AlphaTransport } from "./transport";
import { ZerosDevSession } from "./session";
import { ProductApi } from "./product";
import { RunStore, type Source } from "./receipts";
import { ZerosDevRuntime } from "./runtime";
import { controlPlaneHealth, controlPlaneLogs, databaseHealth } from "./health";
import { HELP, parseCommand, executeCommand, type Services } from "./commands";
import { ZerosDevError, closedError } from "./errors";
import { connectGithub } from "./github";
import { exportCleanupHandoff } from "./cleanup-handoff";
import { exportCleanupRecovery } from "./cleanup-recovery";
import { parseCloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";

async function source(checkout: string): Promise<Source> {
  const exec = promisify(execFile);
  const options = { cwd: checkout, timeout: 5000, maxBuffer: 128 * 1024, env: { PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0" } };
  try {
    const revision = (await exec("git", ["rev-parse", "--verify", "HEAD"], options)).stdout.trim();
    const dirty = Boolean((await exec("git", ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=normal"], options)).stdout.trim());
    return { revision: /^[a-f0-9]{40}$/.test(revision) ? revision : null, dirty };
  } catch { return { revision: null, dirty: true }; }
}

async function services(checkout: string, write: (value: unknown) => void): Promise<Services> {
  const file = await canonicalAgentFile(checkout), store = new AgentFileStore(file), transport = new AlphaTransport();
  await store.read();
  const session = new ZerosDevSession(store, transport), api = new ProductApi(session, transport);
  let runs: RunStore | undefined;
  const loadRuns = async () => {
    if (runs) return runs;
    const parent = path.join(path.dirname(file), ".context");
    await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o022 || await realpath(parent) !== parent)
      throw new ZerosDevError("receipt_invalid");
    await session.whoami();
    runs = new RunStore(path.join(parent, "zeros-dev"), await session.fixture(), await session.device()); return runs;
  };
  return {
    session, api, write, source: () => source(checkout), values: async () => (await store.read()).values,
    runs: loadRuns,
    handoff: async (runIds, output, signal) => exportCleanupHandoff({ file: path.resolve(checkout, output), runIds,
      store: await loadRuns(), credential: await session.device(), api, signal }),
    recovery: async (request, signal) => {
      const fixture = await session.fixture();
      let credential;
      try {
        const raw = (await store.read()).values.ZEROS_DEV_DEVICE_PRIVATE_KEY_B64;
        if (!raw || raw.length > 8192 || Buffer.from(raw, "base64").toString("base64") !== raw) throw new Error();
        credential = parseCloudReplicaDeviceCredential(JSON.parse(Buffer.from(raw, "base64").toString("utf8")));
        if (!credential.deviceId || credential.accountUserId !== fixture.accountId) throw new Error();
      } catch { throw new ZerosDevError("credentials_invalid"); }
      // Recovery must use the already enrolled signer, never enroll a device
      // or alter local run receipts just to export a failed Actions predecessor.
      await session.whoami();
      return exportCleanupRecovery({ ...request, artifact: path.resolve(checkout, request.artifact), file: path.resolve(checkout, request.file),
        credentialFile: file, fixture, credential, api, signal });
    },
    content: async (input, limit) => {
      const target = path.resolve(checkout, input);
      let handle;
      try {
        // Rotation replaces the credential inode. Exclude its canonical path
        // independently, including aliases through a parent directory.
        if (target === file || await realpath(target) === file) throw new ZerosDevError("invalid_request");
        const secret = (await store.read()).info;
        handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== process.getuid?.() || (opened.mode & 0o022) ||
            opened.size > limit || (opened.dev === secret.dev && opened.ino === secret.ino) ||
            await realpath(target) === file) throw new ZerosDevError("invalid_request");
        const text = await handle.readFile("utf8");
        const current = await lstat(target);
        if (!text.trim() || Buffer.byteLength(text) > limit || current.ino !== opened.ino || current.dev !== opened.dev)
          throw new ZerosDevError("invalid_request");
        return text;
      } catch { throw new ZerosDevError("invalid_request"); }
      finally { await handle?.close(); }
    },
    connect: (run, signal, onAdmissionEvent) => ZerosDevRuntime.connect(session, api, run, { signal, onAdmissionEvent }),
    healthCp: () => controlPlaneHealth(transport),
    healthDb: async run => databaseHealth((await store.read()).values, await session.fixture(), run),
    healthLogs: async run => controlPlaneLogs((await store.read()).values, run),
    githubConnect: (repository, signal, show) => connectGithub(session, api, repository, show, signal),
  };
}

export async function runCli(args: string[], options: { cwd?: string; signal?: AbortSignal; write?: (value: unknown) => void; initialize?: typeof services } = {}): Promise<number> {
  const write = options.write ?? (value => process.stdout.write(`${JSON.stringify(value)}\n`));
  try {
    const command = parseCommand(args);
    if (!command) { write({ schema: "zeros.dev-help/v1", help: HELP }); return 0; }
    if (process.platform !== "linux") throw new ZerosDevError("invalid_request");
    const context = await (options.initialize ?? services)(options.cwd ?? process.cwd(), write);
    return executeCommand(command, context, options.signal ?? AbortSignal.timeout(30 * 60_000));
  } catch (error) { write({ schema: "zeros.dev-error/v1", code: closedError(error) }); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  void runCli(process.argv.slice(2), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]) })
    .then(code => { process.exitCode = code; })
    .catch(() => { process.stderr.write('{"schema":"zeros.dev-error/v1","code":"internal"}\n'); process.exitCode = 1; })
    .finally(() => { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); });
}
