import {
  getDocument,
  GlobalWorkerOptions,
  PDFDataRangeTransport,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  FILE_MEDIA_CHUNK_BYTES,
  type FileMediaDescriptor,
} from "@zeros/protocol/file-media";
import { createWorkspaceMediaReader } from "@/renderer/platform/files";

GlobalWorkerOptions.workerSrc = workerUrl;
const MAX_PDF_RANGE_BYTES = 32 * 1024 * 1024;

// Vite emits the upstream fonts, CMaps and image decoders as local assets.
// No document or fallback resource is sent to an external service.
const resources = import.meta.glob<string>(
  [
    "/node_modules/pdfjs-dist/cmaps/*.bcmap",
    "/node_modules/pdfjs-dist/standard_fonts/*.{ttf,pfb}",
    "/node_modules/pdfjs-dist/wasm/*.wasm",
  ],
  { eager: true, query: "?url", import: "default" },
);

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

class LocalPdfResources {
  async fetch({
    kind,
    filename,
  }: {
    kind: string;
    filename: string;
  }): Promise<Uint8Array> {
    const directory = {
      cMapUrl: "cmaps",
      standardFontDataUrl: "standard_fonts",
      wasmUrl: "wasm",
    }[kind];
    const url =
      directory &&
      resources[`/node_modules/pdfjs-dist/${directory}/${filename}`];
    if (!url) throw new Error("The document resource is unavailable.");
    if (url.startsWith("data:"))
      return decodeBase64(url.slice(url.indexOf(",") + 1));
    // XMLHttpRequest supports packaged file:// resources as well as dev HTTP.
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("GET", url);
      request.responseType = "arraybuffer";
      request.onload = () =>
        request.response && (request.status === 0 || request.status === 200)
          ? resolve(new Uint8Array(request.response))
          : reject(new Error("The document resource is unavailable."));
      request.onerror = () =>
        reject(new Error("The document resource is unavailable."));
      request.send();
    });
  }
}

export interface PdfSource {
  cwd?: string;
  path: string;
  bytes: number;
  media?: FileMediaDescriptor;
  blob?: Blob;
  dataUrl?: string;
}

/** PDF.js requests bounded ranges through the same exact-workspace authority
 * as media playback. Retiring a document prevents queued and late reads. */
export function openPdfDocument(source: PdfSource, onError: () => void) {
  const read =
    source.cwd && source.media ? createWorkspaceMediaReader(source.cwd) : null;
  const inline = source.dataUrl?.startsWith("data:")
    ? decodeBase64(source.dataUrl.slice(source.dataUrl.indexOf(",") + 1))
    : null;
  let closed = false;
  class Ranges extends PDFDataRangeTransport {
    private queue = Promise.resolve();
    override requestDataRange(begin: number, end: number) {
      this.queue = this.queue
        .then(async () => {
          if (closed) return;
          if (
            !Number.isSafeInteger(begin) ||
            !Number.isSafeInteger(end) ||
            begin < 0 ||
            end <= begin ||
            end > source.bytes
          )
            throw new Error("Invalid document range");
          // PDF.js requires one response for a coalesced range. Bound that
          // allocation as well as each wire read, even for malformed xrefs.
          if (end - begin > MAX_PDF_RANGE_BYTES)
            throw new Error("The document range is too large to preview.");
          const buffer = new Uint8Array(end - begin);
          for (
            let offset = begin;
            offset < end && !closed;
            offset += FILE_MEDIA_CHUNK_BYTES
          ) {
            const length = Math.min(FILE_MEDIA_CHUNK_BYTES, end - offset);
            const data = source.blob
              ? new Uint8Array(
                  await source.blob
                    .slice(offset, offset + length)
                    .arrayBuffer(),
                )
              : inline
                ? inline.slice(offset, offset + length)
                : read && source.media
                  ? decodeBase64(
                      (
                        await read({
                          path: source.path,
                          version: source.media.version,
                          offset,
                          length,
                        })
                      ).base64,
                    )
                  : null;
            if (!data || data.length !== length)
              throw new Error("The document changed while reading.");
            if (!closed) buffer.set(data, offset - begin);
          }
          if (!closed) this.onDataRange(begin, buffer);
        })
        .catch(() => {
          if (!closed) {
            closed = true;
            onError();
          }
        });
    }
    override abort() {
      closed = true;
    }
  }
  const range = new Ranges(source.bytes, null);
  return getDocument({
    range,
    rangeChunkSize: 65536,
    disableAutoFetch: true,
    disableStream: true,
    useWorkerFetch: false,
    BinaryDataFactory: LocalPdfResources,
    enableXfa: false,
    maxImageSize: 32 * 1024 * 1024,
    canvasMaxAreaInBytes: 64 * 1024 * 1024,
    verbosity: 0,
  });
}
