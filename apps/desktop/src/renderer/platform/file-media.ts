import { FILE_MEDIA_CHUNK_BYTES, fileMediaDescriptorSchema, type FileMediaDescriptor } from "@zeros/protocol/file-media";
import { createWorkspaceMediaReader } from "./files";
import { isNativeRuntime, nativeInvoke, nativeListen } from "./runtime";

export interface FileMediaLease {
  url: string;
  release(): void;
  download(filename: string): Promise<boolean>;
}
interface RangeRequest { sourceId: string; requestId: string; offset: number; length: number }
type Reader = (request: RangeRequest) => Promise<string>;
const readers = new Map<string, Reader>();
let listening: Promise<() => void> | undefined;
function listen() {
  return listening ??= nativeListen<RangeRequest>("file-media-range", request => {
    const read = readers.get(request.sourceId);
    if (!read) {
      // Delivery can trail renderer cleanup. Drain the native request's slot
      // immediately instead of holding the global read budget until timeout.
      void nativeInvoke("file_media_reply", { requestId: request.requestId, error: true }).catch(() => {});
      return;
    }
    void read(request).then(base64 => {
      return nativeInvoke("file_media_reply", { requestId: request.requestId,
        ...(readers.get(request.sourceId) === read ? { base64 } : { error: true }) });
    }, () => nativeInvoke("file_media_reply", { requestId: request.requestId, error: true })).catch(() => {});
  });
}

/** Only native Chromium owns encoded buffers/decoder work. Renderer forwards
 * bounded range strings from its already-authorized exact workspace bridge. */
export async function openWorkspaceMedia(input: { cwd: string; path: string; bytes: number; media: FileMediaDescriptor }): Promise<FileMediaLease> {
  if (!isNativeRuntime()) throw new Error("Open this file in the desktop app to stream its preview.");
  const descriptor = fileMediaDescriptorSchema.parse(input.media);
  const readRange = createWorkspaceMediaReader(input.cwd), sourceId = crypto.randomUUID();
  await listen();
  readers.set(sourceId, async request => {
    if (!Number.isSafeInteger(request.offset) || !Number.isSafeInteger(request.length) || request.offset < 0 || request.length < 1 || request.length > FILE_MEDIA_CHUNK_BYTES || request.offset + request.length > input.bytes) throw new Error("Invalid media range");
    const result = await readRange({ path: input.path, version: descriptor.version, offset: request.offset, length: request.length });
    if (result.bytes !== request.length) throw new Error("The media file changed");
    return result.base64;
  });
  let url: string;
  try { url = await nativeInvoke<string>("file_media_open", { sourceId, bytes: input.bytes, mimeType: descriptor.mimeType }); }
  catch (error) { readers.delete(sourceId); throw error; }
  let leases = 1, released = false;
  const release = () => {
    if (--leases !== 0) return;
    readers.delete(sourceId);
    void nativeInvoke("file_media_close", { sourceId }).catch(() => {});
  };
  return {
    url,
    release: () => { if (!released) { released = true; release(); } },
    download: async filename => {
      if (released) throw new Error("The preview is closed");
      leases++;
      try { return await nativeInvoke<boolean>("file_media_download", { url, filename }); }
      finally { release(); }
    },
  };
}
