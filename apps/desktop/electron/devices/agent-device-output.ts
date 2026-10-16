// What agents read from agent-device. Replies are rebuilt from its JSON so
// paths, log locations and its own diagnostics never reach them.

import {
  isSimulatorOrientation,
  type SimulatorOrientation,
  type SimulatorPlatform,
} from "@zeros/protocol/simulators";

import type { AgentDeviceFailure } from "./agent-device";

export interface DevicePoint {
  x: number;
  y: number;
}

export interface DeviceSpace {
  width: number;
  height: number;
}

export interface DeviceApp {
  name: string;
  bundleId: string;
}

const MAX_NODES = 400;
const MAX_LABEL = 160;
const MAX_INDENT = 8;
const MAX_APPS = 500;
const EDITABLE_KINDS = new Set(["text-field", "secure-text-field", "search", "text-view"]);
/** XCUIElementType values agent-device leaves unnamed. */
const XCUI_KINDS: Record<string, string> = { "19": "keyboard", "25": "status-bar", "44": "icon" };
/** Its iOS runner and the helpers it puts on Android devices. */
const OWN_APP = /^com\.callstack\.agentdevice\./i;
const APP_LINE = /^(.+?) \(([A-Za-z0-9_][A-Za-z0-9_.-]*)\)$/;
const REF_REASONS = new Set([
  "ref_frame_expired",
  "ref_generation_mismatch",
  "ref_not_issued",
  "ref_not_found",
]);

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanText(value: unknown, max = MAX_LABEL): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nodeKind(node: Record<string, unknown>): string {
  const kind =
    typeof node.kind === "string" && node.kind
      ? node.kind
      : typeof node.type === "string" && node.type
        ? node.type.toLowerCase()
        : "element";
  const code = /^element\((\d+)\)$/.exec(kind)?.[1];
  return (code && XCUI_KINDS[code]) || kind;
}

/** One line per element: `@e3 [button] "General"`, indented under its
 * parent. */
export function formatDeviceSnapshot(data: Record<string, unknown>): string {
  const nodes = (Array.isArray(data.nodes) ? data.nodes : []).flatMap((node) => {
    const record = plainRecord(node);
    return record && typeof record.ref === "string" && /^e\d{1,6}$/.test(record.ref)
      ? [record]
      : [];
  });
  const appName = cleanText(data.appName, 80);
  // An Android session is bound to no app; each element names its window's
  // package, and the app in front comes first.
  const bundleId =
    cleanText(data.appBundleId, 255) ??
    nodes.reduce<string | null>((found, node) => found ?? cleanText(node.bundleId, 255), null);
  const app =
    appName && bundleId && appName !== bundleId
      ? `${appName} (${bundleId})`
      : (bundleId ?? appName ?? "The app");
  const lines = [`${app}, ${nodes.length} element${nodes.length === 1 ? "" : "s"}:`];
  const levels = new Map<number, number>();
  for (const node of nodes.slice(0, MAX_NODES)) {
    const parentLevel =
      typeof node.parentIndex === "number" ? levels.get(node.parentIndex) : undefined;
    const level = parentLevel === undefined ? 0 : Math.min(parentLevel + 1, MAX_INDENT);
    if (typeof node.index === "number") levels.set(node.index, level);
    const kind = nodeKind(node);
    let line = `${"  ".repeat(level)}@${String(node.ref)} [${kind}]`;
    // An empty Android field reports its hint as its text.
    const hintShowing = node.hintShowing === true;
    const placeholder =
      cleanText(node.placeholder) ?? (hintShowing ? cleanText(node.value) : null);
    let label = cleanText(node.label);
    if (hintShowing && label === placeholder) label = null;
    if (label) line += ` ${JSON.stringify(label)}`;
    const value = hintShowing ? null : cleanText(node.value);
    if (value && value !== label) line += ` value=${JSON.stringify(value)}`;
    if (placeholder && placeholder !== label) {
      line += ` placeholder=${JSON.stringify(placeholder)}`;
    }
    const flags: string[] = [];
    const editable = node.editable === true || EDITABLE_KINDS.has(kind);
    if (editable) flags.push("editable");
    if (node.enabled === false) flags.push("disabled");
    // agent-device marks whole web regions focused; it matters only where
    // typing goes.
    if (editable && node.focused === true) flags.push("focused");
    if (node.hiddenContentAbove === true) flags.push("more above");
    if (node.hiddenContentBelow === true) flags.push("more below");
    if (flags.length > 0) line += ` (${flags.join(", ")})`;
    lines.push(line);
  }
  if (nodes.length > MAX_NODES) {
    lines.push(`…and ${nodes.length - MAX_NODES} more.`);
  }
  if (data.truncated === true) lines.push("The app's element tree was cut short.");
  const reasons = plainRecord(data.visibility)?.reasons;
  if (
    Array.isArray(reasons) &&
    (reasons.includes("scroll-hidden-above") || reasons.includes("scroll-hidden-below"))
  ) {
    lines.push("More content is off screen; scroll to reach it.");
  }
  const keyboard = plainRecord(data.keyboard)?.kind;
  if (typeof keyboard === "string" && keyboard !== "absent") {
    lines.push("The keyboard is showing.");
  }
  return lines.join("\n");
}

