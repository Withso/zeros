// ──────────────────────────────────────────────────────────
// zeros-design MCP — first-party, workspace-scoped design context
// ──────────────────────────────────────────────────────────
//
// This standalone Streamable-HTTP implementation is retained for the future
// native design harness. It is deliberately not started by ZerosEngine or
// injected into the existing coding-agent gateway. A per-process secret plus
// opaque workspace id scopes the endpoint; every tool call re-resolves that
// workspace before touching disk.

import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  DESIGN_GUIDES,
  lintDesignDocument,
  listDesignFrames,
  readDesignFrame,
  readDesignFrameRenderIdentity,
  readDesignTokens,
  setDesignNodeText,
  type DesignGuideTopic,
  type DesignMutationResult,
  updateDesignNodeStyles,
  writeDesignNodeHtml,
} from "./document";
import { getDesignScreenshot } from "./screenshots";
import { forgetDesignSelection, getDesignSelection } from "./selection";
import type { Workspace } from "../git/types";

const SERVER_NAME = "zeros-design";
const SERVER_VERSION = "0.2.0";

// MCP clients must treat absent annotations pessimistically. In particular,
// Codex assumes an unannotated tool may mutate state and can require an
// approval even for a read. Keep the two contracts explicit so the seven
// inspection tools remain usable in non-interactive/full-access turns while
// the three source mutations retain their write gate.
const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} satisfies NonNullable<Tool["annotations"]>;

const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} satisfies NonNullable<Tool["annotations"]>;

export const DESIGN_MCP_INSTRUCTIONS = `Use these tools to understand the live design workspace before and after editing files.
Design files live only under "Zeros Design/". Author pure HTML and CSS: no JavaScript, inline event handlers, external URLs, or files outside that directory.
One top-level .html file is one frame. Give every rendered element inside body a stable unique data-oid, but never put data-oid on html, head, body, meta, link, title, or style. Use tokens from tokens.css where they apply and keep spacing on the 4px scale unless the user requests otherwise.
Workflow: inspect selection and frames, use the structured write tools with the exact sourceVersion, call lint_design, re-read the affected frame, use screenshot_frame to visually verify the result, then call lint_design again so browser-computed checks are included. Resolve every error and review non-blocking advisory findings before finishing. Structured writes and the visual inspector share the same validated minimal-diff mutation layer.`;

