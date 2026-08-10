const MCP_PROTOCOL_VERSION = "2025-06-18";

type BrowserContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };

export interface BrowserMcpToolResult {
  success: boolean;
  contentItems: BrowserContentItem[];
}

export interface BrowserMcpCall {
  name: string;
  arguments: unknown;
}

export interface BrowserMcpReply {
  status: number;
  body: Record<string, unknown> | null;
}

type BrowserMcpExecutor = (
  call: BrowserMcpCall,
) => Promise<BrowserMcpToolResult>;

const BROWSER_MCP_TOOLS = [
  {
    name: "open",
    description:
      "Open an http(s) URL in the browser provider selected in Zeros and return a semantic page snapshot.",
    inputSchema: objectSchema(
      {
        url: { type: "string", description: "Absolute http(s) URL." },
        width: { type: "integer", minimum: 320, maximum: 2560 },
        height: { type: "integer", minimum: 320, maximum: 1800 },
      },
      ["url"],
    ),
    annotations: safeBrowserAnnotations(),
  },
  {
    name: "snapshot",
    description:
      "Inspect the current page and return visible text plus semantic element refs.",
    inputSchema: objectSchema({}),
    annotations: safeBrowserAnnotations(),
  },
  {
    name: "click",
    description:
      "Click an element from the latest snapshot by its semantic ref.",
    inputSchema: objectSchema(
      { ref: { type: "string", description: "Element ref such as b12." } },
      ["ref"],
    ),
    annotations: interactiveBrowserAnnotations(),
  },
  {
    name: "type",
    description:
      "Type into a text field. Password entry pauses for explicit user confirmation; use upload for file inputs.",
    inputSchema: objectSchema(
      {
        ref: { type: "string" },
        text: { type: "string", maxLength: 20_000 },
        clear: { type: "boolean", default: true },
      },
      ["ref", "text"],
    ),
    annotations: interactiveBrowserAnnotations(),
  },
  {
    name: "upload",
    description:
      "Choose one local file for a file input. The app validates the file and pauses for explicit user confirmation before the page can read it.",
    inputSchema: objectSchema(
      {
        ref: { type: "string", description: "File-input element ref." },
        path: { type: "string", description: "Absolute local file path." },
      },
      ["ref", "path"],
    ),
    annotations: interactiveBrowserAnnotations(),
  },
  {
    name: "screenshot",
    description:
      "Capture the current browser viewport as an image, optionally highlighting semantic refs.",
    inputSchema: objectSchema({
      annotations: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: { ref: { type: "string" }, label: { type: "string" } },
          required: ["ref"],
          additionalProperties: false,
        },
      },
    }),
    annotations: safeBrowserAnnotations(),
  },
  {
    name: "computer_screenshot",
    description:
      "Capture the primary Mac display when System Computer Use is selected and both macOS permissions are granted.",
    inputSchema: objectSchema({}),
    annotations: safeBrowserAnnotations(),
  },
  {
    name: "computer_click",
    description:
      "Click a primary-display coordinate through macOS System Computer Use. Zeros always pauses for explicit confirmation.",
    inputSchema: objectSchema(
      {
        x: { type: "integer", minimum: 0, maximum: 20_000 },
        y: { type: "integer", minimum: 0, maximum: 20_000 },
      },
      ["x", "y"],
    ),
    annotations: interactiveBrowserAnnotations(),
  },
  {
    name: "computer_type",
    description:
      "Type text into the focused macOS control through System Computer Use. Zeros always pauses for explicit confirmation.",
    inputSchema: objectSchema(
      { text: { type: "string", minLength: 1, maxLength: 2_000 } },
      ["text"],
    ),
    annotations: interactiveBrowserAnnotations(),
  },
  {
    name: "computer_key",
    description:
      "Press one supported navigation key through macOS System Computer Use. Zeros always pauses for explicit confirmation.",
    inputSchema: objectSchema(
      {
        key: {
          type: "string",
          enum: [
            "enter",
            "tab",
            "escape",
            "space",
            "backspace",
            "arrow-up",
            "arrow-down",
            "arrow-left",
            "arrow-right",
          ],
        },
      },
      ["key"],
    ),
    annotations: interactiveBrowserAnnotations(),
  },
  {
    name: "trace",
    description:
      "Persist the bounded navigation, tool, permission, download, console, and network event trace for this task.",
    inputSchema: objectSchema({}),
    annotations: safeBrowserAnnotations(),
  },
  {
    name: "cdp",
    description:
      "Run one raw Chrome DevTools Protocol command. Disabled by default; requires the Developer browser CDP setting and explicit confirmation for the exact site and method.",
    inputSchema: objectSchema(
      {
        method: { type: "string", description: "CDP Domain.method name." },
        params: { type: "object", additionalProperties: true },
      },
      ["method"],
    ),
    annotations: interactiveBrowserAnnotations(),
  },
  {
    name: "resize",
    description: "Resize the viewport for responsive testing.",
    inputSchema: objectSchema(
      {
        width: { type: "integer", minimum: 320, maximum: 2560 },
        height: { type: "integer", minimum: 320, maximum: 1800 },
      },
      ["width", "height"],
    ),
    annotations: safeBrowserAnnotations(),
  },
  ...["back", "forward", "reload", "close"].map((name) => ({
    name,
    description:
      name === "close"
        ? "Close this task's browser session and erase its isolated session data when applicable."
        : `${name[0]!.toUpperCase()}${name.slice(1)} in the selected browser provider.`,
    inputSchema: objectSchema({}),
    annotations: safeBrowserAnnotations(),
  })),
];

