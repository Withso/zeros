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
};

function argumentsOf(value: string): number[] {
  return value
    .replace(/,/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => finite(part));
}

export function parseDesignTransform(value: string): DesignTransformValue {
  const result = { ...DEFAULT_TRANSFORM };
  const source = value.trim();
  if (!source || source.toLocaleLowerCase() === "none") return result;
  const matrix = /^matrix\(([^)]+)\)$/i.exec(source);
  if (matrix?.[1]) {
    const [a = 1, b = 0, c = 0, d = 1, x = 0, y = 0] = argumentsOf(matrix[1]);
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
  const functions = source.matchAll(/([A-Za-z0-9]+)\(([^)]*)\)/g);
  for (const match of functions) {
    const name = (match[1] ?? "").toLocaleLowerCase();
    const values = argumentsOf(match[2] ?? "");
    if (name === "translate" || name === "translate3d") {
      result.x = values[0] ?? result.x;
      result.y = values[1] ?? result.y;
    } else if (name === "translatex") result.x = values[0] ?? result.x;
    else if (name === "translatey") result.y = values[0] ?? result.y;
    else if (name === "rotate" || name === "rotatez") {
      result.rotate = values[0] ?? result.rotate;
    } else if (name === "scale") {
      result.scaleX = values[0] ?? result.scaleX;
      result.scaleY = values[1] ?? values[0] ?? result.scaleY;
    } else if (name === "scalex") result.scaleX = values[0] ?? result.scaleX;
    else if (name === "scaley") result.scaleY = values[0] ?? result.scaleY;
    else if (name === "skew") {
      result.skewX = values[0] ?? result.skewX;
      result.skewY = values[1] ?? result.skewY;
    } else if (name === "skewx") result.skewX = values[0] ?? result.skewX;
    else if (name === "skewy") result.skewY = values[0] ?? result.skewY;
  }
  return result;
}

export function formatDesignTransform(transform: DesignTransformValue): string {
  const functions: string[] = [];
  if (transform.x !== 0 || transform.y !== 0) {
    functions.push(
      `translate(${rounded(transform.x)}px, ${rounded(transform.y)}px)`,
    );
  }
  if (transform.rotate !== 0) {
    functions.push(`rotate(${rounded(transform.rotate)}deg)`);
  }
  if (transform.skewX !== 0 || transform.skewY !== 0) {
    functions.push(
      `skew(${rounded(transform.skewX)}deg, ${rounded(transform.skewY)}deg)`,
    );
  }
  if (transform.scaleX !== 1 || transform.scaleY !== 1) {
    functions.push(
      `scale(${rounded(transform.scaleX)}, ${rounded(transform.scaleY)})`,
    );
  }
  return functions.join(" ") || "none";
}