const TOOLS: Tool[] = [
  {
    name: "get_selection",
    annotations: READ_TOOL_ANNOTATIONS,
    description:
      "Return the frame currently selected on the Zeros design canvas.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_frames",
    annotations: READ_TOOL_ANNOTATIONS,
    description:
      "List all top-level HTML frames with titles, dimensions, node counts, and modification times.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_frame",
    annotations: READ_TOOL_ANNOTATIONS,
    description:
      "Return metadata and a depth-limited HTML tree summary for one frame.",
    inputSchema: {
      type: "object",
      properties: {
        frame: { type: "string", description: "Top-level .html filename." },
        depth: {
          type: "number",
          minimum: 0,
          maximum: 8,
          description: "Tree depth; defaults to 4.",
        },
      },
      required: ["frame"],
      additionalProperties: false,
    },
  },
  {
    name: "screenshot_frame",
    annotations: READ_TOOL_ANNOTATIONS,
    description:
      "Return the latest real rendered screenshot of a frame or stable data-oid node.",
    inputSchema: {
      type: "object",
      properties: {
        frame: { type: "string", description: "Top-level .html filename." },
        nodeId: {
          type: "string",
          description:
            "Optional stable data-oid to capture instead of the frame.",
        },
        scale: {
          type: "number",
          minimum: 0.1,
          maximum: 2,
          description:
            "Preferred capture scale. The latest safe cached capture is returned with its actual scale.",
        },
      },
      required: ["frame"],
      additionalProperties: false,
    },
  },
  {
    name: "lint_design",
    annotations: READ_TOOL_ANNOTATIONS,
    description:
      "Validate HTML/CSS constraints and return stable rule ids, locations, and fix guidance.",
    inputSchema: {
      type: "object",
      properties: {
        frame: {
          type: "string",
          description:
            "Optional top-level .html filename; omit for all frames.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_tokens",
    annotations: READ_TOOL_ANNOTATIONS,
    description:
      "Return typed tokens from tokens.css with current values and usage counts.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_guide",
    annotations: READ_TOOL_ANNOTATIONS,
    description:
      "Return focused design-workspace guidance without loading the whole rulebook.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: ["frame", "layout", "tokens", "workflow", "components"],
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    name: "write_html",
    annotations: WRITE_TOOL_ANNOTATIONS,
    description:
      "Append or replace the inner HTML of one stable data-oid using a validated minimal source splice.",
    inputSchema: {
      type: "object",
      properties: {
        frame: { type: "string", description: "Top-level .html filename." },
        nodeId: { type: "string", description: "Stable target data-oid." },
        sourceVersion: {
          type: "string",
          description: "Exact sourceVersion returned by get_frame.",
        },
        html: { type: "string", description: "Safe HTML/CSS-only markup." },
        mode: {
          type: "string",
          enum: ["append", "replace-inner"],
          description: "Defaults to replace-inner.",
        },
      },
      required: ["frame", "nodeId", "sourceVersion", "html"],
      additionalProperties: false,
    },
  },
  {
    name: "update_styles",
    annotations: WRITE_TOOL_ANNOTATIONS,
    description:
      "Update or remove inline CSS declarations on one stable data-oid using the same writer as the visual inspector. Use null to remove a property.",
    inputSchema: {
      type: "object",
      properties: {
        frame: { type: "string", description: "Top-level .html filename." },
        nodeId: { type: "string", description: "Stable target data-oid." },
        sourceVersion: {
          type: "string",
          description: "Exact sourceVersion returned by get_frame.",
        },
        styles: {
          type: "object",
          minProperties: 1,
          maxProperties: 64,
          additionalProperties: {
            anyOf: [{ type: "string" }, { type: "null" }],
          },
        },
      },
      required: ["frame", "nodeId", "sourceVersion", "styles"],
      additionalProperties: false,
    },
  },
  {
    name: "set_text",
    annotations: WRITE_TOOL_ANNOTATIONS,
    description:
      "Replace the direct text of a leaf element without rewriting its surrounding HTML.",
    inputSchema: {
      type: "object",
      properties: {
        frame: { type: "string", description: "Top-level .html filename." },
        nodeId: { type: "string", description: "Stable target data-oid." },
        sourceVersion: {
          type: "string",
          description: "Exact sourceVersion returned by get_frame.",
        },
        text: { type: "string" },
      },
      required: ["frame", "nodeId", "sourceVersion", "text"],
      additionalProperties: false,
    },
  },
];

interface SessionEntry {
  server: Server;
  transport: StreamableHTTPServerTransport;
  workspaceId: string;
  closed: boolean;
}

export interface DesignMcpConnection {
  url: string;
  bearerToken: string;
}

export interface DesignMcpServerOptions {
  port?: number;
  resolveWorkspace: (workspaceId: string) => Workspace | null;
}

function textResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

function stringArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`"${key}" must be a non-empty string.`);
  }
  return value.trim();
}

function mutationResult(result: DesignMutationResult): CallToolResult {
  const { source: _source, srcDoc: _srcDoc, ...frame } = result.frame;
  return textResult({
    changed: result.changed,
    sourcePath: `Zeros Design/${result.frame.file}`,
    frame,
    lint: result.lint,
  });
}

function styleArguments(
  args: Record<string, unknown>,
): Record<string, string | null> {
  const value = args.styles;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('"styles" must be an object of CSS values.');
  }
  const styles: Record<string, string | null> = {};
  for (const [property, propertyValue] of Object.entries(value)) {
    if (typeof propertyValue !== "string" && propertyValue !== null) {
      throw new Error(`CSS value for "${property}" must be a string or null.`);
    }
    styles[property] = propertyValue;
  }
  return styles;
}

export class DesignMcpServer {
  private port: number;
  private readonly secret = randomBytes(32).toString("hex");
  private readonly resolveWorkspace: DesignMcpServerOptions["resolveWorkspace"];
  private httpServer: http.Server | null = null;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly provisionalConnections = new Set<SessionEntry>();

  constructor(options: DesignMcpServerOptions) {
    this.port = options.port ?? 0;
    this.resolveWorkspace = options.resolveWorkspace;
  }

  get running(): boolean {
    return this.httpServer !== null;
  }

  /** Number of initialized plus not-yet-initialized transports. Exposed so
   * lifecycle tests can prove malformed/stale requests do not leak servers. */
  get openConnectionCount(): number {
    return this.sessions.size + this.provisionalConnections.size;
  }

  urlForWorkspace(workspaceId: string): string | null {
    return this.connectionForWorkspace(workspaceId)?.url ?? null;
  }

