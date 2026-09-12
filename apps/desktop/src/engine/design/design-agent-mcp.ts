import { randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { McpServerRegistration } from "../agents/types";
import { DesignAgentCapabilityManager } from "./design-agent-capability";

export const DESIGN_AGENT_CAPABILITY_ENV =
  "ZEROS_DESIGN_AGENT_CAPABILITY" as const;
const SERVER_NAME = "design-draft";
const SERVER_VERSION = "1.0.0";
const MAX_MCP_SESSIONS = 8;
const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024;
const MAX_MCP_HEADER_BYTES = 16 * 1024;

class McpBodyTooLargeError extends Error {}
class McpInvalidJsonError extends Error {}

const EMPTY_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const TOOLS = [
  {
    name: "design_document_open",
    description:
      "Refresh the bound Design document and return its current draft revision.",
    inputSchema: EMPTY_INPUT,
  },
  {
    name: "design_source_read",
    description: "Read one source file from the bound Design draft revision.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        expectedRevision: { type: "string" },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "design_foundation_read",
    description: "Read tokens, manifest, and authored keyframes.",
    inputSchema: {
      type: "object",
      properties: { expectedRevision: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "design_projection_read",
    description: "Read a bounded semantic node projection of the Design draft.",
    inputSchema: {
      type: "object",
      properties: {
        expectedRevision: { type: "string" },
        cursor: { type: "string" },
        limit: { type: "integer" },
        maxDepth: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "design_provenance_read",
    description: "Resolve the authored provenance of one node style property.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        property: { type: "string" },
        expectedRevision: { type: "string" },
        computedValue: { type: ["string", "null"] },
        matched: { type: "array", items: { type: "object" } },
      },
      required: ["nodeId", "property"],
      additionalProperties: false,
    },
  },
  {
    name: "design_transaction_apply",
    description:
      "Validate and atomically apply a semantic Design transaction at its exact base revision.",
    inputSchema: {
      type: "object",
      properties: {
        transaction: { type: "object" },
        dryRun: { type: "boolean" },
      },
      required: ["transaction"],
      additionalProperties: false,
    },
  },
  {
    name: "design_history_undo",
    description: "Undo the latest transaction owned by this Design-agent run.",
    inputSchema: EMPTY_INPUT,
  },
  {
    name: "design_history_redo",
    description: "Redo the latest transaction undone by this Design-agent run.",
    inputSchema: EMPTY_INPUT,
  },
] as const;

function objectArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Design tool arguments must be an object.");
  }
  return value as Record<string, unknown>;
}

function exactArguments(
  input: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = [],
): void {
  const permitted = new Set(allowed);
  if (Object.keys(input).some((key) => !permitted.has(key))) {
    throw new Error("Design tool arguments contain an unsupported field.");
  }
  if (required.some((key) => input[key] === undefined)) {
    throw new Error("Design tool arguments are incomplete.");
  }
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Design tool ${key} must be a string.`);
  }
  return value;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = optionalString(input, key);
  if (!value) throw new Error(`Design tool ${key} is required.`);
  return value;
}

function optionalInteger(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Design tool ${key} must be an integer.`);
  }
  return value as number;
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

function sameBearer(actual: string | undefined, token: string): boolean {
  if (!actual?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(actual.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function readBoundedJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  if (
    declaredLength !== undefined &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_MCP_BODY_BYTES)
  ) {
    request.resume();
    return Promise.reject(
      /^\d+$/.test(declaredLength)
        ? new McpBodyTooLargeError()
        : new McpInvalidJsonError(),
    );
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
    };
    const fail = (error: Error, drain = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain) request.resume();
      reject(error);
    };
    const onData = (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      received += chunk.byteLength;
      if (received > MAX_MCP_BODY_BYTES) {
        chunks.length = 0;
        fail(new McpBodyTooLargeError(), true);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks, received).toString("utf8")));
      } catch {
        reject(new McpInvalidJsonError());
      }
    };
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new Error("MCP request was aborted."));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

