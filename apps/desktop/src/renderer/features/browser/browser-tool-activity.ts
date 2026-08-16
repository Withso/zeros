import {
  isBrowserToolName,
  type BrowserToolName,
} from "@zeros/protocol/browser-tools";

import type {
  AgentMessage,
  AgentToolMessage,
} from "../agent/use-agent-session";

export interface BrowserToolActivity {
  id: string;
  tool: BrowserToolName;
  label: string;
  phase: "connect" | "browse" | "handoff";
  target?: string;
  url?: string;
  detail?: string;
  status: AgentToolMessage["status"];
}

export type GroupedBrowserActivity =
  | { kind: "event"; id: string; event: AgentMessage }
  | {
      kind: "browser-activity";
      id: string;
      events: AgentToolMessage[];
      actions: BrowserToolActivity[];
      /** A later narration, permission/question, unrelated tool, or settled
       * turn boundary proves that no more actions belong to this burst. Child
       * completion alone is deliberately insufficient: providers append the
       * next browser call asynchronously. */
      closed: boolean;
    };

export interface BrowserActivityPresentation {
  host: string | null;
  faviconDataUrl?: string;
}

export type BrowserActivityGroupStatus = "browsing" | "used" | "failed";

/** Connection/bootstrap and final handoff describe the Browser capability,
 * not a website interaction. Those rows use the Browser-use cursor glyph;
 * only page work inherits untrusted website artwork. */
export function browserActivityUsesWebsiteIcon(
  activity: Pick<BrowserToolActivity, "phase">,
): boolean {
  return activity.phase === "browse";
}

/** A later visible event is one boundary; provider-turn settlement is the
 * other. Individual child completion is intentionally not a boundary because
 * app-server can append another Browser batch a moment later. */
export function browserActivityTailClosed(
  turnLive: boolean,
  laterVisibleBoundary: boolean,
): boolean {
  return !turnLive || laterVisibleBoundary;
}

/** A browser batch stays live until both every child settles AND a later event
 * closes its chronological boundary. A partial recovery is successful: only
 * an all-failed closed batch gets the failure treatment. */
