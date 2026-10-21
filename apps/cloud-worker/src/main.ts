import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CloudWorker } from "./worker";
import { RelayTransport, WORKER_TOKEN_FILE } from "./relay-transport";

export const WORKER_STATE_DIRECTORY = "/home/user/.local/share/zeros/cloud-worker";
interface BootOptions { url: string; workspaceId: string; tokenFile?: string; directory?: string }

/** The service receives only non-secret boot configuration. Model configuration
 * and the checkout arrive over the authenticated relay after hello. */
export function readBootEnvironment(environment: NodeJS.ProcessEnv = process.env): BootOptions {
  const url = environment.ZEROS_WORKER_URL, workspaceId = environment.ZEROS_WORKSPACE_ID;
  if (!url || !workspaceId || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(workspaceId))
    throw new Error("Worker boot configuration is missing or invalid.");
  return { url, workspaceId };
}

export function startWorker(options: BootOptions): { worker: CloudWorker; stop: (code?: number) => Promise<void> } {
  let stopping: Promise<void> | undefined;
  const log = (event: string) => { process.stdout.write(`cloud-worker ${event}\n`); };
  const transport = new RelayTransport({ url: options.url, tokenFile: options.tokenFile ?? WORKER_TOKEN_FILE,
    onStatus: status => {
      log(status);
      if (["superseded", "stopped", "protocol-error"].includes(status)) void stop(status === "protocol-error" ? 1 : 0);
    },
  });
  const worker = new CloudWorker({ directory: options.directory ?? WORKER_STATE_DIRECTORY, workspaceId: options.workspaceId, transport,
    gitAskpassPath: fileURLToPath(new URL("./bin/git-askpass", import.meta.url)), onError: code => log(code),
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
