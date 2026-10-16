import http2 from "node:http2";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  GRPC_CANCELLED,
  GRPC_DEADLINE_EXCEEDED,
  GRPC_RESOURCE_EXHAUSTED,
  GRPC_UNAUTHENTICATED,
  GRPC_UNAVAILABLE,
  GRPC_UNKNOWN,
  GrpcClient,
  GrpcError,
  GrpcMessageFramer,
  ProtoWriter,
  protoField,
  readProtoFields,
} from "../devices/android-grpc";

function grpcFrame(message: Buffer, compressed = false): Buffer {
  const frame = Buffer.alloc(5 + message.length);
  frame[0] = compressed ? 1 : 0;
  frame.writeUInt32BE(message.length, 1);
  message.copy(frame, 5);
  return frame;
}

describe("protobuf", () => {
  it("writes fields as protobuf does", () => {
    expect(new ProtoWriter().varint(1, 150).finish()).toEqual(Buffer.from([0x08, 0x96, 0x01]));
    expect(new ProtoWriter().string(2, "testing").finish()).toEqual(
      Buffer.from("120774657374696e67", "hex"),
    );
    expect(new ProtoWriter().varint(3, true).finish()).toEqual(Buffer.from([0x18, 0x01]));
    expect(new ProtoWriter().varint(1, -1).finish()).toEqual(
      Buffer.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]),
    );
    expect(new ProtoWriter().message(3, new ProtoWriter().varint(1, 150)).finish()).toEqual(
      Buffer.from([0x1a, 0x03, 0x08, 0x96, 0x01]),
    );
    expect(new ProtoWriter().floats(4, [1, -2]).finish()).toEqual(
      Buffer.from([0x22, 0x08, 0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0xc0]),
    );
    expect(new ProtoWriter().varint(16, 1).finish()).toEqual(Buffer.from([0x80, 0x01, 0x01]));
  });

  it("reads back what it writes, in wire order", () => {
    const nested = new ProtoWriter().varint(1, 7).string(2, "home");
    const bytes = new ProtoWriter()
      .varint(1, 300)
      .message(2, nested)
      .bytes(3, Buffer.from([1, 2, 3]))
      .varint(1, 2 ** 40)
      .finish();
    const fields = readProtoFields(bytes);
    expect(fields.map((entry) => entry.field)).toEqual([1, 2, 3, 1]);
    expect(fields[0]!.number).toBe(300);
    expect(protoField(fields, 1)!.number).toBe(2 ** 40);
    const inner = readProtoFields(protoField(fields, 2)!.bytes!);
    expect(protoField(inner, 1)!.number).toBe(7);
    expect(protoField(inner, 2)!.bytes!.toString()).toBe("home");
    expect([...protoField(fields, 3)!.bytes!]).toEqual([1, 2, 3]);
    expect(protoField(fields, 9)).toBeNull();
  });

  it("reads fixed-width fields and rejects broken messages", () => {
    const fixed = Buffer.from([0x0d, 1, 0, 0, 0, 0x11, 2, 0, 0, 0, 0, 0, 0, 0]);
    const fields = readProtoFields(fixed);
    expect(fields[0]!.fixed!.readUInt32LE(0)).toBe(1);
    expect(fields[1]!.fixed!.readBigUInt64LE(0)).toBe(2n);
    expect(() => readProtoFields(Buffer.from([0x08]))).toThrow(/Truncated/);
    expect(() => readProtoFields(Buffer.from([0x12, 0x05, 0x01]))).toThrow(/Truncated/);
    expect(() => readProtoFields(Buffer.from([0x0b]))).toThrow(/wire type 3/);
    expect(() => readProtoFields(Buffer.alloc(11, 0xff))).toThrow(/Malformed/);
  });
});

