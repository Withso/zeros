import {
  FILE_MEDIA_CHUNK_BYTES,
  type FileMediaDescriptor,
} from "@zeros/protocol/file-media";
import { createWorkspaceMediaReader } from "@/renderer/platform/files";

export const MAX_WORD_PREVIEW_BYTES = 50_000_000;

export async function readDocumentBytes(
  source: {
    cwd?: string;
    path: string;
    bytes: number;
    media?: FileMediaDescriptor;
    blob?: Blob;
  },
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    source.bytes > MAX_WORD_PREVIEW_BYTES ||
    (source.blob?.size ?? 0) > MAX_WORD_PREVIEW_BYTES
  )
    throw new Error("This Word document is too large to preview.");
  if (!Number.isSafeInteger(source.bytes) || source.bytes < 1)
    throw new Error("The document source is unavailable.");
  signal.throwIfAborted();
  if (source.blob) {
    const data = new Uint8Array(await source.blob.arrayBuffer());
    signal.throwIfAborted();
    if (data.length !== source.bytes)
      throw new Error("The document changed while reading.");
    return data;
  }
  if (!source.cwd || !source.media)
    throw new Error("The document source is unavailable.");
  const read = createWorkspaceMediaReader(source.cwd),
    data = new Uint8Array(source.bytes);
  for (let offset = 0; offset < data.length; offset += FILE_MEDIA_CHUNK_BYTES) {
    signal.throwIfAborted();
    const length = Math.min(FILE_MEDIA_CHUNK_BYTES, data.length - offset);
    const result = await read({
      path: source.path,
      version: source.media.version,
      offset,
      length,
    });
    signal.throwIfAborted();
    const decoded = atob(result.base64);
    if (decoded.length !== length || result.bytes !== length)
      throw new Error("The document changed while reading.");
    for (let index = 0; index < decoded.length; index++)
      data[offset + index] = decoded.charCodeAt(index);
  }
  return data;
}

/** Bound actual expansion before JSZip allocates the document tree. Header
 * sizes alone cannot bound an untrusted compressed stream. Ordinary DOCX uses
 * stored/deflate entries, without ZIP64, encryption or multi-disk archives. */
export async function validateDocxArchive(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const fail = () => {
    throw new Error("This Word document can't be previewed.");
  };
  signal?.throwIfAborted();
  if (bytes.length < 22 || bytes.length > MAX_WORD_PREVIEW_BYTES) return fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let footer = bytes.length - 22;
  while (
    footer >= Math.max(0, bytes.length - 65557) &&
    view.getUint32(footer, true) !== 0x06054b50
  )
    footer--;
  if (
    footer < 0 ||
    view.getUint32(footer, true) !== 0x06054b50 ||
    footer + 22 + view.getUint16(footer + 20, true) !== bytes.length
  )
    return fail();
  const count = view.getUint16(footer + 10, true),
    start = view.getUint32(footer + 16, true),
    size = view.getUint32(footer + 12, true);
  if (
    !count ||
    count > 2000 ||
    view.getUint32(footer + 4, true) !== 0 ||
    view.getUint16(footer + 8, true) !== count ||
    start + size !== footer
  )
    return fail();
  let offset = start,
    expanded = 0,
    document = false;
  const names = new Set<string>();
  const entries: Array<{
    start: number;
    data: number;
    end: number;
    expanded: number;
    method: number;
  }> = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > footer || view.getUint32(offset, true) !== 0x02014b50)
      return fail();
    const flags = view.getUint16(offset + 8, true),
      compressed = view.getUint32(offset + 20, true),
      uncompressed = view.getUint32(offset + 24, true);
    const method = view.getUint16(offset + 10, true),
      local = view.getUint32(offset + 42, true);
    const nameLength = view.getUint16(offset + 28, true),
      extraLength = view.getUint16(offset + 30, true),
      commentLength = view.getUint16(offset + 32, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (
      next > footer ||
      local + 30 > start ||
      view.getUint32(local, true) !== 0x04034b50
    )
      return fail();
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder().decode(rawName);
    const localNameLength = view.getUint16(local + 26, true),
      localExtraLength = view.getUint16(local + 28, true);
    const data = local + 30 + localNameLength + localExtraLength,
      end = data + compressed;
    if (
      end > start ||
      localNameLength !== nameLength ||
      !rawName.every((byte, index) => byte === bytes[local + 30 + index]) ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method ||
      (!(flags & 8) &&
        (view.getUint32(local + 18, true) !== compressed ||
          view.getUint32(local + 22, true) !== uncompressed))
    )
      return fail();
    expanded += uncompressed;
    if (
      flags & 0x2041 ||
      view.getUint16(offset + 34, true) !== 0 ||
      ![0, 8].includes(method) ||
      (method === 0 && compressed !== uncompressed) ||
      uncompressed > 32_000_000 ||
      expanded > 64_000_000 ||
      !name ||
      names.has(name) ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((part) => part === "." || part === "..") ||
      name.includes("\0")
    )
      return fail();
    names.add(name);
    entries.push({ start: local, data, end, expanded: uncompressed, method });
    document ||= name === "word/document.xml";
    offset = next;
  }
  if (offset !== footer || !document) return fail();
  entries.sort((a, b) => a.start - b.start);
  for (let index = 0; index < entries.length; index++) {
    signal?.throwIfAborted();
    const entry = entries[index];
    if (index && entry.start < entries[index - 1].end) return fail();
    if (entry.method === 0) continue;
    const reader = new Blob([bytes.slice(entry.data, entry.end)])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"))
      .getReader();
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    let length = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        length += value.length;
        if (length > entry.expanded) return fail();
      }
      if (length !== entry.expanded) return fail();
    } catch {
      signal?.throwIfAborted();
      return fail();
    } finally {
      signal?.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
    }
  }
}