export async function handleBrowserMcpRequest(
  request: unknown,
  execute: BrowserMcpExecutor,
): Promise<BrowserMcpReply> {
  const rpc = asRecord(request);
  const id = rpc.id;
  const method = typeof rpc.method === "string" ? rpc.method : "";

  if (!Object.hasOwn(rpc, "id")) {
    return { status: 202, body: null };
  }
  if (!method) return rpcError(id, -32600, "Invalid MCP request.");

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "zeros-browser", version: "0.1.0" },
      instructions:
        "Use these tools directly for browser navigation and user-like website testing. Do not ask the user to connect Chrome.",
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    return rpcResult(id, { tools: BROWSER_MCP_TOOLS });
  }
  if (method !== "tools/call") {
    return rpcError(id, -32601, `Unsupported MCP method: ${method}`);
  }

  const params = asRecord(rpc.params);
  const name = typeof params.name === "string" ? params.name : "";
  if (!BROWSER_MCP_TOOLS.some((tool) => tool.name === name)) {
    return rpcResult(id, {
      content: [{ type: "text", text: `Unsupported browser tool: ${name}` }],
      isError: true,
    });
  }

  const result = await execute({ name, arguments: params.arguments ?? {} });
  return rpcResult(id, {
    content: result.contentItems.map(toMcpContent),
    isError: !result.success,
  });
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function safeBrowserAnnotations(): Record<string, boolean> {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
}

function interactiveBrowserAnnotations(): Record<string, boolean> {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };
}

function toMcpContent(item: BrowserContentItem): Record<string, unknown> {
  if (item.type === "inputText") return { type: "text", text: item.text };
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(item.imageUrl);
  if (!match) {
    return {
      type: "text",
      text: "Browser screenshot was not valid image data.",
    };
  }
  return { type: "image", mimeType: match[1], data: match[2] };
}

function rpcResult(id: unknown, result: unknown): BrowserMcpReply {
  return {
    status: 200,
    body: { jsonrpc: "2.0", id: id as string | number | null, result },
  };
}

function rpcError(id: unknown, code: number, message: string): BrowserMcpReply {
  return {
    status: 200,
    body: {
      jsonrpc: "2.0",
      id: id as string | number | null,
      error: { code, message },
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
