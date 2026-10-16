// Zeros simulator tools for agents.
//
// Electron main owns DeviceHub, the agent-device runner, the per-device
// approvals and which chat uses which simulator. The engine serves the
// curated `zeros_device` tools to Claude, Codex and Cursor in Local
// workspaces while "Let agents use simulators" is on. Every action names one
// simulator by the ID `list_devices` returns; tool arguments never choose the
// runner session, its state or a configuration file.

import {
  agentControlName,
  isAgentControlFamily,
  isBrowserProductId,
  type AgentControlFamily,
  type BrowserJsonValue,
} from "./browser-tools";
import type { ConversationId, WorkspaceId } from "./identities";
import {
  MAX_SIMULATOR_PINCH,
  MIN_SIMULATOR_PINCH,
  SIMULATOR_BUTTONS,
  SIMULATOR_KEYS,
  SIMULATOR_ORIENTATIONS,
  isSimulatorDeviceId,
  isSimulatorPlatform,
  type SimulatorAppearance,
  type SimulatorButton,
  type SimulatorKey,
  type SimulatorOrientation,
  type SimulatorPlatform,
  type SimulatorSettings,
} from "./simulators";

export const DEVICE_TOOLS_SERVICE_VERSION = 1 as const;
export const DEVICE_TOOL_NAMESPACE = "zeros_device" as const;

export const DEVICE_TOOL_NAMES = [
  "list_devices",
  "boot_device",
  "list_apps",
  "install_app",
  "launch_app",
  "open_url",
  "snapshot",
  "screenshot",
  "tap",
  "type_text",
  "press_key",
  "swipe",
  "scroll",
  "pinch",
  "press_button",
  "rotate",
  "set_appearance",
] as const;

export type DeviceToolName = (typeof DEVICE_TOOL_NAMES)[number];

export const DEVICE_ORIENTATIONS = SIMULATOR_ORIENTATIONS;
export type DeviceOrientation = SimulatorOrientation;

export const DEVICE_SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type DeviceScrollDirection = (typeof DEVICE_SCROLL_DIRECTIONS)[number];

export interface DeviceToolDefinition {
  name: DeviceToolName;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, BrowserJsonValue>;
    required?: string[];
    additionalProperties: false;
  };
}

const MAX_TEXT = 2_000;
const MAX_POINT = 10_000;
const MAX_URL = 2_048;
const MAX_PATH = 4_096;
/** Snapshot refs such as `@e12`, optionally pinned to one snapshot (`@e12~s4`). */
export const DEVICE_ELEMENT_REF_PATTERN = "^@?e[0-9]{1,6}(?:~s[0-9]{1,12})?$" as const;
const ELEMENT_REF = new RegExp(DEVICE_ELEMENT_REF_PATTERN);
// Reverse-DNS iOS bundle IDs and Android package names. The first character
// is never "-", so an ID cannot read as a flag.
const APP_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/;
const URL_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]{0,31}):/;
const REFUSED_URL_SCHEMES = new Set(["file", "javascript", "data", "blob", "vbscript"]);

const DEVICE_ID = {
  type: "string",
  maxLength: 128,
  description: "Simulator ID from list_devices.",
} as const;
const ELEMENT_REF_PROPERTY = {
  type: "string",
  pattern: DEVICE_ELEMENT_REF_PATTERN,
  description:
    "Element ref such as @e3 from the latest snapshot. Refs expire when the screen changes.",
} as const;
const POINT = (axis: "X" | "Y") =>
  ({
    type: "number",
    minimum: 0,
    maximum: MAX_POINT,
    description: `${axis} in points of the latest screenshot.`,
  }) as const;