/** Installed apps, without agent-device's own. */
export function readInstalledApps(data: Record<string, unknown>): DeviceApp[] {
  const apps: DeviceApp[] = [];
  for (const entry of Array.isArray(data.apps) ? data.apps : []) {
    let app: DeviceApp | null = null;
    if (typeof entry === "string") {
      const match = APP_LINE.exec(entry.trim());
      if (match?.[1] && match[2]) app = { name: match[1], bundleId: match[2] };
    } else {
      const record = plainRecord(entry);
      const bundleId = record && (cleanText(record.bundleId, 255) ?? cleanText(record.id, 255));
      if (record && bundleId) {
        app = { name: cleanText(record.name, 120) ?? bundleId, bundleId };
      }
    }
    if (app && !OWN_APP.test(app.bundleId)) apps.push(app);
    if (apps.length >= MAX_APPS) break;
  }
  return apps;
}

export function formatInstalledApps(apps: DeviceApp[], deviceName: string, all: boolean): string {
  if (apps.length === 0) {
    return all
      ? `Zeros couldn't read the apps on ${deviceName}.`
      : `No apps of your own are installed on ${deviceName}. Pass all to include the built-in apps.`;
  }
  const lines = apps.map((app) =>
    app.name === app.bundleId ? `- ${app.bundleId}` : `- ${app.name} (${app.bundleId})`,
  );
  return [`Apps on ${deviceName}:`, ...lines].join("\n");
}

export function readSpace(data: Record<string, unknown>, keys: "screenshot" | "action"): DeviceSpace | null {
  const width = finite(keys === "screenshot" ? data.width : data.referenceWidth);
  const height = finite(keys === "screenshot" ? data.height : data.referenceHeight);
  return width !== null && height !== null && width > 0 && height > 0 ? { width, height } : null;
}

export function readDisplayRotation(data: Record<string, unknown>): SimulatorOrientation | null {
  return isSimulatorOrientation(data.displayRotation) ? data.displayRotation : null;
}

/** Where agent-device pressed, which for a ref is the element it resolved.
 * An Android pinch reports only where its fingers started, its center. */
export function readActionPoint(data: Record<string, unknown>): DevicePoint | null {
  const from = plainRecord(data.from);
  const x = finite(data.x) ?? finite(from?.x);
  const y = finite(data.y) ?? finite(from?.y);
  return x !== null && y !== null ? { x, y } : null;
}

/**
 * A point in the app's upright coordinates, as tools and screenshots use,
 * moved to the device's portrait screen, as the Simulator tab draws it. The
 * space is landscape only when the app turned with the device. Upside down
 * looks the same either way: iPad apps turn with the device, iPhone apps
 * don't.
 */
