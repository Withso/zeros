import { closeSync, constants, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudWorker } from "./worker";
import { HybridTransport } from "./hybrid-transport";
import { WORKER_TOKEN_FILE } from "./worker-token";
import { runtimePermit } from "./runtime-permit";
import { persistCompileCache } from "./compile-cache";
import { homedir } from "node:os";
import { bootClean, procDeps } from "./sharing/boot-clean";
import { PersonalEnvironments } from "./sharing/personal-env";

export const WORKER_STATE_DIRECTORY = "/home/user/.local/share/zeros/cloud-worker";
interface BootOptions { apiUrl: string; workspaceId: string; runtimeSha256: string; tokenFile?: string; directory?: string; publicKeys?: readonly string[]; port?: number;
  runtimeHandoff?: { id: string; bootId: string; instanceId: string } }

/** The service receives only non-secret boot configuration. Model configuration
 * and the checkout arrive over authenticated HTTPS after hello. */
export function readBootEnvironment(environment: NodeJS.ProcessEnv = process.env): BootOptions {
  const apiUrl = environment.CLOUD_V2_API_URL, workspaceId = environment.ZEROS_WORKSPACE_ID, runtimeSha256 = environment.CLOUD_V2_RUNTIME_SHA256;
  if (!apiUrl || !runtimeSha256 || !/^[a-f0-9]{64}$/.test(runtimeSha256) || !workspaceId || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(workspaceId))
    throw new Error("Worker boot configuration is missing or invalid.");
  const { ZEROS_RUNTIME_HANDOFF: id, ZEROS_RUNTIME_BOOT: bootId, ZEROS_RUNTIME_INSTANCE: instanceId } = environment;
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if ([id, bootId, instanceId].some(Boolean) && ![id, bootId, instanceId].every(value => value && uuid.test(value))) throw new Error("Invalid runtime handoff.");
  return { apiUrl, workspaceId, runtimeSha256, ...(id && bootId && instanceId ? { runtimeHandoff: { id, bootId, instanceId } } : {}) };
}

export function startWorker(options: BootOptions): { worker: CloudWorker; stop: (code?: number) => Promise<void> } {
  const directory = options.directory ?? WORKER_STATE_DIRECTORY;
  const runtimeHandoff = consumeRuntimeHandoff(directory, options.runtimeHandoff);
  let stopping: Promise<void> | undefined, connected = false;
  const log = (event: string) => { process.stdout.write(`cloud-worker ${event}\n`); };
  // Process uptime splits a resume's wait before hello into module loading and the rest.
  const uptime = () => Math.round(process.uptime() * 1000);
  log(`boot loaded ${uptime()}`);
  const transport = new HybridTransport({ apiUrl: options.apiUrl, workspaceId: options.workspaceId, runtimeSha256: options.runtimeSha256,
    ...(runtimeHandoff ? { runtimeHandoff } : {}),
    ...(options.publicKeys ? { publicKeys: options.publicKeys } : {}), ...(options.port === undefined ? {} : { port: options.port }),
    tokenFile: options.tokenFile ?? WORKER_TOKEN_FILE, log,
    onStatus: status => {
      log(status);
      if (status === "connected" && !connected) { connected = true; log(`boot connected ${uptime()}`); setImmediate(persistCompileCache); }
      if (["unauthorized", "stopped", "protocol-error"].includes(status)) void stop(status === "protocol-error" ? 1 : 0);
    },
  });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bootPath = join(directory, "runtime-boot");
  writeFileSync(`${bootPath}.${transport.bootId}`, transport.bootId, { mode: 0o600, flag: "wx" });
  renameSync(`${bootPath}.${transport.bootId}`, bootPath);
  const worker = new CloudWorker({ directory, workspaceId: options.workspaceId, transport, runtimePermit: runtimePermit(directory, transport.bootId),
    ...(runtimeHandoff ? { runtimeResume: { instanceId: runtimeHandoff.instanceId, ready: () => completeRuntimeHandoff(directory, runtimeHandoff) } } : {}),
    gitAskpassPath: fileURLToPath(new URL("./bin/git-askpass", import.meta.url)), onError: code => log(code), onSync: line => log(line),
    onTiming: record => log(`timing ${JSON.stringify(record)}`),
    onReconfigure: changed => log(`reconfigure ${changed.join(",")}`),
    memoryWatchdog: { runtimeRoots: [...new Set([dirname(fileURLToPath(import.meta.url)), dirname(realpathSync(fileURLToPath(import.meta.url)))])] },
    onMemory: event => log(event),
    bootClean: () => bootClean(procDeps(() => new PersonalEnvironments(homedir()).eraseAll())),
  });
  const shutdown = () => { void stop(); };
  const stop = (code = 0): Promise<void> => {
    if (stopping) return stopping;
    process.removeListener("SIGINT", shutdown); process.removeListener("SIGTERM", shutdown);
    // Bound shutdown if a native process cannot be reaped. No provider output
    // or configuration is written to the service journal.
    const deadline = setTimeout(() => process.exit(1), 30_000); deadline.unref();
    stopping = worker.dispose().then(() => { process.exitCode = code; }, () => { process.exitCode = 1; log("shutdown-failed"); }).finally(() => clearTimeout(deadline));
    return stopping;
  };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  worker.start();
  return { worker, stop };
}

/** An unfinished private boot must stay fenced after a crash. Only a durable
 * readiness receipt allows an ordinary restart without reusing its seed proof. */
export function consumeRuntimeHandoff(directory: string, handoff: BootOptions["runtimeHandoff"]): BootOptions["runtimeHandoff"] {
  if (!handoff) return undefined;
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (![handoff.id, handoff.bootId, handoff.instanceId].every(value => uuid.test(value))) throw new Error("Invalid runtime handoff.");
  const path = join(directory, "runtime-handoffs"); mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(join(path, `${handoff.id}-${handoff.bootId}`), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const fd = openSync(join(path, `completed-${handoff.id}-${handoff.bootId}`), constants.O_RDONLY | constants.O_NOFOLLOW);
    closeSync(fd); return undefined;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return handoff;
}

export function completeRuntimeHandoff(directory: string, handoff: NonNullable<BootOptions["runtimeHandoff"]>): void {
  const path = join(directory, "runtime-handoffs"), target = join(path, `completed-${handoff.id}-${handoff.bootId}`);
  const fd = openSync(target, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

// Node resolves ESM URLs through the version-cache symlink; argv keeps the
// launch path. Compare canonical paths so the systemd entry actually starts.
function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; } // An importer using stdin/eval need not have a file entry.
}

if (isEntrypoint()) {
  try { startWorker(readBootEnvironment()); }
  catch { process.stderr.write("cloud-worker invalid-boot-configuration\n"); process.exitCode = 1; }
}
