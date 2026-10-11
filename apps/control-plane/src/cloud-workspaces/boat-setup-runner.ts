import { BOAT_RESOURCE_ID_PATTERN, BoatBootPendingError, type BoatApiClient } from "./boat-client.js";
import { executeBoatPinnedSsh, type BoatBootstrapChannel } from "./boat-pinned-ssh.js";
// Preserve existing imports of transport helpers while both runners share them.
export { boatAuthorizedKeyCommand, isPublicBoatAddress, openBoatBootstrapChannel,
  parseBoatHostKey, parseBoatSshEndpoint, type BoatBootstrapExecution } from "./boat-pinned-ssh.js";
export type { BoatBootstrapChannel } from "./boat-pinned-ssh.js";
import { CLOUD_WORKSPACE_LINUX_SETUP_HELPER_COMMAND, CLOUD_WORKSPACE_RUNTIME_INSTALL_COMMAND } from "./linux-setup-executor.js";
import { RuntimeBaseStatusSchema, RuntimeInstallInputSchema, RUNTIME_INSTALL_MAX_ENCODED_BYTES } from "./runtime-contract.js";
import { setupTimingClock } from "./setup-timings.js";
import {
  CloudProviderError,
  type CloudWorkspaceCommandRunner,
} from "./provider.js";

const SETUP_ENV = "ZEROS_CLOUD_WORKSPACE_SETUP_B64";
const ENSURE_SUPERVISOR_COMMAND =
  "/usr/bin/sudo -n /opt/zeros-runtime/bin/node /opt/zeros-runtime/lib/zeros/ensure-cloud-worker-supervisor.mjs";
const BASE_STATUS_COMMAND = "/usr/bin/sudo -n /usr/bin/python3 -I /opt/zeros-bootstrap/bootstrap.py status";
const BASE_STATUS_TIMEOUT_SECONDS = 20;
// The v4 base waits up to 480 seconds for the provider restore (bootstrap.py
// HYDRATION_TIMEOUT) before reporting failure; allow a further minute.
const BASE_RESTORE_GATE_MS = 540_000;
// A fixed list, no path/argv disclosure and no dependency on the restored Node.
const BOOTSTRAP_FILE_PROBE_COMMAND = "/bin/sh -c 'for f in /opt/zeros-runtime/bin/node /opt/zeros-runtime/lib/zeros/ensure-cloud-worker-supervisor.mjs /opt/zeros-runtime/lib/zeros/setup-cloud-workspace.mjs /opt/zeros/dist-engine/cli.js; do if test -f \"$f\"; then printf 1; else printf 0; fi; done'";
type CommandResult = Awaited<ReturnType<CloudWorkspaceCommandRunner["execute"]>>;

function baseHostStopped(response: Record<string, unknown>, expectedBase: string): boolean {
  if (response.success !== true || response.exitCode !== 0 || response.timedOut || response.stdoutTruncated ||
    typeof response.stdout !== "string" || Buffer.byteLength(response.stdout) > 16_384 || !/^[^\r\n]+\n?$/.test(response.stdout)) return false;
  try {
    const status = RuntimeBaseStatusSchema.safeParse(JSON.parse(response.stdout));
    return status.success && status.data.baseCompatibilityId === expectedBase && status.data.hostState === "stopped";
  } catch { return false; }
}

/** Before any admission or SSH key is sent, poll only the fixed read-only v4
 * status command. A provider-running VM can still be restoring its overlay.
 * All setup/installer/SSH failures retain the worker's ordinary retry policy.
 * A nonzero restoreCeilingMs is used only before setup authority exists.
 */