describe("GrpcMessageFramer", () => {
  it("splits messages however the body arrives", () => {
    const messages: string[] = [];
    const framer = new GrpcMessageFramer((message) => messages.push(message.toString()), 1024);
    const body = Buffer.concat([
      grpcFrame(Buffer.from("first")),
      grpcFrame(Buffer.alloc(0)),
      grpcFrame(Buffer.from("second")),
    ]);
    for (const byte of body) framer.push(Buffer.from([byte]));
    framer.push(Buffer.concat([grpcFrame(Buffer.from("a")), grpcFrame(Buffer.from("b"))]));
    expect(messages).toEqual(["first", "", "second", "a", "b"]);
  });

  it("reuses a message's buffer only when asked", () => {
    const seen: Buffer[] = [];
    const reusing = new GrpcMessageFramer((message) => seen.push(message), 1024, true);
    reusing.push(Buffer.concat([grpcFrame(Buffer.from("one")), grpcFrame(Buffer.from("two"))]));
    expect(seen[0]).toBe(seen[1]);
    expect(seen[1]!.toString()).toBe("two");
    const copies: Buffer[] = [];
    const copying = new GrpcMessageFramer((message) => copies.push(message), 1024);
    copying.push(Buffer.concat([grpcFrame(Buffer.from("one")), grpcFrame(Buffer.from("two"))]));
    expect(copies.map(String)).toEqual(["one", "two"]);
  });

  it("refuses compressed and oversized messages", () => {
    const framer = new GrpcMessageFramer(() => undefined, 4);
    expect(() => framer.push(grpcFrame(Buffer.from("x"), true))).toThrow(GrpcError);
    const large = new GrpcMessageFramer(() => undefined, 4);
    try {
      large.push(grpcFrame(Buffer.from("too large")));
      expect.unreachable();
    } catch (error) {
      expect((error as GrpcError).code).toBe(GRPC_RESOURCE_EXHAUSTED);
    }
  });
});

type Handler = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, request: Buffer) => void;

let server: http2.Http2Server | null = null;
let client: GrpcClient | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  const running = server;
  server = null;
  if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
});

async function serve(handler: Handler): Promise<{ port: number; sessions: http2.ServerHttp2Session[] }> {
  const sessions: http2.ServerHttp2Session[] = [];
  server = http2.createServer();
  server.on("session", (session) => sessions.push(session));
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const body = Buffer.concat(chunks);
      handler(stream, headers, body.length >= 5 ? body.subarray(5, 5 + body.readUInt32BE(1)) : body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return { port: (server.address() as AddressInfo).port, sessions };
}

function reply(stream: http2.ServerHttp2Stream, messages: Buffer[], status = "0", text?: string): void {
  stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
  stream.on("wantTrailers", () => {
    stream.sendTrailers({ "grpc-status": status, ...(text ? { "grpc-message": text } : {}) });
  });
  for (const message of messages) stream.write(grpcFrame(message));
  stream.end();
}

async function failure(promise: Promise<unknown>): Promise<GrpcError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GrpcError);
    return error as GrpcError;
  }
  throw new Error("Expected the call to fail.");
}

