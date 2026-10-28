import {
  ATTACHMENT_CHUNK_BYTES,
  contextAttachmentPath,
  safeAttachmentFilename,
  validateAttachmentFile,
  type AttachmentWriteResult,
} from "@zeros/protocol/attachment-policy";
import { createContextAttachmentWriter } from "./agent-history-client";
import { attachmentReferenceBlock } from "./attachment-reference";
import {
  prepareAttachmentSource,
  completeAttachmentSource,
} from "./attachment-sources";
import { attachmentOwner } from "./attachment-owner";
import { registerAttachmentSourceOwner } from "./attachment-source-retention";
import type { ComposerAttachment } from "./composer-attachments";
import { offerPendingFilePreview } from "../../platform/pending-file-preview";
import { workspaceFileAccessKey } from "../../platform/workspace-file-scope";

export type FileAttachmentProgress = {
  phase: "saving" | "ready" | "error";
  percent: number;
  error?: string;
  diskPath?: string;
};
const states = new Map<string, FileAttachmentProgress>();
const listeners = new Map<string, Set<() => void>>();
const flights = new Map<string, Promise<AttachmentWriteResult>>();
let active = 0;
const waiting: Array<() => void> = [];

function keyFor(cwd: string, id: string): string {
  return JSON.stringify([
    attachmentOwner(cwd).runtime,
    cwd.replace(/\/$/, ""),
    id,
    workspaceFileAccessKey(cwd),
  ]);
}
export function getFileAttachmentProgress(
  cwd: string,
  id: string,
): FileAttachmentProgress | undefined {
  return states.get(keyFor(cwd, id));
}
export function subscribeFileAttachmentProgress(
  cwd: string,
  id: string,
  listener: () => void,
): () => void {
  const key = keyFor(cwd, id);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(key);
  };
}
function publish(key: string, state: FileAttachmentProgress): void {
  const previous = states.get(key);
  if (
    previous?.phase === state.phase &&
    previous.percent === state.percent &&
    previous.error === state.error &&
    (state.diskPath === undefined || previous.diskPath === state.diskPath)
  )
    return;
  states.delete(key);
  states.set(key, { ...state, diskPath: state.diskPath ?? previous?.diskPath });
  for (const [oldKey, old] of states) {
    if (states.size <= 128) break;
    if (old.phase !== "saving" && !listeners.has(oldKey)) states.delete(oldKey);
  }
  for (const listener of listeners.get(key) ?? []) listener();
}

/** Legacy inline drafts use the older writer, but their pills need the same
 * confirmed-path publication as streamed imports. */
export function publishSavedAttachment(cwd: string, attachment: ComposerAttachment, result: AttachmentWriteResult): void {
  attachment.diskPath = result.relativePath;
  attachment.absolutePath = result.absolutePath;
  attachment.contextAttachmentId ??= attachment.id;
  attachment.owner = attachmentOwner(cwd);
  publish(keyFor(cwd, attachment.contextAttachmentId), { phase: "ready", percent: 100, diskPath: result.relativePath });
}

async function withUploadSlot<T>(task: () => Promise<T>): Promise<T> {
  if (waiting.length >= 32) throw new Error("Too many files are waiting to upload. Wait for a file to finish, then retry.");
  if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  else active += 1;
  try {
    return await task();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}

async function base64Chunk(blob: Blob): Promise<string> {
  // The browser encodes in native code; avoid constructing a million-character
  // JS string for every chunk. The fallback serves DOM-free test runtimes.
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(String(reader.result).split(",", 2)[1] ?? "");
      reader.onerror = () => reject(reader.error);
      reader.onabort = () =>
        reject(new Error("Attachment read was interrupted"));
      reader.readAsDataURL(blob);
    });
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Attach-time and send-time callers share the exact same transfer. Pending
 * sources have private recovery storage; saved drafts contain metadata only.
 * Restored drafts resolve completed records before retrying an interrupted
 * import. Agent delivery never embeds the file contents. */
