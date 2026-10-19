import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { canonicalFinalSaveJson, type CloudFinalSaveCommit } from "@zeros/protocol/cloud-final-save";

export const CLOUD_FINAL_SAVE_BODY_BYTES = 256 * 1024;
export type FinalSaveJournalScope = { organizationId: string; workspaceId: string; generation: number; engineInstanceId: string; origin: string };
export type FinalSaveJournalAttempt = { id: string; reason: string; deadlineAtMs: number };
export type FinalSaveJournalRecord = Readonly<{ version: 1; owner: string; scope: FinalSaveJournalScope;
  attempt: FinalSaveJournalAttempt; body: string; commit: CloudFinalSaveCommit }>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export class CloudFinalSaveJournalError extends Error {
  constructor() { super("cloud final save journal or custody is unavailable"); this.name = "CloudFinalSaveJournalError"; }
}

/** The CP commit's existing canonical digest. The wire body itself is retained
 * separately: key order and whitespace may never change during a retry. */
export function finalSaveCommitDescriptor(body: string): CloudFinalSaveCommit {
  if (Buffer.byteLength(body) > CLOUD_FINAL_SAVE_BODY_BYTES) throw new CloudFinalSaveJournalError();
  const value = JSON.parse(body) as Record<string, unknown>;
  const artifacts = Array.isArray(value.artifactBlobIds) ? [...new Set(value.artifactBlobIds)].sort() : [];
  return { idempotencyKey: String(value.idempotencyKey), bodySha256: sha(body), requestSha256: sha(canonicalFinalSaveJson({
    generation: value.generation, requestId: value.requestId ?? null, contentRevision: value.contentRevision, reason: value.reason,
    manifestBlobId: value.manifestBlobId, artifactBlobId: value.artifactBlobId,
    ...(artifacts.length ? { artifactBlobIds: artifacts } : {}), inclusionPolicy: value.inclusionPolicy,
    fileCount: value.fileCount, totalBytes: value.totalBytes, integritySha256: value.integritySha256,
  })) };
}

/** One unresolved body per original engine. Disk is recovery evidence, never
 * permission to adopt a previous process's frozen writer or workload tickets. */
export class CloudFinalSaveJournal {
  private readonly owner = randomUUID();
  private record: FinalSaveJournalRecord | null = null;
  private poisoned = false;
  private preparing = false;
  constructor(private readonly dataRoot: string) {}

  private async directory(): Promise<FileHandle> {
    const parent = await fs.open(path.resolve(this.dataRoot), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let handle: FileHandle;
    try {
      const directory = `/proc/self/fd/${parent.fd}/final-save-commits`;
      await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      // An earlier read may have created this entry but failed its fsync.
      // Existence alone is not durable publication of the parent entry.
      await parent.sync();
      handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } finally { await parent.close(); }
    try {
      const stat = await handle.stat();
      if (!stat.isDirectory() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700)
        throw new CloudFinalSaveJournalError();
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  private file(directory: FileHandle, scope: FinalSaveJournalScope): string {
    if (!uuid.test(scope.engineInstanceId)) throw new CloudFinalSaveJournalError();
    // The held directory descriptor fences renames and symlink replacement.
    return `/proc/self/fd/${directory.fd}/${scope.engineInstanceId}.json`;
  }
  async read(scope: FinalSaveJournalScope, attempt: FinalSaveJournalAttempt): Promise<FinalSaveJournalRecord | null> {
    if (this.poisoned) throw new CloudFinalSaveJournalError();
    let directory: FileHandle | undefined, file: FileHandle | undefined;
    try {
      directory = await this.directory();
      try { file = await fs.open(this.file(directory, scope), constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !this.record) return null;
        throw error;
      }
      const record = this.record;
      if (!record || record.owner !== this.owner || canonicalFinalSaveJson(record.scope) !== canonicalFinalSaveJson(scope) ||
        canonicalFinalSaveJson(record.attempt) !== canonicalFinalSaveJson(attempt)) throw new CloudFinalSaveJournalError();
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600 ||
        stat.size > CLOUD_FINAL_SAVE_BODY_BYTES * 2) throw new CloudFinalSaveJournalError();
      const bytes = Buffer.alloc(CLOUD_FINAL_SAVE_BODY_BYTES * 2 + 1);
      try {
        let used = 0;
        while (used < bytes.length) {
          const read = await file.read(bytes, used, bytes.length-used, null);
          if (!read.bytesRead) break;
          used += read.bytesRead;
        }
        if (used > CLOUD_FINAL_SAVE_BODY_BYTES * 2 || bytes.subarray(0,used).toString("utf8") !== JSON.stringify(record))
          throw new CloudFinalSaveJournalError();
      } finally { bytes.fill(0); }
      return record;
    } catch { throw new CloudFinalSaveJournalError(); }
    finally { await file?.close(); await directory?.close(); }
  }
  async prepare(scope: FinalSaveJournalScope, attempt: FinalSaveJournalAttempt, body: string): Promise<FinalSaveJournalRecord> {
    const commit = Object.freeze(finalSaveCommitDescriptor(body));
    const held: FinalSaveJournalRecord = Object.freeze({ version: 1, owner: this.owner,
      scope: Object.freeze({ ...scope }), attempt: Object.freeze({ ...attempt }), body, commit });
    if (this.record || this.poisoned || this.preparing) throw new CloudFinalSaveJournalError();
    // All values above are detached before the first await; no bearer is stored.
    this.preparing = true;
    let directory: FileHandle | undefined, temporary: string | undefined, file: FileHandle | undefined;
    try {
      await this.read(held.scope, held.attempt);
      this.record = held;
      directory = await this.directory();
      temporary = `/proc/self/fd/${directory.fd}/.${this.owner}.tmp`;
      file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.writeFile(JSON.stringify(held)); await file.sync(); await file.close(); file = undefined;
      // link is atomic and refuses replacement of any older unresolved body.
      await fs.link(temporary, this.file(directory, held.scope));
      await fs.unlink(temporary); temporary = undefined;
      await directory.sync();
      return held;
    } catch { this.poisoned = true; throw new CloudFinalSaveJournalError(); }
    finally {
      this.preparing = false;
      await file?.close();
      if (temporary) await fs.unlink(temporary).catch(() => undefined);
      await directory?.close();
    }
  }
  descriptor(): CloudFinalSaveCommit | null { return this.record?.commit ?? null; }
  async resolve(scope: FinalSaveJournalScope, attempt: FinalSaveJournalAttempt): Promise<void> {
    if (!await this.read(scope, attempt)) return;
    const directory = await this.directory();
    try { await fs.unlink(this.file(directory, scope)); await directory.sync(); this.record = null; }
    catch { this.poisoned = true; throw new CloudFinalSaveJournalError(); }
    finally { await directory.close(); }
  }
}
