// PURPOSE: The tokens a Design frame can use, typed and grouped by role, for
// the Style panel's pills and token pickers. A frame receives the imported
// style sources it chooses (every one unless meta/canvas.json picks some) and
// the directory's tokens.css, which loads last and overrides an imported name.
// Types come from each token's resolved value, roles from the names the
// directory uses. Nothing here is stored; it is derived from the snapshot.

import type {
  DesignStyleSourceWire,
  DesignThemeWire,
  DesignTokenWire,
} from "../../platform/git";
import {
  DESIGN_MANUAL_TOKEN_SOURCE,
  designColorTokenFamily,
  resolveDesignTokenReferences,
} from "./design-color-tokens";
import { inferDesignTokenType } from "./design-theme-css";
import { designStyleSourceTokens } from "./design-theme-sources";
import { designThemeView } from "./design-themes";

export type DesignTokenType =
  | "color"
  | "length"
  | "percentage"
  | "number"
  | "font-weight"
  | "font-family"
  | "shadow"
  | "duration"
  | "easing";

export interface DesignTokenThemeValue {
  /** Theme id; null is the unnamed default (`:root`). */
  theme: string | null;
  label: string;
  /** Aliases resolved for that theme, or null when it cannot resolve. */
  resolved: string | null;
}

export interface DesignToken {
  /** Custom property name, with its leading dashes. */
  name: string;
  /** Its value for the active theme as written (may read another token). */
  declared: string;
  /** Aliases resolved for the active theme, or null when it cannot resolve. */
  resolved: string | null;
  types: readonly DesignTokenType[];
  /** Role group key: a known role or the name's family word. */
  role: string;
  /** "Manual" for tokens.css, else the declaring source's title. */
  source: string;
  /** The comment attached to its tokens.css declaration, as plain text. */
  description?: string;
  /** Every other theme whose resolved value differs from the active one. */
  differsIn: readonly DesignTokenThemeValue[];
  /** Cascade position: imported sources as declared, then Manual. */
  order: number;
}

export interface DesignTokenCatalog {
  tokens: readonly DesignToken[];
  byName: ReadonlyMap<string, DesignToken>;
  /** Every type some token has, so a field asks whether it is offered tokens
   * without scanning them. */
  types: ReadonlySet<DesignTokenType>;
  /** The active theme's label, for Detach's hint. */
  themeLabel: string;
  /** Changes whenever anything a pill or picker shows changes. */
  key: string;
}

export interface DesignTokenCatalogInput {
  manual: readonly DesignTokenWire[];
  sources: readonly DesignStyleSourceWire[];
  themes?: readonly DesignThemeWire[];
  /** The theme frames show; null is the unnamed default (`:root`). */
  theme: string | null;
  /** The sources the frame receives; undefined is every declared one. */
  sourceIds?: readonly string[];
}

const TOKEN_NAME = /^--[A-Za-z0-9_-]{1,128}$/;
const FONTS_SOURCE_ID = "@fonts";
export const EMPTY_DESIGN_TOKEN_CATALOG: DesignTokenCatalog = {
  tokens: [],
  byName: new Map(),
  types: new Set(),
  themeLabel: "",
  key: "",
};

const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
const LENGTH_UNITS =
  "px|rem|em|ex|ch|lh|rlh|vh|vw|vmin|vmax|svh|lvh|dvh|svw|lvw|dvw|cqw|cqh|cqi|cqb|pt|pc|cm|mm|in|q";