function endStatus(response: http.ServerResponse, statusCode: number): void {
  if (response.writableEnded) return;
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

/** One loopback MCP endpoint per persistent Design-agent run. The trusted
 * engine hosts it outside ZSR; only semantic operations cross this boundary,
 * and every HTTP request must present the run's scoped capability. */
export class DesignAgentMcpServer {
  private port = 0;
  private httpServer: http.Server | null = null;
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();
  private readonly initializing = new Set<StreamableHTTPServerTransport>();

  constructor(
    private readonly options: {
      manager: DesignAgentCapabilityManager;
      token: string;
    },
  ) {}

  get url(): string {
    if (!this.httpServer || this.port < 1) {
      throw new Error("The Design-agent MCP server is not running.");
    }
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  get registration(): Extract<McpServerRegistration, { transport: "http" }> {
    return {
      name: SERVER_NAME,
      transport: "http",
      url: this.url,
      headersFromEnv: {
        Authorization: DESIGN_AGENT_CAPABILITY_ENV,
      },
    };
  }

  get localPort(): number {
    if (!this.httpServer || this.port < 1) {
      throw new Error("The Design-agent MCP server is not running.");
    }
    return this.port;
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    this.options.manager.assertActive(this.options.token);
    const server = http.createServer(
      {
        headersTimeout: 10_000,
        keepAliveTimeout: 5_000,
        maxHeaderSize: MAX_MCP_HEADER_BYTES,
        requestTimeout: 15_000,
      },
      (request, response) => {
        void this.handle(request, response);
      },
    );
    server.maxConnections = 32;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
    this.port = (server.address() as AddressInfo).port;
    this.httpServer = server;
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = null;
    this.port = 0;
    const transports = new Set([
      ...this.sessions.values(),
      ...this.initializing,
    ]);
    this.initializing.clear();
    this.sessions.clear();
    await Promise.allSettled(
      [...transports].map((transport) => transport.close()),
    );
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private makeServer(): Server {
    const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS as never,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.options.manager.assertActive(this.options.token);
      const input = objectArguments(request.params.arguments ?? {});
      switch (request.params.name) {
        case "design_document_open": {
          exactArguments(input, []);
          return result(
            await this.options.manager.open(this.options.token),
          ) as never;
        }
        case "design_source_read":
          exactArguments(input, ["file", "expectedRevision"], ["file"]);
          return result(
            await this.options.manager.readSource(this.options.token, {
              file: requiredString(input, "file"),
              expectedRevision: optionalString(input, "expectedRevision"),
            }),
          ) as never;
        case "design_foundation_read":
          exactArguments(input, ["expectedRevision"]);
          return result(
            await this.options.manager.readFoundation(this.options.token, {
              expectedRevision: optionalString(input, "expectedRevision"),
            }),
          ) as never;
        case "design_projection_read":
          exactArguments(input, [
            "expectedRevision",
            "cursor",
            "limit",
            "maxDepth",
          ]);
          return result(
            await this.options.manager.readProjection(this.options.token, {
              expectedRevision: optionalString(input, "expectedRevision"),
              cursor: optionalString(input, "cursor"),
              limit: optionalInteger(input, "limit"),
              maxDepth: optionalInteger(input, "maxDepth"),
            }),
          ) as never;
        case "design_provenance_read": {
          exactArguments(
            input,
            [
              "nodeId",
              "property",
              "expectedRevision",
              "computedValue",
              "matched",
            ],
            ["nodeId", "property"],
          );
          const computedValue = input.computedValue;
          if (
            computedValue !== undefined &&
            computedValue !== null &&
            typeof computedValue !== "string"
          ) {
            throw new Error("Design tool computedValue is invalid.");
          }
          if (
            input.matched !== undefined &&
            (!Array.isArray(input.matched) ||
              input.matched.some(
                (entry) =>
                  !entry || typeof entry !== "object" || Array.isArray(entry),
              ))
          ) {
            throw new Error("Design tool matched provenance is invalid.");
          }
          return result(
            await this.options.manager.readProvenance(this.options.token, {
              nodeId: requiredString(input, "nodeId"),
              property: requiredString(input, "property"),
              expectedRevision: optionalString(input, "expectedRevision"),
              ...(computedValue !== undefined ? { computedValue } : {}),
              ...(input.matched !== undefined
                ? { matched: input.matched as never }
                : {}),
            }),
          ) as never;
        }
        case "design_transaction_apply":
          exactArguments(input, ["transaction", "dryRun"], ["transaction"]);
          if (
            !input.transaction ||
            typeof input.transaction !== "object" ||
            Array.isArray(input.transaction)
          ) {
            throw new Error("Design tool transaction must be an object.");
          }
          if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") {
            throw new Error("Design tool dryRun must be a boolean.");
          }
          return result(
            await this.options.manager.apply(
              this.options.token,
              input.transaction,
              { dryRun: input.dryRun === true },
            ),
          ) as never;
        case "design_history_undo":
          exactArguments(input, []);
          return result(
            await this.options.manager.undo(this.options.token),
          ) as never;
        case "design_history_redo":
          exactArguments(input, []);
          return result(
            await this.options.manager.redo(this.options.token),
          ) as never;
        default:
          throw new Error("Unknown Design tool.");
      }
    });
    return server;
  }

  private allowedRequest(request: http.IncomingMessage): boolean {
    const host = (request.headers.host ?? "").toLowerCase();
    if (
      host !== `127.0.0.1:${this.port}` &&
      host !== `localhost:${this.port}`
    ) {
      return false;
    }
    if (request.url !== "/mcp") return false;
    const origin = request.headers.origin?.toLowerCase();
    if (
      origin !== undefined &&
      origin !== `http://127.0.0.1:${this.port}` &&
      origin !== `http://localhost:${this.port}`
    ) {
      return false;
    }
    if (!sameBearer(request.headers.authorization, this.options.token)) {
      return false;
    }
    try {
      this.options.manager.assertActive(this.options.token);
      return true;
    } catch {
      return false;
    }
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    try {
      if (!this.allowedRequest(request)) {
        endStatus(response, request.headers.origin ? 403 : 401);
        return;
      }
      const sessionId = request.headers["mcp-session-id"];
      if (Array.isArray(sessionId)) {
        request.resume();
        endStatus(response, 400);
        return;
      }
      let transport: StreamableHTTPServerTransport | undefined;
      if (sessionId !== undefined) {
        transport = this.sessions.get(sessionId);
        if (!transport) {
          request.resume();
          endStatus(response, 404);
          return;
        }
      } else if (request.method !== "POST") {
        request.resume();
        endStatus(response, 400);
        return;
      } else if (
        this.sessions.size + this.initializing.size >=
        MAX_MCP_SESSIONS
      ) {
        request.resume();
        endStatus(response, 429);
        return;
      }

      const parsedBody =
        request.method === "POST"
          ? await readBoundedJsonBody(request)
          : undefined;
      let created: StreamableHTTPServerTransport | null = null;
      if (!transport) {
        const next = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => {
            let id: string;
            do id = randomUUID();
            while (this.sessions.has(id));
            return id;
          },
          onsessioninitialized: (id: string) => {
            this.initializing.delete(next);
            if (!this.httpServer || this.sessions.has(id)) {
              throw new Error("The Design-agent MCP session is unavailable.");
            }
            this.sessions.set(id, next);
          },
        });
        next.onclose = () => {
          this.initializing.delete(next);
          if (next.sessionId) this.sessions.delete(next.sessionId);
        };
        this.initializing.add(next);
        try {
          await this.makeServer().connect(next);
        } catch (error) {
          this.initializing.delete(next);
          await next.close().catch(() => undefined);
          throw error;
        }
        transport = next;
        created = next;
      }
      try {
        await transport.handleRequest(request, response, parsedBody);
      } finally {
        if (
          created &&
          (!created.sessionId ||
            this.sessions.get(created.sessionId) !== created)
        ) {
          this.initializing.delete(created);
          await created.close().catch(() => undefined);
        }
      }
    } catch (error) {
      if (error instanceof McpBodyTooLargeError) {
        endStatus(response, 413);
        return;
      }
      if (error instanceof McpInvalidJsonError) {
        endStatus(response, 400);
        return;
      }
      if (!response.headersSent) response.statusCode = 500;
      if (!response.writableEnded) response.end();
    }
  }
}
