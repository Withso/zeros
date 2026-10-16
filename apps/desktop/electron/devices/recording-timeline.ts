// What happened during a simulator recording, worded for the timeline a
// recording brings into a chat, such as `00:03.2 tap Button "Sign in"`.

import {
  MAX_SIMULATOR_RECORDING_ACTIONS,
  simulatorElementName,
  simulatorElementsAt,
  type SimulatorRecordingAction,
  type SimulatorUiElement,
} from "@zeros/protocol/simulator-captures";
import type {
  SimulatorAppearance,
  SimulatorButton,
  SimulatorInput,
  SimulatorKey,
  SimulatorOrientation,
  SimulatorPoint,
} from "@zeros/protocol/simulators";

import { uprightPoint, type DeviceSpace } from "./agent-device-output";

/**
 * Something the user or an agent did. Points are in the app's upright
 * points, as agents use them, unless `portrait` says they're on the portrait
 * screen, as the Simulator tab sends them.
 */
export type RecordedAction =
  | {
      kind: "tap" | "double-tap" | "long-press";
      at: SimulatorPoint | null;
      portrait?: boolean;
      /** What the agent named instead of a point, such as `@e5`. */
      target?: string;
    }
  | { kind: "swipe"; from: SimulatorPoint; to: SimulatorPoint; portrait?: boolean }
  | { kind: "text"; text: string }
  | { kind: "key"; key: SimulatorKey }
  | { kind: "button"; button: SimulatorButton }
  | { kind: "pinch"; scale: number }
  | { kind: "scroll"; direction: "up" | "down" | "left" | "right" }
  | { kind: "rotate"; orientation: SimulatorOrientation }
  | { kind: "appearance"; appearance: SimulatorAppearance }
  | { kind: "open"; target: string }
  | { kind: "install"; app: string };

/** What the user did on the Simulator tab, which sends portrait points. */
export function recordedInput(input: SimulatorInput): RecordedAction {
  switch (input.kind) {
    case "tap":
      return { kind: "tap", at: input.at, portrait: true };
    case "drag":
      // The tab sends a long press as a drag that ends where it began.
      return input.from.x === input.to.x && input.from.y === input.to.y
        ? { kind: "long-press", at: input.from, portrait: true }
        : { kind: "swipe", from: input.from, to: input.to, portrait: true };
    case "text":
      return { kind: "text", text: input.text };
    case "key":
      return { kind: "key", key: input.key };
    case "button":
      return { kind: "button", button: input.button };
    case "pinch":
      return { kind: "pinch", scale: input.scale };
  }
}

/** The screen as it was just before the action, when Zeros knows it. */
export interface ScreenBefore {
  /** The app's upright coordinate space. */
  space: DeviceSpace | null;
  elements: readonly SimulatorUiElement[];
}

export interface ActionContext {
  orientation: SimulatorOrientation;
  screen: ScreenBefore | null;
  /** Typing is counted, not quoted: a password field may have it. */
  maskTyping?: boolean;
}

const KEY_NAMES: Record<SimulatorKey, string> = {
  enter: "Return",
  backspace: "Delete",
  delete: "Forward Delete",
  tab: "Tab",
  escape: "Escape",
  space: "Space",
  "arrow-up": "Up Arrow",
  "arrow-down": "Down Arrow",
  "arrow-left": "Left Arrow",
  "arrow-right": "Right Arrow",
};

const BUTTON_NAMES: Record<SimulatorButton, string> = {
  home: "Home",
  lock: "Lock",
  back: "Back",
};

const MAX_TYPED = 80;
const MAX_TARGET = 120;
/** A swipe shorter than this, in points, is too small to have a direction. */
const MIN_SWIPE = 8;

