// Zeros computer-use contract.
//
// Electron main owns the Cua Driver host, each chat's driver session and the
// per-app leases that let chats work in different apps at once. The engine
// serves the curated `zeros_computer` tools to every agent, Codex included,
// when computer use is turned on. Every action addresses one app window by
// process ID; desktop-wide input, scripts and driver configuration are not
// part of this contract.

import {
  agentControlName,
  isAgentControlFamily,
  isBrowserProductId,
  type AgentControlFamily,
  type BrowserJsonValue,
} from "./browser-tools";
import type { ConversationId, WorkspaceId } from "./identities";

export const COMPUTER_USE_SERVICE_VERSION = 1 as const;
export const COMPUTER_TOOL_NAMESPACE = "zeros_computer" as const;
/** Cua element handles are scoped to one window snapshot: `s<8 hex>:<index>`. */
export const COMPUTER_ELEMENT_TOKEN_PATTERN = "^s[0-9a-f]{8}:[0-9]{1,6}$" as const;
const COMPUTER_ELEMENT_TOKEN = new RegExp(COMPUTER_ELEMENT_TOKEN_PATTERN);

export const COMPUTER_TOOL_NAMES = [
  "list_apps",
  "list_windows",
  "screenshot",
  "click",
  "type_text",
  "press_key",
  "scroll",
  "drag",
  "open_app",
  "open_url",
] as const;

export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number];

export const COMPUTER_MODIFIER_KEYS = [
  "cmd",
  "shift",
  "option",
  "ctrl",
  "fn",
] as const;
export type ComputerModifierKey = (typeof COMPUTER_MODIFIER_KEYS)[number];

export interface ComputerToolDefinition {
  name: ComputerToolName;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, BrowserJsonValue>;
    required?: string[];
    additionalProperties: false;
  };
}

const MAX_TEXT = 20_000;
const MAX_URL = 8_192;
const MAX_COORDINATE = 100_000;
const MAX_WINDOW_ID = 0xffff_ffff;
const MAX_PID = 0x7fff_ffff;

const PID = {
  type: "integer",
  minimum: 1,
  maximum: MAX_PID,
  description: "Process ID of the app, from list_apps or list_windows.",
} as const;
const WINDOW_ID = {
  type: "integer",
  minimum: 0,
  maximum: MAX_WINDOW_ID,
  description: "Window ID from list_windows.",
} as const;
const ELEMENT_TOKEN = {
  type: "string",
  pattern: COMPUTER_ELEMENT_TOKEN_PATTERN,
  description:
    "Element token from the latest screenshot of the window. A newer screenshot replaces earlier tokens.",
} as const;
const POINT = (axis: "X" | "Y") =>
  ({
    type: "number",
    minimum: 0,
    maximum: MAX_COORDINATE,
    description: `${axis} in pixels of the window's latest screenshot. Requires window_id.`,
  }) as const;
const MODIFIERS: BrowserJsonValue = {
  type: "array",
  items: { type: "string", enum: [...COMPUTER_MODIFIER_KEYS] },
  maxItems: COMPUTER_MODIFIER_KEYS.length,
  uniqueItems: true,
};

