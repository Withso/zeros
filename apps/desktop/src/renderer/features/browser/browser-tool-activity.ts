import {
  BROWSER_TOOL_NAMESPACE,
  isBrowserToolName,
  type BrowserToolName,
} from "@zeros/protocol/browser-tools";
import {
  COMPUTER_TOOL_NAMESPACE,
  isComputerToolName,
  type ComputerToolName,
} from "@zeros/protocol/computer-use-tools";
import {
  DEVICE_SCROLL_DIRECTIONS,
  DEVICE_TOOL_NAMESPACE,
  isDeviceAppId,
  isDeviceToolName,
  type DeviceToolName,
} from "@zeros/protocol/device-tools";

import type {
  AgentMessage,
  AgentToolMessage,
} from "../agent/use-agent-session";
import {
  nativeToolSurface,
  nativeToolTitle,
} from "../agent/renderers/native-tool-presentation";

/** What an agent was controlling. Each surface gets its own activity group. */
export type AgentControlSurface = "browser" | "computer" | "simulator";

export interface BrowserToolActivity {
  id: string;
  /** Absent means browser. Computer and simulator rows never inherit website
   * artwork. */
  surface?: AgentControlSurface;
  tool: BrowserToolName;
  label: string;
  phase: "connect" | "browse" | "handoff";
  target?: string;
  url?: string;
  detail?: string;
  status: AgentToolMessage["status"];
  surfaceScope?: string;
  external?: boolean;
  appId?: string;
  faviconUrl?: string;
}

