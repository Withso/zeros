import { randomUUID } from "node:crypto";
import { mkdir, chmod, unlink } from "node:fs/promises";
import { endianness } from "node:os";
import { join } from "node:path";
import {
  createServer,
  type Server,
  type Socket,
} from "node:net";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const HEADER_BYTES = 4;

export interface CodexBrowserUseRequest {
  method: string;
  params: Record<string, unknown>;
  sessionId: string;
  turnId: string;
  socket: Socket;
}

export interface CodexBrowserUsePipeOptions {
  directory?: string;
  onRequest(request: CodexBrowserUseRequest): Promise<unknown>;
}

export interface CodexBrowserUsePipeHandle {
  path: string;
  notify(method: string, params: Record<string, unknown>): void;
  stop(): Promise<void>;
}

export interface CodexBrowserUseRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** Codex's bundled Browser skill discovers IAB backends by scanning this
 * directory and speaking length-prefixed JSON-RPC over a privileged Node REPL
 * native-pipe bridge. Keep this transport dependency-free and fail closed on
 * absent session metadata; the main browser host owns all page/security logic. */
export async function startCodexBrowserUsePipe(
  options: CodexBrowserUsePipeOptions,
): Promise<CodexBrowserUsePipeHandle> {
  const directory =
    options.directory ??
    (process.platform === "win32"
      ? "\\\\.\\pipe\\codex-browser-use"
      : "/tmp/codex-browser-use");
  if (process.platform !== "win32") {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const path =
    process.platform === "win32"
      ? `${directory}-${randomUUID()}`
      : join(directory, `${randomUUID()}.sock`);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffered = Buffer.alloc(0);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      try {
        for (;;) {
          if (buffered.byteLength < HEADER_BYTES) return;
          const length = readFrameLength(buffered);
          if (length > MAX_FRAME_BYTES) {
            socket.destroy(new Error("Browser Use frame exceeds limit."));
            return;
          }
          if (buffered.byteLength < HEADER_BYTES + length) return;
          const body = buffered
            .subarray(HEADER_BYTES, HEADER_BYTES + length)
            .toString("utf8");
          buffered = buffered.subarray(HEADER_BYTES + length);
          void handleMessage(socket, body, options.onRequest);
        }
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
  await listen(server, path);
  if (process.platform !== "win32") await chmod(path, 0o600);

  return {
    path,
    notify(method, params) {
      const message = encodeCodexBrowserUseFrame({
        jsonrpc: "2.0",
        method,
        params,
      });
      for (const socket of sockets) {
        if (!socket.destroyed) socket.write(message);
      }
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await close(server);
      if (process.platform !== "win32") {
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
  };
}

async function handleMessage(
  socket: Socket,
  raw: string,
  onRequest: CodexBrowserUsePipeOptions["onRequest"],
): Promise<void> {
  let message: CodexBrowserUseRpcRequest;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid Browser Use JSON-RPC request.");
    }
    message = parsed as CodexBrowserUseRpcRequest;
  } catch {
    socket.write(
      encodeCodexBrowserUseFrame({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Invalid Browser Use JSON-RPC." },
      }),
    );
    return;
  }
  const reply = await dispatchCodexBrowserUseRequest(
    message,
    socket,
    onRequest,
  );
  if (reply) socket.write(encodeCodexBrowserUseFrame(reply));
}

export async function dispatchCodexBrowserUseRequest(
  message: CodexBrowserUseRpcRequest,
  socket: Socket,
  onRequest: CodexBrowserUsePipeOptions["onRequest"],
): Promise<Record<string, unknown> | null> {
  const id = message.id;
  const method = typeof message.method === "string" ? message.method : "";
  const params = asRecord(message.params);
  if (!method || id === undefined) return null;
  const sessionId = stringField(params, "session_id");
  const turnId = stringField(params, "turn_id");
  if (!sessionId || !turnId) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32602,
        message: "Missing required browser session metadata.",
      },
    };
  }
  try {
    const result = await onRequest({
      method,
      params,
      sessionId,
      turnId,
      socket,
    });
    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function encodeCodexBrowserUseFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new Error("Browser Use response exceeds frame limit.");
  }
  const header = Buffer.alloc(HEADER_BYTES);
  if (endianness() === "LE") header.writeUInt32LE(body.byteLength, 0);
  else header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

function readFrameLength(buffer: Buffer): number {
  return endianness() === "LE"
    ? buffer.readUInt32LE(0)
    : buffer.readUInt32BE(0);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
