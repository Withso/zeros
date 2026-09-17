import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema, type ClientRequest, type Implementation, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { safeParse, type AnySchema, type SchemaOutput } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";

export const TOOL_DISCOVERY_LIMITS = {
  pages: 100,
  tools: 10_000,
  bytes: 8 * 1024 * 1024,
  cursorBytes: 8 * 1024,
  timeoutMs: 15_000,
} as const;

/** Client.listTools replaces the SDK's output validators/task metadata after
 * each response. Collect pages below that public method, so the SDK commits
 * metadata for the complete catalog once and failed reads preserve it. */
export class CatalogClient extends Client {
  private readonly catalogValidator: { current: AjvJsonSchemaValidator };

  constructor(info: Implementation) {
    const validator = { current: new AjvJsonSchemaValidator() };
    super(info, { jsonSchemaValidator: {
      getValidator<T>(schema: JsonSchemaType) { return validator.current.getValidator<T>(schema); },
    } });
    this.catalogValidator = validator;
  }

  override async request<T extends AnySchema>(request: ClientRequest, resultSchema: T, options?: RequestOptions): Promise<SchemaOutput<T>> {
    if (request.method !== "tools/list" || request.params?.cursor !== undefined) return super.request(request, resultSchema, options);
    const tools = await listAllBackendTools({
      listTools: (params, pageOptions) => super.request({
        ...request, params: { ...request.params, ...params },
      }, ListToolsResultSchema, { ...options, ...pageOptions }),
    }, options?.signal ?? new AbortController().signal);
    const result = safeParse(resultSchema, { tools });
    if (!result.success) throw result.error;
    // Compile before the SDK clears its confirmed metadata. A fresh compiler
    // also allows a changed schema to reuse its $id without stale validation.
    const validator = new AjvJsonSchemaValidator();
    for (const tool of tools) if (tool.outputSchema) validator.getValidator(tool.outputSchema);
    this.catalogValidator.current = validator;
    return result.data;
  }
}

/** Read a complete catalog or fail. Callers retain their prior confirmed
 * snapshot on refresh failure; no partially fetched catalog is published. */
export async function listAllBackendTools(client: Pick<Client, "listTools">, signal: AbortSignal): Promise<Tool[]> {
  signal.throwIfAborted();
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(new Error("MCP tool discovery timed out")), TOOL_DISCOVERY_LIMITS.timeoutMs);
  const readSignal = AbortSignal.any([signal, deadline.signal]);
  const started = Date.now();
  const cursors = new Set<string>();
  const tools = new Map<string, Tool>();
  let cursor: string | undefined;
  let count = 0;
  let bytes = 0;
  try {
    for (let page = 0; page < TOOL_DISCOVERY_LIMITS.pages; page++) {
      readSignal.throwIfAborted();
      const remaining = TOOL_DISCOVERY_LIMITS.timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw new Error("MCP tool discovery timed out");
      const result = await client.listTools(cursor === undefined ? undefined : { cursor }, {
        signal: readSignal, timeout: remaining, maxTotalTimeout: remaining,
      });
      readSignal.throwIfAborted();
      count += result.tools.length;
      if (count > TOOL_DISCOVERY_LIMITS.tools) throw new Error("MCP tool discovery exceeded the tool limit");
      for (const tool of result.tools) {
        bytes += Buffer.byteLength(JSON.stringify(tool), "utf8");
        if (bytes > TOOL_DISCOVERY_LIMITS.bytes) throw new Error("MCP tool discovery exceeded the size limit");
        const previous = tools.get(tool.name);
        if (previous && !isDeepStrictEqual(previous, tool)) throw new Error("MCP tool discovery returned conflicting duplicate tools");
        if (!previous) tools.set(tool.name, tool);
      }
      if (result.nextCursor === undefined) return [...tools.values()];
      cursor = result.nextCursor;
      if (Buffer.byteLength(cursor, "utf8") > TOOL_DISCOVERY_LIMITS.cursorBytes) throw new Error("MCP tool discovery exceeded the cursor size limit");
      if (cursors.has(cursor)) throw new Error("MCP tool discovery repeated a pagination cursor");
      cursors.add(cursor);
    }
    throw new Error("MCP tool discovery exceeded the page limit");
  } finally { clearTimeout(timeout); }
}