/** The `zeros_device` MCP tool list, advertised verbatim. */
export const DEVICE_TOOL_DEFINITIONS: readonly DeviceToolDefinition[] = [
  {
    name: "list_devices",
    description:
      "List the iOS and Android simulators on this Mac with their ID, name, OS and whether each is running. The first time you use a simulator in this chat, the user is asked to allow it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "boot_device",
    description:
      "Start a simulator that isn't running. The user is asked to allow it every time. Returns once it has started; Zeros shows it in a Simulator tab.",
    inputSchema: {
      type: "object",
      properties: { device_id: DEVICE_ID },
      required: ["device_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_apps",
    description:
      "List the apps installed on a running simulator, with bundle IDs (package names on Android). Pass all to include built-in apps.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: DEVICE_ID,
        all: { type: "boolean", description: "Include built-in apps. Default false." },
      },
      required: ["device_id"],
      additionalProperties: false,
    },
  },
  {
    name: "install_app",
    description:
      "Install an app on a running simulator: a .app bundle built for the iOS Simulator, such as one in Xcode's DerivedData, or an .apk on Android.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: DEVICE_ID,
        path: {
          type: "string",
          maxLength: MAX_PATH,
          description: "Absolute path of the .app bundle or .apk file on this Mac.",
        },
      },
      required: ["device_id", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "launch_app",
    description:
      "Open an installed app by bundle ID and bring it to the front. Pass relaunch to quit it first.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: DEVICE_ID,
        bundle_id: {
          type: "string",
          maxLength: 255,
          description:
            "Bundle ID from list_apps, such as com.apple.mobilesafari, or an Android package name such as com.android.settings.",
        },
        relaunch: { type: "boolean" },
      },
      required: ["device_id", "bundle_id"],
      additionalProperties: false,
    },
  },
  {
    name: "open_url",
    description:
      "Open a web address in the simulator's browser, or an app's deep link such as myapp://settings, on a running simulator.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: DEVICE_ID,
        url: { type: "string", maxLength: MAX_URL },
      },
      required: ["device_id", "url"],
      additionalProperties: false,
    },
  },
  {
    name: "snapshot",
    description:
      "List the on-screen elements of the app in front, or the home screen, with refs such as @e3 for tap and type_text. Lists interactive elements only unless all is true.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: DEVICE_ID,
        all: { type: "boolean", description: "List every element. Default false." },
      },
      required: ["device_id"],
      additionalProperties: false,
    },
  },
  {
    name: "screenshot",
    description:
      "Capture the simulator's screen in points. Use the image's x and y with tap, swipe and pinch.",
    inputSchema: {
      type: "object",
      properties: { device_id: DEVICE_ID },
      required: ["device_id"],
      additionalProperties: false,
    },
  },
  {
    name: "tap",
    description:
      "Tap an element by ref from the latest snapshot, or a point in the latest screenshot. hold_ms makes it a long press; count 2 double-taps.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: DEVICE_ID,
        ref: ELEMENT_REF_PROPERTY,
        x: POINT("X"),
        y: POINT("Y"),
        hold_ms: { type: "integer", minimum: 100, maximum: 10_000 },
        count: { type: "integer", minimum: 1, maximum: 2 },
      },
      required: ["device_id"],
      additionalProperties: false,
    },
  },
  {
    name: "type_text",
    description:
      "Type into the focused text field, or replace the text of the field a ref names.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: DEVICE_ID,
        text: { type: "string", maxLength: MAX_TEXT },
        ref: ELEMENT_REF_PROPERTY,
      },
      required: ["device_id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "press_key",
    description: "Press a keyboard key such as enter, backspace, tab or escape.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: DEVICE_ID,
        key: { type: "string", enum: [...SIMULATOR_KEYS] },
      },
      required: ["device_id", "key"],
      additionalProperties: false,
    },
  },
  {
    name: "swipe",
    description:
      "Swipe between two points in the latest screenshot. A longer duration_ms drags slowly.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: DEVICE_ID,
        from_x: POINT("X"),
        from_y: POINT("Y"),
        to_x: POINT("X"),
        to_y: POINT("Y"),
        duration_ms: { type: "integer", minimum: 50, maximum: 5_000 },
      },
      required: ["device_id", "from_x", "from_y", "to_x", "to_y"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description:
      "Scroll the screen's content up, down, left or right. amount is the share of the screen to move, from 0.1 to 0.8.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: DEVICE_ID,
        direction: { type: "string", enum: [...DEVICE_SCROLL_DIRECTIONS] },
        amount: { type: "number", minimum: 0.1, maximum: 0.8 },
      },
      required: ["device_id", "direction"],
      additionalProperties: false,
    },
  },
  {
    name: "pinch",
    description:
      "Pinch to zoom: scale above 1 zooms in and below 1 zooms out, around x and y or the screen's center.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: DEVICE_ID,
        scale: { type: "number", minimum: 0.1, maximum: 10 },
        x: POINT("X"),
        y: POINT("Y"),
      },
      required: ["device_id", "scale"],
      additionalProperties: false,
    },
  },
  {
    name: "press_button",
    description: "Press the simulator's Home or Lock button, or Back on Android.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: DEVICE_ID,
        button: { type: "string", enum: [...SIMULATOR_BUTTONS] },
      },
      required: ["device_id", "button"],
      additionalProperties: false,
    },
  },
  {
    name: "rotate",
    description: "Rotate the simulator.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: DEVICE_ID,
        orientation: { type: "string", enum: [...DEVICE_ORIENTATIONS] },
      },
      required: ["device_id", "orientation"],
      additionalProperties: false,
    },
  },
  {
    name: "set_appearance",
    description: "Switch the simulator between light and dark appearance.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: DEVICE_ID,
        appearance: { type: "string", enum: ["light", "dark"] },
      },
      required: ["device_id", "appearance"],
      additionalProperties: false,
    },
  },
] as const;

