// Drives cloud v2 workspaces through their transitional states on Boat, and
// stops idle ones. Every step is idempotent, so a crash or a lost reply only
// repeats it: creation uses the workspace id as Boat's idempotency key, and
// the worker credential is delivered by command after boot, never in the
// sandbox definition, so it can be rotated on any retry.
import type { CloudV2Compute } from "./boat.js";
import type { CloudV2Store, CloudV2Workspace } from "./store.js";

const BATCH = 10;
const LEASE_MS = 2 * 60_000;
const HELLO_POLL_MS = 15_000;
const BOOT_DEADLINE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 8;
export const CLOUD_V2_IDLE_STOP_MS = 10 * 60_000;
/** Boat's stock image runs commands as its one user, `user`. The worker and
 * agents run as that user too, so its credential lives in its config dir. */
export const CLOUD_V2_WORKER_TOKEN_PATH = "/home/user/.config/zeros/worker-token";

export type CloudV2LifecycleDeps = {
  store: Pick<CloudV2Store, "claimPending" | "defer" | "transition" | "rotateWorkerToken" | "computerSnapshot" | "revoke" | "idleSince">;
  compute: CloudV2Compute;
  /** Non-secret boot settings, e.g. the relay URL and workspace id. */
  bootEnv(workspace: CloudV2Workspace): Record<string, string>;
  sandboxName(workspace: CloudV2Workspace): string;
  /** Cloud Computer builds share this loop; one runs at a time. */
  builds?: { tick(): Promise<void> };
  now?: () => number;
  logger?: Pick<Console, "warn">;
};

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : "provider_request_failed";
}

/** Writes the worker credential owner-only. The value is a single-quoted base64
 * literal the shell never expands. */
export function deliverWorkerTokenCommand(token: string): string {
  if (!/^zw2w_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid worker token");
  const encoded = Buffer.from(token, "utf8").toString("base64");
  const dir = CLOUD_V2_WORKER_TOKEN_PATH.slice(0, CLOUD_V2_WORKER_TOKEN_PATH.lastIndexOf("/"));
  return `umask 077 && mkdir -p ${dir} && chmod 700 ${dir} && ` +
    `printf %s '${encoded}' | base64 -d > ${CLOUD_V2_WORKER_TOKEN_PATH}.tmp && ` +
    `mv -f ${CLOUD_V2_WORKER_TOKEN_PATH}.tmp ${CLOUD_V2_WORKER_TOKEN_PATH}`;
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
    };
  }

  private building: Promise<void> | null = null;

  async tick(): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
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
        else await this.deps.store.defer(workspace.id, workspace.state, Math.min(5_000 * 2 ** workspace.attempts, 5 * 60_000));
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
        await this.deliverToken(workspace.id, sandboxId);
        await store.defer(workspace.id, "creating", HELLO_POLL_MS);
        return;
      }
      case "starting": {
        if (!workspace.boatSandboxId) throw Object.assign(new Error("missing sandbox"), { code: "sandbox_missing" });
        // Resume is idempotent; repeating it while the worker boots is harmless.
        if (workspace.attempts === 1 || workspace.attempts % 4 === 0) await compute.resume(workspace.boatSandboxId);
        if (workspace.attempts === 1) await this.deliverToken(workspace.id, workspace.boatSandboxId);
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

  private async deliverToken(workspaceId: string, sandboxId: string): Promise<void> {
    const token = await this.deps.store.rotateWorkerToken(workspaceId);
    const result = await this.deps.compute.exec(sandboxId, deliverWorkerTokenCommand(token), 30);
    if (result.exitCode !== 0 || result.timedOut) throw Object.assign(new Error("token delivery failed"), { code: "worker_token_delivery_failed" });
  }
}
