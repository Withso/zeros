export type DesignFillType = "solid" | "gradient" | "image";

export interface DesignGradientValue {
  type: "linear" | "radial" | "conic";
  angle: number;
  start: string;
  end: string;
  startPosition?: string;
  endPosition?: string;
  repeating?: boolean;
}

export const DEFAULT_DESIGN_GRADIENT: Readonly<DesignGradientValue> =
  Object.freeze({
    type: "linear",
    angle: 180,
    start: "transparent",
    end: "currentColor",
    startPosition: "0%",
    endPosition: "100%",
    repeating: false,
  });

export function classifyDesignFill(backgroundImage: string): DesignFillType {
  const value = backgroundImage.trim().toLocaleLowerCase();
  if (/^(?:repeating-)?(?:linear|radial|conic)-gradient\(/.test(value)) {
    return "gradient";
  }
  return /^url\(/.test(value) ? "image" : "solid";
}

function splitTopLevel(value: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth < 0) return null;
    }
    if (character === "," && depth === 0) {
      if (!current.trim()) return null;
      parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (quote || depth !== 0 || !current.trim()) return null;
  parts.push(current.trim());
  return parts;
}

const STOP_POSITION =
  /^(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|px|r?em|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pt|pc)?|(?:calc|min|max|clamp)\(.+\))$/i;

function lastTopLevelWhitespace(value: string): number {
  let depth = 0;
  let quote = "";
  let splitAt = -1;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (/\s/.test(character) && depth === 0) splitAt = index;
  }
  return splitAt;
}

function parseStop(
  value: string,
  fallbackPosition: string,
): { color: string; position: string } | null {
  const splitAt = lastTopLevelWhitespace(value);
  const possiblePosition = splitAt >= 0 ? value.slice(splitAt).trim() : "";
  const hasPosition = STOP_POSITION.test(possiblePosition);
  const color = (hasPosition ? value.slice(0, splitAt) : value).trim();
  if (hasPosition) {
    const previousSplit = lastTopLevelWhitespace(color);
    if (
      previousSplit >= 0 &&
      STOP_POSITION.test(color.slice(previousSplit).trim())
    ) {
      return null;
    }
  }
  if (!color || /^(?:from|at|in|to)(?:\s|$)/i.test(color)) return null;
  return {
    color,
    position: hasPosition ? possiblePosition : fallbackPosition,
  };
}

const LINEAR_DIRECTIONS: Readonly<Record<string, number>> = {
  "to top": 0,
  "to top right": 45,
  "to right top": 45,
  "to right": 90,
  "to bottom right": 135,
  "to right bottom": 135,
  "to bottom": 180,
  "to bottom left": 225,
  "to left bottom": 225,
  "to left": 270,
  "to top left": 315,
  "to left top": 315,
};

function linearAngle(value: string): number | null {
  const source = value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (Object.hasOwn(LINEAR_DIRECTIONS, source)) {
    return LINEAR_DIRECTIONS[source]!;
  }
  const match = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))deg$/.exec(source);
  if (!match?.[1]) return null;
  const angle = Number(match[1]);
  return Number.isFinite(angle) ? angle : null;
}

/** Parse only gradients this two-stop editor can round-trip faithfully. */
export function parseDesignGradient(value: string): DesignGradientValue | null {
  const match = /^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/is.exec(
    value.trim(),
  );
  if (!match?.[2] || match[3] === undefined) return null;
  const type = match[2].toLocaleLowerCase() as DesignGradientValue["type"];
  const parts = splitTopLevel(match[3]);
  if (!parts || parts.length < 2 || parts.length > 3) return null;

  let angle = type === "linear" ? 180 : 0;
  if (parts.length === 3) {
    const prelude = parts.shift()!;
    if (/^in\s+/i.test(prelude)) return null;
    if (type === "linear") {
      const parsed = linearAngle(prelude);
      if (parsed === null) return null;
      angle = parsed;
    } else if (type === "radial") {
      if (prelude.trim().toLocaleLowerCase() !== "circle") return null;
    } else {
      const conic = /^from\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+))deg$/i.exec(
        prelude.trim(),
      );
      if (!conic?.[1]) return null;
      angle = Number(conic[1]);
      if (!Number.isFinite(angle)) return null;
    }
  }

  const start = parseStop(parts[0]!, "0%");
  const end = parseStop(parts[1]!, "100%");
  if (!start || !end) return null;
  return {
    type,
    angle,
    start: start.color,
    end: end.color,
    startPosition: start.position,
    endPosition: end.position,
    repeating: Boolean(match[1]),
  };
}

function number(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function formatDesignGradient(gradient: DesignGradientValue): string {
  const prefix = gradient.repeating ? "repeating-" : "";
  const colors = `${gradient.start} ${gradient.startPosition ?? "0%"}, ${gradient.end} ${gradient.endPosition ?? "100%"}`;
  if (gradient.type === "radial") {
    return `${prefix}radial-gradient(circle, ${colors})`;
  }
  if (gradient.type === "conic") {
    return `${prefix}conic-gradient(from ${number(gradient.angle)}deg, ${colors})`;
  }
  return `${prefix}linear-gradient(${number(gradient.angle)}deg, ${colors})`;
}

export function readDesignImageUrl(value: string): string {
  const match = /^url\(\s*(["']?)(.*?)\1\s*\)$/i.exec(value.trim());
  return match?.[2] ?? "";
}

export function formatDesignImageUrl(value: string): string {
  const escaped = value.trim().replace(/(["\\])/g, "\\$1");
  return escaped ? `url("${escaped}")` : "none";
}
