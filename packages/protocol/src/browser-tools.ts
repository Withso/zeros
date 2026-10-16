// Zeros browser-host contract.
//
// Electron main owns the browser runtime. The session/confirmation/state wire
// shapes cross only trusted Zeros boundaries. The semantic tool inventory is
// the `zeros_browser` MCP server the engine serves to Claude and Cursor, and
// to Codex when its built-in Browser plugin is switched off or unavailable.
// Codex otherwise keeps OpenAI's Browser plugin/IAB contract, and Claude keeps
// its official Chrome integration when the user chooses it.

import type { ConversationId, WorkspaceId } from "./identities";

export const BROWSER_SERVICE_VERSION = 1 as const;
export const BROWSER_TOOL_NAMESPACE = "zeros_browser" as const;
/** The suffix is a fresh random scope for every semantic snapshot. Keeping it
 * in the public ref prevents an older `b1` from silently selecting whatever
 * happens to be first in a newer DOM walk. */
export const BROWSER_ELEMENT_REF_PATTERN =
  "^b[1-9][0-9]{0,8}_[a-f0-9]{24}$" as const;
const BROWSER_ELEMENT_REF = new RegExp(BROWSER_ELEMENT_REF_PATTERN);

export const BROWSER_TOOL_NAMES = [
  "open",
  "snapshot",
  "click",
  "type",
  "key",
  "select",
  "scroll",
  "wait",
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

/** Semantic executor manifest, advertised verbatim as the `zeros_browser` MCP
 * tool list. Raw CDP and host-computer control are deliberately absent. */
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
      "Read the visible page text and interactive elements, assigning tokenized snapshot-scoped refs such as b1_0123456789abcdef01234567 for later actions. A newer snapshot invalidates earlier refs.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
  },
  {
    name: "click",
    description:
      "Click an element from the latest browser snapshot. Consequential controls pause for a Zeros confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", pattern: BROWSER_ELEMENT_REF_PATTERN },
      },
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
        ref: { type: "string", pattern: BROWSER_ELEMENT_REF_PATTERN },
        text: { type: "string", maxLength: 20_000 },
        clear: { type: "boolean" },
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "key",
    description:
      "Press one key or shortcut, such as Enter, Escape, Tab, ArrowDown or Meta+A, optionally focusing a referenced element first. Enter in a form field, Enter or Space on a control a click would confirm, and either key inside a frame from another origin pause for a Zeros confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", maxLength: 40 },
        ref: { type: "string", pattern: BROWSER_ELEMENT_REF_PATTERN },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "select",
    description:
      "Choose an option in a referenced select element by its value or visible label, then return a fresh semantic snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", pattern: BROWSER_ELEMENT_REF_PATTERN },
        value: { type: "string", maxLength: 1_000 },
        label: { type: "string", maxLength: 1_000 },
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description:
      "Visibly scroll the shared page by a bounded horizontal and/or vertical distance, then return a fresh semantic snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "integer", minimum: -10_000, maximum: 10_000 },
        y: { type: "integer", minimum: -10_000, maximum: 10_000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "wait",
    description:
      "Wait until text appears on the page, or for a short delay, for at most 10 seconds. Returns a fresh semantic snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: 500 },
        seconds: { type: "number", minimum: 0.1, maximum: 10 },
      },
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
        ref: { type: "string", pattern: BROWSER_ELEMENT_REF_PATTERN },
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
              ref: {
                type: "string",
                pattern: BROWSER_ELEMENT_REF_PATTERN,
              },
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
      "Finish agent control and hand the current page to the user. The page, URL, history, cookies, and scroll position remain open until the conversation or Browser use is closed by Zeros.",
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
  /** Proves that this main-process build owns the private IAB socket consumed
   * by OpenAI's bundled Browser plugin. Older Zeros browser hosts exposed only
   * the legacy canonical-tool service and must fail closed for Codex. */
  capabilities: {
    codexIab: true;
  };
}

export interface BrowserSessionReleaseRequest {
  version: typeof BROWSER_SERVICE_VERSION;
  workspaceId: WorkspaceId;
  conversationId: ConversationId;
}

export interface BrowserSessionReleaseResponse {
  version: typeof BROWSER_SERVICE_VERSION;
  released: boolean;
}

/** Stop the agent's current browser action without closing the page. The
 * same interruption the Browser tab's Stop button applies. */
export interface BrowserSessionStopResponse {
  version: typeof BROWSER_SERVICE_VERSION;
  stopped: boolean;
}

export interface BrowserToolInvokeRequest {
  version: typeof BROWSER_SERVICE_VERSION;
  browserSessionId: string;
  tool: BrowserToolName;
  arguments: BrowserJsonValue;
  /** The admitted agent, named on the page's control bar. */
  agent?: AgentControlFamily;
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
  "navigation",
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
  /** Durable Zeros owners used to route the prompt into the exact chat. */
  workspaceId: WorkspaceId;
  conversationId: ConversationId;
  category: BrowserRiskCategory;
  scope?: string;
  origin: string;
  url: string;
  label: string;
  createdAt: number;
}

export interface BrowserAgentPointer {
  x: number;
  y: number;
  action: "move" | "click" | "type" | "scroll";
  updatedAt: number;
}

/** Host-authored presentation state for one browser action. Labels are
 * deliberately concise and must never contain typed values or upload paths. */
export interface BrowserSessionAction {
  sequence: number;
  kind: BrowserToolName | "permission" | "download";
  label: string;
  startedAt: number;
}