/** Which simulator tools an agent family gets in a Local workspace. Cloud
 * workspaces get none; callers check placement first. */
export type DeviceToolRoute = "off" | "zeros";

export function resolveDeviceToolRoute(
  agentFamily: string,
  settings: Pick<SimulatorSettings, "enabled">,
): DeviceToolRoute {
  return isAgentControlFamily(agentFamily) && settings.enabled ? "zeros" : "off";
}

/** The control bar's second half: "Codex" + "is using iPhone 17". */
export function deviceControlDetail(deviceName: string): string {
  return `is using ${deviceName}`;
}

export function isDeviceToolName(value: unknown): value is DeviceToolName {
  return (
    typeof value === "string" &&
    (DEVICE_TOOL_NAMES as readonly string[]).includes(value)
  );
}

export function isDeviceAppId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 255 && APP_ID.test(value);
}

/** A validated call. Main maps it onto DeviceHub and agent-device. */
export interface DeviceToolCall {
  tool: DeviceToolName;
  deviceId?: string;
  all?: boolean;
  path?: string;
  bundleId?: string;
  relaunch?: boolean;
  url?: string;
  /** Always with its leading "@". */
  ref?: string;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  holdMs?: number;
  count?: number;
  durationMs?: number;
  text?: string;
  key?: SimulatorKey;
  direction?: DeviceScrollDirection;
  amount?: number;
  scale?: number;
  button?: SimulatorButton;
  orientation?: DeviceOrientation;
  appearance?: SimulatorAppearance;
}

export type DeviceToolCallParse =
  | { ok: true; call: DeviceToolCall }
  | { ok: false; error: string };

const ALLOWED_ARGUMENTS: Record<DeviceToolName, readonly string[]> = {
  list_devices: [],
  boot_device: ["device_id"],
  list_apps: ["device_id", "all"],
  install_app: ["device_id", "path"],
  launch_app: ["device_id", "bundle_id", "relaunch"],
  open_url: ["device_id", "url"],
  snapshot: ["device_id", "all"],
  screenshot: ["device_id"],
  tap: ["device_id", "ref", "x", "y", "hold_ms", "count"],
  type_text: ["device_id", "text", "ref"],
  press_key: ["device_id", "key"],
  swipe: ["device_id", "from_x", "from_y", "to_x", "to_y", "duration_ms"],
  scroll: ["device_id", "direction", "amount"],
  pinch: ["device_id", "scale", "x", "y"],
  press_button: ["device_id", "button"],
  rotate: ["device_id", "orientation"],
  set_appearance: ["device_id", "appearance"],
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

function decimal(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail(`${key} must be a number from ${min} to ${max}.`);
  }
  return value;
}

function point(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_POINT) {
    fail(`${key} must be a position in points of the latest screenshot.`);
  }
  return Math.round(value);
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

function flag(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail(`${key} must be true or false.`);
  return value;
}

