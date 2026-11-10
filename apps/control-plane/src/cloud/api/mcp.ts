import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { HttpError } from "../../authz.js";
import { CLOUD_V2_MAX_PROMPT_BYTES, CloudV2PromptIdSchema } from "../prompt-contract.js";
import { apiInput, ApiPageSchema, ApiWorkspaceListSchema, ApiWorkspaceCreateSchema, ApiSessionCreateSchema,
  ApiSessionListSchema, ApiMessageListSchema, ApiMessageSendSchema, ApiRenameSchema, ApiSessionRenameSchema } from "./contract.js";
import { cloudApiCreateLimit, cloudApiFailure, createCloudApiBoundary, type CloudApiDependencies } from "./boundary.js";

const empty = z.object({}).strict();
const workspace = z.object({ workspaceId: z.string().uuid() }).strict();
const session = z.object({ sessionId: CloudV2PromptIdSchema }).strict();
const content = (document: Record<string, unknown>) => ({ structuredContent: document,
  content: [{ type: "text" as const, text: JSON.stringify(document) }] });

export function createCloudApiMcpRoutes({ credentials, service }: CloudApiDependencies) {
  const app = createCloudApiBoundary(credentials), createLimit = cloudApiCreateLimit();
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== new URL(c.req.url).origin)
      return c.json({ error: { code: "invalid_origin", message: "Invalid request origin" } }, 403);
    await next();
  });
  app.post("/", async c => {
    const body: unknown = await c.req.json().catch(() => null);
    // One HTTP request spends one credential budget; batches could bypass it.
    if (Array.isArray(body)) return c.json({ jsonrpc: "2.0", id: null,
      error: { code: -32600, message: "Batch requests are not supported" } }, 400);
    const credential = c.get("cloudApiCredential");
    const sourceSessionId = c.req.header("x-zeros-session-id");
    const tools = new Map<string, { definition: Tool; run(input: unknown): Promise<Record<string, unknown>> }>();
    function tool<T extends z.ZodObject>(name: string, description: string, schema: T, readOnly: boolean,
      run: (input: z.output<T>) => Record<string, unknown> | Promise<Record<string, unknown>>) {
      tools.set(name, { definition: { name, description, inputSchema: z.toJSONSchema(schema, { io: "input" }) as Tool["inputSchema"],
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly } },
      run: async input => run(apiInput(schema, input) as z.output<T>) });
    }
    tool("whoami", "Show the user, organization and credential kind.", empty, true, () => service.me(credential));
    tool("list_models", "List supported agents, models and effort levels.", empty, true, () => service.models());
    tool("list_repositories", "List Cloud Computer repositories you can create workspaces in.", ApiPageSchema.strict(), true,
      input => service.repositories(credential, input));
    tool("list_workspaces", "List your cloud workspaces without waking them.", ApiWorkspaceListSchema, true,
      input => service.workspaces(credential, input));
    tool("create_workspace", "Create a cloud workspace and optionally queue its first message. Reuse idempotencyKey to retry safely.",
      ApiWorkspaceCreateSchema.safeExtend({ idempotencyKey: z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/).optional() }), false,
      async ({ idempotencyKey, ...input }) => {
        await createLimit(c, async () => {});
        return service.createWorkspace(credential, input, idempotencyKey, sourceSessionId);
      });
    tool("get_workspace", "Read a workspace without waking it.", workspace, true, ({ workspaceId }) => service.workspace(credential, workspaceId));
    tool("get_workspace_status", "Read workspace lifecycle status without waking it.", workspace, true,
      ({ workspaceId }) => service.workspaceStatus(credential, workspaceId));
    tool("rename_workspace", "Set a workspace title.", workspace.extend(ApiRenameSchema.shape), false,
      ({ workspaceId, ...input }) => service.renameWorkspace(credential, workspaceId, input));
    for (const [action, description] of [
      ["archive", "Archive a workspace and stop its VM."], ["unarchive", "Unarchive a workspace and start its VM."],
      ["sleep", "Stop a workspace VM."], ["wake", "Start a workspace VM."],
    ] as const) tool(`${action}_workspace`, description, workspace, false, ({ workspaceId }) => service.lifecycle(credential, workspaceId, action));
    tool("list_workspace_sessions", "List mirrored sessions without waking the workspace.", ApiSessionListSchema.extend(workspace.shape), true,
      ({ workspaceId, ...input }) => service.sessions(credential, workspaceId, input));
    tool("create_session", "Create a session with its first message; wakes a sleeping workspace. An archived workspace must be unarchived first.",
      ApiSessionCreateSchema, false, input => service.createSession(credential, input, sourceSessionId));
    tool("get_session", "Read a mirrored session without waking its workspace.", session, true,
      ({ sessionId }) => service.getSession(credential, sessionId));
    tool("get_session_status", "Read whether a session is idle, working or in error.", session, true,
      ({ sessionId }) => service.sessionStatus(credential, sessionId));
    tool("cancel_session", "Stop the current turn and drop queued messages.", session, false,
      ({ sessionId }) => service.cancelSession(credential, sessionId));
    tool("rename_session", "Rename a session without waking its workspace.", session.extend(ApiSessionRenameSchema.shape), false,
      ({ sessionId, ...input }) => service.renameSession(credential, sessionId, input));
    tool("archive_session", "Archive an idle session without waking its workspace. Cancel a working session first.", session, false,
      ({ sessionId }) => service.archiveSession(credential, sessionId, true));
    tool("unarchive_session", "Unarchive a session without waking its workspace.", session, false,
      ({ sessionId }) => service.archiveSession(credential, sessionId, false));
    tool("send_message", "Queue a message; wakes a sleeping workspace. Reuse messageId to retry safely.", session.extend(ApiMessageSendSchema.shape), false,
      async ({ sessionId, ...input }) => ({ message: (await service.sendMessage(credential, sessionId, input, sourceSessionId)).message }));
    tool("list_messages", "Read mirrored messages in order, optionally after a message ID. Never wakes a workspace.", ApiMessageListSchema.extend(session.shape), true,
      ({ sessionId, ...input }) => service.messages(credential, sessionId, input));
    tool("get_message", "Read one mirrored message without waking its workspace.", session.extend({ messageId: CloudV2PromptIdSchema }), true,
      ({ sessionId, messageId }) => service.message(credential, sessionId, messageId));

    // Stateless transport: the next request must resolve current authority again.
    const server = new Server({ name: "zeros-cloud", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools.values()].map(tool => tool.definition) }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        const selected = tools.get(request.params.name);
        if (!selected) throw new HttpError(404, "not_found", "Tool not found");
        return content(await selected.run(request.params.arguments ?? {}));
      } catch (error) {
        const failure = cloudApiFailure(error);
        if (failure.retryAfter !== undefined) c.header("Retry-After", String(failure.retryAfter));
        return { ...content({ error: failure.error }), isError: true };
      }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: CLOUD_V2_MAX_PROMPT_BYTES });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(c.req.raw, { parsedBody: body });
      return c.newResponse(response.body, response);
    } finally { await server.close(); }
  });
  app.all("/", c => {
    c.header("Allow", "POST");
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed" } }, 405);
  });
  return app;
}
