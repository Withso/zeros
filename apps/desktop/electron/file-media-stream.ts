import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { FILE_MEDIA_CHUNK_BYTES, FILE_MEDIA_SCHEME, MAX_FILE_MEDIA_BYTES, fileMediaDescriptorSchema, parseFileMediaRange } from "@zeros/protocol/file-media";

const registration = z.object({
  sourceId: z.string().uuid(),
  mimeType: fileMediaDescriptorSchema.shape.mimeType,
  bytes: z.number().int().min(0).max(MAX_FILE_MEDIA_BYTES),
});
type Source = z.infer<typeof registration> & { owner: number; token: string; send: (event: unknown) => void; streams: Set<AbortController>; reads: number };
type Pending = { source: Source; signal: AbortSignal; length: number; resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void };

/** Adapts Chromium's pull-driven Range requests to the authenticated workspace
 * reader. No paths, credentials, whole-file buffers or persistent cache cross
 * this native boundary. Capabilities belong to one renderer main frame. */
export class FileMediaStreams {
  private readonly sources = new Map<string, Source>();
  private readonly pending = new Map<string, Pending>();
  private readonly readWaiters = new Set<() => void>();
  private active = 0;

  register(owner: number, input: unknown, send: Source["send"]): string {
    const data = registration.parse(input);
    if (this.sources.size >= 24 || [...this.sources.values()].some(source => source.owner === owner && source.sourceId === data.sourceId)) throw new Error("Too many media previews are open");
    const token = randomBytes(32).toString("hex");
    this.sources.set(token, { ...data, owner, token, send, streams: new Set(), reads: 0 });
    return `${FILE_MEDIA_SCHEME}://file/${token}`;
  }
  close(owner: number, sourceId?: string): void {
    for (const [token, source] of this.sources) {
      if (source.owner !== owner || (sourceId !== undefined && source.sourceId !== sourceId)) continue;
      this.sources.delete(token);
      for (const controller of source.streams) controller.abort();
    }
    // Whole-owner retirement means the renderer itself is gone/navigating.
    if (sourceId === undefined) for (const request of this.pending.values()) {
      if (request.source.owner === owner) request.reject(new Error("Media window closed"));
    }
  }
  reply(owner: number, input: Record<string, unknown>): void {
    if (typeof input.requestId !== "string") return;
    const request = this.pending.get(input.requestId);
    if (!request || request.source.owner !== owner) return;
    if (request.signal.aborted) { request.reject(new Error("Media read cancelled")); return; }
    const value = input.base64;
    if (input.error || typeof value !== "string" || value.length !== Math.ceil(request.length / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      request.reject(new Error("The media range could not be read"));
      return;
    }
    const buffer = Buffer.from(value, "base64");
    if (buffer.length !== request.length) request.reject(new Error("The media file changed"));
    else request.resolve(buffer);
  }
  owns(owner: number, url: string): boolean { return this.source(url)?.owner === owner; }
  private source(value: string): Source | undefined {
    try {
      const url = new URL(value);
      if (url.protocol !== `${FILE_MEDIA_SCHEME}:` || url.hostname !== "file" || url.port || url.username || url.password || url.search || url.hash || !/^\/[a-f0-9]{64}$/.test(url.pathname)) return;
      return this.sources.get(url.pathname.slice(1));
    } catch { return; }
  }

  private async read(source: Source, offset: number, length: number, signal: AbortSignal): Promise<Uint8Array> {
    // Current HTTP streams already bound this queue to eight waiters. A new
    // seek waits for an abandoned RPC's slot, and cancelling that seek removes
    // its waiter without sending another workspace request.
    while (!signal.aborted && (this.pending.size >= 8 || source.reads >= 3)) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { this.readWaiters.delete(wake); signal.removeEventListener("abort", abort); };
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(new Error("Media read cancelled")); };
        this.readWaiters.add(wake); signal.addEventListener("abort", abort, { once: true });
      });
    }
    if (signal.aborted || !this.sources.has(source.token)) return Promise.reject(new Error("Media preview closed"));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      source.reads++;
      const finish = (error?: Error, bytes?: Uint8Array) => {
        if (!this.pending.delete(requestId)) return;
        source.reads--;
        for (const wake of this.readWaiters) wake();
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(bytes!);
      };
      // Cancelling HTTP playback cannot cancel an already-sent workspace RPC.
      // Reject playback now, but keep its budget slot until reply/timeout so
      // rapid seeking on a slow cloud link cannot accumulate upstream reads.
      const abort = () => reject(new Error("Media read cancelled"));
      const timer = setTimeout(() => finish(new Error("Media read timed out")), 30_000);
      timer.unref();
      this.pending.set(requestId, { source, signal, length, resolve: bytes => finish(undefined, bytes), reject: finish });
      signal.addEventListener("abort", abort, { once: true });
      try { source.send({ sourceId: source.sourceId, requestId, offset, length }); }
      catch { finish(new Error("Media preview unavailable")); }
    });
  }

  response(request: Request): Response {
    const source = this.source(request.url);
    if (!source || !["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 404 });
    const headers = new Headers({ "Content-Type": source.mimeType, "Accept-Ranges": "bytes", "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*", "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff" });
    const range = parseFileMediaRange(request.headers.get("range"), source.bytes);
    if (!range) { headers.set("Content-Range", `bytes */${source.bytes}`); return new Response(null, { status: 416, headers }); }
    // Smaller video packets reduce Chromium's read-ahead and IPC allocations.
    // Honor its complete HTTP range: truncating an open range makes Electron's
    // media loader misidentify EOF and breaks seeks outside that response.
    const chunkBytes = source.mimeType.startsWith("video/") && range.partial ? 256 * 1024 : FILE_MEDIA_CHUNK_BYTES;
    const length = range.end - range.start + 1;
    headers.set("Content-Length", String(length));
    if (range.partial) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${source.bytes}`);
    const status = range.partial ? 206 : 200;
    if (request.method === "HEAD" || length === 0) return new Response(null, { status, headers });
    if (this.active >= 8 || source.streams.size >= 3) return new Response(null, { status: 429 });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();
    source.streams.add(controller); this.active++;
    let offset = range.start, finished = false;
    const finish = () => {
      if (finished) return;
      finished = true; controller.abort(); this.active--; source.streams.delete(controller);
      request.signal.removeEventListener("abort", cancel);
    };
    const body = new ReadableStream<Uint8Array>({
      start: stream => {
        controller.signal.addEventListener("abort", () => {
          if (!finished) { stream.error(new Error("Media read cancelled")); finish(); }
        }, { once: true });
        if (controller.signal.aborted) { stream.error(new Error("Media read cancelled")); finish(); }
      },
      pull: async stream => {
        try {
          const bytes = await this.read(source, offset, Math.min(chunkBytes, range.end - offset + 1), controller.signal);
          if (controller.signal.aborted) throw new Error("Media preview closed");
          stream.enqueue(bytes); offset += bytes.length;
          if (offset > range.end) { stream.close(); finish(); }
        } catch (error) { stream.error(error); finish(); }
      },
      cancel: finish,
    }, { highWaterMark: 0 });
    return new Response(body, { status, headers });
  }
}