const LENGTH = new RegExp(`^${NUMBER}(?:${LENGTH_UNITS})$`, "i");
const PERCENTAGE = new RegExp(`^${NUMBER}%$`);
const PLAIN_NUMBER = new RegExp(`^${NUMBER}$`);
const DURATION = new RegExp(`^${NUMBER}(?:ms|s)$`, "i");
const MATH = /^(?:calc|min|max|clamp)\(/i;
const EASING = /^(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)$|^(?:cubic-bezier|steps|linear)\(/i;
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);
const WEIGHT_KEYWORDS = new Set(["normal", "bold", "bolder", "lighter"]);

/** Split on commas outside parentheses and quotes. */
function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === separator && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function isColor(value: string, syntax: string): boolean {
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function")
    return CSS.supports("color", value);
  return (
    inferDesignTokenType("", value, syntax) === "color" ||
    /^(?:rgba|hsla|color-mix|light-dark)\(/i.test(value)
  );
}

function isShadow(value: string): boolean {
  if (/^none$/i.test(value)) return false;
  return splitTopLevel(value, ",").every((layer) => {
    // Colour functions hold numbers too; only the offsets and radii count.
    const words = splitTopLevel(layer.replace(/[a-z-]+\([^)]*\)/gi, " "), " ")
      .flatMap((word) => word.split(/\s+/))
      .filter((word) => word && word.toLowerCase() !== "inset");
    const lengths = words.filter((word) => word === "0" || LENGTH.test(word));
    return lengths.length >= 2 && lengths.length <= 4;
  });
}

function isFontFamily(name: string, value: string, syntax: string): boolean {
  if (/custom-ident|string/i.test(syntax)) return true;
  const families = splitTopLevel(value, ",");
  if (families.length === 0) return false;
  const quotedOrGeneric = families.some(
    (family) => /^["'].+["']$/.test(family) || GENERIC_FAMILIES.has(family.toLowerCase()),
  );
  if (quotedOrGeneric) return families.every((family) => !PLAIN_NUMBER.test(family));
  // A bare word is a family only when the name says so: `--surface: ink`
  // reads nothing about fonts.
  return (
    /(?:^|[-_])(?:font|family|typeface)(?:[-_]|$)/i.test(name.replace(/^--/, "")) &&
    families.every((family) => /^[a-z][a-z0-9 -]*$/i.test(family))
  );
}

/** Every type a resolved value fits. `400` is both a number and a weight;
 * `0` is a number and a length. */
export function designTokenTypes(
  name: string,
  resolved: string | null,
  syntax = "*",
): DesignTokenType[] {
  const value = resolved?.trim() ?? "";
  if (!value) return [];
  const types: DesignTokenType[] = [];
  if (isColor(value, syntax)) return ["color"];
  if (PLAIN_NUMBER.test(value)) {
    types.push("number");
    const number = Number(value);
    if (number === 0) types.push("length");
    if (Number.isInteger(number) && number >= 1 && number <= 1000) types.push("font-weight");
    return types;
  }
  if (WEIGHT_KEYWORDS.has(value.toLowerCase())) return ["font-weight"];
  if (PERCENTAGE.test(value)) return ["percentage"];
  if (LENGTH.test(value)) return ["length"];
  if (DURATION.test(value)) return ["duration"];
  if (MATH.test(value)) {
    if (/\d(?:ms|s)\b/i.test(value)) return ["duration"];
    return new RegExp(`\\d(?:${LENGTH_UNITS})\\b`, "i").test(value) ? ["length"] : ["number"];
  }
  if (EASING.test(value)) return ["easing"];
  if (isShadow(value)) return ["shadow"];
  if (isFontFamily(name, value, syntax)) return ["font-family"];
  return types;
}

/** Role labels for families the naming commonly uses; any other family is
 * its own word. Sentence case, as the panel's group labels are. */
const ROLE_LABELS: ReadonlyArray<[readonly string[], string]> = [
  [["bg", "background", "surface", "surfaces", "canvas"], "Surfaces"],
  [["fg", "foreground", "text", "ink"], "Text"],
  [["border", "borders", "stroke", "divider", "outline", "ring"], "Borders"],
  [["radius", "rounded", "corner"], "Radius"],
  [["space", "spacing", "gap", "padding", "margin", "inset"], "Spacing"],
  [["font", "fonts", "family", "leading", "tracking", "weight"], "Fonts"],
  [["shadow", "shadows", "elevation"], "Shadows"],
  [["duration", "ease", "easing", "motion"], "Motion"],
  [["size", "sizes", "width", "height"], "Sizes"],
  [["opacity", "alpha"], "Opacity"],
];
const KNOWN_ROLES = new Map(
  ROLE_LABELS.flatMap(([families, label]) => families.map((family) => [family, label] as const)),
);
const ROLE_NAMES = new Set(KNOWN_ROLES.values());
export const DESIGN_TOKEN_OTHER_ROLE = "Other";

/** A token's role group key: its known role label, or its family word. */
export function designTokenRole(name: string): string {
  const family = designColorTokenFamily(name);
  return KNOWN_ROLES.get(family) ?? family;
}

/** The label a role key shows: known roles as named, a family word in
 * sentence case. */
export function designTokenRoleLabel(role: string): string {
  if (ROLE_NAMES.has(role) || role === DESIGN_TOKEN_OTHER_ROLE) return role;
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : DESIGN_TOKEN_OTHER_ROLE;
}

/** The frame's catalog: winners in cascade order, typed and grouped. */
export function designTokenCatalog({
  manual,
  sources,
  themes,
  theme,
  sourceIds,
}: DesignTokenCatalogInput): DesignTokenCatalog {
  interface Declaration {
    token: DesignTokenWire;
    source: string;
    order: number;
  }
  const view = designThemeView(themes);
  const valueIn = (token: DesignTokenWire, which: string | null): string =>
    (which ? token.themeValues?.[which] : undefined) ??
    (token.value || token.initialValue || "");
  const winnersFor = (which: string | null) => {
    const winners = new Map<string, Declaration>();
    let order = 0;
    const declare = (source: string, tokens: readonly DesignTokenWire[]) => {
      for (const token of tokens) {
        if (!TOKEN_NAME.test(token.name)) continue;
        // A later declarer that sets the name only for other themes leaves
        // the earlier declaration in force for this one.
        if (!valueIn(token, which).trim()) continue;
        winners.set(token.name, { token, source, order: order++ });
      }
    };
    // An empty choice opts out of every source, App fonts included.
    const allowed = sourceIds
      ? new Set(sourceIds.length > 0 ? [...sourceIds, FONTS_SOURCE_ID] : [])
      : null;
    for (const source of sources) {
      if (allowed && !allowed.has(source.id)) continue;
      declare(source.title.trim() || source.id, designStyleSourceTokens(source));
    }
    declare(DESIGN_MANUAL_TOKEN_SOURCE, manual);
    const resolve = (name: string): string | null => {
      const winner = winners.get(name);
      if (!winner) return null;
      return resolveDesignTokenReferences(
        valueIn(winner.token, which).trim(),
        (other) => {
          const candidate = winners.get(other);
          return candidate ? valueIn(candidate.token, which) : undefined;
        },
        new Set([name]),
      );
    };
    return { winners, resolve };
  };
  const active = winnersFor(theme);
  const others = [view.baseId, ...view.others]
    .filter((which) => which !== theme)
    .map((which) => ({ which, ...winnersFor(which) }));

  const tokens = [...active.winners.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ token, source, order }): DesignToken => {
      const resolved = active.resolve(token.name);
      const differsIn = others
        .map(({ which, resolve }) => ({
          theme: which,
          label: view.label(which),
          resolved: resolve(token.name),
        }))
        .filter((entry) => entry.resolved !== resolved);
      return {
        name: token.name,
        declared: valueIn(token, theme).trim(),
        resolved,
        types: designTokenTypes(token.name, resolved, token.syntax),
        role: designTokenRole(token.name),
        source,
        ...(token.description ? { description: token.description } : {}),
        differsIn,
        order,
      };
    });
  const key = tokens
    .map((token) =>
      [
        token.name,
        token.declared,
        token.resolved ?? "",
        token.source,
        token.description ?? "",
        token.differsIn.map((entry) => `${entry.label}:${entry.resolved ?? ""}`).join(","),
      ].join("\u0001"),
    )
    .join("\u0002");
  return {
    tokens,
    byName: new Map(tokens.map((token) => [token.name, token])),
    types: new Set(tokens.flatMap((token) => token.types)),
    themeLabel: view.label(theme),
    key,
  };
}

