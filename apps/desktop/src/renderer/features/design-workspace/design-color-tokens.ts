// PURPOSE: The color tokens a Design frame can use, for the color picker's
// Theme tab. Frames receive every imported style source and the directory's
// manual tokens.css (Manual loads last and overrides an imported name), so
// the winning declaration of each custom property is what a frame resolves.
// Only colors are listed; aliases resolve through the same catalog.

import type { DesignStyleSourceWire, DesignTokenWire } from "../../platform/git";
import { inferDesignTokenType } from "./design-theme-css";
import { designStyleSourceTokens } from "./design-theme-sources";

/** The theme editor's name for tokens.css. */
export const DESIGN_MANUAL_TOKEN_SOURCE = "Manual";

export interface DesignColorToken {
  /** Custom property name, with its leading dashes. */
  name: string;
  /** The value the frame's theme declares, as written (may read another token). */
  declared: string;
  /** A paintable value for the swatch with aliases resolved, or null. */
  color: string | null;
}

export interface DesignColorTokenGroup {
  /** Stable across renders: the declaring source and the token family. */
  key: string;
  /** "App tokens › bg": the declaring source, then the family. */
  label: string;
  source: string;
  tokens: readonly DesignColorToken[];
}

export interface DesignColorTokenCatalogInput {
  /** The Design directory's manual tokens (tokens.css). */
  manual: readonly DesignTokenWire[];
  /** Imported style sources, in meta/canvas.json order. */
  sources: readonly DesignStyleSourceWire[];
  /** The theme frames show; null is the unnamed default (`:root`). */
  theme: string | null;
}

const TOKEN_NAME = /^--[A-Za-z0-9_-]{1,128}$/;
const MAX_ALIAS_DEPTH = 16;

/** Resolve `var(--name, fallback)` references through `lookup`. Null when a
 * reference cannot resolve, including cycles and unbalanced parentheses. */
export function resolveDesignTokenReferences(
  value: string,
  lookup: (name: string) => string | undefined,
  seen: ReadonlySet<string> = new Set(),
  depth = 0,
): string | null {
  if (depth > MAX_ALIAS_DEPTH) return null;
  let output = "";
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf("var(", index);
    if (start < 0) {
      output += value.slice(index);
      break;
    }
    output += value.slice(index, start);
    let cursor = start + 4;
    let nesting = 1;
    let comma = -1;
    for (; cursor < value.length; cursor += 1) {
      const character = value[cursor];
      if (character === "(") nesting += 1;
      else if (character === ")") {
        nesting -= 1;
        if (nesting === 0) break;
      } else if (character === "," && nesting === 1 && comma < 0) {
        comma = cursor;
      }
    }
    if (nesting !== 0) return null;
    const name = value.slice(start + 4, comma < 0 ? cursor : comma).trim();
    const fallback = comma < 0 ? null : value.slice(comma + 1, cursor).trim();
    let replacement: string | null = null;
    if (TOKEN_NAME.test(name) && !seen.has(name)) {
      const declared = lookup(name);
      if (declared?.trim()) {
        replacement = resolveDesignTokenReferences(
          declared,
          lookup,
          new Set([...seen, name]),
          depth + 1,
        );
      }
    }
    if (replacement === null && fallback) {
      replacement = resolveDesignTokenReferences(fallback, lookup, seen, depth + 1);
    }
    if (replacement === null) return null;
    output += replacement;
    index = cursor + 1;
  }
  return output.trim();
}

/** `bg1-hover` → "bg", `red-500` → "red", `scrim` → "scrim": the leading
 * letters of a name's first segment, so numbered steps share one family. */
export function designColorTokenFamily(name: string): string {
  const first = name.replace(/^--/, "").split(/[-_]/).find(Boolean) ?? "";
  const family = first.replace(/[\d.]+$/, "").toLocaleLowerCase();
  return family || "other";
}