function quoted(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return `"${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}"`;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function round(point: SimulatorPoint): string {
  return `${Math.round(point.x)}, ${Math.round(point.y)}`;
}

function upright(point: SimulatorPoint, portrait: boolean | undefined, context: ActionContext) {
  if (!portrait) return point;
  const { orientation } = context;
  return uprightPoint(
    point,
    context.screen?.space ?? null,
    orientation,
    orientation === "portrait-upside-down",
  );
}

function elementAt(point: SimulatorPoint, context: ActionContext): string | null {
  const screen = context.screen;
  if (!screen) return null;
  const [element] = simulatorElementsAt(screen.elements, point);
  return element ? simulatorElementName(element) : null;
}

function direction(from: SimulatorPoint, to: SimulatorPoint): string | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < MIN_SWIPE) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

/** The timeline's words for an action. */
export function describeAction(action: RecordedAction, context: ActionContext): string {
  switch (action.kind) {
    case "tap":
    case "double-tap":
    case "long-press": {
      const at = action.at ? upright(action.at, action.portrait, context) : null;
      const name = at ? elementAt(at, context) : null;
      if (name) return `${action.kind} ${name}`;
      if (action.target) return `${action.kind} ${clip(action.target, MAX_TARGET)}`;
      return at ? `${action.kind} at ${round(at)}` : action.kind;
    }
    case "swipe": {
      const from = upright(action.from, action.portrait, context);
      const to = upright(action.to, action.portrait, context);
      const way = direction(from, to);
      const on = elementAt(from, context);
      if (!way) return on ? `drag ${on}` : `drag at ${round(from)}`;
      return on ? `swipe ${way} on ${on}` : `swipe ${way} from ${round(from)}`;
    }
    case "text": {
      if (!context.maskTyping) return `type ${quoted(action.text, MAX_TYPED)}`;
      const count = [...action.text].length;
      return `type ${count} ${count === 1 ? "character" : "characters"}`;
    }
    case "key":
      return `press ${KEY_NAMES[action.key]}`;
    case "button":
      return `press ${BUTTON_NAMES[action.button]}`;
    case "pinch":
      return action.scale > 1 ? "zoom in" : "zoom out";
    case "scroll":
      return `scroll ${action.direction}`;
    case "rotate":
      return `rotate to ${action.orientation.replace(/-/g, " ")}`;
    case "appearance":
      return `switch to ${action.appearance} appearance`;
    case "open":
      return `open ${clip(action.target, MAX_TARGET)}`;
    case "install":
      return `install ${clip(action.app, MAX_TARGET)}`;
  }
}

/** Typing within this of the same person's last typing extends it. */
export const TYPING_MERGE_MS = 2_000;

/** One recording's actions, in order, from its first frame. */
export class RecordingLog {
  private readonly entries: SimulatorRecordingAction[] = [];
  private typing: {
    index: number;
    agent: string | null;
    at: number;
    text: string;
    masked: boolean;
  } | null = null;

  constructor(private readonly startedAt: number) {}

  note(at: number, agent: string | null, action: RecordedAction, context: ActionContext): void {
    if (action.kind === "text") {
      const typing = this.typing;
      if (
        typing &&
        typing.agent === agent &&
        typing.index === this.entries.length - 1 &&
        at - typing.at <= TYPING_MERGE_MS
      ) {
        typing.text += action.text;
        typing.at = at;
        typing.masked ||= context.maskTyping === true;
        this.entries[typing.index] = {
          ...this.entries[typing.index]!,
          text: describeAction(
            { kind: "text", text: typing.text },
            { ...context, maskTyping: typing.masked },
          ),
        };
        return;
      }
    }
    if (this.entries.length >= MAX_SIMULATOR_RECORDING_ACTIONS) return;
    this.entries.push({
      atMs: Math.max(0, Math.round(at - this.startedAt)),
      agent,
      text: describeAction(action, context),
    });
    this.typing =
      action.kind === "text"
        ? {
            index: this.entries.length - 1,
            agent,
            at,
            text: action.text,
            masked: context.maskTyping === true,
          }
        : null;
  }

  actions(): SimulatorRecordingAction[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}