export async function ensureFileAttachment(
  cwd: string,
  attachment: ComposerAttachment,
): Promise<AttachmentWriteResult> {
  const id = attachment.contextAttachmentId ?? attachment.id;
  const owner = attachmentOwner(cwd);
  attachment.owner ??= owner;
  const key = keyFor(cwd, id);
  // Conflicting legacy records may share an id but have different confirmed
  // paths. They must not adopt each other's in-flight resolution.
  const flightKey = JSON.stringify([key, attachment.diskPath ?? null, attachment.name, attachment.mimeType]);
  let flight = flights.get(flightKey);
  if (!flight) {
    const validation = validateAttachmentFile({
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
    });
    if (!validation.ok) throw new Error(validation.reason);
    const writeContextAttachment = createContextAttachmentWriter(cwd);
    const canUpload = !!attachment.sourceFile || !!attachment.sourceRecoveryId;
    const args = {
      cwd,
      attachmentId: id,
      filename: attachment.name,
      mimeType: attachment.mimeType,
      diskPath: attachment.diskPath,
    };
    const previous = states.get(key);
    // A queued transfer owns its immutable source independently of the caller's
    // mutable draft. Another destination may finish and retire that draft's
    // recovery fields before this queue slot is admitted.
    if (attachment.sourceFile) attachment.sourceRecoveryId ??= crypto.randomUUID();
    const transferSource = { ...attachment };
    const finishPreview = attachment.sourceFile
      ? offerPendingFilePreview(cwd, attachment.diskPath ?? contextAttachmentPath(id, safeAttachmentFilename(attachment.name)), attachment.sourceFile) : undefined;
    publish(key, { phase: "saving", percent: 0 });
    const releaseOwner = registerAttachmentSourceOwner(() => [transferSource, attachment]);
    flight = withUploadSlot(async () => {
      if (!canUpload) {
        return writeContextAttachment({ ...args, base64: "", resolve: true });
      }
      // A dispatcher can reuse the same Blob in several workspaces. Resolve
      // against THIS workspace instead of trusting another owner's snapshot
      // or uploading the same 500 MB again on every send/undo.
      if (attachment.diskPath || !attachment.sourceFile || previous) {
        try {
          return await writeContextAttachment({
            ...args,
            base64: "",
            resolve: true,
          });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes("not available")
          )
            throw error;
        }
      }
      const prepared = await prepareAttachmentSource(transferSource, cwd.startsWith("cloud://"));
      if (prepared.nativeSourceId) {
        const result = await writeContextAttachment({
          ...args,
          base64: "",
          nativeSourceId: prepared.nativeSourceId,
        });
        if (
          result.pending ||
          !result.absolutePath ||
          !result.relativePath ||
          result.bytes !== attachment.size
        )
          throw new Error("Attachment copy did not finish");
        return result;
      }
      const source = prepared.blob;
      if (!source || source.size !== attachment.size)
        throw new Error("Attachment size changed — attach it again");
      const uploadId = crypto.randomUUID();
      try {
        // Older engines reject the empty-payload handshake before receiving
        // any file bytes. Detect build skew before a partial copy is written.
        let result = await writeContextAttachment({
          ...args,
          uploadId,
          offset: 0,
          totalBytes: source.size,
          base64: "",
        });
        if (source.size > 0 && !result.pending)
          throw new Error("Restart Zeros to enable large attachment transfers");
        for (
          let offset = 0;
          offset < source.size;
          offset += ATTACHMENT_CHUNK_BYTES
        ) {
          const base64 = await base64Chunk(
            source.slice(offset, offset + ATTACHMENT_CHUNK_BYTES),
          );
          result = await writeContextAttachment({
            ...args,
            uploadId,
            offset,
            totalBytes: source.size,
            base64,
          });
          const received = Math.min(
            offset + ATTACHMENT_CHUNK_BYTES,
            source.size,
          );
          if (received < source.size && !result.pending)
            throw new Error(
              "Attachment transfer ended before the file was saved",
            );
          publish(key, {
            phase: "saving",
            percent: source.size
              ? Math.min(99, Math.floor((received * 100) / source.size))
              : 99,
          });
        }
        if (
          result.pending ||
          !result.relativePath ||
          !result.absolutePath ||
          result.bytes !== source.size
        )
          throw new Error("Attachment transfer did not finish");
        return result;
      } catch (error) {
        await writeContextAttachment({
          ...args,
          uploadId,
          base64: "",
          abort: true,
        }).catch(() => {});
        throw error;
      }
    }).then((result) => {
      attachment.diskPath = result.relativePath;
      attachment.absolutePath = result.absolutePath;
      attachment.owner = attachmentOwner(cwd);
      attachment.contextAttachmentId = id;
      attachment.delivery = "reference";
      finishPreview?.();
      releaseOwner();
      void completeAttachmentSource(attachment).catch(() => {});
      return result;
    }).finally(releaseOwner);
    flights.set(flightKey, flight);
    void flight
      .then(
        (result) => {
          publish(key, {
            phase: "ready",
            percent: 100,
            diskPath: result.relativePath,
          });
        },
        (error: unknown) => {
          publish(key, {
            phase: "error",
            percent: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      )
      .finally(() => {
        if (flights.get(flightKey) === flight) flights.delete(flightKey);
      });
  }
  const result = await flight;
  attachment.diskPath = result.relativePath;
  attachment.absolutePath = result.absolutePath;
  attachment.owner = attachmentOwner(cwd);
  attachment.contextAttachmentId = id;
  attachment.delivery = "reference";
  void completeAttachmentSource(attachment).catch(() => {});
  return result;
}

export function resetFileAttachmentTransfersForTests(): void {
  states.clear();
  flights.clear();
  listeners.clear();
}

export function fileAttachmentReference(
  name: string,
  result: AttachmentWriteResult,
): string {
  const escape = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const reference = attachmentReferenceBlock({
    name,
    mimeType: result.mimeType,
    absolutePath: result.absolutePath,
  });
  return `<attached_file name="${escape(name)}" mime="${escape(result.mimeType)}" bytes="${result.bytes}">\n${escape(reference)}\n</attached_file>`;
}
