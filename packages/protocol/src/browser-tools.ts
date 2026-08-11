// Provider-neutral Zeros browser tool contract.
//
// The Electron main process owns the browser runtime, while the engine's agent
// adapters advertise and invoke these tools. Keeping the manifest and wire
// shapes here gives every adapter the same product contract without making MCP,
// Codex threads, Claude sessions, or Cursor agents the owner of browser state.

import type { ConversationId, WorkspaceId } from "./identities";

export const BROWSER_SERVICE_VERSION = 1 as const;
export const BROWSER_TOOL_NAMESPACE = "zeros_browser" as const;

export const BROWSER_TOOL_NAMES = [
  "open",
  "snapshot",
  "click",
  "type",
  "upload",
  "resize",
  "back",
  "forward",
  "reload",
  "screenshot",
  "trace",
  "close",
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

export type BrowserJsonValue =
  | null
  | boolean
  | number
  | string
  | BrowserJsonValue[]
  | { [key: string]: BrowserJsonValue };

export interface BrowserToolDefinition {
  name: BrowserToolName;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, BrowserJsonValue>;
    required?: string[];
    additionalProperties: false;
  };
}

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

/** The one canonical tool manifest. Provider adapters translate this exact
 * inventory into their native tool-definition shape; they do not maintain
 * separate browser schemas. Raw CDP and host-computer control are deliberately
 * absent from the product contract. */
export const BROWSER_TOOL_DEFINITIONS: readonly BrowserToolDefinition[] = [
  {
    name: "open",
    description:
      "Open an HTTP or HTTPS URL in the isolated Zeros browser and return a semantic page snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", maxLength: 8_192 },
        width: { type: "integer", minimum: 320, maximum: 2_560 },
        height: { type: "integer", minimum: 320, maximum: 1_800 },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "snapshot",
    description:
      "Read the visible page text and interactive elements, assigning stable refs such as b1 for later actions.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: "click",
    description:
      "Click an element from the latest browser snapshot. Consequential controls pause for a Zeros confirmation.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string", pattern: "^b[1-9][0-9]{0,8}$" } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "type",
    description:
      "Enter text into a referenced input. Password fields pause for a Zeros confirmation and their value is never echoed.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", pattern: "^b[1-9][0-9]{0,8}$" },
        text: { type: "string", maxLength: 20_000 },
        clear: { type: "boolean" },
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "upload",
    description:
      "Upload one regular file from the owning Zeros workspace to a referenced file input after confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", pattern: "^b[1-9][0-9]{0,8}$" },
        path: { type: "string", maxLength: 4_096 },
      },
      required: ["ref", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "resize",
    description:
      "Resize the isolated browser viewport and return a fresh snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "integer", minimum: 320, maximum: 2_560 },
        height: { type: "integer", minimum: 320, maximum: 1_800 },
      },
      required: ["width", "height"],
      additionalProperties: false,
    },
  },
  {
    name: "back",
    description: "Navigate backward and return a fresh semantic snapshot.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: "forward",
    description: "Navigate forward and return a fresh semantic snapshot.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: "reload",
    description:
      "Reload the current page and return a fresh semantic snapshot.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: "screenshot",
    description:
      "Capture the current viewport as JPEG evidence. Optional annotations point to refs from the latest snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        annotations: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              ref: { type: "string", pattern: "^b[1-9][0-9]{0,8}$" },
              label: { type: "string", maxLength: 80 },
            },
            required: ["ref"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "trace",
    description:
      "Persist a bounded JSON trace of browser navigation, console, network, confirmation, and tool activity.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: "close",
    description:
      "Close the current page and clear its ephemeral profile while retaining the Zeros browser-session identity for a later open.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
] as const;

export interface BrowserSessionOwner {
  workspaceId: WorkspaceId;
  conversationId: ConversationId;
  /** Canonical workspace/worktree root. Uploads are restricted below it. */
  workspaceRoot: string;
}

export interface BrowserSessionAcquireRequest {
  version: typeof BROWSER_SERVICE_VERSION;
  owner: BrowserSessionOwner;
}

export interface BrowserSessionAcquireResponse {
  version: typeof BROWSER_SERVICE_VERSION;
  browserSessionId: string;
}

export interface BrowserToolInvokeRequest {
  version: typeof BROWSER_SERVICE_VERSION;
  browserSessionId: string;
  tool: BrowserToolName;
  arguments: BrowserJsonValue;
}

export type BrowserToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/jpeg" };

export interface BrowserToolResult {
  version: typeof BROWSER_SERVICE_VERSION;
  success: boolean;
  content: BrowserToolContent[];
}

export const BROWSER_RISK_CATEGORIES = [
  "authentication",
  "payment",
  "publishing",
  "destructive",
  "external-submit",
  "file-upload",
  "download",
  "browser-permission",
] as const;

export type BrowserRiskCategory = (typeof BROWSER_RISK_CATEGORIES)[number];
export const BROWSER_CONFIRMATION_DECISIONS = [
  "allow-once",
  "allow-site",
  "deny",
] as const;
export type BrowserConfirmationDecision =
  (typeof BROWSER_CONFIRMATION_DECISIONS)[number];

/** Main→trusted-renderer authorization request. The browser host creates every
 * field; provider tool arguments never create ids, origins, or grant scopes. */
export interface BrowserConfirmationRequest {
  id: string;
  browserSessionId: string;
  category: BrowserRiskCategory;
  scope?: string;
  origin: string;
  url: string;
  label: string;
  createdAt: number;
}

export interface BrowserSessionState {
  browserSessionId: string;
  workspaceId: WorkspaceId;
  conversationId: ConversationId;
  url: string;
  title: string;
  loading: boolean;
  status: "working" | "awaiting-confirmation" | "ready" | "closed";
  tool?: BrowserToolName | "permission" | "download" | "renderer-crash";
}

const BOUNDED_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export function isBrowserToolName(value: unknown): value is BrowserToolName {
  return (
    typeof value === "string" &&
    (BROWSER_TOOL_NAMES as readonly string[]).includes(value)
  );
}

export function isBrowserConfirmationDecision(
  value: unknown,
): value is BrowserConfirmationDecision {
  return (
    typeof value === "string" &&
    (BROWSER_CONFIRMATION_DECISIONS as readonly string[]).includes(value)
  );
}

export function isBrowserProductId(value: unknown): value is string {
  return typeof value === "string" && BOUNDED_ID.test(value);
}