function hasControlCharacter(value: string, allowLineBreaks: boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (allowLineBreaks && (code === 0x0a || code === 0x09)) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function elementRef(value: unknown): string {
  if (typeof value !== "string" || !ELEMENT_REF.test(value)) {
    fail("ref must be an element ref such as @e3 from the latest snapshot.");
  }
  return value.startsWith("@") ? value : `@${value}`;
}

function openableUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_URL ||
    /\s/.test(value) ||
    hasControlCharacter(value, false)
  ) {
    fail(`url must be a web address or deep link of at most ${MAX_URL} characters.`);
  }
  const scheme = URL_SCHEME.exec(value)?.[1]?.toLowerCase();
  if (!scheme) fail("url needs a scheme, such as https:// or myapp://.");
  if (REFUSED_URL_SCHEMES.has(scheme)) fail(`${scheme}: URLs can't be opened on a simulator.`);
  if (scheme === "http" || scheme === "https") {
    try {
      new URL(value);
    } catch {
      fail("url is not a valid web address.");
    }
  }
  return value;
}

const APP_PATH_ERROR = "path must be the absolute path of a .app bundle or .apk file.";

/** A .app bundle is a folder, so a trailing slash is fine; an .apk is a
 * file and takes none. */
function appBundlePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > MAX_PATH ||
    hasControlCharacter(value, false)
  ) {
    fail(APP_PATH_ERROR);
  }
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  const trimmed = value.slice(0, end);
  const apk = /\.apk$/i.test(trimmed);
  if (
    (apk && trimmed !== value) ||
    !/\.(app|apk)$/i.test(trimmed) ||
    trimmed.split("/").includes("..")
  ) {
    fail(APP_PATH_ERROR);
  }
  return trimmed;
}

function parse(name: DeviceToolName, args: Record<string, unknown>): DeviceToolCall {
  for (const key of Object.keys(args)) {
    if (!ALLOWED_ARGUMENTS[name].includes(key)) fail(`Unknown argument: ${key}.`);
  }
  const call: DeviceToolCall = { tool: name };
  if (name === "list_devices") return call;
  if (!isSimulatorDeviceId(args.device_id)) {
    fail("device_id must be a simulator ID from list_devices.");
  }
  call.deviceId = args.device_id;
  switch (name) {
    case "boot_device":
    case "screenshot":
      return call;
    case "list_apps":
    case "snapshot": {
      if (flag(args, "all")) call.all = true;
      return call;
    }
    case "install_app":
      call.path = appBundlePath(args.path);
      return call;
    case "launch_app": {
      if (!isDeviceAppId(args.bundle_id)) {
        fail("bundle_id must be an app's bundle ID, such as com.apple.mobilesafari.");
      }
      call.bundleId = args.bundle_id;
      if (flag(args, "relaunch")) call.relaunch = true;
      return call;
    }
    case "open_url":
      call.url = openableUrl(args.url);
      return call;
    case "tap": {
      const x = point(args, "x");
      const y = point(args, "y");
      if ((x === undefined) !== (y === undefined)) fail("Pass x and y together.");
      if (args.ref !== undefined) {
        if (x !== undefined) fail("Pass ref or x and y, not both.");
        call.ref = elementRef(args.ref);
      } else if (x === undefined || y === undefined) {
        fail("Pass a ref from the latest snapshot, or x and y.");
      } else {
        call.x = x;
        call.y = y;
      }
      const holdMs = integer(args, "hold_ms", 100, 10_000);
      const count = integer(args, "count", 1, 2);
      if (holdMs !== undefined && count === 2) fail("A long press can't be a double-tap.");
      if (holdMs !== undefined) call.holdMs = holdMs;
      if (count === 2) call.count = 2;
      return call;
    }
    case "type_text": {
      if (typeof args.text !== "string" || args.text.length > MAX_TEXT) {
        fail(`text must be at most ${MAX_TEXT} characters.`);
      }
      if (hasControlCharacter(args.text, true)) {
        fail("text can't contain control characters other than new lines and tabs.");
      }
      if (args.ref === undefined && args.text.length === 0) fail("text is empty.");
      call.text = args.text;
      if (args.ref !== undefined) call.ref = elementRef(args.ref);
      return call;
    }
    case "press_key": {
      const key = oneOf(args, "key", SIMULATOR_KEYS);
      if (!key) fail("key is required.");
      call.key = key;
      return call;
    }
    case "swipe": {
      const fromX = point(args, "from_x");
      const fromY = point(args, "from_y");
      const toX = point(args, "to_x");
      const toY = point(args, "to_y");
      if (
        fromX === undefined ||
        fromY === undefined ||
        toX === undefined ||
        toY === undefined
      ) {
        fail("from_x, from_y, to_x and to_y are required.");
      }
      if (fromX === toX && fromY === toY) fail("A swipe needs two different points.");
      call.x = fromX;
      call.y = fromY;
      call.toX = toX;
      call.toY = toY;
      const durationMs = integer(args, "duration_ms", 50, 5_000);
      if (durationMs !== undefined) call.durationMs = durationMs;
      return call;
    }
    case "scroll": {
      const direction = oneOf(args, "direction", DEVICE_SCROLL_DIRECTIONS);
      if (!direction) fail("direction is required.");
      call.direction = direction;
      const amount = decimal(args, "amount", 0.1, 0.8);
      if (amount !== undefined) call.amount = Math.round(amount * 100) / 100;
      return call;
    }
    case "pinch": {
      const scale = decimal(args, "scale", 0.1, 10);
      if (scale === undefined) fail("scale is required.");
      if (scale === 1) fail("scale 1 would not zoom. Use above 1 to zoom in, below 1 to zoom out.");
      call.scale = Math.round(scale * 100) / 100;
      const x = point(args, "x");
      const y = point(args, "y");
      if ((x === undefined) !== (y === undefined)) fail("Pass x and y together.");
      if (x !== undefined && y !== undefined) {
        call.x = x;
        call.y = y;
      }
      return call;
    }
    case "press_button": {
      const button = oneOf(args, "button", SIMULATOR_BUTTONS);
      if (!button) fail("button is required.");
      call.button = button;
      return call;
    }
    case "rotate": {
      const orientation = oneOf(args, "orientation", DEVICE_ORIENTATIONS);
      if (!orientation) fail("orientation is required.");
      call.orientation = orientation;
      return call;
    }
    case "set_appearance": {
      const appearance = oneOf(args, "appearance", ["light", "dark"] as const);
      if (!appearance) fail("appearance is required.");
      call.appearance = appearance;
      return call;
    }
  }
  return fail("Unknown Zeros simulator tool.");
}

