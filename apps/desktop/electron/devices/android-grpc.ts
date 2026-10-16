// A small gRPC client for the Android Emulator's control service, over
// Node's own HTTP/2 and a hand-written protobuf codec, so Zeros ships no
// gRPC or protobuf runtime. It speaks only what the emulator needs: unary
// and server-streaming calls, uncompressed, to 127.0.0.1.

import http2 from "node:http2";

// ── Protobuf ─────────────────────────────────────────────

const VARINT = 0;
const FIXED64 = 1;
const LENGTH = 2;
const FIXED32 = 5;

/** Writes one message's fields in the order they're added. */
export class ProtoWriter {
  private readonly chunks: Buffer[] = [];

  private tag(field: number, wire: number): void {
    this.rawVarint(BigInt(field) * 8n + BigInt(wire));
  }

  private rawVarint(value: bigint): void {
    const bytes: number[] = [];
    let rest = BigInt.asUintN(64, value);
    do {
      const low = Number(rest & 0x7fn);
      rest >>= 7n;
      bytes.push(rest > 0n ? low | 0x80 : low);
    } while (rest > 0n);
    this.chunks.push(Buffer.from(bytes));
  }

  /** int32, uint32, int64, bool and enum fields; negative numbers take ten
   * bytes, as protobuf writes them. */
  varint(field: number, value: number | boolean): this {
    const number = typeof value === "boolean" ? Number(value) : Math.trunc(value);
    this.tag(field, VARINT);
    this.rawVarint(BigInt(number));
    return this;
  }

  bytes(field: number, value: Uint8Array): this {
    this.tag(field, LENGTH);
    this.rawVarint(BigInt(value.byteLength));
    this.chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, Buffer.from(value, "utf8"));
  }

  message(field: number, message: ProtoWriter): this {
    return this.bytes(field, message.finish());
  }

  /** A packed `repeated float`. */
  floats(field: number, values: readonly number[]): this {
    const packed = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => packed.writeFloatLE(value, index * 4));
    return this.bytes(field, packed);
  }

  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export interface ProtoField {
  field: number;
  wire: number;
  /** Varint fields, as a number; past 2^53 it loses precision. */
  number: number;
  /** Length-delimited fields: a view into the message, not a copy. */
  bytes: Buffer | null;
  /** Fixed-width fields' raw little-endian bytes. */
  fixed: Buffer | null;
}

function readVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let multiplier = 1;
  for (let index = 0; index < 10; index++) {
    const byte = buffer[offset + index];
    if (byte === undefined) throw new Error("Truncated protobuf varint.");
    value += (byte & 0x7f) * multiplier;
    multiplier *= 128;
    if ((byte & 0x80) === 0) return { value, next: offset + index + 1 };
  }
  throw new Error("Malformed protobuf varint.");
}

/** A message's fields in wire order. Unknown wire types throw. */
export function readProtoFields(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.next;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    const entry: ProtoField = { field, wire, number: 0, bytes: null, fixed: null };
    switch (wire) {
      case VARINT: {
        const value = readVarint(buffer, offset);
        entry.number = value.value;
        offset = value.next;
        break;
      }
      case FIXED64:
      case FIXED32: {
        const size = wire === FIXED64 ? 8 : 4;
        if (offset + size > buffer.length) throw new Error("Truncated protobuf field.");
        entry.fixed = buffer.subarray(offset, offset + size);
        offset += size;
        break;
      }
      case LENGTH: {
        const length = readVarint(buffer, offset);
        const end = length.next + length.value;
        if (end > buffer.length) throw new Error("Truncated protobuf field.");
        entry.bytes = buffer.subarray(length.next, end);
        offset = end;
        break;
      }
      default:
        throw new Error(`Unsupported protobuf wire type ${wire}.`);
    }
    fields.push(entry);
  }
  return fields;
}

/** The last value of a field, as protobuf reads repeated scalars. */
export function protoField(fields: readonly ProtoField[], field: number): ProtoField | null {
  for (let index = fields.length - 1; index >= 0; index--) {
    if (fields[index]!.field === field) return fields[index]!;
  }
  return null;
}

// ── gRPC ─────────────────────────────────────────────────

export const GRPC_OK = 0;
export const GRPC_CANCELLED = 1;
export const GRPC_UNKNOWN = 2;
export const GRPC_DEADLINE_EXCEEDED = 4;
export const GRPC_RESOURCE_EXHAUSTED = 8;
export const GRPC_UNAVAILABLE = 14;
export const GRPC_UNAUTHENTICATED = 16;

export class GrpcError extends Error {
  override name = "GrpcError";
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Splits a gRPC response body into messages. With `reuse`, a message's
 * buffer is used again for the next one of the same size, so `onMessage`
 * must finish with it before returning. */
export class GrpcMessageFramer {
  private readonly header = Buffer.alloc(5);
  private headerFilled = 0;
  private body: Buffer | null = null;
  private bodyFilled = 0;
  private spare: Buffer | null = null;

  constructor(
    private readonly onMessage: (message: Buffer) => void,
    private readonly maxBytes: number,
    private readonly reuse = false,
  ) {}

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const take = Math.min(5 - this.headerFilled, chunk.length - offset);
        chunk.copy(this.header, this.headerFilled, offset, offset + take);
        this.headerFilled += take;
        offset += take;
        if (this.headerFilled < 5) return;
        this.headerFilled = 0;
        if (this.header[0] !== 0) throw new GrpcError(GRPC_UNKNOWN, "Compressed gRPC messages aren't supported.");
        const length = this.header.readUInt32BE(1);
        if (length > this.maxBytes) {
          throw new GrpcError(GRPC_RESOURCE_EXHAUSTED, "gRPC message is too large.");
        }
        this.body =
          this.reuse && this.spare?.length === length ? this.spare : Buffer.allocUnsafe(length);
        this.bodyFilled = 0;
      }
      const take = Math.min(this.body.length - this.bodyFilled, chunk.length - offset);
      chunk.copy(this.body, this.bodyFilled, offset, offset + take);
      this.bodyFilled += take;
      offset += take;
      if (this.bodyFilled === this.body.length) {
        const message = this.body;
        this.body = null;
        if (this.reuse) this.spare = message;
        this.onMessage(message);
      }
    }
  }
}

