// ──────────────────────────────────────────────────────────
// Local orchestration — the loopback endpoint the CLI calls
// ──────────────────────────────────────────────────────────
//
// One engine-wide HTTP listener on 127.0.0.1 (ephemeral port). It accepts only
// `POST /local/v1/call` with an exact loopback Host, no browser Origin and an
// execution-scoped bearer minted by admission.ts. The bearer resolves to the
// caller (chat + execution); the body is one LocalCallRequest; the response is
// always a LocalEnvelope. This is separate from the desktop bridge and never
// accepts its token.
// ──────────────────────────────────────────────────────────

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  LOCAL_MAX_REQUEST_BYTES,
  LOCAL_ORCHESTRATION_CALL_PATH,
  LOCAL_ORCHESTRATION_PROTOCOL,
  localFail,
  type LocalEnvelope,
} from "@zeros/protocol/local-orchestration";
import type { LocalCallerScope } from "./types";

/** Bearer → caller. Tokens are stored by hash so lookups leak nothing. */
export class LocalCapabilityRegistry {
  private readonly byHash = new Map<string, LocalCallerScope>();

  private static hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  mint(scope: LocalCallerScope): string {
    const token = randomBytes(32).toString("base64url");
    this.byHash.set(LocalCapabilityRegistry.hash(token), scope);
    return token;
  }

  resolve(token: string | null | undefined): LocalCallerScope | null {
    if (!token) return null;
    return this.byHash.get(LocalCapabilityRegistry.hash(token)) ?? null;
  }

  revoke(token: string): void {
    this.byHash.delete(LocalCapabilityRegistry.hash(token));
  }

  revokeExecution(executionId: string): void {
    for (const [hash, scope] of this.byHash) if (scope.executionId === executionId) this.byHash.delete(hash);
  }

  clear(): void {
    this.byHash.clear();
  }

  get size(): number {
    return this.byHash.size;
  }
}

export type LocalCallHandler = (scope: LocalCallerScope, body: unknown, signal: AbortSignal) => Promise<LocalEnvelope>;

const MAX_ACTIVE_WAITS = 32;
const MAX_ACTIVE_CALLS = 64;
const KEEPALIVE_MS = 4_000;

export class LocalOrchestrationServer {
  private server: http.Server | null = null;
  private port = 0;
  private activeWaits = 0;
  private activeCalls = 0;
  private starting: Promise<void> | null = null;

  constructor(
    private readonly registry: LocalCapabilityRegistry,
    private readonly handler: LocalCallHandler,
    private readonly engineId: () => string,
    private readonly options: { keepaliveMs?: number } = {},
  ) {}

  get url(): string {
    if (!this.server || this.port < 1) throw new Error("The Zeros Local CLI endpoint is not running.");
    return `http://127.0.0.1:${this.port}`;
  }

  get running(): boolean {
    return this.server !== null && this.port > 0;
  }