// inferDesignTokenType reads syntax, hex, keywords and color names; the
// legacy and composed color functions below also paint a swatch.
const COLOR_FUNCTION = /^(?:rgba|hsla|color-mix|light-dark)\(/i;

function isColorValue(name: string, value: string, syntax: string): boolean {
  if (inferDesignTokenType(name, value, syntax) === "color") return true;
  return COLOR_FUNCTION.test(value.trim());
}

/** The color tokens a frame resolves, grouped by declaring source and family
 * in cascade order: imported sources as declared, then Manual. */
export function designColorTokenGroups({
  manual,
  sources,
  theme,
}: DesignColorTokenCatalogInput): DesignColorTokenGroup[] {
  interface Declaration {
    token: DesignTokenWire;
    sourceKey: string;
    source: string;
    order: number;
  }
  const winners = new Map<string, Declaration>();
  let order = 0;
  const declare = (
    sourceKey: string,
    source: string,
    tokens: readonly DesignTokenWire[],
  ) => {
    for (const token of tokens) {
      if (!TOKEN_NAME.test(token.name)) continue;
      winners.set(token.name, { token, sourceKey, source, order: order++ });
    }
  };
  for (const source of sources) {
    declare(
      `source:${source.id}`,
      source.title.trim() || source.id,
      designStyleSourceTokens(source),
    );
  }
  declare("manual", DESIGN_MANUAL_TOKEN_SOURCE, manual);

  const valueOf = (token: DesignTokenWire): string =>
    (theme ? token.themeValues?.[theme] : undefined) ??
    (token.value || token.initialValue || "");
  const lookup = (name: string): string | undefined => {
    const winner = winners.get(name);
    return winner ? valueOf(winner.token) : undefined;
  };

  const groups = new Map<
    string,
    { key: string; label: string; source: string; tokens: DesignColorToken[] }
  >();
  const ordered = [...winners.values()].sort((left, right) => left.order - right.order);
  for (const { token, sourceKey, source } of ordered) {
    const declared = valueOf(token).trim();
    if (!declared) continue;
    const resolved = resolveDesignTokenReferences(
      declared,
      lookup,
      new Set([token.name]),
    );
    if (!resolved || !isColorValue(token.name, resolved, token.syntax)) continue;
    const family = designColorTokenFamily(token.name);
    const key = `${sourceKey}\u0000${family}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, label: `${source} › ${family}`, source, tokens: [] };
      groups.set(key, group);
    }
    group.tokens.push({ name: token.name, declared, color: resolved });
  }
  return [...groups.values()];
}

/** Groups whose label, or whose tokens' names or declared values, contain the
 * query. An empty query returns the same array. */
export function filterDesignColorTokenGroups(
  groups: readonly DesignColorTokenGroup[],
  query: string,
): readonly DesignColorTokenGroup[] {
  const needle = query.trim().toLocaleLowerCase().replace(/^--/, "");
  if (!needle) return groups;
  const shown: DesignColorTokenGroup[] = [];
  for (const group of groups) {
    const tokens = group.label.toLocaleLowerCase().includes(needle)
      ? group.tokens
      : group.tokens.filter(
          (token) =>
            token.name.toLocaleLowerCase().includes(needle) ||
            token.declared.toLocaleLowerCase().includes(needle),
        );
    if (tokens.length === 0) continue;
    shown.push(tokens === group.tokens ? group : { ...group, tokens });
  }
  return shown;
}

function tokenNameOf(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("--") ? trimmed : `--${trimmed}`;
}

/** The listed token a field's winning declaration reads, or null. */
export function activeDesignColorToken(
  groups: readonly DesignColorTokenGroup[],
  tokenName: string | null | undefined,
): string | null {
  if (!tokenName?.trim()) return null;
  const name = tokenNameOf(tokenName);
  return groups.some((group) => group.tokens.some((token) => token.name === name))
    ? name
    : null;
}

/** The declaration value choosing a token writes. */
export function designColorTokenValue(name: string): string {
  return `var(${tokenNameOf(name)})`;
}

/** Changes whenever a listed name, value or grouping changes. */
export function designColorTokenGroupsKey(
  groups: readonly DesignColorTokenGroup[],
): string {
  return groups
    .map(
      (group) =>
        `${group.key}\u0001${group.tokens
          .map((token) => `${token.name}\u0002${token.declared}\u0002${token.color ?? ""}`)
          .join("\u0003")}`,
    )
    .join("\u0004");
}
