// Drives cloud v2 workspaces through their transitional states on Boat, and
// stops idle ones. Every step is idempotent, so a crash or a lost reply only
// repeats it: creation uses the workspace id as Boat's idempotency key, and
// the worker credential is delivered by command after boot, never in the
// sandbox definition, so it can be rotated on any retry.
import type { CloudV2Compute, CloudV2CommandResult } from "./boat.js";
import { installRuntimeCommand, type CloudV2Runtime } from "./runtime.js";
import type { CloudV2Store, CloudV2Workspace } from "./store.js";

const BATCH = 10;
const LEASE_MS = 2 * 60_000;
/** The worker's hello moves the workspace to running at once; this poll only
 * re-delivers a credential to a worker that has not connected. */
const HELLO_POLL_MS = 30_000;
const BOOT_DEADLINE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 8;
export const CLOUD_V2_IDLE_STOP_MS = 10 * 60_000;
/** Boat's stock image runs commands as its one user, `user`. The worker and
 * agents run as that user too, so its credential lives in its config dir. */
export const CLOUD_V2_WORKER_TOKEN_PATH = "/home/user/.config/zeros/worker-token";
/** Non-secret boot settings for the worker's systemd unit (EnvironmentFile). */
export const CLOUD_V2_WORKER_ENV_PATH = "/home/user/.config/zeros/worker.env";

export type CloudV2LifecycleDeps = {
  store: Pick<CloudV2Store, "claimPending" | "defer" | "transition" | "rotateWorkerToken" | "computerSnapshot" | "revoke" | "idleSince">;
  compute: CloudV2Compute;
  /** The worker runtime every VM must run; installed on create and on wake. */
  runtime: CloudV2Runtime;
  /** Non-secret boot settings, e.g. the relay URL and workspace id. */
  bootEnv(workspace: CloudV2Workspace): Record<string, string>;
  sandboxName(workspace: CloudV2Workspace): string;
  /** Cloud Computer builds share this loop; one runs at a time. */
  builds?: { tick(): Promise<void>; cleanup?(): Promise<void> };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<Console, "warn">;
};

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : "provider_request_failed";
}

/** Writes the worker credential and its boot settings owner-only, then starts
 * the worker if it is not running. Values are single-quoted base64 literals the
 * shell never expands. Boat's sandbox environment does not reach systemd, so
 * the boot settings travel with the credential. */