  connectionForWorkspace(workspaceId: string): DesignMcpConnection | null {
    const workspace = this.resolveDesignWorkspace(workspaceId);
    if (!this.running || !workspace) return null;
    const url = new URL(`http://127.0.0.1:${this.port}/mcp`);
    url.searchParams.set("workspaceId", workspace.id);
    return {
      url: url.toString(),
      bearerToken: this.tokenForWorkspace(workspace.id),
    };
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    const server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown) => reject(error);
      server.once("error", onError);
      server.listen(this.port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
    this.port = (server.address() as AddressInfo).port;
    this.httpServer = server;
  }

  async stop(): Promise<void> {
    const entries = new Set([
      ...this.sessions.values(),
      ...this.provisionalConnections.values(),
    ]);
    for (const entry of entries) {
      await this.closeEntry(entry);
    }
    this.sessions.clear();
    this.provisionalConnections.clear();
    if (this.httpServer) {
      await new Promise<void>((resolve) =>
        this.httpServer?.close(() => resolve()),
      );
      this.httpServer = null;
    }
  }

  private resolveDesignWorkspace(workspaceId: string): Workspace | null {
    const workspace = this.resolveWorkspace(workspaceId);
    return workspace?.kind === "design" && workspace.archivedAt == null
      ? workspace
      : null;
  }

  private tokenForWorkspace(workspaceId: string): string {
    return createHmac("sha256", this.secret)
      .update("zeros-design-mcp\0", "utf8")
      .update(workspaceId, "utf8")
      .digest("hex");
  }

  private secretMatches(workspaceId: string, candidate: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(candidate)) return false;
    const expected = Buffer.from(this.tokenForWorkspace(workspaceId), "hex");
    const actual = Buffer.from(candidate, "hex");
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  private async closeEntry(entry: SessionEntry): Promise<void> {
    if (entry.closed) return;
    entry.closed = true;
    this.provisionalConnections.delete(entry);
    if (entry.transport.sessionId) {
      this.sessions.delete(entry.transport.sessionId);
    }
    try {
      await entry.server.close();
    } catch {
      try {
        await entry.transport.close();
      } catch {
        /* best-effort */
      }
    }
  }

  private isAllowedRequest(request: http.IncomingMessage): boolean {
    const host = (request.headers.host ?? "").toLowerCase();
    if (
      host !== `127.0.0.1:${this.port}` &&
      host !== `localhost:${this.port}`
    ) {
      return false;
    }
    const origin = request.headers.origin?.toLowerCase();
    return (
      origin === undefined ||
      origin === `http://127.0.0.1:${this.port}` ||
      origin === `http://localhost:${this.port}`
    );
  }

