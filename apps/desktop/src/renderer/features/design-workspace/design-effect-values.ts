export interface DesignShadowValue {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
}

export interface DesignTransformValue {
  x: number;
  y: number;
  rotate: number;
  scaleX: number;
  scaleY: number;
  skewX: number;
  skewY: number;
  xUnit?: string;
  yUnit?: string;
  rotateUnit?: string;
  skewXUnit?: string;
  skewYUnit?: string;
  /** Unsupported authored syntax stays raw and disables structured controls. */
  raw?: string;
}

const DEFAULT_SHADOW_COLOR = "rgb(0 0 0 / 0.25)"; // check:ui ignore-line (authored CSS default)

function finite(value: string | undefined, fallback = 0): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rounded(value: number): string {
  const result = Math.round(value * 1_000) / 1_000;
  return Object.is(result, -0) ? "0" : String(result);
}

function splitCssTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (const character of value.trim()) {
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
    if (character === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(character) && depth === 0) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export function parseDesignShadow(value: string): DesignShadowValue {
  if (!value.trim() || value.trim().toLocaleLowerCase() === "none") {
    return {
      inset: false,
      x: 0,
      y: 4,
      blur: 16,
      spread: 0,
      color: DEFAULT_SHADOW_COLOR,
    };
  }
  const firstShadow = value.split(/,(?![^()]*\))/)[0] ?? value;
  const tokens = splitCssTokens(firstShadow);
  const insetIndex = tokens.findIndex(
    (token) => token.toLocaleLowerCase() === "inset",
  );
  const inset = insetIndex >= 0;
  if (inset) tokens.splice(insetIndex, 1);
  const lengths: number[] = [];
  const colors: string[] = [];
  for (const token of tokens) {
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/i.test(token)) {
      lengths.push(finite(token));
    } else {
      colors.push(token);
    }
  }
  return {
    inset,
    x: lengths[0] ?? 0,
    y: lengths[1] ?? 0,
    blur: Math.max(0, lengths[2] ?? 0),
    spread: lengths[3] ?? 0,
    color: colors.join(" ") || DEFAULT_SHADOW_COLOR,
  };
}

export function formatDesignShadow(
  shadow: DesignShadowValue,
  includeSpread = true,
): string {
  const lengths = [shadow.x, shadow.y, Math.max(0, shadow.blur)];
  if (includeSpread) lengths.push(shadow.spread);
  return `${shadow.inset ? "inset " : ""}${lengths
    .map((value) => `${rounded(value)}px`)
    .join(" ")} ${shadow.color.trim() || DEFAULT_SHADOW_COLOR}`;
}

const DEFAULT_TRANSFORM: DesignTransformValue = {
  x: 0,
  y: 0,
  rotate: 0,
  scaleX: 1,
  scaleY: 1,
  skewX: 0,
  skewY: 0,
  xUnit: "px",
  yUnit: "px",
  rotateUnit: "deg",
  skewXUnit: "deg",
  skewYUnit: "deg",
};

interface DesignTransformArgument {
  number: number;
  unit: string;
}

function argumentsOf(value: string): DesignTransformArgument[] | null {
  const parts = value.replace(/,/g, " ").trim().split(/\s+/).filter(Boolean);
  const result: DesignTransformArgument[] = [];
  for (const part of parts) {
    const match =
      /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([A-Za-z%]*)$/.exec(
        part,
      );
    if (!match?.[1]) return null;
    const number = Number(match[1]);
    if (!Number.isFinite(number)) return null;
    result.push({ number, unit: match[2] ?? "" });
  }
  return result;
}

function rawDesignTransform(source: string): DesignTransformValue {
  return { ...DEFAULT_TRANSFORM, raw: source };
}

function transformFunctionCategory(name: string): number | null {
  if (name.startsWith("translate")) return 0;
  if (name === "rotate" || name === "rotatez") return 1;
  if (name.startsWith("skew")) return 2;
  if (name.startsWith("scale")) return 3;
  return null;
}