describe("GrpcClient", () => {
  it("makes a unary call with the token, and reads its reply", async () => {
    const seen: { path?: string; auth?: string; type?: string; request?: string; timeout?: string } = {};
    const { port } = await serve((stream, headers, request) => {
      seen.path = headers[":path"] as string;
      seen.auth = headers.authorization as string;
      seen.type = headers["content-type"] as string;
      seen.timeout = headers["grpc-timeout"] as string;
      seen.request = request.toString();
      reply(stream, [Buffer.from("pong")]);
    });
    client = new GrpcClient({ port, token: "secret-token", service: "android.emulation.control.EmulatorController" });
    const response = await client.unary("getStatus", Buffer.from("ping"), { timeoutMs: 2_000 });
    expect(response.toString()).toBe("pong");
    expect(seen).toEqual({
      path: "/android.emulation.control.EmulatorController/getStatus",
      auth: "Bearer secret-token",
      type: "application/grpc",
      timeout: "2000m",
      request: "ping",
    });
  });

  it("leaves the token out when there isn't one, and takes empty replies", async () => {
    let auth: unknown = "unset";
    const { port } = await serve((stream, headers) => {
      auth = headers.authorization;
      reply(stream, [Buffer.alloc(0)]);
    });
    client = new GrpcClient({ port, token: null, service: "Svc" });
    await expect(client.unary("sendKey", Buffer.alloc(0))).resolves.toEqual(Buffer.alloc(0));
    expect(auth).toBeUndefined();
  });

  it("rejects with the server's status and message", async () => {
    const { port } = await serve((stream) => reply(stream, [], "16", "bad%20token"));
    client = new GrpcClient({ port, token: "wrong-token", service: "Svc" });
    const error = await failure(client.unary("getStatus", Buffer.alloc(0)));
    expect(error.code).toBe(GRPC_UNAUTHENTICATED);
    expect(error.message).toBe("bad token");
  });

  it("reads a status sent with the headers alone", async () => {
    const { port } = await serve((stream) => {
      stream.respond(
        { ":status": 200, "content-type": "application/grpc", "grpc-status": "14", "grpc-message": "%E0%A4%A" },
        { endStream: true },
      );
    });
    client = new GrpcClient({ port, token: null, service: "Svc" });
    const error = await failure(client.unary("getStatus", Buffer.alloc(0)));
    expect(error.code).toBe(GRPC_UNAVAILABLE);
    expect(error.message).toBe("%E0%A4%A");
  });

  it("fails a call that ends without a status or a reply", async () => {
    const { port } = await serve((stream) => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" });
      stream.end();
    });
    client = new GrpcClient({ port, token: null, service: "Svc" });
    expect((await failure(client.unary("getStatus", Buffer.alloc(0)))).code).toBe(GRPC_UNAVAILABLE);
  });

  it("fails on an HTTP error", async () => {
    const { port } = await serve((stream) => {
      stream.respond({ ":status": 404 });
      stream.end();
    });
    client = new GrpcClient({ port, token: null, service: "Svc" });
    const error = await failure(client.unary("missing", Buffer.alloc(0)));
    expect(error.code).toBe(GRPC_UNAVAILABLE);
    expect(error.message).toMatch(/HTTP 404/);
  });

  it("fails an OK reply without a message", async () => {
    const { port } = await serve((stream) => reply(stream, []));
    client = new GrpcClient({ port, token: null, service: "Svc" });
    expect((await failure(client.unary("getStatus", Buffer.alloc(0)))).code).toBe(GRPC_UNKNOWN);
  });

  it("streams messages until the server ends", async () => {
    const { port } = await serve((stream) =>
      reply(stream, [Buffer.from("one"), Buffer.from("two"), Buffer.from("six")]),
    );
    client = new GrpcClient({ port, token: null, service: "Svc" });
    const messages: string[] = [];
    const stream = client.serverStream("streamScreenshot", Buffer.alloc(0), (message) => {
      messages.push(message.toString());
    });
    await stream.done;
    expect(messages).toEqual(["one", "two", "six"]);
  });

  it("cancels a stream, and the server sees it go", async () => {
    let serverClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      serverClosed = resolve;
    });
    const { port } = await serve((stream) => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" });
      stream.write(grpcFrame(Buffer.from("frame")));
      stream.on("close", () => serverClosed());
    });
    client = new GrpcClient({ port, token: null, service: "Svc" });
    let gotFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      gotFirst = resolve;
    });
    const stream = client.serverStream("streamScreenshot", Buffer.alloc(0), () => gotFirst());
    await first;
    stream.cancel();
    expect((await failure(stream.done)).code).toBe(GRPC_CANCELLED);
    await closed;
  });

  it("times out, and stops on an abort signal", async () => {
    const { port } = await serve(() => undefined);
    client = new GrpcClient({ port, token: null, service: "Svc" });
    const timedOut = await failure(client.unary("getStatus", Buffer.alloc(0), { timeoutMs: 50 }));
    expect(timedOut.code).toBe(GRPC_DEADLINE_EXCEEDED);
    const controller = new AbortController();
    const call = client.unary("getStatus", Buffer.alloc(0), { signal: controller.signal });
    controller.abort();
    expect((await failure(call)).code).toBe(GRPC_CANCELLED);
    const aborted = new AbortController();
    aborted.abort();
    expect(
      (await failure(client.unary("getStatus", Buffer.alloc(0), { signal: aborted.signal }))).code,
    ).toBe(GRPC_CANCELLED);
  });

  it("reconnects after the connection drops, and refuses calls once closed", async () => {
    const { port, sessions } = await serve((stream) => reply(stream, [Buffer.from("ok")]));
    client = new GrpcClient({ port, token: null, service: "Svc" });
    await client.unary("getStatus", Buffer.alloc(0));
    const dropped = new Promise<void>((resolve) => sessions[0]!.on("close", () => resolve()));
    sessions[0]!.destroy();
    await dropped;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(client.unary("getStatus", Buffer.alloc(0))).resolves.toEqual(Buffer.from("ok"));
    expect(sessions).toHaveLength(2);
    client.close();
    expect((await failure(client.unary("getStatus", Buffer.alloc(0)))).code).toBe(GRPC_CANCELLED);
  });

  it("fails when nothing is listening", async () => {
    const { port } = await serve(() => undefined);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    client = new GrpcClient({ port, token: null, service: "Svc" });
    expect((await failure(client.unary("getStatus", Buffer.alloc(0), { timeoutMs: 2_000 }))).code).toBe(
      GRPC_UNAVAILABLE,
    );
  });
});