export interface DesignTokenGroup {
  key: string;
  label: string;
  tokens: readonly DesignToken[];
}

/** The tokens a field accepts, grouped by role in cascade order. A family
 * the vocabulary does not know, with one token, joins "Other", which comes
 * last. */
export function designTokenGroups(
  catalog: DesignTokenCatalog,
  accepts: readonly DesignTokenType[],
): DesignTokenGroup[] {
  const fitting = catalog.tokens.filter((token) =>
    token.types.some((type) => accepts.includes(type)),
  );
  const byRole = new Map<string, DesignToken[]>();
  for (const token of fitting) {
    const list = byRole.get(token.role) ?? [];
    list.push(token);
    byRole.set(token.role, list);
  }
  const groups: DesignTokenGroup[] = [];
  const other: DesignToken[] = [];
  for (const [role, list] of byRole) {
    const known = ROLE_NAMES.has(role);
    if (!known && list.length === 1) other.push(...list);
    else groups.push({ key: role, label: designTokenRoleLabel(role), tokens: list });
  }
  if (other.length > 0)
    groups.push({
      key: DESIGN_TOKEN_OTHER_ROLE,
      label: DESIGN_TOKEN_OTHER_ROLE,
      tokens: other.sort((left, right) => left.order - right.order),
    });
  return groups;
}