export function browserActivityGroupStatus(
  events: readonly Pick<AgentToolMessage, "status">[],
  closed: boolean,
): BrowserActivityGroupStatus {
  if (
    !closed ||
    events.some(
      (event) => event.status === "pending" || event.status === "in_progress",
    )
  ) {
    return "browsing";
  }
  return events.length > 0 && events.every((event) => event.status === "failed")
    ? "failed"
    : "used";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toolIdentity(tool: AgentToolMessage): BrowserToolName | null {
  const input = record(tool.rawInput);
  const namespace = String(input.namespace ?? input.server ?? "");
  const inputTool = typeof input.tool === "string" ? input.tool : "";
  if (namespace === "zeros_browser" && isBrowserToolName(inputTool)) {
    return inputTool;
  }
  const title = typeof tool.title === "string" ? tool.title.trim() : "";
  const match = /(?:^|[/:._-])zeros_browser(?:[/:._-]+)([a-z_-]+)$/i.exec(
    title,
  );
  if (match && isBrowserToolName(match[1])) return match[1];
  return null;
}

function nativeCodexBrowserActivity(
  tool: AgentToolMessage,
  assumeActiveBrowserBatch = false,
): BrowserToolActivity | null {
  if (!isCodexNodeReplJsToolCall(tool)) return null;
  const input = record(tool.rawInput);
  const args = record(input.arguments);
  const code = typeof args.code === "string" ? args.code : "";
  const nativeMetadata = nativeBrowserOutputCandidates(tool).some(
    (candidate) => record(candidate._meta)["codex/browserUse"] === true,
  );
  if (
    !nativeMetadata &&
    !assumeActiveBrowserBatch &&
    !/\b(?:setupBrowserRuntime|agent\.browsers|iab|playwright|dom_cua|claimTab|browserTab|crawlTab|tabs\.finalize)\b/.test(
      code,
    ) &&
    !/\.goto\s*\(/.test(code)
  ) {
    return null;
  }
  const handoff = /\btabs\.finalize\s*\(/.test(code);
  const connectionOperation =
    /\b(?:setupBrowserRuntime|agent\.browsers|browsers\.get|claimTab|openTabs)\b/.test(
      code,
    );
  const pageOperation =
    /(?:\.goto\s*\(|playwright|dom_cua|Input\.|Page\.)/.test(code);
  const connect = !handoff && !pageOperation && connectionOperation;
  const phase: BrowserToolActivity["phase"] = handoff
    ? "handoff"
    : connect
      ? "connect"
      : "browse";
  const title =
    typeof args.title === "string" && args.title.trim()
      ? args.title.trim().replace(/\s+/g, " ").slice(0, 160)
      : phase === "handoff"
        ? "Leave browser open"
        : phase === "connect"
          ? "Connect to the in-app browser"
          : "Use the browser";
  const url = nativeBrowserResultUrl(tool) ?? firstBrowserUrlInCode(code);
  const host = hostname(url);
  const inferredTool: BrowserToolName = handoff
    ? "close"
    : /(?:\.goto\s*\(|Page\.navigate)/.test(code)
      ? "open"
      : /(?:\.scroll\s*\(|mouseWheel)/.test(code)
        ? "scroll"
        : /(?:\.click\s*\(|dispatchMouseEvent)/.test(code)
          ? "click"
          : /(?:\.fill\s*\(|\.type\s*\(|insertText|dispatchKeyEvent)/.test(code)
            ? "type"
            : /(?:captureScreenshot|\.screenshot\s*\()/.test(code)
              ? "screenshot"
              : "snapshot";
  return {
    id: tool.id,
    tool: inferredTool,
    label: title,
    phase,
    ...(url ? { url } : {}),
    ...(host ? { target: host } : {}),
    status: tool.status,
  };
}

const CLAUDE_CHROME_TOOL = /^mcp__claude-in-chrome__([a-z0-9_-]+)$/;

/** Claude's official extension is an external browser, so these events have
 * no Zeros-native session/favicons. They still belong in the same compact
 * Browser activity UI; exact prefix matching prevents unrelated MCP servers
 * with browser-like tool names from being mislabeled. */
function nativeClaudeChromeActivity(
  tool: AgentToolMessage,
): BrowserToolActivity | null {
  if (tool.toolKind !== "mcp") return null;
  const match = CLAUDE_CHROME_TOOL.exec(tool.title?.trim() ?? "");
  if (!match) return null;
  const nativeTool = match[1]!;
  const input = record(tool.rawInput);
  const action = String(input.action ?? input.operation ?? "").toLowerCase();
  const semantic = semanticResult(tool);
  const url = semantic.url ?? safeUrl(input.url) ?? safeUrl(input.targetUrl);
  const target = hostname(url) ?? undefined;

  let browserTool: BrowserToolName = "snapshot";
  let label = "Used Chrome";
  let phase: BrowserToolActivity["phase"] = "browse";
  switch (nativeTool) {
    case "tabs_context_mcp":
      label = "Connected to Chrome";
      phase = "connect";
      break;
    case "tabs_create_mcp":
      browserTool = "open";
      label = "Opened tab";
      break;
    case "tabs_close_mcp":
      browserTool = "close";
      label = "Closed tab";
      phase = "handoff";
      break;
    case "navigate":
      if (action === "back") {
        browserTool = "back";
        label = "Went back";
      } else if (action === "forward") {
        browserTool = "forward";
        label = "Went forward";
      } else if (action === "reload") {
        browserTool = "reload";
        label = "Reloaded page";
      } else {
        browserTool = "open";
        label = "Opened";
      }
      break;
    case "computer":
      if (/click|press/.test(action)) {
        browserTool = "click";
        label = "Clicked";
      } else if (/type|key/.test(action)) {
        browserTool = "type";
        label = "Typed";
      } else if (/scroll|wheel/.test(action)) {
        browserTool = "scroll";
        label = "Scrolled";
      } else if (/screenshot/.test(action)) {
        browserTool = "screenshot";
        label = "Captured screenshot";
      }
      break;
    case "form_input":
      browserTool = "type";
      label = "Filled form";
      break;
    case "resize_window":
      browserTool = "resize";
      label = "Resized browser";
      break;
    case "upload_image":
      browserTool = "upload";
      label = "Uploaded file";
      break;
    case "gif_creator":
      browserTool = "trace";
      label = "Recorded browser GIF";
      break;
    case "read_page":
    case "get_page_text":
      label = "Read page";
      break;
    case "read_console_messages":
      label = "Read console";
      break;
    case "read_network_requests":
      label = "Read network requests";
      break;
    case "javascript_tool":
      label = "Ran browser script";
      break;
    case "browser_batch":
      label = "Used Chrome";
      break;
  }
  return {
    id: tool.id,
    tool: browserTool,
    label,
    phase,
    ...(url ? { url } : {}),
    ...(target ? { target } : {}),
    ...(semantic.detail ? { detail: semantic.detail } : {}),
    status: tool.status,
  };
}

/** OpenAI's native Browser plugin owns one verified `node_repl` server. Some
 * helper batches only summarize variables produced by the preceding browser
 * call and therefore carry neither Browser code nor result metadata. They are
 * Browser activity only while chronologically inside an already-open Browser
 * group; callers must not classify an isolated REPL calculation with this. */
export function isOfficialCodexNodeReplToolCall(
  tool: AgentToolMessage,
): boolean {
  return nativeCodexBrowserActivity(tool) !== null;
}

/** Structural identity only. Used after a Browser group is already proven so
 * URL-less helper writes remain in it without relabeling unrelated REPL work. */
export function isCodexNodeReplJsToolCall(tool: AgentToolMessage): boolean {
  if (tool.toolKind !== "mcp") return false;
  const input = record(tool.rawInput);
  const args = record(input.arguments);
  return (
    input.server === "node_repl" &&
    input.tool === "js" &&
    typeof args.code === "string"
  );
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function hostname(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.hostname
      : null;
  } catch {
    return null;
  }
}

function origin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** Keep completed transcript history bound to the URL recorded by that group.
 * A live session may have moved since an earlier row settled; its favicon is
 * safe to reuse for history only when the exact displayed origin still
 * matches. A running group follows the current live page by design. */
export function resolveBrowserActivityPresentation(
  actions: BrowserToolActivity[],
  running: boolean,
  session?: { url?: string; faviconDataUrl?: string } | null,
): BrowserActivityPresentation {
  let latestActionUrl: string | undefined;
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    if (actions[index]?.url) {
      latestActionUrl = actions[index]!.url;
      break;
    }
  }
  const actionHost = hostname(latestActionUrl);
  const liveHost = hostname(session?.url);
  const actionOrigin = origin(latestActionUrl);
  const liveOrigin = origin(session?.url);
  const host = running ? (liveHost ?? actionHost) : (actionHost ?? liveHost);
  const canUseLiveFavicon = running
    ? Boolean(liveOrigin)
    : Boolean(actionOrigin && actionOrigin === liveOrigin);
  return {
    host,
    ...(canUseLiveFavicon && session?.faviconDataUrl
      ? { faviconDataUrl: session.faviconDataUrl }
      : {}),
  };
}

/** Associate URL-less operations with the most recently opened/read URL in
 * their browser group. The initial connection has no site yet; once a page is
 * known, later page interactions retain that site identity. Icon selection is
 * still phase-aware, so connect/finalize rows use Browser-use artwork even
 * when an inherited URL is available. */
export function resolveBrowserActionUrls(
  actions: readonly BrowserToolActivity[],
): Array<string | undefined> {
  let currentUrl: string | undefined;
  return actions.map((action) => {
    if (action.url) currentUrl = action.url;
    return action.url ?? currentUrl;
  });
}

export function browserToolActivity(
  message: AgentMessage,
): BrowserToolActivity | null {
  if (message.kind !== "tool") return null;
  const toolMessage = message as AgentToolMessage;
  const native = nativeCodexBrowserActivity(toolMessage);
  if (native) return native;
  const claudeChrome = nativeClaudeChromeActivity(toolMessage);
  if (claudeChrome) return claudeChrome;
  const tool = toolIdentity(toolMessage);
  if (!tool) return null;
  const input = record(toolMessage.rawInput);
  // Codex's dynamic-item envelope carries `arguments`; Claude/Cursor expose
  // the same canonical call with the arguments as rawInput itself.
  const nestedArgs = record(input.arguments);
  const args = Object.keys(nestedArgs).length > 0 ? nestedArgs : input;
  // Snapshot tokens make refs safe to execute but are implementation noise in
  // the transcript. Keep only the short ordinal when describing a target.
  const ref =
    typeof args.ref === "string"
      ? args.ref.split("_", 1)[0]?.slice(0, 20)
      : undefined;
  const semantic = semanticResult(toolMessage);
  const url = semantic.url ?? safeUrl(args.url);
  const host = url ? new URL(url).hostname : undefined;
  const detail = semantic.detail;
  const labels: Record<BrowserToolName, string> = {
    open: "Opened",
    snapshot: "Read page",
    click: "Clicked",
    type: "Typed",
    scroll: "Scrolled",
    upload: "Uploaded file",
    resize: "Resized browser",
    back: "Went back",
    forward: "Went forward",
    reload: "Reloaded page",
    screenshot: "Captured screenshot",
    trace: "Saved browser trace",
    close: "Finished browser session",
  };
  return {
    id: toolMessage.id,
    tool,
    label: labels[tool],
    phase: tool === "close" ? "handoff" : "browse",
    ...(url ? { url } : {}),
    ...(host ? { target: host } : ref ? { target: ref } : {}),
    ...(detail ? { detail } : {}),
    status: toolMessage.status,
  };
}

function semanticResult(tool: AgentToolMessage): {
  detail?: string;
  url?: string;
} {
  let text: string | undefined;
  for (const item of tool.content ?? []) {
    const value = record(item);
    const content = record(value.content);
    if (content.type === "text" && typeof content.text === "string") {
      text = content.text;
      break;
    }
    if (value.type === "text" && typeof value.text === "string") {
      text = value.text;
      break;
    }
  }
  if (!text) {
    for (const item of Array.isArray(tool.rawOutput) ? tool.rawOutput : []) {
      const value = record(item);
      if (
        (value.type === "inputText" || value.type === "text") &&
        typeof value.text === "string"
      ) {
        text = value.text;
        break;
      }
    }
  }
  if (!text || text.length > 100_000) return {};
  try {
    const parsed = record(JSON.parse(text));
    const pieces: string[] = [];
    if (typeof parsed.title === "string" && parsed.title.trim()) {
      pieces.push(parsed.title.trim().replace(/\s+/g, " ").slice(0, 80));
    }
    if (Array.isArray(parsed.elements)) {
      pieces.push(
        `${parsed.elements.length} ${parsed.elements.length === 1 ? "element" : "elements"}`,
      );
    }
    const url = safeUrl(parsed.url);
    return {
      ...(pieces.length > 0 ? { detail: pieces.join(" · ") } : {}),
      ...(url ? { url } : {}),
    };
  } catch {
    if (tool.status !== "failed") return {};
    const normalized = text.trim().replace(/\s+/g, " ");
    // Show only known host-authored families. Unexpected Node/Electron errors
    // can contain local paths, so they collapse to a generic reason instead of
    // leaking their raw string into the transcript UI.
    return {
      detail:
        /^(?:Browser work was stopped|Browser use is disabled|Open a URL before|Opening this website was denied|The (?:browser|user|click|link|selected|isolated|input|file input)|Unknown or stale browser ref|Page navigation timed out|Browser action failed)/.test(
          normalized,
        )
          ? normalized.slice(0, 240)
          : "Browser action failed.",
    };
  }
}

/** Fold all Browser batches in one provider turn into a single nested activity
 * group while leaving narration and unrelated tools in their original order.
 * The group is inserted at the first Browser action; canonical messages remain
 * intact for counts, persistence, and expanded history. */
export function groupBrowserToolActivity(
  events: AgentMessage[],
  options: { closeTail?: boolean } = {},
): GroupedBrowserActivity[] {
  const grouped: GroupedBrowserActivity[] = [];
  let current: Extract<
    GroupedBrowserActivity,
    { kind: "browser-activity" }
  > | null = null;
  for (const event of events) {
    let action = browserToolActivity(event);
    if (
      !action &&
      current &&
      event.kind === "tool" &&
      isCodexNodeReplJsToolCall(event as AgentToolMessage)
    ) {
      action = nativeCodexBrowserActivity(event as AgentToolMessage, true);
    }
    if (!action || event.kind !== "tool") {
      if (current) current.closed = true;
      current = null;
      grouped.push({ kind: "event", id: event.id, event });
      continue;
    }
    if (!current) {
      current = {
        kind: "browser-activity",
        id: `browser-activity-${event.id}`,
        events: [],
        actions: [],
        closed: false,
      };
      grouped.push(current);
    }
    current.events.push(event as AgentToolMessage);
    current.actions.push(action);
  }
  if (current && options.closeTail === true) current.closed = true;
  return grouped;
}

/** Derive the settled working-group icon inventory from the same chronological
 * grouping used by the expanded transcript. This is deliberately not an
 * event-by-event semantic filter: URL-less node_repl helpers are Browser work
 * only because they sit inside a proven Browser batch, and must not reappear
 * as a stray MCP plug in the parent summary. */
export function partitionBrowserActivityForSummary(events: AgentMessage[]): {
  browserEvents: AgentToolMessage[];
  actions: BrowserToolActivity[];
  otherEvents: AgentMessage[];
} {
  const browserEvents: AgentToolMessage[] = [];
  const actions: BrowserToolActivity[] = [];
  const otherEvents: AgentMessage[] = [];
  for (const item of groupBrowserToolActivity(events)) {
    if (item.kind === "browser-activity") {
      browserEvents.push(...item.events);
      actions.push(...item.actions);
    } else {
      otherEvents.push(item.event);
    }
  }
  return { browserEvents, actions, otherEvents };
}

function nativeBrowserOutputCandidates(
  tool: AgentToolMessage,
): Record<string, unknown>[] {
  const output = record(tool.rawOutput);
  const result = record(output.result);
  return [output, result, record(output.raw), record(result.raw)];
}

function nativeBrowserResultUrl(tool: AgentToolMessage): string | undefined {
  for (const candidate of nativeBrowserOutputCandidates(tool)) {
    const meta = record(candidate._meta);
    const browserUse = record(meta.browser_use ?? meta.browserUse);
    const url = safeUrl(browserUse.url);
    if (url) return url;
  }
  return undefined;
}

function firstBrowserUrlInCode(value: string): string | undefined {
  for (const candidate of value.match(/https?:\/\/[^\s"'`<>\\)]+/giu) ?? []) {
    const url = safeUrl(candidate);
    if (url) return url;
  }
  return undefined;
}