/** Validate untrusted tool arguments against the curated contract. Main runs
 * this again before anything reaches a simulator. */
export function parseDeviceToolCall(name: unknown, input: unknown): DeviceToolCallParse {
  if (!isDeviceToolName(name)) {
    return { ok: false, error: "Unknown Zeros simulator tool." };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Simulator tool arguments must be an object." };
  }
  try {
    return { ok: true, call: parse(name, input as Record<string, unknown>) };
  } catch (error) {
    if (error instanceof ArgumentError) return { ok: false, error: error.message };
    throw error;
  }
}

export interface DeviceUseOwner {
  workspaceId: WorkspaceId;
  conversationId: ConversationId;
}

export interface DeviceToolInvokeRequest {
  version: typeof DEVICE_TOOLS_SERVICE_VERSION;
  owner: DeviceUseOwner;
  agent: AgentControlFamily;
  /** A fresh ID per provider turn. After the user stops the agent on a
   * simulator, main refuses the rest of that turn there. */
  turnId: string;
  tool: DeviceToolName;
  arguments: BrowserJsonValue;
}

export type DeviceToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };

export interface DeviceToolResult {
  version: typeof DEVICE_TOOLS_SERVICE_VERSION;
  success: boolean;
  content: DeviceToolContent[];
}

/** Turn end, composer Stop and conversation retirement. `retire` also forgets
 * the chat's simulator approvals. */
export interface DeviceUseReleaseRequest {
  version: typeof DEVICE_TOOLS_SERVICE_VERSION;
  owner: DeviceUseOwner;
  reason: "turn-end" | "stop" | "retire";
}

export interface DeviceUseReleaseResponse {
  version: typeof DEVICE_TOOLS_SERVICE_VERSION;
  released: boolean;
}

/** A chat that is using one simulator right now. */
export interface DeviceUseHolder extends DeviceUseOwner {
  agent: AgentControlFamily;
  deviceId: string;
  deviceName: string;
  /** Which kind of Simulator tab shows the device. */
  platform: SimulatorPlatform;
}

