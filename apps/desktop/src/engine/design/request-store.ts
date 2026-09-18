import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { designTransactionSchema } from "@zeros/design-core";
import {
  designPrivateStorageDirectory,
  writePrivateDesignState,
} from "./metadata";
import { readSafeRegularFile } from "./safe-files";

export const DESIGN_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const DESIGN_REQUEST_LIMIT = 512;
export const DESIGN_REQUEST_STORE_BYTES = 4 * 1024 * 1024;
export const designRequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const entrySchema = z
  .object({
    id: designRequestIdSchema,
    actorId: designRequestIdSchema,
    signature: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.number().int().nonnegative(),
    status: z.enum([
      "proposed",
      "started",
      "committed",
      "rejected",
      "indeterminate",
    ]),
    transaction: designTransactionSchema.optional(),
    proposal: z.object({
      documentId: z.string().max(260),
      baseRevision: z.string().max(128),
      intent: z.string().max(2048),
      operationCount: z.number().int().min(0).max(256),
    }).strict().optional(),
    review: z.object({
      decision: z.enum(["accept", "reject"]),
      reviewerId: z.literal("desktop"),
      reviewedAt: z.number().int().nonnegative(),
    }).strict().optional(),
    result: z.unknown().optional(),
  })
  .strict();
const storeSchema = z
  .object({
    version: z.literal(1),
    directoryId: z.string(),
    retiredBefore: z.number().int().nonnegative().default(0),
    entries: z.array(entrySchema).max(DESIGN_REQUEST_LIMIT),
  })
  .strict();
export type DesignRequestRecord = z.infer<typeof entrySchema>;

export function designRequestSignature(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Private, bounded retry/proposal records. Callers hold the workspace's
 * semantic mutation lane across read/change/write. A started record without a
 * receipt is deliberately indeterminate: matching content is not proof that
 * this request committed. Such requests are never replayed automatically. */
export class DesignRequestStore {
  private readonly file: string;
  private retiredBefore = 0;
  constructor(
    private readonly workspacePath: string,
    private readonly directoryId: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = `requests-${createHash("sha256").update(directoryId).digest("hex").slice(0, 32)}.json`;
  }

  async read(): Promise<DesignRequestRecord[]> {
    const root = designPrivateStorageDirectory(this.workspacePath);
    const target = path.join(root, this.file);
    const safe = await readSafeRegularFile(
      root,
      target,
      DESIGN_REQUEST_STORE_BYTES,
    );
    if (!safe) {
      if (existsSync(target))
        throw new Error(
          "Design request history is unsafe or exceeds its byte limit.",
        );
      this.retiredBefore = 0;
      return [];
    }
    const value = storeSchema.parse(JSON.parse(safe.body.toString("utf8")));
    if (value.directoryId !== this.directoryId)
      throw new Error("Design request history belongs to another directory.");
    if (
      new Set(value.entries.map((entry) => `${entry.actorId}\0${entry.id}`))
        .size !== value.entries.length
    ) {
      throw new Error("Design request history contains duplicate identities.");
    }
    this.retiredBefore = value.retiredBefore;
    return value.entries.filter((entry) => {
      const retain =
        entry.status === "started" ||
        entry.status === "indeterminate" ||
        this.now() - entry.createdAt <= DESIGN_REQUEST_RETENTION_MS;
      if (!retain)
        this.retiredBefore = Math.max(this.retiredBefore, entry.createdAt);
      return retain;
    });
  }

  write(entries: DesignRequestRecord[]): void {
    // Evict only resolved receipts. The durable timestamp floor prevents an
    // evicted request from becoming a fresh mutation after restart or an ABA
    // content change. Unresolved requests are never silently discarded.
    const sizes = new Map(
      entries.map((entry) => [
        entry,
        Buffer.byteLength(JSON.stringify(entry)) + 1,
      ]),
    );
    let bytes = [...sizes.values()].reduce((total, size) => total + size, 256);
    const removable = entries
      .filter(
        (entry) => entry.status === "committed" || entry.status === "rejected",
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    const removed = new Set<DesignRequestRecord>();
    for (const entry of removable) {
      if (
        entries.length - removed.size <= DESIGN_REQUEST_LIMIT &&
        bytes <= DESIGN_REQUEST_STORE_BYTES
      )
        break;
      removed.add(entry);
      bytes -= sizes.get(entry)!;
      this.retiredBefore = Math.max(this.retiredBefore, entry.createdAt);
    }
    if (removed.size)
      entries.splice(
        0,
        entries.length,
        ...entries.filter((entry) => !removed.has(entry)),
      );
    const value = storeSchema.parse({
      version: 1,
      directoryId: this.directoryId,
      retiredBefore: this.retiredBefore,
      entries,
    });
    const source = JSON.stringify(value);
    if (Buffer.byteLength(source) > DESIGN_REQUEST_STORE_BYTES)
      throw new Error(
        "Design request history is full; review retained proposals before continuing.",
      );
    writePrivateDesignState(this.workspacePath, this.file, source);
  }

  add(entries: DesignRequestRecord[], entry: DesignRequestRecord): void {
    const checked = entrySchema.parse(entry);
    if (checked.createdAt <= this.retiredBefore)
      throw new Error(
        "Design request belongs to retired history; inspect the current document and create a new request.",
      );
    entries.push(checked);
    this.write(entries);
  }
}
