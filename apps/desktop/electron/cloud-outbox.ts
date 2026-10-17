// ──────────────────────────────────────────────────────────
// cloud-outbox — the desktop's durable command outbox for cloud workspaces.
// ──────────────────────────────────────────────────────────
//
// One outbox per signed-in account, living in Electron main (S3-Q5). Every
// lifecycle command (create/wake/stop/archive/delete/rename) enters through
// here before it touches the network: the entry's id IS the Idempotency-Key
// and stays identical across every retry, so a crash between "sent" and
// "response received" can only ever replay, never duplicate.
//
// Bounds and privacy (S3-Q5):
//   • at most 500 entries, entries expire after 7 days;
//   • cleared on sign-out (the account switch seam in the IPC layer);
//   • capabilities, tickets and tokens are NEVER persisted here — enqueue
//     rejects a body that smells like a credential.
//
// Local workspaces never touch this module; the capability gate at
// `createCloudOutboxIfEnabled` keeps the SDK from even opening the directory
// when ZEROS_CLOUD_WORKSPACES_ENABLED is false.
// ──────────────────────────────────────────────────────────

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { classifyFailure, retryDelayMs } from "@zeros/cloud-client";

export const CLOUD_OUTBOX_MAX_ENTRIES = 500;
export const CLOUD_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The control plane remembers an Idempotency-Key's answer for 24 h. A
 * pending entry is resent only within this window after its first send
 * (one hour of margin for clock differences); after it, a resend could run
 * the command a second time. */
export const CLOUD_OUTBOX_RESEND_WINDOW_MS = 23 * 60 * 60 * 1000;

const OperationSchema = z.enum(["create", "wake", "stop", "archive", "delete", "rename"]);
export type CloudOutboxOperation = z.infer<typeof OperationSchema>;

const EntrySchema = z
  .object({
    /** The Idempotency-Key. Never regenerated, even across restarts. */
    id: z.string().min(8).max(128),
    operation: OperationSchema,
    organizationId: z.string().min(1),
    workspaceId: z.string().min(1).optional(),
    body: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    firstSentAt: z.number().int().nonnegative().optional(),
    state: z.enum(["pending", "completed", "failed"]),
    replayed: z.boolean().optional(),
    lastError: z.object({ code: z.string(), status: z.number().int().optional() }).strict().optional(),
  })
  .strict();
export type CloudOutboxEntry = z.infer<typeof EntrySchema>;

const FileSchema = z
  .object({ version: z.literal(1), entries: z.array(EntrySchema).max(CLOUD_OUTBOX_MAX_ENTRIES) })
  .strict();

export type CloudOutboxSendResult = { status: number; replayed: boolean; body?: unknown };
export type CloudOutboxSender = (entry: CloudOutboxEntry) => Promise<CloudOutboxSendResult>;

export type CloudOutboxOptions = {
  accountId: string;
  /** userData directory; the account's file name is a sha256 of the id. */
  directory: string;
  send: CloudOutboxSender;
  now?: () => number;
  random?: () => number;
  /** Timer seam; defaults to setTimeout. Receives the retry delay. */
  schedule?: (delayMs: number, run: () => void) => void;
  /** Fires exactly once per entry when it reaches completed or failed. */
  onSettled?: (entry: CloudOutboxEntry) => void;
  maxEntries?: number;
  ttlMs?: number;
  resendWindowMs?: number;
};

/** Keys that must never be written to disk: capabilities, tickets, tokens… */
const SECRET_KEY = /(capabilit|ticket|token|secret|signature|credential|authorization)/i;

function containsSecret(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSecret);
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => SECRET_KEY.test(key) || containsSecret(child),
  );
}

export class CloudOutbox {
  private entries: CloudOutboxEntry[] = [];
  private readonly file: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly schedule: (delayMs: number, run: () => void) => void;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly resendWindowMs: number;
  private readonly send: CloudOutboxSender;
  private readonly onSettled?: (entry: CloudOutboxEntry) => void;
  private draining: Promise<void> | null = null;
  private drainRequested = false;
  private closed = false;

  constructor(options: CloudOutboxOptions) {
    this.file = path.join(options.directory, cloudOutboxFileName(options.accountId));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.schedule = options.schedule ?? ((delayMs, run) => setTimeout(run, delayMs).unref?.());
    this.maxEntries = options.maxEntries ?? CLOUD_OUTBOX_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? CLOUD_OUTBOX_TTL_MS;
    this.resendWindowMs = options.resendWindowMs ?? CLOUD_OUTBOX_RESEND_WINDOW_MS;
    this.send = options.send;
    if (options.onSettled) this.onSettled = options.onSettled;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > CLOUD_OUTBOX_MAX_ENTRIES)
      throw new Error("Invalid cloud outbox bound.");
    if (!Number.isSafeInteger(this.resendWindowMs) || this.resendWindowMs < 1)
      throw new Error("Invalid cloud outbox bound.");
    if (!existsSync(this.file)) return;
    let parsed: z.infer<typeof FileSchema>;
    try {
      parsed = FileSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch (parseError) {
      // Unknown durable state must not replay blindly: keep it for forensics,
      // start empty. Server-side idempotency (24 h window) absorbs the risk.
      if (process.env.ZEROS_OUTBOX_DEBUG) console.error(parseError);
      renameSync(this.file, `${this.file}.corrupt`);
      return;
    }
    const cutoff = this.now() - this.ttlMs;
    this.entries = parsed.entries.filter((entry) => entry.createdAt >= cutoff);
  }