export function portraitPoint(
  point: DevicePoint,
  space: DeviceSpace | null,
  orientation: SimulatorOrientation | undefined,
  turnsUpsideDown = false,
): DevicePoint {
  if (!space) return point;
  const clamp = (mapped: DevicePoint, width: number, height: number): DevicePoint => ({
    x: Math.min(Math.max(mapped.x, 0), width),
    y: Math.min(Math.max(mapped.y, 0), height),
  });
  if (space.width <= space.height) {
    if (orientation !== "portrait-upside-down" || !turnsUpsideDown) return point;
    return clamp(
      { x: space.width - point.x, y: space.height - point.y },
      space.width,
      space.height,
    );
  }
  const width = space.height;
  const height = space.width;
  return clamp(
    orientation === "landscape-right"
      ? { x: point.y, y: height - point.x }
      : { x: width - point.y, y: point.x },
    width,
    height,
  );
}

/** portraitPoint the other way: a point on the portrait screen, as the
 * Simulator tab sends input, in the app's upright coordinates. */
export function uprightPoint(
  point: DevicePoint,
  space: DeviceSpace | null,
  orientation: SimulatorOrientation | undefined,
  turnsUpsideDown = false,
): DevicePoint {
  if (!space) return point;
  const clamp = (mapped: DevicePoint): DevicePoint => ({
    x: Math.min(Math.max(mapped.x, 0), space.width),
    y: Math.min(Math.max(mapped.y, 0), space.height),
  });
  if (space.width <= space.height) {
    if (orientation !== "portrait-upside-down" || !turnsUpsideDown) return point;
    return clamp({ x: space.width - point.x, y: space.height - point.y });
  }
  return clamp(
    orientation === "landscape-right"
      ? { x: space.width - point.y, y: point.x }
      : { x: point.y, y: space.height - point.x },
  );
}

/** Its own message when that is one short line naming no path. */
function plainMessage(message: string): string | null {
  const text = message.trim();
  if (!text || text.length > 300 || /[\r\n]/.test(text)) return null;
  if (/(^|[\s"'(=:])(~\/|\/[^\s/]+\/)/.test(text)) return null;
  return text;
}

export function deviceFailureText(
  failure: AgentDeviceFailure,
  deviceName: string,
  platform: SimulatorPlatform = "ios",
): string {
  if (failure.reason && REF_REASONS.has(failure.reason)) {
    return "That ref is from an older screen. Take a new snapshot and use its refs.";
  }
  switch (failure.reason) {
    case "ios_app_session_required":
      return "Open an app with launch_app or open_url first.";
    case "scroll_no_progress":
      return "The content didn't move; it may already be scrolled to the end.";
    case "scroll_keyboard_occludes_surface":
      return "The keyboard covers what you tried to scroll. Close the keyboard first.";
    default:
      break;
  }
  switch (failure.code) {
    case "UNAVAILABLE":
      return "This build of Zeros can't control simulators.";
    case "TIMEOUT":
      return `${deviceName} didn't respond in time. Try again.`;
    case "ABORTED":
      return "The simulator action was cancelled.";
    case "UNREADABLE":
      return `Zeros couldn't read ${deviceName}'s reply. Try again.`;
    case "DEVICE_IN_USE":
      return `Another automation tool is using ${deviceName}. End it and try again.`;
    case "DEVICE_NOT_FOUND":
      return `${deviceName} is no longer available. Call list_devices.`;
    case "APP_NOT_INSTALLED":
      return `That app isn't installed on ${deviceName}. Call list_apps.`;
    case "TEXT_INPUT_NOT_FOCUSED":
      return "No text field is focused. Tap one first, or pass its ref.";
    case "AMBIGUOUS_MATCH":
      return "That matches more than one element. Use a ref from a new snapshot.";
    case "TOOL_MISSING":
      return platform === "android"
        ? "The Android SDK's platform tools are missing, so Zeros can't control Android simulators."
        : "Xcode's command-line tools are missing, so Zeros can't control simulators.";
    case "SESSION_NOT_FOUND":
      return `Zeros lost its connection to ${deviceName}. Try again.`;
    default:
      return plainMessage(failure.message) ?? `The action on ${deviceName} failed.`;
  }
}
