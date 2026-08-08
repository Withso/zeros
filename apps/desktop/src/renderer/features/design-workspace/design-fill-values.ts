export type DesignFillType = "solid" | "gradient" | "image";

export interface DesignGradientValue {
  type: "linear" | "radial" | "conic";
  angle: number;
  start: string;
  end: string;
}

export function classifyDesignFill(backgroundImage: string): DesignFillType {
  const value = backgroundImage.trim().toLocaleLowerCase();
  if (
    /^(?:linear|radial|conic|repeating-linear|repeating-radial)-gradient\(/.test(
      value,
    )
  ) {
    return "gradient";
  }
  return /^url\(/.test(value) ? "image" : "solid";
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (const character of value) {
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    if (character === "(") depth += 1;
    if (character === ")") depth = Math.max(0, depth - 1);
    if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function withoutStop(value: string): string {
  return value.replace(/\s+-?(?:\d+(?:\.\d*)?|\.\d+)%\s*$/, "").trim();
}

export function parseDesignGradient(value: string): DesignGradientValue {
  const match = /^(linear|radial|conic)(?:-gradient)\((.*)\)$/i.exec(
    value.trim(),
  );
  if (!match?.[1] || !match[2]) {
    return {
      type: "linear",
      angle: 180,
      start: "transparent",
      end: "currentColor",
    };
  }
  const type = match[1].toLocaleLowerCase() as DesignGradientValue["type"];
  const parts = splitTopLevel(match[2]);
  let angle = type === "linear" ? 180 : 0;
  if (type === "linear" && /deg$/i.test(parts[0] ?? "")) {
    angle = Number.parseFloat(parts.shift() ?? "180") || 0;
  } else if (type === "conic" && /^from\s+/i.test(parts[0] ?? "")) {
    angle =
      Number.parseFloat(parts.shift()?.replace(/^from\s+/i, "") ?? "0") || 0;
  } else if (type === "radial" && parts.length > 2) {
    parts.shift();
  }
  return {
    type,
    angle,
    start: withoutStop(parts[0] ?? "transparent"),
    end: withoutStop(parts.at(-1) ?? "currentColor"),
  };
}

function number(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function formatDesignGradient(gradient: DesignGradientValue): string {
  const colors = `${gradient.start} 0%, ${gradient.end} 100%`;
  if (gradient.type === "radial") {
    return `radial-gradient(circle, ${colors})`;
  }
  if (gradient.type === "conic") {
    return `conic-gradient(from ${number(gradient.angle)}deg, ${colors})`;
  }
  return `linear-gradient(${number(gradient.angle)}deg, ${colors})`;
}

export function readDesignImageUrl(value: string): string {
  const match = /^url\(\s*(["']?)(.*?)\1\s*\)$/i.exec(value.trim());
  return match?.[2] ?? "";
}

export function formatDesignImageUrl(value: string): string {
  const escaped = value.trim().replace(/(["\\])/g, "\\$1");
  return escaped ? `url("${escaped}")` : "none";
}
