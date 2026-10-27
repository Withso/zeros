import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, rm, stat, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, sep } from "node:path";
import { ATTACHMENT_CHUNK_BYTES, contextAttachmentLocations, contextAttachmentPath, parseContextAttachmentPath, safeAttachmentFilename, validateAttachmentFile, type AttachmentWriteResult } from "@zeros/protocol/attachment-policy";
import { CheckedFiles, descriptorPath } from "./checked-files";
import { WorkspaceError, reqString, type WorkspaceScope } from "./scope";

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const IDLE_MS = 5 * 60_000;
interface Upload {
  attachmentId: string; filename: string; mimeType: string; total: number; offset: number;
  path: string; file?: FileHandle; busy: boolean; timer?: ReturnType<typeof setTimeout>;
  done?: Promise<AttachmentWriteResult>;
}
const invalid = (message: string) => new WorkspaceError("ATTACHMENT_INVALID", message);

/** Standalone cloud receiver. The authenticated workspace service selects the
 * owner; a Local source capability or another checkout is never accepted.
 * One bounded chunk per upload, four transfers per VM, private partial files,
 * atomic no-clobber publication. Nothing stores file bytes in prompt/history. */
export class AttachmentTransfers {
  private readonly uploads = new Map<string, Upload>();
  private readonly checked: CheckedFiles;
  private storage?: Promise<void>;
  private storageIdentity?: { dev: number; ino: number; root: string };
  private disposed = false;
  constructor(private readonly scope: WorkspaceScope, private readonly directory: string, private readonly changed: () => void) {
    this.checked = new CheckedFiles(scope);
  }
  get busy(): boolean { return this.uploads.size > 0; }
  private async assertRecordLocation(file: FileHandle, relativePath: string): Promise<void> {
    await this.checked.assertDescriptor(file);
    // Checkpoints deliberately skip symbolic links in attachment layouts.
    // Never acknowledge a redirected record and then discard its recovery copy.
    if (await realpath(descriptorPath(file)) !== join(await realpath(this.scope.root), relativePath))
      throw invalid("Attachment storage cannot use symbolic links.");
  }
  private async prepareStorage(): Promise<void> {
    this.storage ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const info = await lstat(this.directory), root = await realpath(this.scope.root), directory = await realpath(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink() || directory === root || directory.startsWith(root + sep) || (await stat(root)).dev !== info.dev) throw invalid("Attachment temporary storage is unavailable outside this checkout.");
      this.storageIdentity = { dev: info.dev, ino: info.ino, root: directory };
      // Reclaim only our stale regular partial files. A new worker never scans
      // the user's checkout or follows a symlink during interrupted cleanup.
      const entries = await opendir(this.directory);
      let visited = 0;
      for await (const entry of entries) {
        if (++visited > 128) break;
        if (!/^upload-[a-f0-9-]{36}\.part$/.test(entry.name) || !entry.isFile()) continue;
        const path = join(this.directory, entry.name), file = await lstat(path).catch(() => null);
        if (file?.isFile() && Date.now() - file.mtimeMs > 24 * 60 * 60_000) await rm(path, { force: true });
      }
    })();
    const preparing = this.storage;
    try { await preparing; }
    catch (error) {
      // A failed first attempt must not poison every Retry until worker restart.
      if (this.storage === preparing) { this.storage = undefined; this.storageIdentity = undefined; }
      throw error;
    }
    const identity = this.storageIdentity!, current = await lstat(this.directory);
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino || await realpath(this.directory) !== identity.root) throw invalid("Attachment temporary storage changed.");
  }
  private async remove(id: string, upload: Upload): Promise<void> {
    if (this.uploads.get(id) === upload) this.uploads.delete(id);
    clearTimeout(upload.timer);
    await upload.file?.close().catch(() => {});
    // The held fd may already be closed, but never traverse a replaced parent.
    try {
      const current = await lstat(this.directory);
      if (current.dev === this.storageIdentity?.dev && current.ino === this.storageIdentity?.ino) await rm(upload.path, { force: true });
    } catch { /* Startup cleanup covers an interrupted worker. */ }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled([...this.uploads.values()].map(upload => upload.done));
    await Promise.all([...this.uploads].map(([id, upload]) => this.remove(id, upload)));
  }

  private async resolve(attachmentId: string, filename: string, mimeType: string, diskPath: unknown): Promise<AttachmentWriteResult> {
    let safeName = safeAttachmentFilename(filename);
    const candidates = new Set<string>();
    if (diskPath !== undefined) {
      const parsed = typeof diskPath === "string" ? parseContextAttachmentPath(diskPath) : null;
      if (!parsed || parsed.folderId !== attachmentId || [".", ".."].includes(parsed.filename)) throw invalid("Invalid attachment path identity.");
      safeName = parsed.filename; candidates.add(diskPath as string);
    }
    for (const path of contextAttachmentLocations(attachmentId, safeName)) candidates.add(path);
    let result: AttachmentWriteResult | undefined;
    for (const path of candidates) {
      const file = await this.checked.file(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (!file) continue;
      try {
        const info = await file.stat();
        await this.assertRecordLocation(file, path);
        const validation = validateAttachmentFile({ name: safeName, mimeType, size: info.size });
        if (!validation.ok) throw invalid(validation.reason!);
        if (result) throw invalid("The saved attachment is ambiguous — attach it again.");
        result = { absolutePath: this.scope.path(path), relativePath: path, mimeType, bytes: info.size, skipped: true };
        if (path === diskPath) return result;
      } finally { await file.close(); }
    }
    if (!result) throw new WorkspaceError("ATTACHMENT_UNAVAILABLE", "The saved attachment is not available — attach it again.");
    return result;
  }

  async write(params: Record<string, unknown>): Promise<AttachmentWriteResult> {
    if (this.disposed) throw invalid("The workspace is closing.");
    const attachmentId = reqString(params, "attachmentId"), filename = reqString(params, "filename"), mimeType = reqString(params, "mimeType");
    if (!ID.test(attachmentId) || params.nativeSourceId !== undefined || typeof params.base64 !== "string") throw invalid("Invalid cloud attachment transfer.");
    if (params.resolve === true) return this.resolve(attachmentId, filename, mimeType, params.diskPath);
    const id = reqString(params, "uploadId");
    if (!ID.test(id)) throw invalid("Invalid upload identity.");
    let upload = this.uploads.get(id);
    if (upload && (upload.attachmentId !== attachmentId || upload.filename !== filename || upload.mimeType !== mimeType)) throw invalid("Attachment metadata changed.");
    if (upload?.busy) throw invalid("The attachment upload is busy.");
    if (params.abort === true) {
      if (upload) await this.remove(id, upload);
      return { absolutePath: "", relativePath: "", mimeType, bytes: 0, pending: true };
    }
    const total = params.totalBytes as number, offset = params.offset as number;
    const validation = validateAttachmentFile({ name: filename, mimeType, size: total });
    if (!validation.ok) throw invalid(validation.reason!);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > total || (upload && (upload.total !== total || upload.offset !== offset)) || (!upload && offset !== 0)) throw invalid("Unexpected attachment offset.");
    const base64 = params.base64;
    if (base64.length > Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || (!base64 && offset !== 0)) throw invalid("Invalid attachment chunk.");
    if (!upload) {
      if (this.uploads.size >= 4) throw invalid("Too many attachment uploads. Wait for another to finish.");
      upload = { attachmentId, filename, mimeType, total, offset: 0, path: join(this.directory, `upload-${randomUUID()}.part`), busy: true };
      this.uploads.set(id, upload);
    }
    const current = upload;
    clearTimeout(current.timer); current.busy = true;
    const task = (async () => {
      try {
        const chunk = Buffer.from(base64, "base64");
        if (chunk.length > ATTACHMENT_CHUNK_BYTES || offset + chunk.length > total || chunk.toString("base64") !== base64) throw invalid("Invalid attachment chunk size.");
        await this.prepareStorage();
        current.file ??= await open(current.path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        if (await realpath(descriptorPath(current.file)) !== current.path) throw invalid("Attachment temporary file moved.");
        let written = 0;
        while (written < chunk.length) {
          const { bytesWritten } = await current.file.write(chunk, written, chunk.length - written, offset + written);
          if (!bytesWritten) throw invalid("The attachment could not be saved.");
          written += bytesWritten;
        }
        current.offset += written;
        if (current.offset !== total) {
          current.timer = setTimeout(() => { void this.remove(id, current); }, IDLE_MS); current.timer.unref();
          return { absolutePath: "", relativePath: "", mimeType, bytes: current.offset, pending: true };
        }
        await current.file.sync();
        const relativePath = contextAttachmentPath(attachmentId, safeAttachmentFilename(filename));
        const { parent } = await this.checked.writeParent(relativePath);
        try {
          await this.assertRecordLocation(parent, dirname(relativePath));
          await this.prepareStorage();
          const info = await current.file.stat(), named = await lstat(current.path);
          if (info.size !== total || info.ino !== named.ino || info.dev !== named.dev || !named.isFile()) throw invalid("Attachment temporary file changed.");
          await this.assertRecordLocation(parent, dirname(relativePath));
          // link is atomic and fails on an existing destination; it cannot
          // overwrite a user edit or expose a partial file to agents.
          await link(current.path, `${descriptorPath(parent)}/${basename(relativePath)}`).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "EEXIST") throw invalid("An attachment already exists at this path. Resolve it before uploading again.");
            throw error;
          });
          await parent.sync();
          await this.assertRecordLocation(parent, dirname(relativePath));
          this.changed();
          return { absolutePath: this.scope.path(relativePath), relativePath, mimeType, bytes: total };
        } finally { await parent.close(); }
      } catch (error) {
        await this.remove(id, current); throw error;
      } finally {
        current.busy = false;
        if (current.offset === total) await this.remove(id, current);
      }
    })();
    current.done = task;
    return task;
  }
}