  private requestScope(
    request: http.IncomingMessage,
  ): { workspace: Workspace; workspaceId: string } | null {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.port}`);
    if (url.pathname !== "/mcp") return null;
    const workspaceId = url.searchParams.get("workspaceId") ?? "";
    const authorization = request.headers.authorization ?? "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    if (!workspaceId || !this.secretMatches(workspaceId, token)) return null;
    const workspace = this.resolveDesignWorkspace(workspaceId);
    return workspace ? { workspace, workspaceId } : null;
  }

  private makeServer(workspaceId: string): Server {
    const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        capabilities: { tools: {} },
        instructions: DESIGN_MCP_INSTRUCTIONS,
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const workspace = this.resolveDesignWorkspace(workspaceId);
        if (!workspace) {
          throw new Error(
            "The design workspace is no longer available. Stop and ask the user to reopen it.",
          );
        }
        const args = (request.params.arguments ?? {}) as Record<
          string,
          unknown
        >;
        switch (request.params.name) {
          case "get_selection": {
            const selection = getDesignSelection(workspaceId);
            if (selection) {
              let isCurrent = false;
              try {
                const frame = await readDesignFrameRenderIdentity(
                  workspace.path,
                  selection.frame,
                );
                isCurrent = frame.sourceVersion === selection.sourceVersion;
              } catch {
                // A removed or invalid frame makes the prior selection stale.
              }
              if (isCurrent) return textResult(selection);
              forgetDesignSelection(workspaceId);
            }
            return textResult({
              selection: null,
              message: "Nothing is selected on the design canvas.",
            });
          }
          case "list_frames":
            return textResult({
              designDirectory: "Zeros Design",
              frames: await listDesignFrames(workspace.path),
            });
          case "get_frame": {
            const frame = await readDesignFrame(
              workspace.path,
              stringArgument(args, "frame"),
              typeof args.depth === "number" ? args.depth : 4,
            );
            const { source: _source, srcDoc: _srcDoc, ...summary } = frame;
            return textResult({
              sourcePath: `Zeros Design/${frame.file}`,
              ...summary,
            });
          }
          case "screenshot_frame": {
            const frame = stringArgument(args, "frame");
            const currentFrame = await readDesignFrameRenderIdentity(
              workspace.path,
              frame,
            );
            const nodeId =
              typeof args.nodeId === "string" && args.nodeId.trim()
                ? args.nodeId.trim()
                : null;
            const screenshot = getDesignScreenshot(
              workspaceId,
              frame,
              nodeId,
              currentFrame.sourceVersion,
            );
            if (!screenshot) {
              throw new Error(
                nodeId
                  ? `No rendered screenshot is available for ${frame}#${nodeId}. Select that layer on the live canvas, then retry.`
                  : `No rendered screenshot is available for ${frame}. Open the live design canvas, then retry.`,
              );
            }
            return {
              content: [
                {
                  type: "image",
                  data: screenshot.data,
                  mimeType: screenshot.mimeType,
                },
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      frame,
                      nodeId,
                      width: screenshot.width,
                      height: screenshot.height,
                      scale: screenshot.scale,
                      capturedAt: screenshot.capturedAt,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          case "lint_design":
            return textResult(
              await lintDesignDocument(
                workspace.path,
                typeof args.frame === "string" ? args.frame : undefined,
              ),
            );
          case "get_tokens":
            return textResult({
              sourcePath: "Zeros Design/tokens.css",
              tokens: await readDesignTokens(workspace.path),
            });
          case "get_guide": {
            const topic = stringArgument(args, "topic") as DesignGuideTopic;
            const guide = DESIGN_GUIDES[topic];
            if (!guide) throw new Error(`Unknown design guide topic: ${topic}`);
            return textResult({ topic, guide });
          }
          case "write_html":
            return mutationResult(
              await writeDesignNodeHtml(workspace.path, {
                frame: stringArgument(args, "frame"),
                nodeId: stringArgument(args, "nodeId"),
                sourceVersion: stringArgument(args, "sourceVersion"),
                html: stringArgument(args, "html"),
                mode: args.mode === "append" ? "append" : "replace-inner",
              }),
            );
          case "update_styles":
            return mutationResult(
              await updateDesignNodeStyles(workspace.path, {
                frame: stringArgument(args, "frame"),
                nodeId: stringArgument(args, "nodeId"),
                sourceVersion: stringArgument(args, "sourceVersion"),
                styles: styleArguments(args),
              }),
            );
          case "set_text":
            return mutationResult(
              await setDesignNodeText(workspace.path, {
                frame: stringArgument(args, "frame"),
                nodeId: stringArgument(args, "nodeId"),
                sourceVersion: stringArgument(args, "sourceVersion"),
                text:
                  typeof args.text === "string"
                    ? args.text
                    : (() => {
                        throw new Error('"text" must be a string.');
                      })(),
              }),
            );
          default:
            throw new Error(`Unknown design tool: ${request.params.name}`);
        }
      } catch (error) {
        return errorResult(error);
      }
    });
    return server;
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    try {
      if (!this.isAllowedRequest(request)) {
        response.statusCode = 403;
        response.end();
        return;
      }
      const scope = this.requestScope(request);
      if (!scope) {
        response.statusCode = 404;
        response.end();
        return;
      }
      const sessionId = request.headers["mcp-session-id"];
      const entry =
        typeof sessionId === "string"
          ? this.sessions.get(sessionId)
          : undefined;
      if (entry && entry.workspaceId !== scope.workspaceId) {
        response.statusCode = 403;
        response.end();
        return;
      }
      if (typeof sessionId === "string" && !entry) {
        response.statusCode = 404;
        response.end();
        return;
      }
      if (!entry) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            this.provisionalConnections.delete(provisional);
            this.sessions.set(id, provisional);
          },
        });
        const server = this.makeServer(scope.workspaceId);
        const provisional: SessionEntry = {
          server,
          transport,
          workspaceId: scope.workspaceId,
          closed: false,
        };
        transport.onclose = () => {
          provisional.closed = true;
          this.provisionalConnections.delete(provisional);
          if (transport.sessionId) this.sessions.delete(transport.sessionId);
        };
        this.provisionalConnections.add(provisional);
        try {
          await server.connect(transport);
          await transport.handleRequest(request, response);
        } finally {
          if (this.provisionalConnections.has(provisional)) {
            await this.closeEntry(provisional);
          }
        }
        return;
      }
      await entry.transport.handleRequest(request, response);
    } catch (error) {
      console.error(
        "[zeros-design-mcp] request failed:",
        error instanceof Error ? error.message : error,
      );
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end();
      }
    }
  }
}