  /** Concurrent first admissions share one listener. */
  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    this.starting ??= this.listen().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async listen(): Promise<void> {
    const server = http.createServer(
      { headersTimeout: 10_000, keepAliveTimeout: 5_000, maxHeaderSize: 16 * 1024, requestTimeout: 30_000 },
      (request, response) => {
        void this.handle(request, response);
      },
    );
    server.maxConnections = MAX_ACTIVE_CALLS + 8;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  async stop(): Promise<void> {
    // A listener still opening must not outlive this stop.
    await this.starting?.catch(() => {});
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private send(response: http.ServerResponse, status: number, envelope: LocalEnvelope): void {
    if (response.writableEnded) return;
    const body = JSON.stringify(envelope);
    // A long call already committed 200 and kept the connection alive with
    // whitespace, which JSON parsing ignores; the envelope still says it all.
    if (response.headersSent) {
      response.end(body);
      return;
    }
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Length", Buffer.byteLength(body));
    response.end(body);
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const meta = { engine: this.engineId() };
    const host = request.headers.host ?? "";
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      request.resume();
      this.send(response, 421, localFail("NO_CAPABILITY", "Wrong host.", { meta }));
      return;
    }
    // A browser always sends Origin on a cross-site POST; the CLI never does.
    if (request.headers.origin !== undefined) {
      request.resume();
      this.send(response, 403, localFail("NO_CAPABILITY", "Browser requests are not accepted.", { meta }));
      return;
    }
    if (request.method !== "POST" || (request.url ?? "") !== LOCAL_ORCHESTRATION_CALL_PATH) {
      request.resume();
      this.send(response, 404, localFail("USAGE", "Unknown endpoint.", { meta }));
      return;
    }
    const auth = request.headers.authorization ?? "";
    const scope = auth.startsWith("Bearer ") ? this.registry.resolve(auth.slice("Bearer ".length)) : null;
    if (!scope) {
      request.resume();
      this.send(
        response,
        401,
        localFail("NO_CAPABILITY", "This Zeros Local CLI access is not valid any more. It works only inside a running Zeros Local agent chat.", { meta }),
      );
      return;
    }
    let body: unknown;
    try {
      body = await readBody(request);
    } catch (error) {
      this.send(response, 413, localFail("USAGE", error instanceof Error ? error.message : "Invalid request body.", { meta }));
      return;
    }
    // Reading a streamed body yields. Dispose may revoke the execution
    // after the headers were accepted but before the command is admitted.
    if (this.registry.resolve(auth.slice("Bearer ".length)) !== scope) {
      this.send(
        response,
        401,
        localFail("NO_CAPABILITY", "This Zeros Local CLI access is not valid any more. It works only inside a running Zeros Local agent chat.", { meta }),
      );
      return;
    }
    const isWait = typeof body === "object" && body !== null && (body as { command?: unknown }).command === "chat.wait";
    if (isWait ? this.activeWaits >= MAX_ACTIVE_WAITS : this.activeCalls >= MAX_ACTIVE_CALLS) {
      this.send(response, 200, localFail("BUSY", "Zeros is handling many Local CLI calls. Try again shortly.", { retryable: true, meta }));
      return;
    }
    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", onClose);
    if (isWait) this.activeWaits += 1;
    else this.activeCalls += 1;
    // Waits and slow creates can run for minutes without a byte; some HTTP
    // stacks (Bun's server among them) close idle connections after seconds.
    const keepaliveMs = this.options.keepaliveMs ?? KEEPALIVE_MS;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const keepalive = setTimeout(() => {
      if (response.writableEnded || response.headersSent) return;
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      const beat = () => {
        if (!response.writableEnded) response.write(" ");
      };
      beat();
      heartbeat = setInterval(beat, keepaliveMs);
      heartbeat.unref?.();
    }, keepaliveMs);
    keepalive.unref?.();
    try {
      const envelope = await this.handler({ ...scope, surface: "cli" }, body, controller.signal);
      this.send(response, envelope.ok || envelope.error.code !== "USAGE" ? 200 : 400, envelope);
    } catch {
      this.send(response, 500, {
        ok: false,
        protocol: LOCAL_ORCHESTRATION_PROTOCOL,
        error: { code: "INTERNAL", message: "Zeros could not complete the command.", retryable: false },
        meta,
      });
    } finally {
      clearTimeout(keepalive);
      clearInterval(heartbeat);
      response.removeListener("close", onClose);
      if (isWait) this.activeWaits -= 1;
      else this.activeCalls -= 1;
    }
  }
}

function readBody(request: http.IncomingMessage): Promise<unknown> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > LOCAL_MAX_REQUEST_BYTES)) {
    request.resume();
    return Promise.reject(new Error("Request is too large."));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    request.on("data", (raw: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      received += chunk.byteLength;
      if (received > LOCAL_MAX_REQUEST_BYTES) {
        settled = true;
        chunks.length = 0;
        request.resume();
        reject(new Error("Request is too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks, received).toString("utf8")));
      } catch {
        reject(new Error("Request body is not JSON."));
      }
    });
    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