export type GroupedBrowserActivity =
  | { kind: "event"; id: string; event: AgentMessage }
  | {
      kind: "browser-activity";
      id: string;
      surface: AgentControlSurface;
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
  activity: Pick<BrowserToolActivity, "phase" | "surface">,
): boolean {
  return (activity.surface ?? "browser") === "browser" && activity.phase === "browse";
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

export function browserActivityGroupLabel(
  surface: AgentControlSurface,
  status: BrowserActivityGroupStatus,
): string {
  if (surface === "computer") {
    return status === "browsing"
      ? "Using the computer"
      : status === "failed"
        ? "Computer use failed"
        : "Used the computer";
  }
  if (surface === "simulator") {
    return status === "browsing"
      ? "Using the simulator"
      : status === "failed"
        ? "Simulator use failed"
        : "Used the simulator";
  }
  return status === "browsing"
    ? "Browsing"
    : status === "failed"
      ? "Browser use failed"
      : "Used the browser";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** One Zeros-owned MCP server: its namespace, the qualified-name pattern
 * providers print, and the tool names it serves. */
interface ZerosToolServer<T extends string> {
  namespace: string;
  qualified: RegExp;
  isName: (value: unknown) => value is T;
}

function zerosToolServer<T extends string>(
  namespace: string,
  toolNameCharacters: string,
  isName: (value: unknown) => value is T,
): ZerosToolServer<T> {
  return {
    namespace,
    qualified: new RegExp(
      `(?:^|[/:._-])${namespace}[/:._-]+([${toolNameCharacters}]+)$`,
      "i",
    ),
    isName,
  };
}

const ZEROS_BROWSER_SERVER = zerosToolServer(
  BROWSER_TOOL_NAMESPACE,
  "a-z_-",
  isBrowserToolName,
);
const ZEROS_COMPUTER_SERVER = zerosToolServer(
  COMPUTER_TOOL_NAMESPACE,
  "a-z_",
  isComputerToolName,
);
const ZEROS_DEVICE_SERVER = zerosToolServer(
  DEVICE_TOOL_NAMESPACE,
  "a-z_",
  isDeviceToolName,
);

function qualifiedZerosTool<T extends string>(
  server: ZerosToolServer<T>,
  value: unknown,
): T | null {
  if (typeof value !== "string") return null;
  const match = server.qualified.exec(value.trim().replace(/^MCP\s+/, ""));
  return match && server.isName(match[1]) ? match[1] : null;
}

/** Codex reports server (or a dynamic-tool namespace) and tool; Claude reports
 * the qualified name as the title; Cursor reports providerIdentifier/toolName,
 * sometimes qualified. Explicit foreign server identity always wins over a
 * Zeros-looking title or tool name. */
function zerosToolName<T extends string>(
  server: ZerosToolServer<T>,
  tool: AgentToolMessage,
): T | null {
  const input = record(tool.rawInput);
  const reported = input.server ?? input.namespace;
  if (typeof reported === "string") {
    return reported === server.namespace && server.isName(input.tool)
      ? input.tool
      : null;
  }
  const provider = input.providerIdentifier;
  if (typeof provider === "string" && !provider.startsWith("mcp__")) {
    if (provider !== server.namespace) return null;
    return server.isName(input.toolName)
      ? input.toolName
      : qualifiedZerosTool(server, input.toolName);
  }
  for (const name of [input.toolName, provider, tool.title]) {
    const found = qualifiedZerosTool(server, name);
    if (found) return found;
  }
  return null;
}

function toolIdentity(tool: AgentToolMessage): BrowserToolName | null {
  return zerosToolName(ZEROS_BROWSER_SERVER, tool);
}

function nativeCodexBrowserActivity(
  tool: AgentToolMessage,
  assumeActiveBrowserBatch = false,
): BrowserToolActivity | null {
  const input = record(tool.rawInput);
  const unified =
    input.server === "cua_repl" &&
    input.tool === "js" &&
    tool.toolKind === "mcp";
  if (!unified && !isCodexNodeReplJsToolCall(tool)) return null;
  const surface = nativeToolSurface(tool);
  if (surface?.kind === "computer") return null;
  const args = record(input.arguments);
  const code = typeof args.code === "string" ? args.code : "";
  const nativeMetadata = nativeBrowserOutputCandidates(tool).some(
    (candidate) => record(candidate._meta)["codex/browserUse"] === true,
  );
  if (
    surface?.kind !== "browser" &&
    !nativeMetadata &&
    !assumeActiveBrowserBatch &&
    !/\b(?:setupBrowserRuntime|agent\.browsers|iab|playwright|dom_cua|claimTab|browserTab|crawlTab|tabs\.finalize)\b/.test(
      code,
    ) &&
    !/\.goto\s*\(/.test(code) &&
    !(
      unified && /\bcua\.(?:getTab|getBrowser|createBrowserTab)\s*\(/.test(code)
    )
  ) {
    return null;
  }
  const handoff = /\btabs\.finalize\s*\(/.test(code);
  const connectionOperation =
    (unified && /\bcua\.(?:getState|getBrowser|listTabs)\s*\(/.test(code)) ||
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
  const url =
    surface?.url ?? nativeBrowserResultUrl(tool) ?? firstBrowserUrlInCode(code);
  const host = hostname(url);
  return {
    id: tool.id,
    tool: handoff ? "close" : inferredNativeTool(code),
    label: title,
    phase,
    ...(url ? { url } : {}),
    ...(host ? { target: host } : {}),
    status: tool.status,
    ...(surface
      ? {
          surfaceScope: surface.scope,
          external: surface.external,
          appId: surface.appId,
          faviconUrl: surface.faviconUrl,
        }
      : unified
        ? { surfaceScope: "cua_repl:unknown", external: true }
        : {}),
  };
}

function inferredNativeTool(code: string): BrowserToolName {
  return /(?:\.goto\s*\(|Page\.navigate)/.test(code)
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
}

/** Codex's native computer use. Completed calls carry `codex/toolSurface`
 * metadata. While a call runs, its server decides: the dedicated computer-use
 * server always controls apps, and a unified `cua_repl` batch that is not
 * Browser work is computer use, as its single-row presentation assumes. All
 * apps share one scope so a burst stays one group while metadata arrives. */
function nativeCodexComputerActivity(
  tool: AgentToolMessage,
): BrowserToolActivity | null {
  if (tool.toolKind !== "mcp") return null;
  const input = record(tool.rawInput);
  const surface = nativeToolSurface(tool);
  if (surface?.kind === "browser") return null;
  if (
    !surface &&
    input.server !== "computer-use" &&
    !(
      input.server === "cua_repl" &&
      input.tool === "js" &&
      !nativeCodexBrowserActivity(tool)
    )
  ) {
    return null;
  }
  const code = record(input.arguments).code;
  return {
    id: tool.id,
    surface: "computer",
    tool: inferredNativeTool(typeof code === "string" ? code : ""),
    label: nativeToolTitle(tool) ?? "Use computer",
    phase: "browse",
    status: tool.status,
    surfaceScope: "computer",
    external: true,
    ...(surface?.appId ? { appId: surface.appId } : {}),
  };
}

/** Codex's envelopes carry `arguments` and Cursor's carry `args`; Claude
 * exposes the same canonical call with the arguments as rawInput itself. */
function zerosToolArguments(tool: AgentToolMessage): Record<string, unknown> {
  const input = record(tool.rawInput);
  const nestedArgs = record(input.arguments ?? input.args);
  return Object.keys(nestedArgs).length > 0 ? nestedArgs : input;
}

const ZEROS_COMPUTER_LABELS: Record<ComputerToolName, string> = {
  list_apps: "Listed apps",
  list_windows: "Listed windows",
  screenshot: "Captured screenshot",
  click: "Clicked",
  type_text: "Typed",
  press_key: "Pressed key",
  scroll: "Scrolled",
  drag: "Dragged",
  open_app: "Opened app",
};

/** BrowserToolActivity carries the browser tool enum for row icons; computer
 * calls map to the nearest one. */
const ZEROS_COMPUTER_TOOL_ICON: Record<ComputerToolName, BrowserToolName> = {
  list_apps: "snapshot",
  list_windows: "snapshot",
  screenshot: "screenshot",
  click: "click",
  type_text: "type",
  press_key: "key",
  scroll: "scroll",
  drag: "click",
  open_app: "open",
};

/** Zeros-owned computer use. Every provider family gets the same rows: an
 * `open_app` names its bundle ID (and earns the app's icon); a failure shows
 * only known host-authored sentences, never a raw driver error. */
function zerosComputerActivity(
  tool: AgentToolMessage,
): BrowserToolActivity | null {
  const computerTool = zerosToolName(ZEROS_COMPUTER_SERVER, tool);
  if (!computerTool) return null;
  const args = zerosToolArguments(tool);
  const bundleId =
    typeof args.bundle_id === "string" && args.bundle_id.length <= 255
      ? args.bundle_id
      : undefined;
  const detail = computerFailureText(tool);
  return {
    id: tool.id,
    surface: "computer",
    tool: ZEROS_COMPUTER_TOOL_ICON[computerTool],
    label: ZEROS_COMPUTER_LABELS[computerTool],
    phase: "browse",
    ...(bundleId ? { target: bundleId, appId: bundleId } : {}),
    ...(detail ? { detail } : {}),
    status: tool.status,
    surfaceScope: "computer",
    external: true,
  };
}

const KNOWN_COMPUTER_FAILURE =
  /^(?:Computer use\b|The user\b|Zeros needs\b)/;
const BLOCKED_APP_FAILURE = / is blocked in Settings > Computer use\.$/;

/** Failure reasons from the computer-use controller are short, authored
 * sentences. Driver or Node errors can contain local paths, so anything
 * unrecognized collapses to a generic reason. */
function computerFailureText(tool: AgentToolMessage): string | undefined {
  if (tool.status !== "failed") return undefined;
  const text = firstToolText(tool);
  if (!text) return undefined;
  const normalized = text.trim().replace(/\s+/g, " ");
  return KNOWN_COMPUTER_FAILURE.test(normalized) ||
    BLOCKED_APP_FAILURE.test(normalized)
    ? normalized.slice(0, 240)
    : "Computer action failed.";
}

const ZEROS_DEVICE_LABELS: Record<DeviceToolName, string> = {
  list_devices: "Listed simulators",
  boot_device: "Started simulator",
  list_apps: "Listed apps",
  install_app: "Installed app",
  launch_app: "Opened app",
  open_url: "Opened link",
  snapshot: "Read screen",
  screenshot: "Captured screenshot",
  tap: "Tapped",
  type_text: "Typed",
  press_key: "Pressed key",
  swipe: "Swiped",
  scroll: "Scrolled",
  pinch: "Pinched",
  press_button: "Pressed button",
  rotate: "Rotated simulator",
  set_appearance: "Changed appearance",
};

const ZEROS_DEVICE_TOOL_ICON: Record<DeviceToolName, BrowserToolName> = {
  list_devices: "snapshot",
  boot_device: "open",
  list_apps: "snapshot",
  install_app: "upload",
  launch_app: "open",
  open_url: "open",
  snapshot: "snapshot",
  screenshot: "screenshot",
  tap: "click",
  type_text: "type",
  press_key: "key",
  swipe: "scroll",
  scroll: "scroll",
  pinch: "resize",
  press_button: "click",
  rotate: "resize",
  set_appearance: "select",
};

/** Gesture rows say what happened ("Zoomed in"), not which tool ran. Unknown
 * argument values fall back to the tool's plain label. */
function zerosDeviceLabel(
  name: DeviceToolName,
  args: Record<string, unknown>,
): string {
  switch (name) {
    case "tap":
      if (args.count === 2) return "Double-tapped";
      if (typeof args.hold_ms === "number") return "Long-pressed";
      break;
    case "scroll":
      if ((DEVICE_SCROLL_DIRECTIONS as readonly unknown[]).includes(args.direction)) {
        return `Scrolled ${String(args.direction)}`;
      }
      break;
    case "pinch":
      if (typeof args.scale === "number" && args.scale !== 1) {
        return args.scale > 1 ? "Zoomed in" : "Zoomed out";
      }
      break;
    case "rotate":
      if (args.orientation === "portrait") return "Rotated to portrait";
      if (args.orientation === "portrait-upside-down") return "Rotated upside down";
      if (
        args.orientation === "landscape-left" ||
        args.orientation === "landscape-right"
      ) {
        return "Rotated to landscape";
      }
      break;
    case "set_appearance":
      if (args.appearance === "dark" || args.appearance === "light") {
        return `Switched to ${args.appearance} appearance`;
      }
      break;
    case "press_button":
      if (args.button === "home") return "Pressed the Home button";
      if (args.button === "lock") return "Pressed the side button";
      break;
  }
  return ZEROS_DEVICE_LABELS[name];
}

/** Zeros-owned simulator use. iOS bundle IDs name the row's target but never
 * select a Mac app icon, and rows carry no URL so website favicons stay out
 * of the simulator group. */
function zerosDeviceActivity(
  tool: AgentToolMessage,
): BrowserToolActivity | null {
  const deviceTool = zerosToolName(ZEROS_DEVICE_SERVER, tool);
  if (!deviceTool) return null;
  const args = zerosToolArguments(tool);
  const target =
    deviceTool === "launch_app" && isDeviceAppId(args.bundle_id)
      ? args.bundle_id
      : deviceTool === "open_url"
        ? (hostname(safeUrl(args.url)) ?? undefined)
        : undefined;
  return {
    id: tool.id,
    surface: "simulator",
    tool: ZEROS_DEVICE_TOOL_ICON[deviceTool],
    label: zerosDeviceLabel(deviceTool, args),
    phase: "browse",
    ...(target ? { target } : {}),
    status: tool.status,
    surfaceScope: "simulator",
    external: true,
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
  const external = actions.some((action) => action.external);
  if (external) session = null;
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
  const zerosComputer = zerosComputerActivity(toolMessage);
  if (zerosComputer) return zerosComputer;
  const zerosDevice = zerosDeviceActivity(toolMessage);
  if (zerosDevice) return zerosDevice;
  const tool = toolIdentity(toolMessage);
  if (!tool) return null;
  const args = zerosToolArguments(toolMessage);
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
    key: "Pressed key",
    select: "Chose option",
    wait: "Waited for page",
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

/** The first text a tool result carries, from either the content blocks or
 * the raw provider output. */
function firstToolText(tool: AgentToolMessage): string | undefined {
  for (const item of tool.content ?? []) {
    const value = record(item);
    const content = record(value.content);
    if (content.type === "text" && typeof content.text === "string") {
      return content.text;
    }
    if (value.type === "text" && typeof value.text === "string") {
      return value.text;
    }
  }
  for (const item of Array.isArray(tool.rawOutput) ? tool.rawOutput : []) {
    const value = record(item);
    if (
      (value.type === "inputText" || value.type === "text") &&
      typeof value.text === "string"
    ) {
      return value.text;
    }
  }
  return undefined;
}

function semanticResult(tool: AgentToolMessage): {
  detail?: string;
  url?: string;
} {
  const text = firstToolText(tool);
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

/** Fold Browser batches, and separately computer-use and simulator batches,
 * into nested activity groups while leaving narration and unrelated tools in their
 * original order. Each group is inserted at its first action; canonical
 * messages remain intact for counts, persistence, and expanded history. */
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
    let action =
      event.kind === "tool"
        ? (browserToolActivity(event) ??
          nativeCodexComputerActivity(event as AgentToolMessage))
        : null;
    if (
      !action &&
      current?.surface === "browser" &&
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
    const surface = action.surface ?? "browser";
    if (
      current &&
      (current.surface !== surface ||
        current.actions.at(-1)?.surfaceScope !== action.surfaceScope)
    ) {
      current.closed = true;
      current = null;
    }
    if (!current) {
      current = {
        kind: "browser-activity",
        id: `browser-activity-${event.id}`,
        surface,
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
 * as a stray MCP plug in the parent summary. Computer-use and simulator calls
 * stay with the other events so the summary keeps one icon per controlled app
 * or device. */
export function partitionBrowserActivityForSummary(events: AgentMessage[]): {
  browserEvents: AgentToolMessage[];
  actions: BrowserToolActivity[];
  otherEvents: AgentMessage[];
} {
  const browserEvents: AgentToolMessage[] = [];
  const actions: BrowserToolActivity[] = [];
  const otherEvents: AgentMessage[] = [];
  for (const item of groupBrowserToolActivity(events)) {
    if (item.kind === "browser-activity" && item.surface === "browser") {
      browserEvents.push(...item.events);
      actions.push(...item.actions);
    } else if (item.kind === "browser-activity") {
      otherEvents.push(...item.events);
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