export function deliverWorkerTokenCommand(token: string, bootEnv: Readonly<Record<string, string>> = {}): string {
  if (!/^zw2w_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid worker token");
  for (const [name, value] of Object.entries(bootEnv))
    if (!/^ZEROS_[A-Z0-9_]{1,64}$/.test(name) || !/^[\x21-\x7e]{1,2048}$/.test(value)) throw new Error("Invalid worker boot setting");
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const dir = CLOUD_V2_WORKER_TOKEN_PATH.slice(0, CLOUD_V2_WORKER_TOKEN_PATH.lastIndexOf("/"));
  const envFile = Object.entries(bootEnv).map(([name, value]) => `${name}=${value}\n`).join("");
  return `umask 077 && mkdir -p ${dir} && chmod 700 ${dir} && ` +
    `printf %s '${b64(envFile)}' | base64 -d > ${CLOUD_V2_WORKER_ENV_PATH}.tmp && mv -f ${CLOUD_V2_WORKER_ENV_PATH}.tmp ${CLOUD_V2_WORKER_ENV_PATH} && ` +
    `printf %s '${b64(token)}' | base64 -d > ${CLOUD_V2_WORKER_TOKEN_PATH}.tmp && mv -f ${CLOUD_V2_WORKER_TOKEN_PATH}.tmp ${CLOUD_V2_WORKER_TOKEN_PATH} && ` +
    `(sudo -n systemctl restart zeros-worker.service || true)`;
}

export class CloudV2Lifecycle {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: CloudV2LifecycleDeps, private readonly intervalMs = 2_000) {}

  start(): () => Promise<void> {
    this.timer = setInterval(() => { this.running ??= this.tick().finally(() => { this.running = null; }); }, this.intervalMs);
    this.timer.unref();
    return async () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      await this.running;
      await this.building;
      await this.cleaning;
    };
  }

  private building: Promise<void> | null = null;
  private cleaning: Promise<void> | null = null;

  async tick(): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    if (this.building && this.deps.builds?.cleanup && !this.cleaning)
      this.cleaning = this.deps.builds.cleanup().catch(() => {}).finally(() => { this.cleaning = null; });
    // A build can take many minutes; it never blocks workspace lifecycle steps.
    if (this.deps.builds && !this.building)
      this.building = this.deps.builds.tick().catch(() => {}).finally(() => { this.building = null; });
    for (const idle of await this.deps.store.idleSince(new Date(now - CLOUD_V2_IDLE_STOP_MS))) {
      await this.deps.store.transition(idle.id, ["running"], "stopping");
    }
    for (const workspace of await this.deps.store.claimPending(BATCH, LEASE_MS)) {
      try {
        await this.step(workspace, now);
      } catch (error) {
        const code = errorCode(error);
        this.deps.logger?.warn(`[cloud-v2] ${workspace.state} step failed (${code})`);
        if (workspace.attempts >= MAX_ATTEMPTS) await this.deps.store.transition(workspace.id, [workspace.state], "failed", { errorCode: code });
        else await this.deps.store.defer(workspace.id, workspace.state, Math.min(5_000 * 2 ** workspace.attempts, 5 * 60_000), { failure: true });
      }
    }
  }

  private async step(workspace: CloudV2Workspace & { attempts: number }, now: number): Promise<void> {
    const { store, compute } = this.deps;
    switch (workspace.state) {
      case "creating": {
        if (now - Date.parse(workspace.createdAt) > BOOT_DEADLINE_MS) {
          await store.transition(workspace.id, ["creating"], "failed", { errorCode: "worker_boot_timeout" });
          return;
        }
        let sandboxId = workspace.boatSandboxId;
        if (!sandboxId) {
          const from = await store.computerSnapshot(workspace.organizationId);
          if (!from) {
            await store.transition(workspace.id, ["creating"], "failed", { errorCode: "cloud_computer_build_required" });
            return;
          }
          ({ sandboxId } = await compute.create({
            key: workspace.id, from, name: this.deps.sandboxName(workspace), env: this.deps.bootEnv(workspace),
          }));
          await store.defer(workspace.id, "creating", 0, { boatSandboxId: sandboxId });
        }
        await this.ensureRuntime(sandboxId);
        await this.deliverToken(workspace, sandboxId);
        await store.defer(workspace.id, "creating", HELLO_POLL_MS);
        return;
      }
      case "starting": {
        if (!workspace.boatSandboxId) {
          await store.transition(workspace.id, ["starting"], "failed", { errorCode: "sandbox_missing" });
          return;
        }
        const waking = now - Date.parse(workspace.updatedAt);
        if (waking > BOOT_DEADLINE_MS) {
          await store.transition(workspace.id, ["starting"], "failed", { errorCode: "worker_boot_timeout" });
          return;
        }
        // Resume is idempotent. The resumed worker reconnects with the
        // credential it kept; only one that has not gets a fresh credential.
        await compute.resume(workspace.boatSandboxId);
        // A runtime shipped while the VM slept is installed now.
        await this.ensureRuntime(workspace.boatSandboxId);
        if (waking >= HELLO_POLL_MS) await this.deliverToken(workspace, workspace.boatSandboxId);
        await store.defer(workspace.id, "starting", HELLO_POLL_MS);
        return;
      }
      case "stopping":
        if (workspace.boatSandboxId) await compute.stop(workspace.boatSandboxId);
        await store.revoke(workspace.id, false);
        await store.transition(workspace.id, ["stopping"], "stopped");
        return;
      case "deleting":
        if (workspace.boatSandboxId) await compute.delete(workspace.boatSandboxId);
        await store.revoke(workspace.id, true);
        await store.transition(workspace.id, ["deleting"], "deleted");
        return;
      default:
        return;
    }
  }

  private async deliverToken(workspace: CloudV2Workspace, sandboxId: string): Promise<void> {
    const token = await this.deps.store.rotateWorkerToken(workspace.id);
    const result = await this.execWhenReady(sandboxId, deliverWorkerTokenCommand(token, this.deps.bootEnv(workspace)), 30);
    if (result.exitCode !== 0 || result.timedOut) throw Object.assign(new Error("token delivery failed"), { code: "worker_token_delivery_failed" });
  }

  /** Quick when the VM already has the runtime; otherwise downloads it. */
  private async ensureRuntime(sandboxId: string): Promise<void> {
    const { runtime } = this.deps;
    const result = await this.execWhenReady(sandboxId, installRuntimeCommand({ sha256: runtime.sha256, url: await runtime.url() }), 300);
    if (result.exitCode !== 0 || result.timedOut) throw Object.assign(new Error("runtime install failed"), { code: "worker_runtime_install_failed" });
  }

  /** A VM that has just started or resumed can refuse commands for a few seconds. */
  private async execWhenReady(sandboxId: string, command: string, timeoutSeconds: number): Promise<CloudV2CommandResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.deps.compute.exec(sandboxId, command, timeoutSeconds);
      } catch (error) {
        if (attempt >= 6) throw error;
        await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(2_000);
      }
    }
  }
}