export interface BrowserSessionState {
  browserSessionId: string;
  workspaceId: WorkspaceId;
  conversationId: ConversationId;
  url: string;
  title: string;
  loading: boolean;
  /** Native Chromium history availability for trusted browser chrome. */
  canGoBack?: boolean;
  canGoForward?: boolean;
  status: "working" | "awaiting-confirmation" | "ready" | "closed";
  tool?: BrowserToolName | "permission" | "download" | "renderer-crash";
  /** Last controller of the shared page. Trusted browser chrome actions and
   * direct keyboard/pointer input inside the attached guest publish `user`. */
  actor?: "agent" | "user";
  /** Host-computed agent pointer position in guest viewport coordinates. */
  pointer?: BrowserAgentPointer;
  /** Bounded data URL fetched through the isolated browser session. */
  faviconDataUrl?: string;
  /** Last full browser viewport before the live native page was rehosted into
   * compact PiP. Presentation uses this aspect ratio instead of turning the
   * site into a tiny mobile layout. */
  sourceViewport?: { width: number; height: number };
  /** Current/recent high-level activity shown in trusted browser chrome. */
  action?: BrowserSessionAction;
  /** True only while Stop can interrupt active browser work. */
  cancellable?: boolean;
  /** Pointer presence over the currently attached native guest. This is
   * presentation-only state used by the compact PiP host because native
   * WebContentsView mouse events do not bubble through the renderer DOM. */
  surfaceHovered?: boolean;
  /** Compatibility field retained for older renderer builds. Current Browser
   * UI follows `actor` for the full provider-owned session instead of expiring
   * between individual actions. */
  agentActivityUntil?: number;
}

/** Agents that drive Zeros-owned browser, computer, and simulator control. */
export const AGENT_CONTROL_FAMILIES = ["claude", "codex", "cursor"] as const;
export type AgentControlFamily = (typeof AGENT_CONTROL_FAMILIES)[number];

const AGENT_CONTROL_NAMES: Record<AgentControlFamily, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

export function isAgentControlFamily(
  value: unknown,
): value is AgentControlFamily {
  return (
    typeof value === "string" &&
    (AGENT_CONTROL_FAMILIES as readonly string[]).includes(value)
  );
}

/** The name trusted control chrome and approval cards show for an agent. */
export function agentControlName(family: AgentControlFamily): string {
  return AGENT_CONTROL_NAMES[family];
}

/** What trusted control chrome says the agent is doing with its page. A
 * finished action's label stays on the state for history, so it only shows
 * while that action is still running. */
export function browserControlDetail(
  state: Pick<BrowserSessionState, "status" | "action">,
): string {
  if (state.status === "awaiting-confirmation") return "Waiting for approval";
  if (state.status === "working" && state.action?.label) {
    return state.action.label;
  }
  return "Using the browser";
}

/** A Browser tab's explicit page color scheme. Absent means System: the page
 * follows the Zeros appearance, so "system" is never stored. */
export type BrowserAppearance = "light" | "dark";

export function normalizeBrowserAppearance(
  value: unknown,
): BrowserAppearance | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}

/** Browser origin permission identity shared by the official-provider adapter
 * and native host. Only apex/www redirects coalesce; subdomains, schemes, and
 * non-default ports retain independent grants. */
export function canonicalBrowserOriginGrantKey(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = url.hostname.toLocaleLowerCase().replace(/^www\./, "");
    return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return null;
  }
}

/** Which browser an agent family uses in a Local workspace. Cloud workspaces
 * get none of these; callers check placement first. */
export type BrowserRoute = "off" | "codex-native" | "claude-chrome" | "zeros";

/** The `[browser]` settings table, normalized with the shipped defaults. */
export interface BrowserRouteSettings {
  /** "Enable browser use" for Codex. */
  codexEnabled: boolean;
  /** "Use Codex's built-in browser". Off routes Codex to `zeros_browser`. */
  codexNative: boolean;
  /** "Use Claude Code with Chrome". Takes Claude off the in-app browser. */
  claudeChrome: boolean;
  /** "Allow Claude and Cursor to use the in-app browser". */
  inAppEnabled: boolean;
}

export function browserRouteSettings(raw: unknown): BrowserRouteSettings {
  const table =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const flag = (key: string, fallback: boolean) =>
    typeof table[key] === "boolean" ? (table[key] as boolean) : fallback;
  // `enabled` predates the per-provider switches; it still decides Codex
  // when `codex_enabled` was never written.
  return {
    codexEnabled: flag("codex_enabled", flag("enabled", true)),
    codexNative: flag("codex_native", true),
    claudeChrome: flag("claude_enabled", false),
    inAppEnabled: flag("in_app_enabled", true),
  };
}

/** The routing table in docs/agent-control.md. A Codex built-in browser that
 * turns out to be unusable falls back to `zeros` at session start. */
export function resolveBrowserRoute(
  agentFamily: string,
  settings: BrowserRouteSettings,
): BrowserRoute {
  switch (agentFamily) {
    case "codex":
      if (!settings.codexEnabled) return "off";
      return settings.codexNative ? "codex-native" : "zeros";
    case "claude":
      if (settings.claudeChrome) return "claude-chrome";
      return settings.inAppEnabled ? "zeros" : "off";
    case "cursor":
      return settings.inAppEnabled ? "zeros" : "off";
    default:
      return "off";
  }
}

const BOUNDED_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export function isBrowserToolName(value: unknown): value is BrowserToolName {
  return (
    typeof value === "string" &&
    (BROWSER_TOOL_NAMES as readonly string[]).includes(value)
  );
}

export function isBrowserElementRef(value: unknown): value is string {
  return typeof value === "string" && BROWSER_ELEMENT_REF.test(value);
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