/** The `zeros_computer` MCP tool list, advertised verbatim. */
export const COMPUTER_TOOL_DEFINITIONS: readonly ComputerToolDefinition[] = [
  {
    name: "list_apps",
    description:
      "List Mac apps you can control, with name, bundle ID, process ID and whether each is running. Apps the user blocked are left out.",
    inputSchema: {
      type: "object",
      properties: {
        running_only: {
          type: "boolean",
          description: "Only list running apps. Default false.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_windows",
    description:
      "List on-screen windows of apps you can control, with window ID, process ID, app, title and bounds. Pass pid to list one app's windows.",
    inputSchema: {
      type: "object",
      properties: { pid: PID },
      additionalProperties: false,
    },
  },
  {
    name: "screenshot",
    description:
      "Capture one app window and list its accessibility elements. Pass element tokens from the latest screenshot of that window to click, type_text, press_key and scroll, or use x and y in the screenshot's pixels.",
    inputSchema: {
      type: "object",
      properties: {
        pid: PID,
        window_id: WINDOW_ID,
        query: {
          type: "string",
          maxLength: 200,
          description: "Only list elements whose role, label or value contain this text (one plain phrase, not a pattern).",
        },
        elements: {
          type: "boolean",
          description:
            "List accessibility elements. Default true; false returns only the image.",
        },
      },
      required: ["pid", "window_id"],
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description:
      'Click an element by token, or a point in the window\'s latest screenshot. Use button "right" for a context menu and count 2 for a double-click.',
    inputSchema: {
      type: "object",
      properties: {
        pid: PID,
        element_token: ELEMENT_TOKEN,
        window_id: WINDOW_ID,
        x: POINT("X"),
        y: POINT("Y"),
        button: { type: "string", enum: ["left", "right"] },
        count: { type: "integer", minimum: 1, maximum: 3 },
        modifiers: MODIFIERS,
      },
      required: ["pid"],
      additionalProperties: false,
    },
  },
  {
    name: "type_text",
    description:
      "Type text into an element by token, at a point in the window's latest screenshot, or into the app's focused field.",
    inputSchema: {
      type: "object",
      properties: {
        pid: PID,
        text: { type: "string", maxLength: MAX_TEXT },
        element_token: ELEMENT_TOKEN,
        window_id: WINDOW_ID,
        x: POINT("X"),
        y: POINT("Y"),
      },
      required: ["pid", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "press_key",
    description:
      'Press a key such as return, tab, escape, delete, up or a letter, with optional modifiers for shortcuts like cmd+s.',
    inputSchema: {
      type: "object",
      properties: {
        pid: PID,
        key: { type: "string", maxLength: 24 },
        modifiers: MODIFIERS,
        element_token: ELEMENT_TOKEN,
        window_id: WINDOW_ID,
      },
      required: ["pid", "key"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description:
      "Scroll at an element, at a point in the window's latest screenshot, or in the app's focused area.",
    inputSchema: {
      type: "object",
      properties: {
        pid: PID,
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "integer", minimum: 1, maximum: 50 },
        by: { type: "string", enum: ["line", "page"] },
        element_token: ELEMENT_TOKEN,
        window_id: WINDOW_ID,
        x: POINT("X"),
        y: POINT("Y"),
      },
      required: ["pid", "direction"],
      additionalProperties: false,
    },
  },
  {
    name: "drag",
    description:
      "Drag between two points in the window's latest screenshot. The window comes to the front for the drag.",
    inputSchema: {
      type: "object",
      properties: {
        pid: PID,
        window_id: WINDOW_ID,
        from_x: POINT("X"),
        from_y: POINT("Y"),
        to_x: POINT("X"),
        to_y: POINT("Y"),
      },
      required: ["pid", "window_id", "from_x", "from_y", "to_x", "to_y"],
      additionalProperties: false,
    },
  },
  {
    name: "open_app",
    description:
      "Open a Mac app by bundle ID without bringing it to the front.",
    inputSchema: {
      type: "object",
      properties: {
        bundle_id: {
          type: "string",
          maxLength: 255,
          description: "Bundle ID from list_apps, such as com.apple.TextEdit.",
        },
      },
      required: ["bundle_id"],
      additionalProperties: false,
    },
  },
  {
    name: "open_url",
    description:
      "Open an http or https URL in a Mac app by bundle ID, such as com.google.Chrome, without bringing it to the front. Faster than typing into the app's address bar.",
    inputSchema: {
      type: "object",
      properties: {
        bundle_id: {
          type: "string",
          maxLength: 255,
          description: "Bundle ID from list_apps, such as com.google.Chrome.",
        },
        url: { type: "string", maxLength: MAX_URL },
      },
      required: ["bundle_id", "url"],
      additionalProperties: false,
    },
  },
] as const;

/** Apps blocked until the user removes them in Settings > General.
 * Zeros itself is always blocked and never appears in this list. */
export const DEFAULT_COMPUTER_BLOCKED_APPS = [
  "com.apple.keychainaccess",
  "com.apple.Passwords",
  "com.apple.systempreferences",
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.bitwarden.desktop",
] as const;

const MAX_BLOCKED_APPS = 256;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export function isComputerBundleId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 255 && BUNDLE_ID.test(value)
  );
}

/** Bundle IDs compare case-insensitively, as Launch Services does. */
export function sameComputerBundleId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The `[computer_use]` settings table, normalized with the shipped defaults.
 * Every key has a row in Settings > General; retired keys (`app_access`,
 * `codex_native`) are ignored. */
export interface ComputerUseSettings {
  /** "Enable computer use": Zeros computer use for every agent, Codex
   * included. */
  enabled: boolean;
  /** "Show agent cursor", shared by computer use and the browser. */
  showAgentCursor: boolean;
  /** Bundle IDs no agent may observe or control. */
  blockedApps: string[];
}

export function computerUseSettings(raw: unknown): ComputerUseSettings {
  const table =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const flag = (key: string, fallback: boolean) =>
    typeof table[key] === "boolean" ? (table[key] as boolean) : fallback;
  const blockedApps: string[] = [];
  const listed = Array.isArray(table.blocked_apps)
    ? (table.blocked_apps as unknown[])
    : [...DEFAULT_COMPUTER_BLOCKED_APPS];
  for (const entry of listed) {
    if (blockedApps.length >= MAX_BLOCKED_APPS) break;
    const bundleId = typeof entry === "string" ? entry.trim() : entry;
    if (!isComputerBundleId(bundleId)) continue;
    if (blockedApps.some((known) => sameComputerBundleId(known, bundleId))) {
      continue;
    }
    blockedApps.push(bundleId);
  }
  return {
    enabled: flag("enabled", true),
    showAgentCursor: flag("show_agent_cursor", true),
    blockedApps,
  };
}

/** What Settings pushes to Electron main, which enforces it on every call. */
export interface ComputerUsePreferences {
  enabled: boolean;
  showAgentCursor: boolean;
  /** Zeros itself is always blocked as well. */
  blockedApps: string[];
}

/** Main reads the renderer's push strictly: one bad field rejects all of it,
 * so a malformed update never half-applies. Fields it does not know, such as
 * an older renderer's `appAccess`, are ignored. */
export function readComputerUsePreferences(
  value: unknown,
): ComputerUsePreferences | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.enabled !== "boolean" ||
    typeof record.showAgentCursor !== "boolean" ||
    !Array.isArray(record.blockedApps) ||
    record.blockedApps.length > MAX_BLOCKED_APPS ||
    !record.blockedApps.every(isComputerBundleId)
  ) {
    return null;
  }
  const blockedApps: string[] = [];
  for (const bundleId of record.blockedApps as string[]) {
    if (!blockedApps.some((known) => sameComputerBundleId(known, bundleId))) {
      blockedApps.push(bundleId);
    }
  }
  return {
    enabled: record.enabled,
    showAgentCursor: record.showAgentCursor,
    blockedApps,
  };
}

/** Main → Settings: whether this copy of Zeros can use the Mac, and which
 * macOS grants it has. */
export interface ComputerUseStatus {
  version: typeof COMPUTER_USE_SERVICE_VERSION;
  /** macOS, with the driver this build ships. */
  available: boolean;
  accessibility: boolean;
  screenRecording: boolean;
}

export function readComputerUseStatus(value: unknown): ComputerUseStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== COMPUTER_USE_SERVICE_VERSION ||
    typeof record.available !== "boolean" ||
    typeof record.accessibility !== "boolean" ||
    typeof record.screenRecording !== "boolean"
  ) {
    return null;
  }
  return {
    version: COMPUTER_USE_SERVICE_VERSION,
    available: record.available,
    accessibility: record.accessibility,
    screenRecording: record.screenRecording,
  };
}

/** Which computer use an agent family gets in a Local workspace. Cloud
 * workspaces get none; callers check placement first. Codex never uses its
 * built-in computer use: one path keeps blocked apps, the control bar, Stop
 * and parallel chats the same for every agent. */
export type ComputerUseRoute = "off" | "zeros";

export function resolveComputerUseRoute(
  agentFamily: string,
  settings: ComputerUseSettings,
): ComputerUseRoute {
  switch (agentFamily) {
    case "codex":
    case "claude":
    case "cursor":
      return settings.enabled ? "zeros" : "off";
    default:
      return "off";
  }
}

/** The control bar's second half: "Codex" + "is using Safari". */
export function computerControlDetail(appName: string | null): string {
  return appName ? `is using ${appName}` : "is using your Mac";
}

export function isComputerToolName(value: unknown): value is ComputerToolName {
  return (
    typeof value === "string" &&
    (COMPUTER_TOOL_NAMES as readonly string[]).includes(value)
  );
}

export function isComputerElementToken(value: unknown): value is string {
  return typeof value === "string" && COMPUTER_ELEMENT_TOKEN.test(value);
}

/** A validated call. Main maps it onto the driver; tool arguments never pick
 * the session, the desktop scope or the delivery mode. */
export interface ComputerToolCall {
  tool: ComputerToolName;
  pid?: number;
  windowId?: number;
  elementToken?: string;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  text?: string;
  key?: string;
  modifiers?: ComputerModifierKey[];
  button?: "left" | "right";
  count?: number;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  by?: "line" | "page";
  query?: string;
  elements?: boolean;
  runningOnly?: boolean;
  bundleId?: string;
  url?: string;
}

export type ComputerToolCallParse =
  | { ok: true; call: ComputerToolCall }
  | { ok: false; error: string };

const ALLOWED_ARGUMENTS: Record<ComputerToolName, readonly string[]> = {
  list_apps: ["running_only"],
  list_windows: ["pid"],
  screenshot: ["pid", "window_id", "query", "elements"],
  click: [
    "pid",
    "element_token",
    "window_id",
    "x",
    "y",
    "button",
    "count",
    "modifiers",
  ],
  type_text: ["pid", "text", "element_token", "window_id", "x", "y"],
  press_key: ["pid", "key", "modifiers", "element_token", "window_id"],
  scroll: [
    "pid",
    "direction",
    "amount",
    "by",
    "element_token",
    "window_id",
    "x",
    "y",
  ],
  drag: ["pid", "window_id", "from_x", "from_y", "to_x", "to_y"],
  open_app: ["bundle_id"],
  open_url: ["bundle_id", "url"],
};

class ArgumentError extends Error {}

function fail(message: string): never {
  throw new ArgumentError(message);
}

function integer(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    fail(`${key} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function coordinate(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_COORDINATE
  ) {
    fail(`${key} must be a pixel position in the window's screenshot.`);
  }
  return value;
}

function oneOf<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    fail(`${key} must be one of: ${values.join(", ")}.`);
  }
  return value as T;
}

