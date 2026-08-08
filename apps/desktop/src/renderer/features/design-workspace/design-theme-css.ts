import { parseDesignCssDeclarations } from "./design-style-values";

export interface DesignCssVariableImport {
  name: string;
  theme: string | null;
  value: string;
}

export type DesignTokenValueType =
  | "color"
  | "length"
  | "number"
  | "time"
  | "angle"
  | "other";

const TOKEN_NAME = /^--[A-Za-z0-9_-]{1,128}$/;
const THEME_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

function themeFromSelector(selector: string): string | null | undefined {
  const normalized = selector.trim();
  if (/^(?::root|html|:host)$/i.test(normalized)) return null;
  const attribute =
    /\[data-(?:zd-)?theme\s*=\s*(["']?)([a-z][a-z0-9_-]{0,63})\1\]/i.exec(
      normalized,
    );
  if (attribute?.[2]) return attribute[2].toLowerCase();
  const className = /^\.(?:theme-)?([a-z][a-z0-9_-]{0,63})$/i.exec(normalized);
  return className?.[1]?.toLowerCase();
}

function addDeclarations(
  output: Map<string, DesignCssVariableImport>,
  declarations: Record<string, string>,
  theme: string | null,
): void {
  for (const [name, value] of Object.entries(declarations)) {
    if (!TOKEN_NAME.test(name)) continue;
    const key = `${theme ?? ""}\u0000${name}`;
    output.delete(key);
    output.set(key, { name, theme, value });
  }
}

/** Parse clipboard CSS into one bounded token/mode matrix. This intentionally
 * accepts common :root, data-theme, and .dark forms, then emits only custom
 * properties; every value is still validated by the engine transaction. */
export function parseDesignCssVariables(
  source: string,
): DesignCssVariableImport[] {
  if (source.length > 256_000)
    throw new Error("CSS variable paste is too large.");
  const output = new Map<string, DesignCssVariableImport>();
  if (!source.includes("{")) {
    addDeclarations(output, parseDesignCssDeclarations(source, 256), null);
    return [...output.values()];
  }

  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("{", cursor);
    if (open < 0) break;
    const selector = source
      .slice(cursor, open)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim();
    let quote = "";
    let escaped = false;
    let depth = 1;
    let close = open + 1;
    for (; close < source.length && depth > 0; close += 1) {
      const character = source[close] ?? "";
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      else if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
    }
    if (depth !== 0) throw new Error("Unclosed CSS variable block.");
    const theme = themeFromSelector(selector);
    if (theme !== undefined && (theme === null || THEME_NAME.test(theme))) {
      const body = source.slice(open + 1, close - 1);
      if (body.includes("{")) {
        throw new Error("Nested CSS variable blocks are not supported.");
      }
      addDeclarations(output, parseDesignCssDeclarations(body, 256), theme);
    }
    cursor = close;
    if (output.size > 256)
      throw new Error("CSS variable paste exceeds 256 values.");
  }
  if (output.size === 0) {
    throw new Error("No CSS custom properties were found.");
  }
  return [...output.values()];
}

export function inferDesignTokenType(
  name: string,
  value: string,
  syntax: string,
): DesignTokenValueType {
  const normalizedSyntax = syntax.toLowerCase();
  if (normalizedSyntax.includes("color")) return "color";
  if (normalizedSyntax.includes("time")) return "time";
  if (normalizedSyntax.includes("angle")) return "angle";
  if (normalizedSyntax.includes("length")) return "length";
  if (
    normalizedSyntax.includes("number") ||
    normalizedSyntax.includes("integer")
  ) {
    return "number";
  }
  const normalized = value.trim();
  if (
    /^(?:#(?:[0-9a-f]{3,8})|(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\()/i.test(
      normalized,
    )
  ) {
    return "color";
  }
  if (
    /^(?:transparent|currentcolor)$/i.test(normalized) ||
    (/(?:^|[-_])(?:color|colour|accent|brand|surface|background|foreground|text|fill|stroke)(?:[-_]|$)/i.test(
      name.replace(/^--/, ""),
    ) &&
      /^[a-z][a-z0-9-]*$/i.test(normalized))
  ) {
    return "color";
  }
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:ms|s)$/i.test(normalized)) return "time";
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:deg|rad|grad|turn)$/i.test(normalized)) {
    return "angle";
  }
  if (
    /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vh|vw|vmin|vmax|ch|ex)$/i.test(
      normalized,
    )
  ) {
    return "length";
  }
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return "number";
  return "other";
}

export function designTokenGroup(name: string): string {
  const pieces = name.replace(/^--/, "").split("-").filter(Boolean);
  return pieces.length > 1 ? pieces[0]!.toLowerCase() : "Other";
}
