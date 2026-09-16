/** File imports are disk references, so their size is independent of model
 * context. MB is decimal, matching the composer label. */
export const MAX_ATTACHMENT_BYTES = 500_000_000;
/** Keep individual encoded requests comfortably below the bridge frame cap. */
export const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;
/** Grace for unreferenced recovery data; referenced drafts never expire. */
export const ATTACHMENT_SOURCE_GRACE_MS = 86_400_000;
export const ATTACHMENT_CLIPBOARD_MIME = "application/x-zeros-composer+json";
export const isAttachmentSourceId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);

/** Read side metadata only. A partial traversal is never safe input to GC. */
export function collectAttachmentSourceIds(value: unknown): string[] | null {
  const ids = new Set<string>();
  const seen = new Set<object>();
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    if (seen.size >= 100_000) return null;
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (key === "sourceRecoveryId" && isAttachmentSourceId(child)) ids.add(child);
      else if (!["sourceFile", "json", "preview"].includes(key) && child && typeof child === "object") pending.push(child);
    }
  }
  return [...ids];
}

// This is a format policy, not a malware scanner. Source scripts remain valid
// coding context. Ambiguous data extensions (.bin, .obj) are not denied.
const EXCLUDED_EXTENSIONS = new Set([
  "zip",
  "zipx",
  "rar",
  "7z",
  "tar",
  "gz",
  "gzip",
  "tgz",
  "bz",
  "bz2",
  "tbz",
  "tbz2",
  "xz",
  "txz",
  "zst",
  "zstd",
  "tzst",
  "lz",
  "lzma",
  "lzo",
  "z",
  "br",
  "cab",
  "ar",
  "cpio",
  "sit",
  "sitx",
  "apk",
  "apks",
  "aab",
  "ipa",
  "app",
  "pkg",
  "mpkg",
  "msi",
  "msp",
  "msix",
  "msixbundle",
  "appx",
  "appxbundle",
  "deb",
  "rpm",
  "appimage",
  "run",
  "jar",
  "war",
  "ear",
  "whl",
  "egg",
  "gem",
  "crate",
  "nupkg",
  "dmg",
  "iso",
  "img",
  "sparseimage",
  "sparsebundle",
  "vhd",
  "vhdx",
  "vmdk",
  "vdi",
  "qcow",
  "qcow2",
  "wim",
  "esd",
  "toast",
  "exe",
  "com",
  "scr",
  "dll",
  "so",
  "dylib",
  "elf",
  "o",
  "a",
  "lib",
  "class",
  "dex",
  "wasm",
]);

const EXCLUDED_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "application/x-bzip",
  "application/x-bzip2",
  "application/x-xz",
  "application/zstd",
  "application/x-lzma",
  "application/x-compress",
  "application/x-cpio",
  "application/vnd.ms-cab-compressed",
  "application/x-apple-diskimage",
  "application/x-iso9660-image",
  "application/vnd.android.package-archive",
  "application/vnd.apple.installer+xml",
  "application/x-debian-package",
  "application/vnd.debian.binary-package",
  "application/x-rpm",
  "application/java-archive",
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-msi",
  "application/vnd.microsoft.portable-executable",
  "application/x-executable",
  "application/x-pie-executable",
  "application/x-sharedlib",
  "application/wasm",
]);

const DOCUMENT_CONTAINERS = new Set([
  "docx",
  "xlsx",
  "pptx",
  "odt",
  "ods",
  "odp",
  "odg",
  "epub",
]);

export function validateAttachmentFile(input: {
  name: string;
  size: number;
  mimeType?: string;
}): { ok: boolean; reason?: string } {
  if (!Number.isSafeInteger(input.size) || input.size < 0) {
    return { ok: false, reason: "Invalid file size" };
  }
  if (input.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: "File exceeds the 500 MB attachment limit" };
  }
  const name = input.name.trim().toLowerCase();
  const extension = name.includes(".") ? name.split(".").at(-1)! : "";
  const mime = (input.mimeType ?? "").split(";")[0].trim().toLowerCase();
  const documentZip =
    DOCUMENT_CONTAINERS.has(extension) &&
    (mime === "application/zip" || mime === "application/x-zip-compressed");
  if (
    EXCLUDED_EXTENSIONS.has(extension) ||
    /\.so(?:\.\d+)+$/.test(name) ||
    (EXCLUDED_MIME_TYPES.has(mime) && !documentZip)
  ) {
    return {
      ok: false,
      reason:
        "Archives, installers, disk images, and compiled executables aren't supported",
    };
  }
  return { ok: true };
}

/** Additive options on the existing attachment.write operation. Old clients
 * can continue sending small base64 payloads. File imports use bounded chunks;
 * resolve returns metadata only for an already-staged record. */
export interface AttachmentTransferOptions {
  /** Opaque Electron-selected source capability. Rejected by remote engines. */
  nativeSourceId?: string;
  uploadId?: string;
  offset?: number;
  totalBytes?: number;
  resolve?: boolean;
  abort?: boolean;
}

export interface AttachmentWriteResult {
  absolutePath: string;
  relativePath: string;
  mimeType: string;
  bytes: number;
  skipped?: boolean;
  pending?: boolean;
}

/** Shared by the atomic writer and clipboard paths for imports still saving. */
export function safeAttachmentFilename(raw: string): string {
  const cleaned = (raw.split("/").pop() ?? "").replace(/[^a-zA-Z0-9._-]+/g, "_");
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned !== ".." ? cleaned.slice(dot) : "";
  const capped = cleaned.length <= 80 ? cleaned
    : extension.length > 0 && extension.length < 80
      ? `${cleaned.slice(0, 80 - extension.length)}${extension}` : cleaned.slice(0, 80);
  return capped === "" || capped === "." || capped === ".." ? "attachment" : capped;
}
