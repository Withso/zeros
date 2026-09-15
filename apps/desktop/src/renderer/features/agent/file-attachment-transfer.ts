import {
  ATTACHMENT_CHUNK_BYTES,
  validateAttachmentFile,
  type AttachmentWriteResult,
} from "@zeros/protocol/attachment-policy";
import { createContextAttachmentWriter } from "./agent-history-client";
import {
  prepareAttachmentSource,
  releaseAttachmentSource,
} from "./attachment-sources";
import { attachmentOwner } from "./attachment-owner";
import { registerAttachmentSourceOwner } from "./attachment-source-retention";
import type { ComposerAttachment } from "./composer-attachments";

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
    previous.error === state.error
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

async function withUploadSlot<T>(task: () => Promise<T>): Promise<T> {
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
  let flight = flights.get(key);
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
    };
    publish(key, { phase: "saving", percent: 0 });
    const releaseOwner = registerAttachmentSourceOwner(() => attachment);
    flight = withUploadSlot(async () => {
      if (!canUpload) {
        return writeContextAttachment({ ...args, base64: "", resolve: true });
      }
      // A dispatcher can reuse the same Blob in several workspaces. Resolve
      // against THIS workspace instead of trusting another owner's snapshot
      // or uploading the same 500 MB again on every send/undo.
      if (attachment.diskPath || !attachment.sourceFile) {
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
      const prepared = await prepareAttachmentSource(attachment);
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
      void releaseAttachmentSource(attachment.sourceRecoveryId).catch(() => {});
      return result;
    }).finally(releaseOwner);
    flights.set(key, flight);
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
        if (flights.get(key) === flight) flights.delete(key);
      });
  }
  const result = await flight;
  attachment.diskPath = result.relativePath;
  attachment.absolutePath = result.absolutePath;
  attachment.owner = attachmentOwner(cwd);
  attachment.contextAttachmentId = id;
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
  return `<attached_file name="${escape(name)}" mime="${escape(result.mimeType)}" bytes="${result.bytes}">\n${escape(result.absolutePath)}\nRead the file with appropriate tools; inspect only the portions needed for the task.\n</attached_file>`;
}
