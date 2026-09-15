import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ATTACHMENT_CHUNK_BYTES,
  validateAttachmentFile,
  type AttachmentWriteResult,
} from "@zeros/protocol/attachment-policy";
import {
  safeAttachmentFilename,
  stageContextGraphAttachment,
  stageContextGraphAttachmentFile,
} from "./context-graph";
import {
  assertContextDirectory,
  CONTEXT_DIR,
  LEGACY_CONTEXT_DIR,
} from "./context-paths";

const ID_OK = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_ACTIVE_UPLOADS = 16;
const UPLOAD_IDLE_MS = 5 * 60_000;
interface Upload {
  attachmentId: string;
  filename: string;
  mimeType: string;
  totalBytes: number;
  offset: number;
  directory?: string;
  file?: fs.FileHandle;
  busy: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
const uploads = new Map<string, Upload>();

async function disposeUpload(key: string, upload: Upload): Promise<void> {
  if (uploads.get(key) === upload) uploads.delete(key);
  clearTimeout(upload.timer);
  await upload.file?.close().catch(() => {});
  if (upload.directory)
    await fs.rm(upload.directory, { recursive: true, force: true });
}

export async function resetAttachmentTransfersForTests(): Promise<void> {
  await Promise.all(
    [...uploads].map(([key, upload]) => disposeUpload(key, upload)),
  );
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`attachment: missing ${key}`);
  return value;
}

async function resolveAttachment(
  root: string,
  attachmentId: string,
  filename: string,
  mimeType: string,
): Promise<AttachmentWriteResult> {
  // Exact attachment identity, without the Context canvas's bounded listing or
  // a file-body read. Sharing and legacy root migration may move this record.
  for (const directory of [CONTEXT_DIR, LEGACY_CONTEXT_DIR]) {
    for (const scope of ["local", "shared"]) {
      const folder = path.join(
        root,
        directory,
        scope,
        "attachments",
        attachmentId,
      );
      await assertContextDirectory(folder, root);
      const target = path.join(folder, safeAttachmentFilename(filename));
      const stat = await fs
        .lstat(target)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (!stat?.isFile()) continue;
      const validation = validateAttachmentFile({
        name: filename,
        mimeType,
        size: stat.size,
      });
      if (!validation.ok) throw new Error(validation.reason);
      return {
        absolutePath: target,
        relativePath: path.relative(root, target),
        mimeType,
        bytes: stat.size,
        skipped: true,
      };
    }
  }
  throw new Error("The saved attachment is not available — attach it again");
}

/** Shared trust-boundary implementation for Electron IPC and the authenticated
 * workspace bridge. The caller authorizes root; no client-supplied source path
 * is accepted. Incomplete uploads live in private temporary directories, never
 * among completed graph records. Only the final operation changes the graph. */
export async function transferContextAttachment(
  workspaceRoot: string,
  args: Record<string, unknown>,
): Promise<AttachmentWriteResult> {
  const attachmentId = requiredString(args, "attachmentId");
  if (!ID_OK.test(attachmentId)) throw new Error("invalid attachment id");
  const filename = requiredString(args, "filename");
  const mimeType = requiredString(args, "mimeType");
  if (typeof args.base64 !== "string")
    throw new Error("attachment: missing base64");
  const root = await fs.realpath(workspaceRoot);
  if (args.resolve === true)
    return resolveAttachment(root, attachmentId, filename, mimeType);

  if (args.uploadId === undefined) {
    if (
      args.offset !== undefined ||
      args.totalBytes !== undefined ||
      args.abort !== undefined
    )
      throw new Error("attachment: missing upload id");
    const verdict = validateAttachmentFile({
      name: filename,
      mimeType,
      size: 0,
    });
    if (!verdict.ok) throw new Error(verdict.reason);
    const result = await stageContextGraphAttachment(root, {
      attachmentId,
      filename,
      base64: args.base64,
    });
    if (!result.ok) throw new Error(result.error);
    return {
      absolutePath: result.absolutePath!,
      relativePath: result.relativePath!,
      mimeType,
      bytes: result.bytes!,
      ...(result.skipped ? { skipped: true } : {}),
    };
  }

  const uploadId = requiredString(args, "uploadId");
  if (!ID_OK.test(uploadId)) throw new Error("invalid upload id");
  const key = JSON.stringify([root, uploadId]);
  let upload = uploads.get(key);
  if (upload?.busy) throw new Error("attachment upload is busy");
  if (args.abort === true) {
    if (upload) {
      if (upload.attachmentId !== attachmentId)
        throw new Error("attachment metadata changed");
      await disposeUpload(key, upload);
    }
    return {
      absolutePath: "",
      relativePath: "",
      mimeType,
      bytes: 0,
      pending: true,
    };
  }
  const totalBytes = args.totalBytes as number;
  const offset = args.offset as number;
  const verdict = validateAttachmentFile({
    name: filename,
    mimeType,
    size: totalBytes,
  });
  if (!verdict.ok) throw new Error(verdict.reason);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes)
    throw new Error("invalid attachment offset");
  if (
    args.base64.length > Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4 ||
    args.base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(args.base64)
  ) {
    throw new Error("invalid attachment chunk");
  }
  const chunk = Buffer.from(args.base64, "base64");
  if (
    chunk.length > ATTACHMENT_CHUNK_BYTES ||
    offset + chunk.length > totalBytes ||
    (chunk.length === 0 && offset !== 0)
  )
    throw new Error("invalid attachment chunk size");
  if (
    upload &&
    (upload.attachmentId !== attachmentId ||
      upload.filename !== filename ||
      upload.mimeType !== mimeType ||
      upload.totalBytes !== totalBytes)
  )
    throw new Error("attachment metadata changed");
  if (upload && upload.offset !== offset)
    throw new Error("unexpected attachment offset");
  if (!upload) {
    if (offset !== 0) throw new Error("attachment upload not found");
    if (uploads.size >= MAX_ACTIVE_UPLOADS)
      throw new Error(
        "Too many attachment uploads; try again after another finishes",
      );
    upload = {
      attachmentId,
      filename,
      mimeType,
      totalBytes,
      offset: 0,
      busy: false,
    };
    uploads.set(key, upload);
  }
  upload.busy = true;
  clearTimeout(upload.timer);
  try {
    if (!upload.file) {
      upload.directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "zeros-attachment-upload-"),
      );
      upload.file = await fs.open(
        path.join(upload.directory, "contents"),
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    }
    await upload.file.writeFile(chunk);
    upload.offset += chunk.length;
    if (upload.offset < upload.totalBytes) {
      const pending = upload;
      upload.timer = setTimeout(() => {
        void disposeUpload(key, pending).catch(() => {});
      }, UPLOAD_IDLE_MS);
      upload.timer.unref();
      return {
        absolutePath: "",
        relativePath: "",
        mimeType,
        bytes: upload.offset,
        pending: true,
      };
    }
    const staged = await stageContextGraphAttachmentFile(root, {
      attachmentId,
      filename,
      file: upload.file,
      size: totalBytes,
    });
    if (!staged.ok) throw new Error(staged.error);
    await disposeUpload(key, upload);
    return {
      absolutePath: staged.absolutePath!,
      relativePath: staged.relativePath!,
      mimeType,
      bytes: staged.bytes!,
      ...(staged.skipped ? { skipped: true } : {}),
    };
  } catch (error) {
    await disposeUpload(key, upload);
    throw error;
  } finally {
    upload.busy = false;
  }
}
