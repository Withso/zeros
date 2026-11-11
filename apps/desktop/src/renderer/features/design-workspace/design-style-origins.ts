// PURPOSE: Where each Style field's value comes from, in plain words: a
// class, a utility, a component, this layer (changed over its class, or set
// here), a parent, a reset, or a rule forcing it. One pure model per runtime
// details object, so every field reads its answer in constant time.

import type {
  DesignRuntimeAuthoredStyle,
  DesignRuntimeNodeDetails,
  DesignRuntimeNodeState,
  DesignRuntimeReplacedStyle,
} from "@zeros/protocol/design-runtime";

import {
  designStyleShorthands,
  designStyleTokenReference,
  type DesignStyleOriginLabel,
} from "./design-style-provenance";
import { designColorValueText, parseDesignColor } from "./design-color-values";
import {
  authoredDeclarationAffects,
  isDesignRuntimeStylePropertyAuthored,
} from "./design-style-values";

export type DesignStyleOriginKind =
  | "token"
  | "class"
  | "utility"
  | "component"
  | "changed"
  | "set-here"
  | "inherited"
  | "reset"
  | "forced";

export interface DesignStyleCardRow {
  key: string;
  text: string;
}

/** What the shared hover card says about one field, as plain strings. */
export interface DesignStyleCard {
  rows: DesignStyleCardRow[];
  /** "Used by 12 other layers in this frame"; absent at 0. */
  foot?: string;
  /** This layer's own declaration, removed whole so the class shows again. */
  reset?: { properties: string[]; text: string };
  /** The rule whose !important forces the value. */
  forcedBy?: string;
}

export interface DesignStyleOrigin {
  kind: DesignStyleOriginKind;
  /** "the class .btn", "this layer", "a parent layer"… */
  from: string;
  card: DesignStyleCard;
}

export interface DesignStyledByGroup {
  /** `state`: what a held layer state changes, never a Styled-by row. */
  kind: "class" | "utility" | "component" | "changed" | "state";
  /** Stable within one model: the row's identity for a filter. */
  key: string;
  label: string;
  name: string;
  /** The authored properties the source sets on this layer. */
  properties: string[];
}

export interface DesignStyledBy {
  summary: string;
  groups: DesignStyledByGroup[];
}

export interface DesignStyleOrigins {
  /** The origin of one field's property; null for an initial value. */
  of(property: string): DesignStyleOrigin | null;
  /** Null when no class or component styles the layer (drawn by hand). */
  styledBy: DesignStyledBy | null;
}

export interface DesignStyleOriginsContext {
  label: DesignStyleOriginLabel;
  /** Style sources whose classes are utilities (Tailwind). */
  utilitySources: ReadonlySet<string>;
  themeLabel?: (theme: string) => string;
}

// Properties a layer takes from its parent when it does not set them.
const INHERITED_PROPERTIES = new Set([
  "color",
  "cursor",
  "direction",
  "font",
  "font-family",
  "font-feature-settings",
  "font-size",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-weight",
  "letter-spacing",
  "line-height",
  "list-style",
  "list-style-position",
  "list-style-type",
  "tab-size",
  "text-align",
  "text-indent",
  "text-shadow",
  "text-transform",
  "visibility",
  "white-space",
  "word-break",
  "word-spacing",
]);

const PROPERTY_LABELS: Record<string, string> = {
  "background-color": "Fill",
  background: "Fill",
  "border-color": "Stroke",
  "border-radius": "Corner radius",
  "border-width": "Stroke width",
  "box-shadow": "Shadow",
  color: "Text color",
  "column-gap": "Gap",
  "font-family": "Font",
  "font-size": "Size",
  "font-weight": "Weight",
  gap: "Gap",
  height: "Height",
  left: "X",
  top: "Y",
  rotate: "Rotation",
  "letter-spacing": "Letter spacing",
  "line-height": "Line height",
  margin: "Margin",
  opacity: "Opacity",
  padding: "Padding",
  "row-gap": "Gap",
  width: "Width",
};