export function parseDesignTransform(value: string): DesignTransformValue {
  const result = { ...DEFAULT_TRANSFORM };
  const source = value.trim();
  if (!source || source.toLocaleLowerCase() === "none") return result;
  const matrix = /^matrix\(([^)]+)\)$/i.exec(source);
  if (matrix?.[1]) {
    const matrixArguments = argumentsOf(matrix[1]);
    if (
      !matrixArguments ||
      matrixArguments.length !== 6 ||
      matrixArguments.some((argument) => argument.unit)
    ) {
      return rawDesignTransform(source);
    }
    const [a = 1, b = 0, c = 0, d = 1, x = 0, y = 0] = matrixArguments.map(
      (argument) => argument.number,
    );
    const scaleX = Math.hypot(a, b) || 1;
    const determinant = a * d - b * c;
    result.x = x;
    result.y = y;
    result.rotate = (Math.atan2(b, a) * 180) / Math.PI;
    result.scaleX = scaleX;
    result.scaleY = determinant / scaleX;
    result.skewX = (Math.atan2(a * c + b * d, scaleX * scaleX) * 180) / Math.PI;
    return result;
  }
  const functions = [...source.matchAll(/([A-Za-z0-9]+)\(([^)]*)\)/g)];
  if (functions.length === 0) return rawDesignTransform(source);
  let parsedThrough = 0;
  let lastCategory = -1;
  let translatedX = false;
  let translatedY = false;
  let rotated = false;
  let skewed = false;
  let scaledX = false;
  let scaledY = false;
  for (const match of functions) {
    const matchIndex = match.index ?? 0;
    if (source.slice(parsedThrough, matchIndex).trim()) {
      return rawDesignTransform(source);
    }
    parsedThrough = matchIndex + match[0].length;
    const name = (match[1] ?? "").toLocaleLowerCase();
    const category = transformFunctionCategory(name);
    if (category === null || category < lastCategory) {
      return rawDesignTransform(source);
    }
    lastCategory = category;
    const values = argumentsOf(match[2] ?? "");
    if (!values) return rawDesignTransform(source);
    if (name === "translate" || name === "translate3d") {
      if (name === "translate3d" || values.length < 1 || values.length > 2) {
        return rawDesignTransform(source);
      }
      if (translatedX || translatedY) return rawDesignTransform(source);
      translatedX = true;
      translatedY = true;
      result.x = values[0]?.number ?? result.x;
      result.xUnit = values[0]?.unit || "px";
      result.y = values[1]?.number ?? result.y;
      if (values[1]) result.yUnit = values[1].unit || "px";
    } else if (name === "translatex") {
      if (values.length !== 1 || translatedX) {
        return rawDesignTransform(source);
      }
      translatedX = true;
      result.x = values[0]!.number;
      result.xUnit = values[0]!.unit || "px";
    } else if (name === "translatey") {
      if (values.length !== 1 || translatedY) {
        return rawDesignTransform(source);
      }
      translatedY = true;
      result.y = values[0]!.number;
      result.yUnit = values[0]!.unit || "px";
    } else if (name === "rotate" || name === "rotatez") {
      if (values.length !== 1 || rotated) return rawDesignTransform(source);
      rotated = true;
      result.rotate = values[0]!.number;
      result.rotateUnit = values[0]!.unit || "deg";
    } else if (name === "scale") {
      if (
        values.length < 1 ||
        values.length > 2 ||
        scaledX ||
        scaledY ||
        values.some((value) => value.unit)
      ) {
        return rawDesignTransform(source);
      }
      scaledX = true;
      scaledY = true;
      result.scaleX = values[0]!.number;
      result.scaleY = values[1]?.number ?? values[0]!.number;
    } else if (name === "scalex") {
      if (values.length !== 1 || values[0]!.unit || scaledX) {
        return rawDesignTransform(source);
      }
      scaledX = true;
      result.scaleX = values[0]!.number;
    } else if (name === "scaley") {
      if (values.length !== 1 || values[0]!.unit || scaledY) {
        return rawDesignTransform(source);
      }
      scaledY = true;
      result.scaleY = values[0]!.number;
    } else if (name === "skew") {
      if (values.length < 1 || values.length > 2 || skewed) {
        return rawDesignTransform(source);
      }
      skewed = true;
      result.skewX = values[0]!.number;
      result.skewXUnit = values[0]!.unit || "deg";
      result.skewY = values[1]?.number ?? result.skewY;
      if (values[1]) result.skewYUnit = values[1].unit || "deg";
    } else if (name === "skewx") {
      if (values.length !== 1 || skewed) return rawDesignTransform(source);
      skewed = true;
      result.skewX = values[0]!.number;
      result.skewXUnit = values[0]!.unit || "deg";
    } else if (name === "skewy") {
      if (values.length !== 1 || skewed) return rawDesignTransform(source);
      skewed = true;
      result.skewY = values[0]!.number;
      result.skewYUnit = values[0]!.unit || "deg";
    } else {
      return rawDesignTransform(source);
    }
  }
  if (source.slice(parsedThrough).trim()) return rawDesignTransform(source);
  return result;
}

export function formatDesignTransform(transform: DesignTransformValue): string {
  if (transform.raw !== undefined) return transform.raw.trim() || "none";
  const functions: string[] = [];
  if (transform.x !== 0 || transform.y !== 0) {
    functions.push(
      `translate(${rounded(transform.x)}${transform.xUnit ?? "px"}, ${rounded(transform.y)}${transform.yUnit ?? "px"})`,
    );
  }
  if (transform.rotate !== 0) {
    functions.push(
      `rotate(${rounded(transform.rotate)}${transform.rotateUnit ?? "deg"})`,
    );
  }
  if (transform.skewX !== 0 || transform.skewY !== 0) {
    functions.push(
      `skew(${rounded(transform.skewX)}${transform.skewXUnit ?? "deg"}, ${rounded(transform.skewY)}${transform.skewYUnit ?? "deg"})`,
    );
  }
  if (transform.scaleX !== 1 || transform.scaleY !== 1) {
    functions.push(
      `scale(${rounded(transform.scaleX)}, ${rounded(transform.scaleY)})`,
    );
  }
  return functions.join(" ") || "none";
}
