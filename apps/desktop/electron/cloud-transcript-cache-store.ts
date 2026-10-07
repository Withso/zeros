import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CLOUD_TRANSCRIPT_CACHE_BYTES, CLOUD_TRANSCRIPT_CACHE_ENTRIES, CLOUD_TRANSCRIPT_WINDOW_BYTES,
  CloudTranscriptOwnerSchema, CloudTranscriptPruneSchema, CachedTranscriptWindowSchema,
  prepareCachedTranscriptWindow, type CachedTranscriptWindow, type CloudTranscriptOwner, type CloudTranscriptPrune,
} from "../src/renderer/platform/cloud-transcript-cache-contract";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const storedOwner = CloudTranscriptOwnerSchema.omit({ accountId: true }).extend({ accountHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const entrySchema = storedOwner.extend({ bytes: z.number().int().positive().max(CLOUD_TRANSCRIPT_WINDOW_BYTES), revision: z.number().int().safe().nonnegative(), recordEpoch: z.string().max(255).nullable() }).strict();
type Entry = z.infer<typeof entrySchema>;
const entryKey = (value: z.infer<typeof storedOwner>) => digest(JSON.stringify([value.accountHash, value.organizationId, value.workspaceId, value.chatId]));
const storedWindow = z.object({ version: z.literal(1), owner: storedOwner, window: CachedTranscriptWindowSchema }).strict();
const INDEX_BYTES = 512 * 1024;

/** Desktop userData, separate from the single-writer engine DB and purgeable
 * Chromium sessionData. Only the small index loads at startup; windows are read
 * individually. Atomic per-chat replacement avoids rewriting 64 MiB per sync. */
export class CloudTranscriptCacheStore {
  private entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private validDirectory = true;

  constructor(private readonly directory: string, options: { maxEntries?: number; maxBytes?: number } = {}) {
    this.maxEntries = options.maxEntries ?? CLOUD_TRANSCRIPT_CACHE_ENTRIES;
    this.maxBytes = options.maxBytes ?? CLOUD_TRANSCRIPT_CACHE_BYTES;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > CLOUD_TRANSCRIPT_CACHE_ENTRIES ||
        !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1024 || this.maxBytes > CLOUD_TRANSCRIPT_CACHE_BYTES) throw new Error("Invalid transcript cache bound.");
    try {
      const directoryStat = lstatSync(directory);
      this.validDirectory = directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && directoryStat.uid === process.getuid?.();
      if (!this.validDirectory) return;
      const index = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(CLOUD_TRANSCRIPT_CACHE_ENTRIES) }).strict()
        .parse(JSON.parse(this.readFile("index.json", INDEX_BYTES)));
      for (const entry of index.entries) this.entries.set(entryKey(entry), entry);
      this.evict();
      this.removeOrphans();
    } catch {
      // A missing/corrupt index never permits an unindexed record to reappear.
      this.entries.clear();
      if (this.validDirectory) this.removeOrphans();
    }
  }
  private identity(owner: CloudTranscriptOwner) {
    const parsed = CloudTranscriptOwnerSchema.parse(owner);
    return { accountHash: digest(parsed.accountId), organizationId: parsed.organizationId, workspaceId: parsed.workspaceId, chatId: parsed.chatId };
  }
  private readFile(name: string, maxBytes: number): string {
    const fd = openSync(path.join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = fstatSync(fd);
      if (!metadata.isFile() || metadata.uid !== process.getuid?.() || metadata.size > maxBytes) throw new Error("Transcript cache unavailable.");
      return readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
  }
  read(owner: CloudTranscriptOwner): CachedTranscriptWindow | null {
    const identity = this.identity(owner), key = entryKey(identity), entry = this.entries.get(key);
    if (!entry || !this.validDirectory) return null;
    try {
      const raw = this.readFile(`${key}.json`, Math.min(CLOUD_TRANSCRIPT_WINDOW_BYTES, this.maxBytes));
      const record = storedWindow.parse(JSON.parse(raw));
      if (entryKey(record.owner) !== key || record.window.revision !== entry.revision || record.window.recordEpoch !== entry.recordEpoch || Buffer.byteLength(raw) !== entry.bytes) throw new Error("Transcript cache changed.");
      // Disk is untrusted too. Reapply field selection before exposing a window.
      const window = prepareCachedTranscriptWindow(record.window);
      this.entries.delete(key); this.entries.set(key, entry);
      this.saveIndex();
      return window;
    } catch {
      this.entries.delete(key); this.removeWindow(key);
      this.saveIndex();
      return null;
    }
  }
  write(owner: CloudTranscriptOwner, input: unknown): void {
    const identity = this.identity(owner), key = entryKey(identity);
    const window = prepareCachedTranscriptWindow(input), previous = this.entries.get(key);
    // A record epoch is comparable only when actually supplied by the server.
    if (previous && previous.recordEpoch === window.recordEpoch && previous.revision >= window.revision) return;
    let raw = JSON.stringify({ version: 1, owner: identity, window });
    while (window.messages.length && Buffer.byteLength(raw) > Math.min(CLOUD_TRANSCRIPT_WINDOW_BYTES, this.maxBytes)) {
      window.messages.shift(); raw = JSON.stringify({ version: 1, owner: identity, window });
    }
    if (Buffer.byteLength(raw) > this.maxBytes) return;
    this.ensureDirectory();
    // Evict before writing, so the on-disk cache never grows by another window.
    this.entries.delete(key);
    const entry: Entry = { ...identity, bytes: Buffer.byteLength(raw), revision: window.revision, recordEpoch: window.recordEpoch };
    this.entries.set(key, entry); this.evict();
    if (!this.entries.has(key)) { this.saveIndex(); return; }
    this.atomicWrite(`${key}.json`, raw);
    this.saveIndex();
  }
  prune(input: CloudTranscriptPrune): void {
    const scope = CloudTranscriptPruneSchema.parse(input), accountHash = digest(scope.accountId);
    if (scope.retainedWorkspaces) { this.retainWorkspaces(scope.accountId, scope.retainedWorkspaces); return; }
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (entry.accountHash !== accountHash || scope.organizationId && entry.organizationId !== scope.organizationId ||
          scope.workspaceId && entry.workspaceId !== scope.workspaceId || scope.chatId && entry.chatId !== scope.chatId) continue;
      this.removeWindow(key); this.entries.delete(key); changed = true;
    }
    if (changed) this.saveIndex();
  }
  retainWorkspaces(accountId: string, targets: Array<{ organizationId: string; workspaceId: string }>): void {
    const scope = CloudTranscriptPruneSchema.parse({ accountId, retainedWorkspaces: targets });
    const hash = digest(scope.accountId), retained = new Set(targets.map(target => JSON.stringify([target.organizationId, target.workspaceId])));
    let changed = false;
    for (const [key, entry] of this.entries) if (entry.accountHash === hash && !retained.has(JSON.stringify([entry.organizationId, entry.workspaceId]))) {
      this.removeWindow(key); this.entries.delete(key); changed = true;
    }
    if (changed) this.saveIndex();
  }
  retainAccount(accountId: string | null): void {
    const hash = accountId === null ? null : digest(accountId);
    let changed = false;
    for (const [key, entry] of this.entries) if (entry.accountHash !== hash) {
      this.removeWindow(key); this.entries.delete(key); changed = true;
    }
    if (changed) this.saveIndex();
  }
  private ensureDirectory(): void {
    if (!this.validDirectory) throw new Error("Transcript cache unavailable.");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) throw new Error("Transcript cache unavailable.");
  }
  private atomicWrite(name: string, raw: string): void {
    this.ensureDirectory();
    const temporary = path.join(this.directory, `${name}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, raw, { flag: "wx", mode: 0o600 });
      renameSync(temporary, path.join(this.directory, name));
    } finally { rmSync(temporary, { force: true }); }
  }
  private saveIndex(): void {
    this.atomicWrite("index.json", this.index());
  }
  private index(): string { return JSON.stringify({ version: 1, entries: [...this.entries.values()] }); }
  private removeWindow(key: string): void { rmSync(path.join(this.directory, `${key}.json`), { force: true }); }
  private evict(): void {
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (this.entries.size && (this.entries.size > this.maxEntries || bytes + Buffer.byteLength(this.index()) > this.maxBytes)) {
      const key = this.entries.keys().next().value!;
      bytes -= this.entries.get(key)!.bytes; this.entries.delete(key); this.removeWindow(key);
    }
  }
  private removeOrphans(): void {
    try {
      for (const name of readdirSync(this.directory)) {
        const record = /^([a-f0-9]{64})\.json$/u.exec(name);
        if (record && !this.entries.has(record[1]!) || /^(?:index\.json|[a-f0-9]{64}\.json)\.[a-f0-9-]+\.tmp$/u.test(name)) rmSync(path.join(this.directory, name), { force: true });
      }
    } catch { /* Cache misses do not create directories. */ }
  }
}