/** The name a person knows a property by: Fill for background-color. */
export function designStylePropertyLabel(property: string): string {
  const known = PROPERTY_LABELS[property];
  if (known) return known;
  const side = /^(padding|margin)-(?:top|right|bottom|left)$/.exec(property);
  if (side) return PROPERTY_LABELS[side[1]!]!;
  const words = property.replace(/^-+/, "").split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A value as a field shows it: 6 for 6px, a colour as the colour field's
 * hex (B22222, with its opacity when not opaque). Colour names stay as
 * written: only notations that parse without the browser are converted. */
function shown(value: string): string {
  const text = value.trim();
  const pixels = /^(-?(?:\d+\.?\d*|\.\d+))px$/.exec(text);
  if (pixels) return pixels[1]!;
  const color = parseDesignColor(text);
  if (!color) return text;
  const hex = designColorValueText(color, "hex");
  return color.a < 1 ? `${hex} at ${Math.round(color.a * 100)}%` : hex;
}

/** "radius-md, which is 6", or the value itself. */
function tokenPhrase(
  value: string,
  tokens: readonly { name: string; value: string }[] | undefined,
  joiner: (name: string, resolved: string) => string,
): string {
  const byName = new Map((tokens ?? []).map((token) => [token.name, token.value]));
  const name = designStyleTokenReference(value, (candidate) => byName.get(candidate));
  if (!name) return shown(value);
  const resolved = byName.get(name)?.trim();
  const bare = name.replace(/^--/, "");
  return resolved ? joiner(bare, shown(resolved)) : bare;
}

function ownSelector(selector: string | undefined, oid: string): boolean {
  const found = selector
    ? /^\[\s*data-oid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]$/i.exec(selector.trim())
    : null;
  return Boolean(found && (found[1] ?? found[2] ?? found[3]) === oid);
}

/** The layer's own declaration: its style attribute, or an unconditional
 * rule written for exactly it. One inside @media, @supports or @layer is
 * named like any other rule; the editor cannot reset it. */
function ownStyle(style: DesignRuntimeAuthoredStyle, oid: string): boolean {
  return style.scope === "inline" || (!style.conditional && ownSelector(style.selector, oid));
}

type Attributed = Pick<
  DesignRuntimeReplacedStyle,
  "origin" | "sourceId" | "component" | "selector" | "subjectClasses"
> & { scope?: DesignRuntimeAuthoredStyle["scope"] };

/** Which named source a rule stands for, before any wording. */
function sourceOf(
  style: Attributed,
  context: DesignStyleOriginsContext,
): { kind: "component" | "utility" | "class" | "reset" | "rule"; name: string } {
  if (style.component) return { kind: "component", name: style.component };
  if (style.scope === "base") return { kind: "reset", name: style.selector ?? "" };
  const subject = style.subjectClasses?.at(-1);
  if (subject) {
    return style.origin === "source" && style.sourceId && context.utilitySources.has(style.sourceId)
      ? { kind: "utility", name: subject }
      : { kind: "class", name: `.${subject}` };
  }
  return { kind: "rule", name: style.selector ?? "" };
}

function fromPhrase(source: ReturnType<typeof sourceOf>): string {
  switch (source.kind) {
    case "component":
      return `the component ${source.name}`;
    case "utility":
      return `the utility ${source.name}`;
    case "class":
      return `the class ${source.name}`;
    case "reset":
      return `a reset (${source.name})`;
    default:
      return source.name ? `the rule ${source.name}` : "a rule";
  }
}

/** Where the token a value reads is declared, when that is somewhere other
 * than the rule itself: radius-md in tokens.css for a frame's class. */
function tokenRows(
  style: DesignRuntimeAuthoredStyle,
  ruleLabel: string | null,
  context: DesignStyleOriginsContext,
): DesignStyleCardRow[] {
  const tokens = style.tokens ?? [];
  const byName = new Map(tokens.map((token) => [token.name, token.value]));
  const name = designStyleTokenReference(style.value, (candidate) => byName.get(candidate));
  const token = name ? tokens.find((candidate) => candidate.name === name) : undefined;
  const label = token?.origin ? context.label(token) : null;
  return label && label !== ruleLabel ? [{ key: "Token", text: `declared in ${label}` }] : [];
}

function themeRows(
  style: DesignRuntimeAuthoredStyle,
  context: DesignStyleOriginsContext,
): DesignStyleCardRow[] {
  return Object.entries(style.themeValues ?? {}).map(([theme, value]) => ({
    key: context.themeLabel?.(theme) ?? theme,
    text: shown(value),
  }));
}

const STATE_LABELS: Record<DesignRuntimeNodeState, string> = {
  hover: "Hover",
  focus: "Focus",
  "focus-visible": "Focus visible",
  active: "Active",
  disabled: "Disabled",
};

/** A layer state as the State menu names it. */
export function designStateLabel(state: DesignRuntimeNodeState): string {
  return STATE_LABELS[state];
}

function stateClause(state: DesignRuntimeNodeState): string {
  return state === "disabled" ? "when disabled" : `on ${STATE_LABELS[state].toLowerCase()}`;
}

/** What a held state changes on the layer: the properties its own rules
 * win, for the panel's filter, and how many fields that is, a shorthand
 * counted once with the longhands it sets. */
export function designHeldStateChanges(details: DesignRuntimeNodeDetails): { properties: string[]; count: number } {
  const properties = Object.entries(details.authoredStyles ?? {})
    .filter(([, style]) => style.state !== undefined)
    .map(([property]) => property);
  const count = properties.filter(
    (property) => !properties.some((other) => other !== property && authoredDeclarationAffects(other, property)),
  ).length;
  return { properties, count };
}

function originOfStyle(
  property: string,
  style: DesignRuntimeAuthoredStyle,
  oid: string,
  context: DesignStyleOriginsContext,
): DesignStyleOrigin {
  const own = ownStyle(style, oid);
  if (own) {
    const replaced = style.replaced;
    if (!replaced) {
      return {
        kind: "set-here",
        from: "this layer",
        card: {
          rows: [
            { key: "Value", text: `${tokenPhrase(style.value, style.tokens, (name) => name)}, set on this layer` },
            ...tokenRows(style, null, context),
            ...themeRows(style, context),
          ],
        },
      };
    }
    const declared = style.declared ?? property;
    const card: DesignStyleCard = {
      rows: [
        { key: "Value", text: `${tokenPhrase(style.value, style.tokens, (name) => name)}, changed on this layer` },
        ...tokenRows(style, null, context),
        {
          key: "Was",
          text: `${tokenPhrase(replaced.value, replaced.tokens, (name, resolved) => `${name} (${resolved})`)} from ${fromPhrase(sourceOf(replaced, context))}`,
        },
        ...themeRows(style, context),
      ],
      reset: {
        properties: [declared],
        text:
          declared === property || !designStyleShorthands(property).includes(declared)
            ? "Reset"
            : `Resets ${declared} on all sides`,
      },
    };
    if (replaced.others) {
      card.foot = `Used by ${plural(replaced.others, "other layer", "other layers")} in this frame`;
    }
    return { kind: "changed", from: "this layer", card };
  }
  const source = sourceOf(style, context);
  const from = style.state ? `${fromPhrase(source)}, ${stateClause(style.state)}` : fromPhrase(source);
  const rows: DesignStyleCardRow[] = [
    { key: "Value", text: tokenPhrase(style.value, style.tokens, (name, resolved) => `${name}, which is ${resolved}`) },
    { key: "From", text: from },
  ];
  const label = context.label(style);
  if (label) rows.push({ key: "Source", text: label });
  rows.push(...tokenRows(style, label, context), ...themeRows(style, context));
  if (style.important) {
    return { kind: "forced", from, card: { rows, forcedBy: source.name || (style.selector ?? "") } };
  }
  const kind: DesignStyleOriginKind =
    source.kind === "rule"
      ? style.tokens?.length
        ? "token"
        : "class"
      : source.kind;
  return { kind, from, card: { rows } };
}

function styledByOf(
  styles: Readonly<Record<string, DesignRuntimeAuthoredStyle>>,
  oid: string,
  context: DesignStyleOriginsContext,
): DesignStyledBy | null {
  const classes = new Map<string, string[]>();
  const utilities = new Map<string, string[]>();
  const components = new Map<string, string[]>();
  const changed: string[] = [];
  for (const [property, style] of Object.entries(styles)) {
    if (ownStyle(style, oid)) {
      if (style.replaced) changed.push(property);
      continue;
    }
    const source = sourceOf(style, context);
    const bucket =
      source.kind === "class"
        ? classes
        : source.kind === "utility"
          ? utilities
          : source.kind === "component"
            ? components
            : null;
    if (!bucket) continue;
    const properties = bucket.get(source.name) ?? [];
    properties.push(property);
    bucket.set(source.name, properties);
  }
  if (classes.size + utilities.size + components.size === 0) return null;
  const groups: DesignStyledByGroup[] = [];
  for (const [name, properties] of classes) {
    groups.push({ kind: "class", key: `class:${name}`, label: "Class", name, properties });
  }
  if (utilities.size > 0) {
    const names = [...utilities.keys()];
    groups.push({
      kind: "utility",
      key: "utilities",
      label: "Utilities",
      name: names.length > 4 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : listed(names),
      properties: [...utilities.values()].flat(),
    });
  }
  for (const [name, properties] of components) {
    groups.push({ kind: "component", key: `component:${name}`, label: "Component", name, properties });
  }
  if (changed.length > 0) {
    groups.push({
      kind: "changed",
      key: "changed",
      label: "Changed here",
      name: listed([...new Set(changed.map(designStylePropertyLabel))]),
      properties: changed,
    });
  }
  const parts: string[] = [];
  if (classes.size > 0) parts.push(plural(classes.size, "class", "classes"));
  if (utilities.size > 0) parts.push(plural(utilities.size, "utility", "utilities"));
  if (components.size > 0) parts.push(plural(components.size, "component", "components"));
  // Three counts read as a plain list, which fits the 280px panel on one line.
  return { summary: `Styled by ${parts.length > 2 ? parts.join(", ") : listed(parts)}`, groups };
}

const MODELS = new WeakMap<
  DesignRuntimeNodeDetails,
  { context: DesignStyleOriginsContext; model: DesignStyleOrigins }
>();

/** One model per details object and context; fields ask it per property. */
export function designStyleOrigins(
  details: DesignRuntimeNodeDetails,
  context: DesignStyleOriginsContext,
): DesignStyleOrigins {
  const cached = MODELS.get(details);
  if (cached?.context === context) return cached.model;
  const styles = details.authoredStyles ?? {};
  const answers = new Map<string, DesignStyleOrigin | null>();
  const resolve = (property: string): DesignStyleOrigin | null => {
    const style =
      styles[property] ??
      designStyleShorthands(property)
        .map((shorthand) => styles[shorthand])
        .find(Boolean);
    if (style) return originOfStyle(property, style, details.oid, context);
    if (details.baseStyleProperties?.includes(property)) {
      return { kind: "reset", from: "a reset", card: { rows: [{ key: "From", text: "a reset" }] } };
    }
    // Without the authored list the runtime said nothing either way.
    if (
      INHERITED_PROPERTIES.has(property) &&
      details.authoredStyleProperties !== undefined &&
      !isDesignRuntimeStylePropertyAuthored(details.authoredStyleProperties, property)
    ) {
      return {
        kind: "inherited",
        from: "a parent layer",
        card: { rows: [{ key: "From", text: "inherited from a parent layer" }] },
      };
    }
    return null;
  };
  const model: DesignStyleOrigins = {
    of(property) {
      if (!answers.has(property)) answers.set(property, resolve(property));
      return answers.get(property)!;
    },
    styledBy: styledByOf(styles, details.oid, context),
  };
  MODELS.set(details, { context, model });
  return model;
}

/** Whether a field's property is among what a Styled-by source sets; a
 * shorthand covers its sides. */
export function designStyleFilterIncludes(
  group: Pick<DesignStyledByGroup, "properties">,
  property: string,
): boolean {
  return group.properties.some((authored) => authoredDeclarationAffects(authored, property));
}