function modifiers(
  args: Record<string, unknown>,
): ComputerModifierKey[] | undefined {
  const value = args.modifiers;
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > COMPUTER_MODIFIER_KEYS.length ||
    new Set(value).size !== value.length ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        !(COMPUTER_MODIFIER_KEYS as readonly string[]).includes(entry),
    )
  ) {
    fail(`modifiers must list distinct keys from: ${COMPUTER_MODIFIER_KEYS.join(", ")}.`);
  }
  return value as ComputerModifierKey[];
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || code === 0x7f) return true;
  }
  return false;
}

/** Only web pages: a `file:` or custom scheme URL could launch arbitrary
 * handlers outside the app the user allowed. */
function webUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_URL || hasControlCharacter(value)) {
    fail(`url must be an http or https URL of at most ${MAX_URL} characters.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail("url must be an http or https URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("url must be an http or https URL.");
  }
  if (parsed.username || parsed.password) fail("url cannot contain credentials.");
  return parsed.href;
}

// Named keys (return, tab, f5, page_down) or one printable character.
const KEY_NAME = /^(?:[A-Za-z][A-Za-z0-9_]{0,23}|[!-~])$/;

function target(
  call: ComputerToolCall,
  args: Record<string, unknown>,
  required: boolean,
): void {
  const token = args.element_token;
  if (token !== undefined) {
    if (!isComputerElementToken(token)) {
      fail("element_token must come from the latest screenshot of the window.");
    }
    call.elementToken = token;
  }
  const windowId = integer(args, "window_id", 0, MAX_WINDOW_ID);
  if (windowId !== undefined) call.windowId = windowId;
  const x = coordinate(args, "x");
  const y = coordinate(args, "y");
  if ((x === undefined) !== (y === undefined)) fail("Pass x and y together.");
  if (x !== undefined && y !== undefined) {
    if (call.elementToken) fail("Pass element_token or x and y, not both.");
    if (windowId === undefined) fail("x and y need the window_id of the screenshot.");
    call.x = x;
    call.y = y;
  }
  if (required && !call.elementToken && call.x === undefined) {
    fail("Pass element_token, or window_id with x and y.");
  }
}

function parse(name: ComputerToolName, args: Record<string, unknown>): ComputerToolCall {
  for (const key of Object.keys(args)) {
    if (!ALLOWED_ARGUMENTS[name].includes(key)) fail(`Unknown argument: ${key}.`);
  }
  const call: ComputerToolCall = { tool: name };
  if (name === "open_app" || name === "open_url") {
    if (!isComputerBundleId(args.bundle_id)) {
      fail("bundle_id must be an app bundle ID such as com.apple.TextEdit.");
    }
    call.bundleId = args.bundle_id;
    if (name === "open_url") call.url = webUrl(args.url);
    return call;
  }
  if (name === "list_apps") {
    if (args.running_only !== undefined) {
      if (typeof args.running_only !== "boolean") fail("running_only must be true or false.");
      if (args.running_only) call.runningOnly = true;
    }
    return call;
  }
  const pid = integer(args, "pid", 1, MAX_PID);
  if (name === "list_windows") {
    if (pid !== undefined) call.pid = pid;
    return call;
  }
  if (pid === undefined) fail("pid is required.");
  call.pid = pid;
  switch (name) {
    case "screenshot": {
      const windowId = integer(args, "window_id", 0, MAX_WINDOW_ID);
      if (windowId === undefined) fail("window_id is required.");
      call.windowId = windowId;
      if (args.query !== undefined) {
        if (typeof args.query !== "string" || args.query.length > 200) {
          fail("query must be text of at most 200 characters.");
        }
        if (args.query.trim()) call.query = args.query.trim();
      }
      if (args.elements !== undefined) {
        if (typeof args.elements !== "boolean") fail("elements must be true or false.");
        if (!args.elements) call.elements = false;
      }
      return call;
    }
    case "click": {
      target(call, args, true);
      const button = oneOf(args, "button", ["left", "right"] as const);
      if (button) call.button = button;
      const count = integer(args, "count", 1, 3);
      if (count !== undefined) call.count = count;
      const keys = modifiers(args);
      if (keys) call.modifiers = keys;
      return call;
    }
    case "type_text": {
      if (typeof args.text !== "string" || args.text.length > MAX_TEXT) {
        fail(`text must be at most ${MAX_TEXT} characters.`);
      }
      if (hasControlCharacter(args.text)) fail("text cannot contain NUL or DEL characters.");
      call.text = args.text;
      target(call, args, false);
      return call;
    }
    case "press_key": {
      if (typeof args.key !== "string" || !KEY_NAME.test(args.key)) {
        fail("key must be a key name such as return, tab or escape, or one character.");
      }
      call.key = args.key;
      const keys = modifiers(args);
      if (keys) call.modifiers = keys;
      if (args.element_token !== undefined) {
        if (!isComputerElementToken(args.element_token)) {
          fail("element_token must come from the latest screenshot of the window.");
        }
        call.elementToken = args.element_token;
      }
      const windowId = integer(args, "window_id", 0, MAX_WINDOW_ID);
      if (windowId !== undefined) call.windowId = windowId;
      return call;
    }
    case "scroll": {
      const direction = oneOf(args, "direction", ["up", "down", "left", "right"] as const);
      if (!direction) fail("direction is required.");
      call.direction = direction;
      const amount = integer(args, "amount", 1, 50);
      if (amount !== undefined) call.amount = amount;
      const by = oneOf(args, "by", ["line", "page"] as const);
      if (by) call.by = by;
      target(call, args, false);
      return call;
    }
    case "drag": {
      const windowId = integer(args, "window_id", 0, MAX_WINDOW_ID);
      if (windowId === undefined) fail("window_id is required.");
      call.windowId = windowId;
      const fromX = coordinate(args, "from_x");
      const fromY = coordinate(args, "from_y");
      const toX = coordinate(args, "to_x");
      const toY = coordinate(args, "to_y");
      if (
        fromX === undefined ||
        fromY === undefined ||
        toX === undefined ||
        toY === undefined
      ) {
        fail("from_x, from_y, to_x and to_y are required.");
      }
      call.x = fromX;
      call.y = fromY;
      call.toX = toX;
      call.toY = toY;
      return call;
    }
  }
  return fail("Unknown Zeros computer tool.");
}

/** Validate untrusted tool arguments against the curated contract. Main runs
 * this again before anything reaches the driver. */
export function parseComputerToolCall(
  name: unknown,
  input: unknown,
): ComputerToolCallParse {
  if (!isComputerToolName(name)) {
    return { ok: false, error: "Unknown Zeros computer tool." };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Computer tool arguments must be an object." };
  }
  try {
    return { ok: true, call: parse(name, input as Record<string, unknown>) };
  } catch (error) {
    if (error instanceof ArgumentError) return { ok: false, error: error.message };
    throw error;
  }
}

export interface ComputerUseOwner {
  workspaceId: WorkspaceId;
  conversationId: ConversationId;
}

export interface ComputerToolInvokeRequest {
  version: typeof COMPUTER_USE_SERVICE_VERSION;
  owner: ComputerUseOwner;
  agent: AgentControlFamily;
  /** A fresh ID per provider turn. After the user stops computer use, main
   * refuses the rest of that turn without blocking the chat's next one. */
  turnId: string;
  tool: ComputerToolName;
  arguments: BrowserJsonValue;
}

export type ComputerToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };

export interface ComputerToolResult {
  version: typeof COMPUTER_USE_SERVICE_VERSION;
  success: boolean;
  content: ComputerToolContent[];
}

/** Turn end, composer Stop and conversation retirement. `retire` also forgets
 * the chat's app approvals. */
export interface ComputerUseReleaseRequest {
  version: typeof COMPUTER_USE_SERVICE_VERSION;
  owner: ComputerUseOwner;
  reason: "turn-end" | "stop" | "retire";
}

export interface ComputerUseReleaseResponse {
  version: typeof COMPUTER_USE_SERVICE_VERSION;
  released: boolean;
}

/** A chat that is using the computer right now. */
export interface ComputerUseHolder extends ComputerUseOwner {
  agent: AgentControlFamily;
  /** The app it controls, once known. */
  app: string | null;
}

export interface ComputerUseWaiter extends ComputerUseOwner {
  agent: AgentControlFamily;
  /** The app it waits for. Main before parallel computer use sends none. */
  app?: string | null;
}

/** Main → renderer: who uses the computer and which chats wait for it. */
export interface ComputerUseStateSnapshot {
  version: typeof COMPUTER_USE_SERVICE_VERSION;
  holders: ComputerUseHolder[];
  waiting: ComputerUseWaiter[];
}

const MAX_STATE_ENTRIES = 64;

function readOwnerEntry(value: unknown): ComputerUseWaiter | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    !isBrowserProductId(entry.workspaceId) ||
    !isBrowserProductId(entry.conversationId) ||
    !isAgentControlFamily(entry.agent)
  ) {
    return null;
  }
  return {
    workspaceId: entry.workspaceId as WorkspaceId,
    conversationId: entry.conversationId as ConversationId,
    agent: entry.agent,
  };
}

export function readComputerUseState(
  value: unknown,
): ComputerUseStateSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== COMPUTER_USE_SERVICE_VERSION ||
    !Array.isArray(record.holders) ||
    !Array.isArray(record.waiting) ||
    record.holders.length > MAX_STATE_ENTRIES ||
    record.waiting.length > MAX_STATE_ENTRIES
  ) {
    return null;
  }
  const holders: ComputerUseHolder[] = [];
  for (const raw of record.holders) {
    const owner = readOwnerEntry(raw);
    const entry = raw as Record<string, unknown>;
    // An older main's `native` flag is ignored: Codex's built-in computer
    // use is disabled, so every holder is a Zeros chat.
    if (
      !owner ||
      (entry.app !== null &&
        (typeof entry.app !== "string" || entry.app.length > 200))
    ) {
      return null;
    }
    holders.push({
      ...owner,
      app: entry.app as string | null,
    });
  }
  const waiting: ComputerUseWaiter[] = [];
  for (const raw of record.waiting) {
    const owner = readOwnerEntry(raw);
    if (!owner) return null;
    const app = (raw as Record<string, unknown>).app;
    if (app === undefined) {
      waiting.push(owner);
      continue;
    }
    if (app !== null && (typeof app !== "string" || app.length > 200)) return null;
    waiting.push({ ...owner, app });
  }
  return { version: COMPUTER_USE_SERVICE_VERSION, holders, waiting };
}

/** The tool row's reason while a chat waits, or null when it does not. */
export function computerUseWaitText(
  state: ComputerUseStateSnapshot | null,
  conversationId: string,
): string | null {
  const waiter = state?.waiting.find((entry) => entry.conversationId === conversationId);
  if (!state || !waiter) return null;
  const others = state.holders.filter(
    (entry) => entry.conversationId !== conversationId,
  );
  // Chats wait per app.
  const holder = waiter.app
    ? others.find((entry) => entry.app === waiter.app)
    : others[0];
  if (holder && waiter.app) {
    return `Waiting for ${agentControlName(holder.agent)} in another chat to finish using ${waiter.app}`;
  }
  if (holder) {
    return `Waiting for ${agentControlName(holder.agent)} in another chat to finish using the computer`;
  }
  return waiter.app
    ? `Waiting for another chat to finish using ${waiter.app}`
    : "Waiting for another chat to finish using the computer";
}