async function waitForBoatBaseStatus(client: Pick<BoatApiClient, "request">, resourceId: string, expectedBase: string, signal: AbortSignal,
  timeoutSeconds: number, restoreCeilingMs = 0) {
  const started = Date.now();
  const boot = new AbortController(), restore = new AbortController();
  const restoreMs = Math.min(restoreCeilingMs, timeoutSeconds * 1000);
  const timers = [setTimeout(() => boot.abort(), Math.min(120_000, timeoutSeconds * 1000)),
    ...(restoreMs > 0 ? [setTimeout(() => restore.abort(), restoreMs)] : [])];
  for (const timer of timers) timer.unref();
  // The status command itself waits while the base gates on the provider
  // restore, so a timed-out status means the base is restoring, not broken.
  // Before authority exists, that evidence extends the wait instead of failing
  // the claim into a backed-off retry that would wait for the same restore.
  let restoring = false;
  const deadline = () => restoring ? restore.signal : boot.signal;
  const pause = (ms: number, error: unknown) => new Promise<void>((resolve, reject) => {
    const readinessSignal = AbortSignal.any([signal, deadline()]);
    const abort = () => { clearTimeout(wait); reject(error); };
    const wait = setTimeout(() => { readinessSignal.removeEventListener("abort", abort); resolve(); }, ms);
    readinessSignal.addEventListener("abort", abort, { once: true });
    if (readinessSignal.aborted) abort();
  });
  const hostPending = Object.assign(new CloudProviderError("provider_bootstrap_unavailable", "Boat runtime broker is not ready", true),
    { diagnostic: { version: 1, phase: "bootstrap", exit: "unknown" } });
  let previousError: unknown;
  try {
    for (;;) {
      signal.throwIfAborted();
      const polled = Date.now();
      try {
        const response = await client.request(`/sandboxes/${resourceId}/commands`, {
          method: "POST", body: { command: BASE_STATUS_COMMAND, timeoutSeconds: BASE_STATUS_TIMEOUT_SECONDS },
          signal: AbortSignal.any([signal, deadline()]),
        });
        // Commands may work before the enabled host unit starts after overlay
        // restoration. Observe only; never restart the host or accept a failed,
        // malformed or foreign base as transient readiness.
        if (baseHostStopped(response, expectedBase)) throw hostPending;
        if (response.timedOut === true && response.stdoutTruncated !== true &&
            restoreMs - (Date.now() - started) >= (BASE_STATUS_TIMEOUT_SECONDS + 2) * 1000) {
          restoring = true;
          // An early timeout report must not turn polling into a busy loop.
          const early = 2000 - (Date.now() - polled);
          if (early > 0) await pause(early, hostPending);
          continue;
        }
        return response;
      } catch (error) {
        signal.throwIfAborted();
        if (deadline().aborted) throw previousError ?? error;
        const bootPending = error === hostPending || error instanceof BoatBootPendingError || (error instanceof CloudProviderError &&
          error.retryable && error.httpStatus !== undefined && error.httpStatus >= 500);
        if (!bootPending || (error instanceof CloudProviderError && (error.retryAfterMs ?? 0) > 2000)) throw error;
        previousError = error;
        await pause(2000, error);
      }
    }
  } finally { for (const timer of timers) clearTimeout(timer); }
}

/** Boat commands do not have a separate stdin/environment carrier. Use its
 * authenticated API only for public SSH material, and use pinned OpenSSH for
 * the one-use setup admission. No plaintext secret file is put in the VM. */
export class BoatSetupCommandRunner implements CloudWorkspaceCommandRunner {
  constructor(
    private readonly options: {
      client: Pick<BoatApiClient, "request">;
      assertOwned(resourceId: string): Promise<void>;
      maxTimeoutSeconds: number;
      maxOutputBytes: number;
      openChannel?: (signal: AbortSignal) => Promise<BoatBootstrapChannel>;
    },
  ) {
    if (
      !Number.isSafeInteger(options.maxTimeoutSeconds) ||
      options.maxTimeoutSeconds < 1 ||
      options.maxTimeoutSeconds > 1800 ||
      !Number.isSafeInteger(options.maxOutputBytes) ||
      options.maxOutputBytes < 128 ||
      options.maxOutputBytes > 1024 * 1024
    ) {
      throw new Error("Invalid Boat bootstrap bounds");
    }
  }

  /** Wait out a restoring base before the coordinator mints setup authority.
   * Any definitive status, ready or not, is left to the readiness check that
   * runs after admission; provider errors keep their ordinary bound. */
  async awaitReadiness(
    input: Parameters<NonNullable<CloudWorkspaceCommandRunner["awaitReadiness"]>>[0],
    signal: AbortSignal,
  ): Promise<void> {
    if (!BOAT_RESOURCE_ID_PATTERN.test(input.resourceId) || !/^bc1-[a-f0-9]{64}$/.test(input.runtimeBaseCompatibilityId) ||
      !Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > this.options.maxTimeoutSeconds)
      throw new CloudProviderError("provider_command_invalid", "Boat accepts only the fixed setup admission", false);
    signal.throwIfAborted();
    await this.options.assertOwned(input.resourceId);
    await waitForBoatBaseStatus(this.options.client, input.resourceId, input.runtimeBaseCompatibilityId, signal, input.timeoutSeconds,
      BASE_RESTORE_GATE_MS);
  }