export interface GrpcCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GrpcStream {
  /** Resolves when the server ends the stream; rejects with a GrpcError. */
  readonly done: Promise<void>;
  cancel(): void;
}

export interface GrpcClientOptions {
  port: number;
  /** The `-grpc-use-token` bearer token. */
  token: string | null;
  service: string;
  /** Largest message accepted. */
  maxMessageBytes?: number;
}

const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

function header(value: string | string[] | number | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value === undefined ? undefined : String(value);
}

/** One HTTP/2 connection, opened on first use and again after it drops. */
export class GrpcClient {
  private session: http2.ClientHttp2Session | null = null;
  private closed = false;
  private readonly maxBytes: number;

  constructor(private readonly options: GrpcClientOptions) {
    this.maxBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  }

  async unary(method: string, request: Buffer, options: GrpcCallOptions = {}): Promise<Buffer> {
    const response: { message: Buffer | null } = { message: null };
    await this.call(method, request, options, false, (message) => {
      response.message = message;
    }).done;
    if (!response.message) throw new GrpcError(GRPC_UNKNOWN, `${method} returned no message.`);
    return response.message;
  }

  /** Calls `onMessage` with each streamed message; its buffer is reused for
   * the next message, so it must finish with it before returning. */
  serverStream(
    method: string,
    request: Buffer,
    onMessage: (message: Buffer) => void,
    options: GrpcCallOptions = {},
  ): GrpcStream {
    return this.call(method, request, options, true, onMessage);
  }

  close(): void {
    this.closed = true;
    const session = this.session;
    this.session = null;
    session?.destroy();
  }

  private connect(): http2.ClientHttp2Session {
    if (this.closed) throw new GrpcError(GRPC_CANCELLED, "The connection is closed.");
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const session = http2.connect(`http://127.0.0.1:${this.options.port}`);
    const forget = () => {
      if (this.session === session) this.session = null;
    };
    session.on("error", forget);
    session.on("goaway", forget);
    session.on("close", forget);
    this.session = session;
    return session;
  }

  private call(
    method: string,
    request: Buffer,
    options: GrpcCallOptions,
    reuse: boolean,
    onMessage: (message: Buffer) => void,
  ): GrpcStream {
    let cancel: () => void = () => undefined;
    const done = new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stream: http2.ClientHttp2Stream | null = null;
      const finish = (error: GrpcError | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (stream && !stream.closed) stream.close(http2.constants.NGHTTP2_CANCEL);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new GrpcError(GRPC_CANCELLED, `${method} was cancelled.`));
      cancel = onAbort;
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        stream = this.connect().request(
          {
            ":method": "POST",
            ":path": `/${this.options.service}/${method}`,
            "content-type": "application/grpc",
            te: "trailers",
            ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
            ...(options.timeoutMs ? { "grpc-timeout": `${Math.ceil(options.timeoutMs)}m` } : {}),
          },
          { endStream: false },
        );
      } catch (error) {
        finish(
          error instanceof GrpcError
            ? error
            : new GrpcError(GRPC_UNAVAILABLE, error instanceof Error ? error.message : String(error)),
        );
        return;
      }
      if (options.timeoutMs) {
        timer = setTimeout(
          () => finish(new GrpcError(GRPC_DEADLINE_EXCEEDED, `${method} timed out.`)),
          options.timeoutMs,
        );
      }
      let status: number | null = null;
      let statusMessage = "";
      const readStatus = (headers: http2.IncomingHttpHeaders) => {
        const code = header(headers["grpc-status"]);
        if (code === undefined) return;
        status = Number(code);
        const text = header(headers["grpc-message"]) ?? "";
        try {
          statusMessage = decodeURIComponent(text);
        } catch {
          statusMessage = text;
        }
      };
      const framer = new GrpcMessageFramer(onMessage, this.maxBytes, reuse);
      stream.on("response", (headers) => {
        const httpStatus = Number(header(headers[":status"]));
        if (httpStatus !== 200) {
          finish(new GrpcError(GRPC_UNAVAILABLE, `${method} got HTTP ${httpStatus}.`));
          return;
        }
        readStatus(headers);
      });
      stream.on("trailers", readStatus);
      stream.on("data", (chunk: Buffer) => {
        if (settled) return;
        try {
          framer.push(chunk);
        } catch (error) {
          finish(
            error instanceof GrpcError
              ? error
              : new GrpcError(GRPC_UNKNOWN, error instanceof Error ? error.message : String(error)),
          );
        }
      });
      stream.on("error", (error) => finish(new GrpcError(GRPC_UNAVAILABLE, error.message)));
      stream.on("close", () => {
        if (status === GRPC_OK) finish(null);
        else if (status !== null) finish(new GrpcError(status, statusMessage || `${method} failed.`));
        else finish(new GrpcError(GRPC_UNAVAILABLE, `${method} ended without a status.`));
      });
      const frame = Buffer.allocUnsafe(5 + request.length);
      frame[0] = 0;
      frame.writeUInt32BE(request.length, 1);
      request.copy(frame, 5);
      stream.end(frame);
    });
    void done.catch(() => undefined);
    return { done, cancel: () => cancel() };
  }
}
