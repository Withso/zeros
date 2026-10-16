// The app on an Android device's screen, from `uiautomator dump`: its
// package and the elements people see and touch, in points of the screen
// as it is turned. Element types use the iOS names, so timelines and marks
// read the same on both.

import {
  MAX_SIMULATOR_UI_ELEMENTS,
  type SimulatorUiElement,
} from "@zeros/protocol/simulator-captures";
import type { SimulatorScreen } from "@zeros/protocol/simulators";

import {
  MAX_TREE_NODES,
  PLAIN_TYPES,
  SECURE_TEXT_FIELD,
  elementText,
  type ScreenElements,
} from "./ui-elements";

interface UiNode {
  attributes: Map<string, string>;
  parent: number;
  /** Words from inside it, for a control that has none of its own. */
  inner: string[];
}

const TAG = /<(\/?)(hierarchy|node)\b((?:[^>"]|"[^"]*")*?)(\/?)>/g;
const ATTRIBUTE = /([A-Za-z][\w:.-]*)="([^"]*)"/g;
const BOUNDS = /^\[(-?\d{1,6}),(-?\d{1,6})\]\[(-?\d{1,6}),(-?\d{1,6})\]$/;
const PACKAGE = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/;
const MAX_INNER = 2;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,4});/gi, (entity, name: string) => {
    if (name[0] !== "#") return ENTITIES[name] ?? entity;
    const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

function attributesOf(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) attributes.set(match[1]!, decode(match[2]!));
  return attributes;
}

function flag(node: UiNode, name: string): boolean {
  return node.attributes.get(name) === "true";
}

/** Clicking, holding or checking it does something; its words name it. */
function actionable(node: UiNode): boolean {
  return flag(node, "clickable") || flag(node, "long-clickable") || flag(node, "checkable");
}

function ownWords(node: UiNode): string | null {
  return elementText(node.attributes.get("content-desc")) ?? elementText(node.attributes.get("text"));
}

/** The iOS name for an Android view, from its class and what it does. */
export function androidElementType(className: string, clickable: boolean, checkable: boolean): string {
  const name = className.slice(className.lastIndexOf(".") + 1);
  if (/EditText$|AutoCompleteTextView$/.test(name)) return "TextField";
  if (/Switch|ToggleButton$/.test(name)) return "Switch";
  if (/CheckBox$|CheckedTextView$/.test(name)) return "CheckBox";
  if (/RadioButton$/.test(name)) return "RadioButton";
  if (/SeekBar$|Slider$|RatingBar$/.test(name)) return "Slider";
  if (/ProgressBar$|ProgressIndicator$/.test(name)) return "ProgressIndicator";
  if (/Spinner$/.test(name)) return "PopUpButton";
  if (/Button$/.test(name)) return "Button";
  if (/WebView$/.test(name)) return "WebView";
  if (/Toolbar$|ActionBar$/.test(name)) return "Toolbar";
  if (/TabWidget$|TabLayout$|NavigationBarView$|BottomNavigationView$/.test(name)) return "TabBar";
  if (checkable) return "CheckBox";
  if (clickable) return "Button";
  if (/TextView$/.test(name)) return "StaticText";
  if (/ImageView$/.test(name)) return "Image";
  if (/ScrollView$|RecyclerView$|ListView$|GridView$|ViewPager2?$/.test(name)) return "ScrollArea";
  return "Group";
}

function frameOf(bounds: string | undefined, scale: number): SimulatorUiElement["frame"] | null {
  const match = bounds ? BOUNDS.exec(bounds) : null;
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1, 5).map(Number) as [number, number, number, number];
  // A view scrolled out of its parent reports bounds that end before they
  // start.
  if (right <= left || bottom <= top) return null;
  const point = (value: number) => Math.round((value / scale) * 10) / 10;
  return {
    x: point(left),
    y: point(top),
    width: point(right - left),
    height: point(bottom - top),
  };
}

function element(node: UiNode, scale: number): SimulatorUiElement | null {
  const frame = frameOf(node.attributes.get("bounds"), scale);
  if (!frame) return null;
  const identifier = elementText(node.attributes.get("resource-id"));
  const description = elementText(node.attributes.get("content-desc"));
  const hint = elementText(node.attributes.get("hint"));
  const text = elementText(node.attributes.get("text"));
  const checkable = flag(node, "checkable");
  const type = androidElementType(
    node.attributes.get("class") ?? "",
    flag(node, "clickable") || flag(node, "long-clickable"),
    checkable,
  );
  if (flag(node, "password")) {
    return { type: SECURE_TEXT_FIELD, label: description ?? hint, value: null, identifier, frame };
  }
  if (type === "TextField") {
    // An empty field reports its hint as its text.
    return {
      type,
      label: description ?? hint,
      value: text && text !== hint ? text : null,
      identifier,
      frame,
    };
  }
  const label =
    description ??
    text ??
    (actionable(node) && node.inner.length > 0 ? node.inner.join(", ") : null);
  const value = checkable
    ? flag(node, "checked")
      ? "1"
      : "0"
    : description && text && text !== description
      ? text
      : null;
  if (!label && !checkable && PLAIN_TYPES.has(type)) return null;
  return { type, label, value, identifier, frame };
}

/**
 * Reads `uiautomator dump`. Its bounds are pixels of the screen as it is
 * turned; elements keep the tree's order, back to front, without repeats.
 */
export function readAndroidScreenElements(
  dump: string,
  screen: Pick<SimulatorScreen, "widthPx" | "heightPx" | "scale">,
): ScreenElements {
  const end = dump.lastIndexOf("</hierarchy>");
  const xml = end < 0 ? dump : dump.slice(0, end + "</hierarchy>".length);
  const nodes: UiNode[] = [];
  const open: number[] = [];
  let rotation: number | null = null;
  for (const match of xml.matchAll(TAG)) {
    const [, closing, tag, source, selfClosing] = match;
    if (tag === "hierarchy") {
      if (!closing) rotation = Number(attributesOf(source!).get("rotation") ?? 0) || 0;
      continue;
    }
    if (closing) {
      open.pop();
      continue;
    }
    if (nodes.length >= MAX_TREE_NODES) break;
    nodes.push({ attributes: attributesOf(source!), parent: open.at(-1) ?? -1, inner: [] });
    if (!selfClosing) open.push(nodes.length - 1);
  }
  if (rotation === null) {
    return { appName: null, appId: null, pid: null, space: null, elements: [] };
  }
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    const words = ownWords(node);
    if (!words || actionable(node)) continue;
    for (let parent = node.parent; parent >= 0; parent = nodes[parent]!.parent) {
      const ancestor = nodes[parent]!;
      if (actionable(ancestor)) {
        if (ancestor.inner.length < MAX_INNER && !ownWords(ancestor)) ancestor.inner.push(words);
        break;
      }
    }
  }
  const elements: SimulatorUiElement[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (elements.length >= MAX_SIMULATOR_UI_ELEMENTS) break;
    const found = element(node, screen.scale);
    if (!found) continue;
    const { x, y, width, height } = found.frame;
    const key = [found.type, found.label, found.value, x, y, width, height].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push(found);
  }
  const sideways = rotation % 2 === 1;
  const appId = nodes[0]?.attributes.get("package");
  return {
    appName: null,
    appId: appId && appId.length <= 200 && PACKAGE.test(appId) ? appId : null,
    pid: null,
    space: {
      width: (sideways ? screen.heightPx : screen.widthPx) / screen.scale,
      height: (sideways ? screen.widthPx : screen.heightPx) / screen.scale,
    },
    elements,
  };
}