  enqueue(input: {
    operation: CloudOutboxOperation;
    organizationId: string;
    workspaceId?: string;
    body?: Record<string, unknown>;
  }): CloudOutboxEntry {
    if (this.closed) throw new Error("Cloud outbox is closed.");
    if (containsSecret(input.body))
      throw new Error("The cloud outbox never stores capabilities, tickets or tokens.");
    OperationSchema.parse(input.operation);
    if (input.operation !== "create" && !input.workspaceId)
      throw new Error("Cloud outbox commands need a workspaceId.");
    this.pruneExpired();
    this.evictForEnqueue();
    const entry: CloudOutboxEntry = {
      id: randomUUID(),
      operation: input.operation,
      organizationId: input.organizationId,
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      createdAt: this.now(),
      attempts: 0,
      state: "pending",
    };
    this.entries.push(entry);
    this.persist();
    return { ...entry };
  }

  list(): readonly CloudOutboxEntry[] {
    this.pruneExpired();
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** Sign-out: nothing about the account may remain on disk. */
  clear(): void {
    this.entries = [];
    this.persist();
  }

  /** Cancel follow-up work; a reopened instance resumes pending entries. */
  close(): void {
    this.closed = true;
  }

  /** Await the in-flight drain pass, if any. */
  async whenIdle(): Promise<void> {
    await this.draining;
  }

  /** Single-flight pass over pending entries. */
  drain(): Promise<void> {
    if (this.draining) {
      // The in-flight pass may already have looked for work and found none;
      // without a second pass an entry enqueued now would wait for a restart.
      this.drainRequested = true;
      return this.draining;
    }
    this.draining = (async () => {
      do {
        this.drainRequested = false;
        await this.drainPending();
      } while (this.drainRequested && !this.closed);
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drainPending(): Promise<void> {
    this.pruneExpired();
    // Re-find the oldest pending entry each pass instead of iterating: the
    // array changes under an awaited send (enqueue, prune, eviction).
    for (;;) {
      if (this.closed) return;
      const cutoff = this.now() - this.ttlMs;
      const entry = this.entries.find((candidate) => candidate.state === "pending" && candidate.createdAt >= cutoff);
      if (!entry) return;
      if (entry.firstSentAt !== undefined && this.now() - entry.firstSentAt >= this.resendWindowMs) {
        entry.state = "failed";
        entry.lastError = { code: "outbox_resend_window_expired" };
        this.persist();
        this.onSettled?.({ ...entry });
        continue;
      }
      if (entry.firstSentAt === undefined) {
        // Recorded before the request leaves, so a crash mid-send still counts it.
        entry.firstSentAt = this.now();
        this.persist();
      }
      try {
        const result = await this.send({ ...entry });
        entry.state = "completed";
        if (result.replayed) entry.replayed = true;
        this.persist();
        this.onSettled?.({ ...entry });
      } catch (cause) {
        const failure = cause as { networkError?: boolean; status?: number; body?: unknown };
        const decision = classifyFailure({
          networkError: failure?.networkError === true,
          status: typeof failure?.status === "number" ? failure.status : undefined,
          body: failure?.body,
        });
        if (decision.kind === "retry") {
          entry.attempts += 1;
          this.persist();
          const delayMs = decision.afterMs ?? retryDelayMs(entry.attempts - 1, this.random);
          this.schedule(delayMs, () => {
            if (!this.closed) void this.drain();
          });
          // The scheduled retry covers any drain requested meanwhile; an
          // immediate second pass would skip the backoff.
          this.drainRequested = false;
          return; // retry later; later entries wait behind this one
        }
        entry.state = "failed";
        const code =
          typeof (failure as { code?: unknown })?.code === "string"
            ? (failure as { code: string }).code
            : decision.code;
        entry.lastError = {
          code,
          ...(typeof failure?.status === "number" ? { status: failure.status } : {}),
        };
        this.persist();
        this.onSettled?.({ ...entry });
      }
    }
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    const kept = this.entries.filter((entry) => entry.createdAt >= cutoff);
    if (kept.length === this.entries.length) return;
    this.entries = kept;
    this.persist();
  }

  private evictForEnqueue(): void {
    if (this.entries.length < this.maxEntries) return;
    const settledIndex = this.entries.findIndex((entry) => entry.state !== "pending");
    if (settledIndex === -1)
      throw new Error("The cloud outbox is full of undelivered commands.");
    this.entries.splice(settledIndex, 1);
  }

  private persist(): void {
    // A closed instance may still finish an in-flight send after a reopened
    // instance took over the file; writing its stale array would drop the
    // newer instance's entries. Its pending entry stays pending on disk and is
    // resent under the same Idempotency-Key, which the server replays.
    if (this.closed) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, entries: this.entries } satisfies z.infer<typeof FileSchema>));
    renameSync(temporary, this.file);
  }
}

/** The account's outbox file name; the account id itself never touches disk. */
export function cloudOutboxFileName(accountId: string): string {
  return `${createHash("sha256").update(accountId).digest("hex")}.json`;
}

/**
 * The capability seam. When the desktop cloud capability is off, the outbox is
 * not constructed and its directory is never opened — Local mode provably does
 * not touch the SDK's durable state.
 */
export function createCloudOutboxIfEnabled(options: {
  capabilityEnabled: () => boolean;
  open: () => CloudOutbox;
}): CloudOutbox | null {
  if (!options.capabilityEnabled()) return null;
  return options.open();
}
