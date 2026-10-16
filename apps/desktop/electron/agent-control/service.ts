// ──────────────────────────────────────────────────────────
// Agent control service: the engine's way into computer and simulator use
// ──────────────────────────────────────────────────────────
//
// A loopback HTTP endpoint with a per-boot bearer token, like the browser
// service. The engine forwards `zeros_computer` and `zeros_device` calls,
// turn ends and Codex's built-in computer-use activity here; Electron main
// decides everything else. The token reaches only the engine and never an
// agent process.
// ──────────────────────────────────────────────────────────

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  COMPUTER_USE_SERVICE_VERSION,
  type ComputerToolInvokeRequest,
  type ComputerToolResult,
  type ComputerUseNativeActivityRequest,
  type ComputerUseReleaseRequest,
} from "@zeros/protocol/computer-use-tools";
import {
  DEVICE_TOOLS_SERVICE_VERSION,
  type DeviceToolInvokeRequest,
  type DeviceToolResult,
  type DeviceUseReleaseRequest,
} from "@zeros/protocol/device-tools";

/** What the service needs from computer use. */
export interface AgentControlComputerPort {
  invoke(
    request: ComputerToolInvokeRequest,
    signal: AbortSignal,
  ): Promise<ComputerToolResult>;
  release(request: ComputerUseReleaseRequest): boolean;
  nativeActivity(request: ComputerUseNativeActivityRequest): boolean;
}

/** What the service needs from simulator use. */
export interface AgentControlDevicePort {
  invoke(request: DeviceToolInvokeRequest, signal: AbortSignal): Promise<DeviceToolResult>;
  release(request: DeviceUseReleaseRequest): boolean;
}

type ToolResult = ComputerToolResult | DeviceToolResult;

interface ToolRoute {
  run(body: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
  version: number;
  failed: string;
  tooLarge: string;
}

const SIMULATORS_UNAVAILABLE = "Simulators are unavailable. Restart Zeros and try again.";

export interface AgentControlServiceHandle {
  readonly baseUrl: string;
  readonly token: string;
  stop(): Promise<void>;
}

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
// A call can wait for another chat and then for the user's approval. Some
// HTTP clients give up on a response that stays silent for minutes, so the
// body starts at once and carries a space now and then until the result.
const KEEPALIVE_MS = 20_000;

class ServiceRequestError extends Error {}

export async function startAgentControlService(options: {
  computer: AgentControlComputerPort;
  /** Absent where Zeros has no simulators. */
  device?: AgentControlDevicePort;
  keepaliveMs?: number;
}): Promise<AgentControlServiceHandle> {
  const token = randomBytes(32).toString("base64url");
  const keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
  const open = new Set<AbortController>();
  const failedResult = (version: number, text: string): ToolResult =>
    ({ version, success: false, content: [{ type: "text", text }] }) as ToolResult;

  const computerRoute: ToolRoute = {
    run: (body, signal) =>
      options.computer.invoke(body as unknown as ComputerToolInvokeRequest, signal),
    version: COMPUTER_USE_SERVICE_VERSION,
    failed: "The computer action failed.",
    tooLarge: "The computer action's result was too large.",
  };
  const deviceRoute: ToolRoute = {
    run: async (body, signal) =>
      options.device
        ? options.device.invoke(body as unknown as DeviceToolInvokeRequest, signal)
        : failedResult(DEVICE_TOOLS_SERVICE_VERSION, SIMULATORS_UNAVAILABLE),
    version: DEVICE_TOOLS_SERVICE_VERSION,
    failed: "The simulator action failed.",
    tooLarge: "The simulator action's result was too large.",
  };

  const invoke = async (
    request: IncomingMessage,
    response: ServerResponse,
    route: ToolRoute,
  ): Promise<void> => {
    const body = asRecord(await readJsonBody(request));
    const abort = new AbortController();
    open.add(abort);
    // The engine aborts its fetch when the agent's call is cancelled; that
    // closes the connection before the answer is written.
    response.once("close", () => {
      if (!response.writableFinished) abort.abort();
      open.delete(abort);
    });
    response.statusCode = 200;
    response.flushHeaders();
    const keepalive = setInterval(() => {
      if (!response.writableEnded) response.write(" ");
    }, keepaliveMs);
    keepalive.unref?.();
    let result: ToolResult;
    try {
      result = await route.run(body, abort.signal);
    } catch {
      result = failedResult(route.version, route.failed);
    } finally {
      clearInterval(keepalive);
    }
    if (response.writableEnded || response.destroyed) return;
    const serialized = JSON.stringify(result);
    response.end(
      Buffer.byteLength(serialized, "utf8") > MAX_RESPONSE_BYTES
        ? JSON.stringify(failedResult(route.version, route.tooLarge))
        : serialized,
    );
  };

  const server: Server = createServer(async (request, response) => {
    setJsonHeaders(response);
    if (!tokenMatches(request, token)) {
      request.resume();
      sendJson(response, 401, { error: "Zeros agent control request rejected." });
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "POST") {
        request.resume();
        sendJson(response, 404, { error: "Zeros agent control route not found." });
        return;
      }
      switch (url.pathname) {
        case "/v1/computer/invoke":
          await invoke(request, response, computerRoute);
          return;
        case "/v1/device/invoke":
          await invoke(request, response, deviceRoute);
          return;
        case "/v1/device/release": {
          const body = asRecord(await readJsonBody(request));
          sendJson(response, 200, {
            version: DEVICE_TOOLS_SERVICE_VERSION,
            released:
              options.device?.release(body as unknown as DeviceUseReleaseRequest) ?? false,
          });
          return;
        }
        case "/v1/computer/release": {
          const body = asRecord(await readJsonBody(request));
          sendJson(response, 200, {
            version: COMPUTER_USE_SERVICE_VERSION,
            released: options.computer.release(
              body as unknown as ComputerUseReleaseRequest,
            ),
          });
          return;
        }
        case "/v1/computer/native-activity": {
          const body = asRecord(await readJsonBody(request));
          sendJson(response, 200, {
            version: COMPUTER_USE_SERVICE_VERSION,
            accepted: options.computer.nativeActivity(
              body as unknown as ComputerUseNativeActivityRequest,
            ),
          });
          return;
        }
        default:
          request.resume();
          sendJson(response, 404, { error: "Zeros agent control route not found." });
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 400, {
        error:
          error instanceof ServiceRequestError
            ? error.message
            : "Invalid Zeros agent control request.",
      });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxConnections = 64;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Zeros agent control service did not bind a loopback port.");
  }

  let stopping: Promise<void> | null = null;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    stop() {
      stopping ??= new Promise<void>((resolve) => {
        for (const abort of open) abort.abort();
        open.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return stopping;
    },
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new ServiceRequestError("Zeros agent control request is too large.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceRequestError("Zeros agent control request is not JSON.");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceRequestError("Zeros agent control request must be an object.");
  }
  return value as Record<string, unknown>;
}

function tokenMatches(request: IncomingMessage, expected: string): boolean {
  const supplied = request.headers.authorization;
  if (typeof supplied !== "string" || !supplied.startsWith("Bearer ")) {
    return false;
  }
  const actual = Buffer.from(supplied.slice(7));
  const expectedBytes = Buffer.from(expected);
  return (
    actual.length === expectedBytes.length &&
    timingSafeEqual(actual, expectedBytes)
  );
}

function setJsonHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.statusCode = status;
  response.end(JSON.stringify(value));
}