  async execute(
    input: Parameters<CloudWorkspaceCommandRunner["execute"]>[0],
    signal: AbortSignal,
  ): Promise<CommandResult> {
    const encoded = input.env?.[SETUP_ENV];
    const v4 = input.command === CLOUD_WORKSPACE_RUNTIME_INSTALL_COMMAND;
    if (
      !BOAT_RESOURCE_ID_PATTERN.test(input.resourceId) ||
      (!v4 && input.command !== CLOUD_WORKSPACE_LINUX_SETUP_HELPER_COMMAND) ||
      (v4 ? !/^bc1-[a-f0-9]{64}$/.test(input.runtimeBaseCompatibilityId ?? "") : input.runtimeBaseCompatibilityId !== undefined) ||
      (input.cwd !== undefined && input.cwd !== "/") ||
      !encoded ||
      !/^[A-Za-z0-9_-]+$/.test(encoded) ||
      encoded.length > (v4 ? RUNTIME_INSTALL_MAX_ENCODED_BYTES : 48 * 1024) ||
      Object.keys(input.env ?? {}).length !== 1 ||
      !Number.isSafeInteger(input.timeoutSeconds) ||
      input.timeoutSeconds < 1 ||
      input.timeoutSeconds > this.options.maxTimeoutSeconds
    ) {
      throw new CloudProviderError(
        "provider_command_invalid",
        "Boat accepts only the fixed setup admission",
        false,
      );
    }
    if (v4) {
      let valid = false;
      try {
        const parsed = RuntimeInstallInputSchema.safeParse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
        valid = parsed.success && parsed.data.purpose === "workspace-setup";
      } catch { /* Input and URLs never appear in errors. */ }
      if (!valid) throw new CloudProviderError("provider_command_invalid", "Boat accepts only the fixed setup admission", false);
    }
    signal.throwIfAborted();
    await this.options.assertOwned(input.resourceId);
    const timings = v4 ? setupTimingClock("boat_transport") : undefined;
    const transportFinished = timings?.start("ssh_transport");
    let bootstrapFinished: ReturnType<ReturnType<typeof setupTimingClock>["start"]> | undefined;
    const operation = executeBoatPinnedSsh({
      resourceId: input.resourceId,
      command: `${input.command}${v4 ? "" : " --stdin"}`,
      stdin: encoded,
      timeoutSeconds: input.timeoutSeconds,
    }, this.options, signal, async () => {
      bootstrapFinished = timings?.start("bootstrap_probe");
      // Boat cold resume restores disk, not the image's OCI entrypoint or /run.
      // This fixed, secret-free helper probes or starts the one root broker;
      // it cannot replace an active engine or consume a launch admission.
      const prepared = v4 ? await waitForBoatBaseStatus(this.options.client, input.resourceId, input.runtimeBaseCompatibilityId!, signal, input.timeoutSeconds)
        : await this.options.client.request(
        `/sandboxes/${input.resourceId}/commands`,
        {
          method: "POST",
          body: { command: ENSURE_SUPERVISOR_COMMAND, timeoutSeconds: 20 },
          signal,
        },
      );
      let baseReady = false;
      if (v4 && typeof prepared.stdout === "string" && /^[^\r\n]+\n?$/.test(prepared.stdout)) {
        try {
          const status = RuntimeBaseStatusSchema.safeParse(JSON.parse(prepared.stdout));
          baseReady = status.success && status.data.baseCompatibilityId === input.runtimeBaseCompatibilityId &&
            (status.data.hostState === "idle" || status.data.hostState === "waiting_for_runtime");
        } catch { /* The provider response cannot contribute free text. */ }
      }
      if (
        prepared.success !== true ||
        prepared.exitCode !== 0 ||
        prepared.timedOut ||
        prepared.stdoutTruncated ||
        (v4 ? !baseReady : prepared.stdout !== "ready\n")
      ) {
        let files;
        if (!v4) try {
          const probe = await this.options.client.request(`/sandboxes/${input.resourceId}/commands`, {
            method: "POST", body: { command: BOOTSTRAP_FILE_PROBE_COMMAND, timeoutSeconds: 5 }, signal,
          });
          if (probe.success === true && probe.exitCode === 0 && !probe.stdoutTruncated && typeof probe.stdout === "string" && /^[01]{4}$/.test(probe.stdout))
            files = { node: probe.stdout[0] === "1", supervisor: probe.stdout[1] === "1", setup: probe.stdout[2] === "1", engine: probe.stdout[3] === "1" };
        } catch { /* Diagnostic transport must not weaken bootstrap rejection. */ }
        throw Object.assign(new CloudProviderError(
          "provider_bootstrap_unavailable", "Boat runtime broker is not ready", true,
        ), { diagnostic: { version: 1, phase: "bootstrap", exit: prepared.timedOut ? "timeout" : prepared.stdoutTruncated ? "overflow" :
          typeof prepared.exitCode === "number" && prepared.exitCode !== 0 ? "nonzero" : "unknown", ...(files ? { files } : {}) } });
      }
      bootstrapFinished?.();
    });
    try {
      const result = await operation;
      transportFinished?.(result.exitCode === 0 ? "passed" : "failed");
      return { ...result, ...(timings ? { timings: timings.snapshot() } : {}) };
    } catch (error) {
      bootstrapFinished?.(signal.aborted ? "cancelled" : "failed");
      transportFinished?.(signal.aborted ? "cancelled" : "failed");
      if (timings && error instanceof Error) Object.assign(error, { timings: timings.snapshot() });
      throw error;
    }
  }
}
