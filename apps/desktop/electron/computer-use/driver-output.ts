// Reads Cua Driver tool output and turns it into what the agent sees.
//
// The driver returns agent-oriented text plus a structured JSON document. The
// agent only receives text and images over MCP, so element tokens, which exist
// only in the structured document, are rendered here. Every reader is bounded
// and skips records it does not understand.

import {
  isComputerBundleId,
  type ComputerToolContent,
} from "@zeros/protocol/computer-use-tools";

import type { ComputerDriverResult } from "./ports";

export interface ComputerApp {
  name: string;
  bundleId: string;
  /** 0 when the app is installed but not running. */
  pid: number;
  running: boolean;
}

export interface ComputerWindow {
  windowId: number;
  pid: number;
  appName: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  onScreen: boolean;
}

const MAX_RECORDS = 2_000;
const MAX_LISTED_APPS = 400;
const MAX_LISTED_WINDOWS = 200;
const MAX_ELEMENT_LINES = 600;
const MAX_TEXT = 40_000;
const MAX_ACTION_TEXT = 4_000;
const MAX_NAME = 200;

/** The driver names its own tools in hints; the agent knows ours. */
const TOOL_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bget_window_state\b/g, "screenshot"],
  [/\blaunch_app\b/g, "open_app"],
];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max = MAX_NAME): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex -- driver text strips C0 and DEL
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bounded(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n… (truncated)` : value;
}

/** Driver prose with tool names rewritten for the agent. */
export function agentText(value: string, max = MAX_ACTION_TEXT): string {
  let result = value;
  for (const [pattern, replacement] of TOOL_ALIASES) {
    result = result.replace(pattern, replacement);
  }
  return bounded(result.trim(), max);
}

export function readApps(result: ComputerDriverResult): ComputerApp[] {
  const raw = result.structured?.apps;
  if (!Array.isArray(raw)) return [];
  const apps: ComputerApp[] = [];
  for (const entry of raw.slice(0, MAX_RECORDS)) {
    const app = record(entry);
    if (!app) continue;
    const name = text(app.name);
    const pid = count(app.pid);
    if (
      !name ||
      !isComputerBundleId(app.bundle_id) ||
      pid === null ||
      typeof app.running !== "boolean"
    ) {
      continue;
    }
    apps.push({
      name,
      bundleId: app.bundle_id,
      pid: app.running ? pid : 0,
      running: app.running && pid > 0,
    });
  }
  return apps;
}

export function readWindows(result: ComputerDriverResult): ComputerWindow[] {
  const raw = result.structured?.windows;
  if (!Array.isArray(raw)) return [];
  const windows: ComputerWindow[] = [];
  for (const entry of raw.slice(0, MAX_RECORDS)) {
    const window = record(entry);
    if (!window) continue;
    const windowId = count(window.window_id);
    const pid = count(window.pid);
    if (windowId === null || pid === null || pid === 0) continue;
    const box = record(window.bounds);
    const x = finite(box?.x);
    const y = finite(box?.y);
    const width = finite(box?.width);
    const height = finite(box?.height);
    windows.push({
      windowId,
      pid,
      appName: text(window.app_name) ?? "",
      title: text(window.title) ?? "",
      bounds:
        x !== null && y !== null && width !== null && height !== null
          ? { x, y, width, height }
          : null,
      onScreen: window.is_on_screen !== false,
    });
  }
  return windows;
}

export function formatApps(apps: readonly ComputerApp[]): string {
  if (apps.length === 0) return "No apps you can control were found.";
  const running = apps.filter((app) => app.running);
  const installed = apps.filter((app) => !app.running);
  const lines: string[] = [];
  let listed = 0;
  if (running.length) {
    lines.push("Running:");
    for (const app of running) {
      if (listed >= MAX_LISTED_APPS) break;
      lines.push(`- ${app.name} (pid ${app.pid}) ${app.bundleId}`);
      listed += 1;
    }
  }
  if (installed.length && listed < MAX_LISTED_APPS) {
    lines.push("Installed, not running (open with open_app):");
    for (const app of installed) {
      if (listed >= MAX_LISTED_APPS) break;
      lines.push(`- ${app.name} ${app.bundleId}`);
      listed += 1;
    }
  }
  if (listed < apps.length) {
    lines.push(`… ${apps.length - listed} more not shown.`);
  }
  return lines.join("\n");
}

export function formatWindows(windows: readonly ComputerWindow[]): string {
  if (windows.length === 0) {
    return "No windows of apps you can control are on screen.";
  }
  const lines = windows.slice(0, MAX_LISTED_WINDOWS).map((window) => {
    const title = window.title ? ` "${window.title}"` : "";
    const box = window.bounds
      ? ` at ${Math.round(window.bounds.x)},${Math.round(window.bounds.y)} size ${Math.round(window.bounds.width)}×${Math.round(window.bounds.height)}`
      : "";
    return `- window ${window.windowId}: ${window.appName || "App"} (pid ${window.pid})${title}${box}`;
  });
  if (windows.length > MAX_LISTED_WINDOWS) {
    lines.push(`… ${windows.length - MAX_LISTED_WINDOWS} more not shown.`);
  }
  return lines.join("\n");
}

function elementLine(element: Record<string, unknown>): string | null {
  const token = text(element.element_token, 32);
  const role = text(element.role, 64) ?? "element";
  const label = text(element.label);
  const value = text(element.value);
  const depth = Math.min(count(element.depth) ?? 0, 12);
  const parts = [token ?? "-", role];
  if (label) parts.push(JSON.stringify(label));
  if (value && value !== label) parts.push(`value=${JSON.stringify(value)}`);
  if (element.enabled === false) parts.push("disabled");
  if (element.selected === true) parts.push("selected");
  return `${"  ".repeat(depth)}${parts.join(" ")}`;
}

/** The screenshot tool's text: the window, the image's pixel space and its
 * elements with tokens. */
export function formatWindowState(
  result: ComputerDriverResult,
  appName: string,
): string {
  const state = result.structured;
  const lines: string[] = [];
  const title = text(state?.window_title);
  const windowId = count(state?.window_id);
  lines.push(
    `${appName}${title ? ` — "${title}"` : ""}${windowId !== null ? ` (window ${windowId})` : ""}`,
  );
  const width = count(state?.screenshot_width);
  const height = count(state?.screenshot_height);
  if (width && height) {
    lines.push(
      `Screenshot ${width}×${height}. x and y for click, type_text and scroll are pixels in this image.`,
    );
  }
  const elements = Array.isArray(state?.elements) ? state.elements : null;
  if (!elements) {
    const fallback = agentText(result.text, MAX_TEXT);
    if (fallback) lines.push(fallback);
    return bounded(lines.join("\n"), MAX_TEXT);
  }
  if (elements.length === 0) {
    lines.push("No accessibility elements matched.");
  } else {
    lines.push("Elements (pass element_token to act on one):");
    let shown = 0;
    for (const entry of elements) {
      if (shown >= MAX_ELEMENT_LINES) break;
      const element = record(entry);
      const line = element ? elementLine(element) : null;
      if (!line) continue;
      lines.push(line);
      shown += 1;
    }
    if (elements.length > shown) {
      lines.push(
        `… ${elements.length - shown} more elements. Pass query to narrow the list.`,
      );
    }
  }
  if (state?.truncated === true || state?.elements_complete === false) {
    lines.push("The element list is partial. Pass query to narrow it.");
  }
  return bounded(lines.join("\n"), MAX_TEXT);
}

/** Driver images the agent can read: PNG and JPEG only. */
export function agentImages(
  result: ComputerDriverResult,
): ComputerToolContent[] {
  const images: ComputerToolContent[] = [];
  for (const image of result.images.slice(0, 2)) {
    const mimeType = image.mimeType.toLowerCase();
    if (
      (mimeType === "image/png" || mimeType === "image/jpeg") &&
      image.data.length > 0
    ) {
      images.push({ type: "image", data: image.data, mimeType });
    }
  }
  return images;
}

/** Text for a failed driver call, preferring the driver's own guidance. */
export function driverFailureText(result: ComputerDriverResult): string {
  const message = agentText(result.text);
  if (message) return message;
  const structuredError = text(result.structured?.error);
  if (structuredError) return structuredError;
  return result.errorCode
    ? `The action failed (${result.errorCode}).`
    : "The action failed.";
}
