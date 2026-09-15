/** File imports are disk references, so their size is independent of model
 * context. MB is decimal, matching the composer label. */
export const MAX_ATTACHMENT_BYTES = 500_000_000;
/** Keep individual encoded requests comfortably below the bridge frame cap. */
export const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;

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
