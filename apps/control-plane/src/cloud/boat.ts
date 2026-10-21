// The only compute provider cloud v2 uses. Every call is a direct Boat API
// request; there is no provider registry or adapter layer between them.
import { z } from "zod";
import type { BoatApiClient } from "../cloud/boat-client.js";

const SANDBOX_ID = /^bx_[a-z0-9]{4,32}$/;
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
/** Our own idle stop decides when to stop; Boat's lease is only a backstop. */
const LEASE_SECONDS = 24 * 60 * 60;

export type CloudV2CommandResult = { exitCode: number; stdout: string; timedOut: boolean };

/** Boat's command endpoint accepts at most about ten minutes per command. */
export const BOAT_MAX_COMMAND_SECONDS = 600;
const SNAPSHOT_SAVE_MS = 30 * 60_000;
const NamedSnapshot = z.object({ snapshot: z.object({ status: z.string() }).passthrough() }).passthrough();

export interface CloudV2Compute {
  /** Idempotent per key: a retry after a lost reply returns the same sandbox. */
  /** From a named snapshot, or Boat's stock image without `from`. */
  create(input: { key: string; from?: string; name: string; env: Record<string, string> }): Promise<{ sandboxId: string }>;
  resume(sandboxId: string): Promise<void>;
  stop(sandboxId: string): Promise<void>;
  /** Succeeds when the sandbox is already gone. */
  delete(sandboxId: string): Promise<void>;
  exec(sandboxId: string, command: string, timeoutSeconds: number): Promise<CloudV2CommandResult>;
  /** Runs past the per-command limit: starts a detached job, then polls it. */
  execLong(sandboxId: string, command: string, timeoutSeconds: number): Promise<CloudV2CommandResult>;
  /** Saves the sandbox's disk under a name and returns once it can deploy. */
  saveSnapshot(sandboxId: string, name: string): Promise<void>;
  deleteSnapshot(name: string): Promise<void>;
}

const Created = z.object({ sandbox: z.object({ id: z.string().regex(SANDBOX_ID) }).passthrough() }).passthrough();
const Command = z.object({
  exitCode: z.number().int().nullable().optional(),
  stdout: z.string().optional(),
  timedOut: z.boolean().optional(),
}).passthrough();

function notFound(error: unknown): boolean {
  const value = error as { code?: unknown; httpStatus?: unknown } | null;
  return typeof value === "object" && value !== null && (value.httpStatus === 404 || value.code === "provider_not_found");
}

export class BoatCloudV2Compute implements CloudV2Compute {
  constructor(
    private readonly client: Pick<BoatApiClient, "request">,
    private readonly machineType = "default",
    private readonly sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  ) {}

  async create(input: { key: string; from?: string; name: string; env: Record<string, string> }) {
    if (input.from !== undefined && !SNAPSHOT_NAME.test(input.from)) throw new Error("Invalid Boat snapshot name");
    const reply = await this.client.request("/sandboxes", {
      method: "POST",
      idempotencyKey: input.key,
      body: {
        type: this.machineType,
        ...(input.from ? { from: input.from } : {}),
        name: input.name,
        ttlSeconds: LEASE_SECONDS,
        env: input.env,
        // Boat's process tracer would keep prompts and logins written to pipes.
        monitoring: false,
      },
    });
    return { sandboxId: Created.parse(reply).sandbox.id };
  }

  async resume(sandboxId: string): Promise<void> {
    await this.client.request(`/sandboxes/${this.id(sandboxId)}/resume`, { method: "POST", body: { ttlSeconds: LEASE_SECONDS } });
  }

  async stop(sandboxId: string): Promise<void> {
    await this.client.request(`/sandboxes/${this.id(sandboxId)}/stop`, { method: "POST" });
  }

  async delete(sandboxId: string): Promise<void> {
    try {
      await this.client.request(`/sandboxes/${this.id(sandboxId)}`, { method: "DELETE", confirmDelete: sandboxId });
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }

  async exec(sandboxId: string, command: string, timeoutSeconds: number): Promise<CloudV2CommandResult> {
    const reply = Command.parse(await this.client.request(`/sandboxes/${this.id(sandboxId)}/commands`, {
      method: "POST",
      body: { command, timeoutSeconds: Math.min(timeoutSeconds, BOAT_MAX_COMMAND_SECONDS) },
      timeoutMs: (Math.min(timeoutSeconds, BOAT_MAX_COMMAND_SECONDS) + 30) * 1000,
    }));
    return { exitCode: reply.exitCode ?? -1, stdout: reply.stdout ?? "", timedOut: reply.timedOut === true };
  }

  async execLong(sandboxId: string, command: string, timeoutSeconds: number): Promise<CloudV2CommandResult> {
    if (timeoutSeconds <= BOAT_MAX_COMMAND_SECONDS - 30) return this.exec(sandboxId, command, timeoutSeconds);
    const job = `/tmp/zeros-job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // The detached script records its own exit status, so it survives the
    // launching command's session ending.
    const script = `(\n${command}\n)\necho $? > ${job}.exit\n`;
    const encoded = Buffer.from(script, "utf8").toString("base64");
    const started = await this.exec(sandboxId,
      `printf %s '${encoded}' | base64 -d > ${job}.sh && { setsid nohup bash ${job}.sh > ${job}.log 2>&1 < /dev/null & } ; echo started`, 30);
    if (started.exitCode !== 0) return started;
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      await this.sleep(5000);
      const poll = await this.exec(sandboxId, `if [ -f ${job}.exit ]; then cat ${job}.exit; else echo running; fi`, 30);
      const state = poll.stdout.trim();
      if (state !== "running") {
        const output = await this.exec(sandboxId, `tail -c 262144 ${job}.log; rm -f ${job}.sh ${job}.exit ${job}.log`, 30);
        return { exitCode: /^\d+$/.test(state) ? Number(state) : -1, stdout: output.stdout, timedOut: false };
      }
      if (Date.now() >= deadline) {
        await this.exec(sandboxId, `pkill -f ${job}.sh || true`, 30).catch(() => {});
        return { exitCode: -1, stdout: "", timedOut: true };
      }
    }
  }

  /** Boat answers the save at once and finishes it in the background. */
  async saveSnapshot(sandboxId: string, name: string): Promise<void> {
    if (!SNAPSHOT_NAME.test(name)) throw new Error("Invalid Boat snapshot name");
    await this.client.request("/named-snapshots", { method: "POST", body: { sandboxId: this.id(sandboxId), name } });
    for (const deadline = Date.now() + SNAPSHOT_SAVE_MS; Date.now() < deadline;) {
      const { status } = NamedSnapshot.parse(await this.client.request(`/named-snapshots/${name}`, { method: "GET" })).snapshot;
      if (status === "ready") return;
      if (status === "failed") throw Object.assign(new Error("snapshot save failed"), { code: "computer_snapshot_failed" });
      await this.sleep(5000);
    }
    throw Object.assign(new Error("snapshot save timed out"), { code: "computer_snapshot_timeout" });
  }

  async deleteSnapshot(name: string): Promise<void> {
    if (!SNAPSHOT_NAME.test(name)) throw new Error("Invalid Boat snapshot name");
    try {
      await this.client.request(`/named-snapshots/${name}`, { method: "DELETE", confirmDelete: name });
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }

  private id(sandboxId: string): string {
    if (!SANDBOX_ID.test(sandboxId)) throw new Error("Invalid Boat sandbox id");
    return sandboxId;
  }
}
