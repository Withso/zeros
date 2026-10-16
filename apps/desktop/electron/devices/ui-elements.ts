// The app on a simulator's screen, from AXe's accessibility tree: its name,
// its process and the elements people see and touch, in the app's upright
// points.

import {
  MAX_SIMULATOR_UI_ELEMENTS,
  type SimulatorUiElement,
  type SimulatorUiRect,
} from "@zeros/protocol/simulator-captures";

export interface ScreenElements {
  /** The front app as its accessibility tree names it. */
  appName: string | null;
  /** The front app's ID when the tree names it, as Android's does; an iOS
   * app's comes from its process. */
  appId: string | null;
  pid: number | null;
  /** The app's coordinate space, which its elements use. */
  space: { width: number; height: number } | null;
  elements: SimulatorUiElement[];
}

/** A password field, whatever the tree calls it; its value is never kept. */
export const SECURE_TEXT_FIELD = "SecureTextField";

const EMPTY: ScreenElements = { appName: null, appId: null, pid: null, space: null, elements: [] };
const MAX_TEXT = 200;
const MAX_TYPE = 60;
const MAX_COORDINATE = 10_000;
/** Nodes read from one tree, at most. */
export const MAX_TREE_NODES = 20_000;
/** Kinds that say nothing about the screen without text of their own. */
export const PLAIN_TYPES: ReadonlySet<string> = new Set([
  "Application",
  "Group",
  "Image",
  "Other",
  "ScrollArea",
  "StaticText",
  "Unknown",
  "Window",
]);
const DIRECTION_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** An element's words on one line, without direction marks, or null when
 * there are none. */
export function elementText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(DIRECTION_MARKS, "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function coordinate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE
    ? Math.round(value * 10) / 10
    : null;
}

function rect(value: unknown): SimulatorUiRect | null {
  const frame = plainRecord(value);
  const x = coordinate(frame?.x);
  const y = coordinate(frame?.y);
  const width = coordinate(frame?.width);
  const height = coordinate(frame?.height);
  if (x === null || y === null || width === null || height === null) return null;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function secure(node: Record<string, unknown>): boolean {
  return [node.type, node.role, node.subrole, node.role_description].some(
    (value) => typeof value === "string" && /secure/i.test(value),
  );
}

function element(node: Record<string, unknown>): SimulatorUiElement | null {
  const frame = rect(node.frame);
  if (!frame) return null;
  if (secure(node)) {
    return {
      type: SECURE_TEXT_FIELD,
      label: elementText(node.AXLabel),
      value: null,
      identifier: elementText(node.AXUniqueId),
      frame,
    };
  }
  const type = elementText(node.type, MAX_TYPE);
  if (!type) return null;
  const label = elementText(node.AXLabel);
  const value = elementText(node.AXValue);
  if (!label && !value && PLAIN_TYPES.has(type)) return null;
  return { type, label, value, identifier: elementText(node.AXUniqueId), frame };
}

/** Reads `axe describe-ui`. Elements keep the tree's order, back to front,
 * without repeats. */
export function readScreenElements(describeUi: string): ScreenElements {
  let parsed: unknown;
  try {
    parsed = JSON.parse(describeUi);
  } catch {
    return EMPTY;
  }
  const roots = (Array.isArray(parsed) ? parsed : [parsed])
    .map(plainRecord)
    .filter((root): root is Record<string, unknown> => root !== null);
  const app = roots[0];
  if (!app) return EMPTY;
  const pid = app.pid;
  const frame = rect(app.frame);
  const elements: SimulatorUiElement[] = [];
  const seen = new Set<string>();
  const stack = [...roots].reverse();
  let visited = 0;
  while (
    stack.length > 0 &&
    visited < MAX_TREE_NODES &&
    elements.length < MAX_SIMULATOR_UI_ELEMENTS
  ) {
    const node = stack.pop()!;
    visited += 1;
    const found = node === app ? null : element(node);
    if (found) {
      const { x, y, width, height } = found.frame;
      const key = [found.type, found.label, found.value, x, y, width, height].join("\u0000");
      if (!seen.has(key)) {
        seen.add(key);
        elements.push(found);
      }
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (let index = children.length - 1; index >= 0; index--) {
      const child = plainRecord(children[index]);
      if (child) stack.push(child);
    }
  }
  return {
    appName: elementText(app.AXLabel, 120),
    appId: null,
    pid: typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    space: frame ? { width: frame.width, height: frame.height } : null,
    elements,
  };
}
