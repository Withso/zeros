// The only compute provider cloud v2 uses. Every call is a direct Boat API
// request; there is no provider registry or adapter layer between them.
import { z } from "zod";
import type { BoatApiClient } from "../cloud-workspaces/boat-client.js";

const SANDBOX_ID = /^bx_[a-z0-9]{4,32}$/;
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
/** Our own idle stop decides when to stop; Boat's lease is only a backstop. */
const LEASE_SECONDS = 24 * 60 * 60;

export type CloudV2CommandResult = { exitCode: number; stdout: string; timedOut: boolean };

export interface CloudV2Compute {
  /** Idempotent per key: a retry after a lost reply returns the same sandbox. */
  create(input: { key: string; from: string; name: string; env: Record<string, string> }): Promise<{ sandboxId: string }>;
  resume(sandboxId: string): Promise<void>;
  stop(sandboxId: string): Promise<void>;
  /** Succeeds when the sandbox is already gone. */
  delete(sandboxId: string): Promise<void>;
  exec(sandboxId: string, command: string, timeoutSeconds: number): Promise<CloudV2CommandResult>;
  /** Saves a stopped sandbox's disk under a name; a later name replaces it. */
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
  constructor(private readonly client: Pick<BoatApiClient, "request">, private readonly machineType = "default") {}

  async create(input: { key: string; from: string; name: string; env: Record<string, string> }) {
    if (!SNAPSHOT_NAME.test(input.from)) throw new Error("Invalid Boat snapshot name");
    const reply = await this.client.request("/sandboxes", {
      method: "POST",
      idempotencyKey: input.key,
      body: {
        type: this.machineType,
        from: input.from,
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
      body: { command, timeoutSeconds },
      timeoutMs: (timeoutSeconds + 30) * 1000,
    }));
    return { exitCode: reply.exitCode ?? -1, stdout: reply.stdout ?? "", timedOut: reply.timedOut === true };
  }

  async saveSnapshot(sandboxId: string, name: string): Promise<void> {
    if (!SNAPSHOT_NAME.test(name)) throw new Error("Invalid Boat snapshot name");
    await this.client.request("/named-snapshots", { method: "POST", body: { sandboxId: this.id(sandboxId), name }, timeoutMs: 600_000 });
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