/** What a picker row says under the name: the token's description, else its
 * resolved value. */
export function designTokenSummary(token: DesignToken): string {
  return token.description ?? token.resolved ?? token.declared;
}

/** The token types a CSS property accepts, or null for a property whose
 * field never shows a pill (measured geometry, stacking order). */
export function designTokenFieldTypes(property: string): readonly DesignTokenType[] | null {
  // One answer per property, the same array each time, so a field's memo on
  // it holds across renders and the patterns run once.
  let types = FIELD_TYPES.get(property);
  if (types === undefined) {
    types = fieldTypesFor(property);
    FIELD_TYPES.set(property, types);
  }
  return types;
}

const COLOR_TYPES: readonly DesignTokenType[] = ["color"];
const OPACITY_TYPES: readonly DesignTokenType[] = ["number", "percentage"];
const WEIGHT_TYPES: readonly DesignTokenType[] = ["font-weight"];
const FAMILY_TYPES: readonly DesignTokenType[] = ["font-family"];
const LINE_HEIGHT_TYPES: readonly DesignTokenType[] = ["number", "length", "percentage"];
const SIZE_TYPES: readonly DesignTokenType[] = ["length", "percentage"];
const LENGTH_TYPES: readonly DesignTokenType[] = ["length"];
const FIELD_TYPES = new Map<string, readonly DesignTokenType[] | null>();

function fieldTypesFor(property: string): readonly DesignTokenType[] | null {
  if (property === "color" || property.endsWith("-color")) return COLOR_TYPES;
  if (property === "opacity") return OPACITY_TYPES;
  if (property === "font-weight") return WEIGHT_TYPES;
  if (property === "font-family") return FAMILY_TYPES;
  if (property === "line-height") return LINE_HEIGHT_TYPES;
  if (/^(?:min-|max-)?(?:width|height)$/.test(property)) return SIZE_TYPES;
  if (
    /^(?:padding|margin)(?:-(?:top|right|bottom|left))?$/.test(property) ||
    /^(?:row-|column-)?gap$/.test(property) ||
    /^border(?:-(?:top|bottom)-(?:left|right))?-radius$/.test(property) ||
    /^(?:border(?:-(?:top|right|bottom|left))?|outline)-width$/.test(property) ||
    ["outline-offset", "letter-spacing", "font-size", "word-spacing", "text-indent"].includes(property)
  )
    return LENGTH_TYPES;
  return null;
}