/** Main → renderer: which chats use which simulators. */
export interface DeviceUseStateSnapshot {
  version: typeof DEVICE_TOOLS_SERVICE_VERSION;
  holders: DeviceUseHolder[];
}

const MAX_HOLDERS = 64;

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readDeviceUseState(value: unknown): DeviceUseStateSnapshot | null {
  const record = plainRecord(value);
  if (
    !record ||
    record.version !== DEVICE_TOOLS_SERVICE_VERSION ||
    !Array.isArray(record.holders) ||
    record.holders.length > MAX_HOLDERS
  ) {
    return null;
  }
  const holders: DeviceUseHolder[] = [];
  for (const raw of record.holders) {
    const entry = plainRecord(raw);
    if (
      !entry ||
      !isBrowserProductId(entry.workspaceId) ||
      !isBrowserProductId(entry.conversationId) ||
      !isAgentControlFamily(entry.agent) ||
      !isSimulatorDeviceId(entry.deviceId) ||
      typeof entry.deviceName !== "string" ||
      entry.deviceName.length === 0 ||
      entry.deviceName.length > 200 ||
      !isSimulatorPlatform(entry.platform)
    ) {
      return null;
    }
    holders.push({
      workspaceId: entry.workspaceId as WorkspaceId,
      conversationId: entry.conversationId as ConversationId,
      agent: entry.agent,
      deviceId: entry.deviceId,
      deviceName: entry.deviceName,
      platform: entry.platform,
    });
  }
  return { version: DEVICE_TOOLS_SERVICE_VERSION, holders };
}

/** The holder of one simulator, if any chat uses it. */
export function deviceUseHolder(
  state: DeviceUseStateSnapshot | null,
  deviceId: string,
): DeviceUseHolder | null {
  return state?.holders.find((holder) => holder.deviceId === deviceId) ?? null;
}

/** "Codex is using iPhone 17", for the Simulator tab's control bar. */
export function deviceUseTitle(holder: DeviceUseHolder): string {
  return `${agentControlName(holder.agent)} ${deviceControlDetail(holder.deviceName)}`;
}

export const DEVICE_AGENT_TOUCH_KINDS = [
  "tap",
  "double-tap",
  "long-press",
  "swipe",
  "pinch",
] as const;
export type DeviceAgentTouchKind = (typeof DEVICE_AGENT_TOUCH_KINDS)[number];

/** Main → renderer: where an agent touched, so the Simulator tab can show
 * it. Points are in the device's portrait screen points, as live-view input
 * is. */
export interface DeviceAgentTouch {
  deviceId: string;
  kind: DeviceAgentTouchKind;
  at: { x: number; y: number };
  /** Where a swipe ends. */
  to?: { x: number; y: number };
  /** How far a pinch zooms: above 1 spreads the fingers apart. */
  scale?: number;
}

function readTouchPoint(value: unknown): { x: number; y: number } | null {
  const record = plainRecord(value);
  const x = record?.x;
  const y = record?.y;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x > MAX_POINT ||
    y > MAX_POINT
  ) {
    return null;
  }
  return { x, y };
}

export function readDeviceAgentTouch(value: unknown): DeviceAgentTouch | null {
  const record = plainRecord(value);
  if (
    !record ||
    !isSimulatorDeviceId(record.deviceId) ||
    typeof record.kind !== "string" ||
    !(DEVICE_AGENT_TOUCH_KINDS as readonly string[]).includes(record.kind)
  ) {
    return null;
  }
  const at = readTouchPoint(record.at);
  if (!at) return null;
  const kind = record.kind as DeviceAgentTouchKind;
  if (kind === "swipe") {
    const to = readTouchPoint(record.to);
    return to ? { deviceId: record.deviceId, kind, at, to } : null;
  }
  if (kind === "pinch" && record.scale !== undefined) {
    const scale = record.scale;
    if (
      typeof scale !== "number" ||
      !Number.isFinite(scale) ||
      scale < MIN_SIMULATOR_PINCH ||
      scale > MAX_SIMULATOR_PINCH
    ) {
      return null;
    }
    return { deviceId: record.deviceId, kind, at, scale };
  }
  return { deviceId: record.deviceId, kind, at };
}
