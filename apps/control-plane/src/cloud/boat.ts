// The only compute provider cloud v2 uses. Every call is a direct Boat API
// request; there is no provider registry or adapter layer between them.
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { BoatApiClient } from "../cloud/boat-client.js";

const SANDBOX_ID = /^bx_[a-z0-9]{4,32}$/;
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
/** Our own idle stop decides when to stop; Boat's lease is only a backstop. */
export const CLOUD_V2_LEASE_SECONDS = 24 * 60 * 60;

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
  /** Boat sets the deadline to now + ttl, without restarting the sandbox. */
  extendLease(sandboxId: string, ttlSeconds: number): Promise<void>;
  stop(sandboxId: string): Promise<void>;
  /** Succeeds when the sandbox is already gone. */
  delete(sandboxId: string): Promise<void>;
  exec(sandboxId: string, command: string, timeoutSeconds: number): Promise<CloudV2CommandResult>;
  /** Runs past the per-command limit: starts a detached job, then polls it. */
  execLong(sandboxId: string, command: string, timeoutSeconds: number, input?: string): Promise<CloudV2CommandResult>;
  /** Saves the sandbox's disk under a name and returns once it can deploy. */
  saveSnapshot(sandboxId: string, name: string): Promise<void>;
  deleteSnapshot(name: string): Promise<void>;
  hostPort(sandboxId: string, input: { port: number; localhost: true; title: string }): Promise<{ url: string; token: string }>;
  /** A sandbox with exactly this name created at or after `since`, newest first. */
  findSandbox(name: string, since: Date): Promise<string | null>;
}

const Created = z.object({ sandbox: z.object({ id: z.string().regex(SANDBOX_ID) }).passthrough() }).passthrough();
const Listed = z.object({
  sandboxes: z.array(z.object({ id: z.string(), name: z.string().nullable().optional(), createdAt: z.string() }).passthrough()),
  pageInfo: z.object({ nextCursor: z.string().nullable().optional(), hasMore: z.boolean() }).passthrough(),
}).passthrough();
/** Pages of 200 newest first; a lookup reads at most this many. */
const FIND_PAGES = 50;
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
        ttlSeconds: CLOUD_V2_LEASE_SECONDS,
        env: input.env,
        // Boat's process tracer would keep prompts and logins written to pipes.
        monitoring: false,
      },
    });
    return { sandboxId: Created.parse(reply).sandbox.id };
  }

  async resume(sandboxId: string): Promise<void> {
    await this.client.request(`/sandboxes/${this.id(sandboxId)}/resume`, { method: "POST", body: { ttlSeconds: CLOUD_V2_LEASE_SECONDS } });
  }

  async extendLease(sandboxId: string, ttlSeconds: number): Promise<void> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > CLOUD_V2_LEASE_SECONDS) throw new Error("Invalid Boat lease");
    await this.client.request(`/sandboxes/${this.id(sandboxId)}`, { method: "PATCH", body: { ttlSeconds } });
  }

  async hostPort(sandboxId: string, input: { port: number; localhost: true; title: string }): Promise<{ url: string; token: string }> {
    const id = this.id(sandboxId);
    if (!Number.isSafeInteger(input.port) || input.port < 1024 || input.port > 65535 || input.localhost !== true || input.title.length > 100)
      throw new Error("Invalid private worker route");
    const raw = await this.client.request(`/sandboxes/${id}/host`, {
      method: "POST", idempotencyKey: `${id}:host:${input.port}`, body: { port: input.port, localhost: true, title: input.title },
    });
    try {
      const hosted = z.object({ url: z.string().max(16_384), access: z.literal("private"), isProtected: z.literal(true), localhost: z.literal(true) }).passthrough().parse(raw);
      const url = new URL(hosted.url), token = url.searchParams.get("_token");
      if (url.protocol !== "https:" || !url.hostname.endsWith(`-${input.port}.on.boat.dev`) || url.username || url.password || url.hash ||
          url.port || url.pathname !== "/" || [...url.searchParams.keys()].join(",") !== "_token" || !token || !/^[A-Za-z0-9._~+/=-]{16,8192}$/.test(token)) throw new Error();
      // Never retain a token-bearing URL, even transiently in workspace rows.
      return { url: url.origin, token };
    } catch { throw new Error("Invalid private worker route"); }
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

  async execLong(sandboxId: string, command: string, timeoutSeconds: number, input?: string): Promise<CloudV2CommandResult> {
    if (input !== undefined) {
      if (Buffer.byteLength(input) > 64 * 1024) throw new Error("Command input is too large");
      // Boat's command API has no stdin field. Its authenticated file endpoint
      // keeps input out of shell argv (including base64-encoded argv). The VM
      // is one trust domain; the private file is unlinked before code executes.
      const directory = `/tmp/zeros-command-input-${randomUUID()}`, file = `${directory}/stdin`;
      const prepared = await this.exec(sandboxId, `umask 077; mkdir -m 700 -- '${directory}'`, 30);
      if (prepared.exitCode !== 0 || prepared.timedOut) throw new Error("Command input could not be prepared");
      try {
        const written = await this.client.request(`/sandboxes/${this.id(sandboxId)}/files`, {
          method: "PUT", body: { path: file, content: input, encoding: "utf8" },
        });
        if (!z.object({ success: z.literal(true) }).safeParse(written).success) throw new Error("Command input could not be delivered");
        return await this.execLong(sandboxId, `set -e; exec 3<'${file}'; rm -f -- '${file}'; ${command} <&3 3<&-`, timeoutSeconds);
      } finally {
        await this.exec(sandboxId, `rm -f -- '${file}'; rmdir -- '${directory}'`, 30).catch(() => {});
      }
    }
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

  async findSandbox(name: string, since: Date): Promise<string | null> {
    let cursor: string | null | undefined;
    for (let page = 0; page < FIND_PAGES; page++) {
      const listed = Listed.parse(await this.client.request(`/sandboxes?limit=200&sort=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { method: "GET" }));
      for (const sandbox of listed.sandboxes) {
        if (Date.parse(sandbox.createdAt) < since.getTime()) return null;
        if (sandbox.name === name && SANDBOX_ID.test(sandbox.id)) return sandbox.id;
      }
      if (!listed.pageInfo.hasMore || !listed.pageInfo.nextCursor) return null;
      cursor = listed.pageInfo.nextCursor;
    }
    throw Object.assign(new Error("sandbox lookup too long"), { code: "provider_request_failed" });
  }

  private id(sandboxId: string): string {
    if (!SANDBOX_ID.test(sandboxId)) throw new Error("Invalid Boat sandbox id");
    return sandboxId;
  }
}