/** How a picker's footer and empty state name what a field lists. */
export function designTokenKindLabel(accepts: readonly DesignTokenType[]): string {
  if (accepts.includes("color")) return "color";
  if (accepts.includes("font-family")) return "font";
  if (accepts.includes("font-weight")) return "weight";
  if (accepts.includes("length")) return "size";
  return "number";
}

export interface DesignTextStyle {
  /** The size token, `--text-<name>`. */
  name: string;
  size: DesignToken;
  lineHeight?: DesignToken;
  letterSpacing?: DesignToken;
  fontWeight?: DesignToken;
}

const TEXT_STYLE_PARTS = {
  "line-height": "lineHeight",
  "letter-spacing": "letterSpacing",
  "font-weight": "fontWeight",
} as const;

/** Text styles: each `--text-<name>` size token, with the optional
 * `--text-<name>--line-height`, `--letter-spacing` and `--font-weight`
 * tokens beside it (Tailwind's convention). */
export function designTextStyles(catalog: DesignTokenCatalog): DesignTextStyle[] {
  const styles: DesignTextStyle[] = [];
  for (const token of catalog.tokens) {
    const match = /^--text-([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)$/.exec(token.name);
    if (!match || !token.types.includes("length")) continue;
    const style: DesignTextStyle = { name: token.name, size: token };
    for (const [suffix, part] of Object.entries(TEXT_STYLE_PARTS)) {
      const member = catalog.byName.get(`${token.name}--${suffix}`);
      if (member?.resolved) style[part] = member;
    }
    styles.push(style);
  }
  return styles;
}

/** CSS pixels for a resolved length or number of `em`s of `base`; null when
 * it cannot be worked out without layout. */
function pixels(value: string | null | undefined, base: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const ratio = /^calc\(\s*(-?[\d.]+)\s*\/\s*(-?[\d.]+)\s*\)$/i.exec(trimmed);
  if (ratio) return (Number(ratio[1]) / Number(ratio[2])) * base;
  if (PLAIN_NUMBER.test(trimmed)) return Number(trimmed) * base;
  const unit = /^(-?[\d.]+)(px|rem|em|%)$/i.exec(trimmed);
  if (!unit) return null;
  const number = Number(unit[1]);
  switch (unit[2]!.toLowerCase()) {
    case "px":
      return number;
    case "rem":
      return number * 16;
    case "em":
      return number * base;
    default:
      return (number / 100) * base;
  }
}

const round = (value: number) => Math.round(value * 10) / 10;

/** "13 on an 18 line", "10": the style's size and line in CSS pixels. */
export function designTextStyleMeasure(style: DesignTextStyle): string {
  const size = pixels(style.size.resolved, 16);
  if (size === null) return style.size.resolved ?? style.size.declared;
  const line = pixels(style.lineHeight?.resolved, size);
  // "an 18 line", "an 8 line", "an 11 line"; "a 180 line".
  const article = line !== null && /^(?:8|1[18](?:\.|$))/.test(String(round(line))) ? "an" : "a";
  return line === null ? String(round(size)) : `${round(size)} on ${article} ${round(line)} line`;
}

/** A text style row's second line: its measure, then its description. */
export function designTextStyleSummary(style: DesignTextStyle): string {
  const measure = designTextStyleMeasure(style);
  return style.size.description ? `${measure}, ${style.size.description}` : measure;
}

/** Detach's hint when the token's value differs by theme. */
export function designTokenDetachHint(
  token: DesignToken | undefined,
  themeLabel: string,
  shown: (value: string) => string = (value) => value,
): string | undefined {
  if (!token?.resolved || token.differsIn.length === 0) return undefined;
  const others = token.differsIn
    .map((entry) => `${entry.label}'s ${entry.resolved ? shown(entry.resolved) : "value"}`)
    .join(" and ");
  return `Detach writes ${themeLabel}'s ${shown(token.resolved)}; ${others} ${
    token.differsIn.length === 1 ? "is" : "are"
  } lost`;
}
