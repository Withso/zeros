// A component's options, as its file declares them in
// <template data-zd-options>: one <zd-option>, <zd-derive> or <zd-variant>
// per line. This module reads those elements (the caller parses the HTML),
// works out an instance's values, and writes the values that reach CSS.
// Values enter CSS only in strict forms: a finite number with a known unit,
// a colour from a fixed grammar or var(--token), and an easing from a fixed
// grammar. Text, choices and booleans never reach CSS.

import {
  COMPONENT_EXPRESSION_RESERVED_NAMES,
  ComponentExpressionError,
  componentExpressionNames,
  createComponentExpressionBudget,
  evaluateComponentExpression,
  parseComponentExpression,
  type ComponentExpression,
  type ComponentExpressionBudget,
  type ComponentExpressionValue,
} from "./component-expressions";

export const COMPONENT_OPTION_LIMITS = Object.freeze({
  options: 64,
  variants: 32,
  derived: 32,
  choices: 16,
  name: 32,
  label: 64,
  text: 2_048,
});

export type ComponentOptionKind = "number" | "boolean" | "choice" | "color" | "text" | "easing";
const KINDS: readonly ComponentOptionKind[] = ["number", "boolean", "choice", "color", "text", "easing"];

export interface ComponentEasing {
  /** As written: a keyword, cubic-bezier(), steps() or spring(bounce). */
  curve: string;
  /** Milliseconds. */
  duration: number;
}
export type ComponentOptionValue = number | boolean | string | ComponentEasing;

interface OptionBase {
  name: string;
  label: string;
  group?: string;
  offset: number;
}
export type ComponentOption =
  | (OptionBase & { kind: "number"; default: number; min?: number; max?: number; step?: number; unit?: string })
  | (OptionBase & { kind: "boolean"; default: boolean })
  | (OptionBase & { kind: "choice"; default: string; choices: string[]; choiceLabels: string[] })
  | (OptionBase & { kind: "color"; default: string })
  | (OptionBase & { kind: "text"; default: string })
  | (OptionBase & { kind: "easing"; default: ComponentEasing });

export interface ComponentDerived {
  name: string;
  source: string;
  expression: ComponentExpression;
  unit?: string;
  offset: number;
}

export interface ComponentVariant {
  name: string;
  values: Map<string, ComponentOptionValue>;
  offset: number;
}

export interface ComponentDeclaration {
  options: ComponentOption[];
  derived: ComponentDerived[];
  variants: ComponentVariant[];
}

export interface ComponentDeclarationElement {
  tag: string;
  attributes: readonly { name: string; value: string }[];
  /** Where the element starts in its file, for diagnostics. */
  offset: number;
}

export interface ComponentOptionProblem {
  message: string;
  severity: "error" | "warning";
  offset?: number;
}

/** Attributes an instance keeps for itself; an option may not take them. */
const HOST_ATTRIBUTES = new Set([
  "class", "style", "id", "hidden", "slot", "title", "lang", "dir", "tabindex", "role", "part", "is", "inert", "draggable",
  "popover", "contenteditable", "spellcheck", "translate", "autofocus", "accesskey", "autocapitalize", "enterkeyhint",
  "inputmode", "nonce", "exportparts", "itemprop", "itemscope", "itemtype", "itemid", "itemref", "name",
]);
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Units a number option may carry into CSS. */
const UNITS = new Set(["px", "%", "rem", "em", "ch", "vw", "vh", "fr", "deg", "ms", "s"]);
export const COMPONENT_VARIANT_ATTRIBUTE = "zd-variant";

/** Why a name cannot be an option, derived value or loop variable; null when it can. */
export function componentOptionNameProblem(name: string): string | null {
  if (name.length > COMPONENT_OPTION_LIMITS.name) return `An option name may be at most ${COMPONENT_OPTION_LIMITS.name} characters.`;
  if (!NAME.test(name)) return `The option name ${JSON.stringify(name)} must use lowercase letters, digits and single hyphens, starting with a letter.`;
  if (/^(?:data|aria|zd)-/.test(name) || /^on/.test(name) || HOST_ATTRIBUTES.has(name) || COMPONENT_EXPRESSION_RESERVED_NAMES.has(name))
    return `${name} is reserved and cannot name an option.`;
  return null;
}

const sentence = (value: string) => {
  const words = value.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

// ── Values ─────────────────────────────────────────────────────

const NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;
const formatList = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;

/** Built on first use, so code that never checks a colour does not carry it. */
let namedColors: ReadonlySet<string> | undefined;
const isNamedColor = (value: string) => (namedColors ??= new Set(
  ("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue " +
    "chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey " +
    "darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray " +
    "darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen " +
    "fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen " +
    "lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime " +
    "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
    "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive " +
    "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue " +
    "slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke " +
    "yellow yellowgreen transparent currentcolor").split(" "),
)).has(value);
const COLOR_FUNCTION = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(([^()]*)\)$/;
const COLOR_ARGUMENT = /^(?:[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:%|deg|rad|grad|turn)?|none)$/;
const TOKEN_REFERENCE = /^var\(\s*--[A-Za-z0-9_-]{1,128}\s*\)$/;

/** A colour in one of the forms CSS accepts that cannot carry anything else. */
function strictColor(raw: string): string | null {
  const value = raw.trim();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return value;
  if (isNamedColor(value.toLowerCase())) return value;
  if (TOKEN_REFERENCE.test(value)) return value.replace(/\s+/g, "");
  const call = COLOR_FUNCTION.exec(value.toLowerCase());
  if (!call) return null;
  const parts = call[2]!.split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4 || !parts.every((part) => COLOR_ARGUMENT.test(part))) return null;
  return value;
}

const EASING_KEYWORDS = new Set(["linear", "ease", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end"]);
const DECIMAL = "[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const CUBIC = new RegExp(`^cubic-bezier\\(\\s*(${DECIMAL})\\s*,\\s*(${DECIMAL})\\s*,\\s*(${DECIMAL})\\s*,\\s*(${DECIMAL})\\s*\\)$`);
const STEPS = /^steps\(\s*(\d{1,3})\s*(?:,\s*(jump-start|jump-end|jump-none|jump-both|start|end)\s*)?\)$/;
const SPRING = new RegExp(`^spring\\(\\s*(${DECIMAL})\\s*\\)$`);
const DURATION = /^(\d+(?:\.\d+)?)(ms|s)$/;
const MAX_DURATION_MS = 60_000;

function strictEasing(raw: string): ComponentEasing | null {
  const value = raw.trim();
  const split = value.lastIndexOf(" ");
  if (split < 0) return null;
  const curve = value.slice(0, split).trim();
  const duration = DURATION.exec(value.slice(split + 1));
  if (!duration) return null;
  const ms = Number(duration[1]) * (duration[2] === "s" ? 1_000 : 1);
  if (!Number.isFinite(ms) || ms > MAX_DURATION_MS) return null;
  if (EASING_KEYWORDS.has(curve)) return { curve, duration: ms };
  const cubic = CUBIC.exec(curve);
  if (cubic) {
    const x1 = Number(cubic[1]);
    const x2 = Number(cubic[3]);
    return x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1 ? { curve: curve.replace(/\s+/g, " "), duration: ms } : null;
  }
  const steps = STEPS.exec(curve);
  if (steps) return Number(steps[1]) >= 1 ? { curve, duration: ms } : null;
  const spring = SPRING.exec(curve);
  if (spring) {
    const bounce = Number(spring[1]);
    return bounce >= 0 && bounce <= 1 ? { curve: `spring(${bounce})`, duration: ms } : null;
  }
  return null;
}

export type ParsedOptionValue = { ok: true; value: ComponentOptionValue } | { ok: false; message: string };

/** One attribute's text as a value of this option, or why it does not fit. */
export function parseComponentOptionValue(option: ComponentOption, raw: string): ParsedOptionValue {
  const misfit = (expected: string): ParsedOptionValue => ({
    ok: false,
    message: `${option.name} must be ${expected}; ${JSON.stringify(raw.length > 40 ? `${raw.slice(0, 40)}…` : raw).replace(/^"(-?[\d.]+)"$/, "$1")} does not fit.`,
  });
  switch (option.kind) {
    case "number": {
      const range =
        option.min !== undefined && option.max !== undefined ? ` from ${option.min} to ${option.max}`
          : option.min !== undefined ? ` of at least ${option.min}`
            : option.max !== undefined ? ` of at most ${option.max}` : "";
      if (!NUMBER.test(raw.trim())) return misfit(`a number${range}`);
      const value = Number(raw);
      if (!Number.isFinite(value) || (option.min !== undefined && value < option.min) || (option.max !== undefined && value > option.max))
        return misfit(`a number${range}`);
      return { ok: true, value };
    }
    case "boolean":
      return raw === "" || raw === "true" ? { ok: true, value: true } : raw === "false" ? { ok: true, value: false } : misfit("true or false");
    case "choice":
      return option.choices.includes(raw) ? { ok: true, value: raw } : misfit(`one of ${formatList(option.choices)}`);
    case "color": {
      const value = strictColor(raw);
      return value ? { ok: true, value } : misfit("a colour (#hex, a colour name, rgb(), hsl(), oklch() and the like) or var(--token)");
    }
    case "text":
      return raw.length <= COMPONENT_OPTION_LIMITS.text
        ? { ok: true, value: raw }
        : misfit(`text of at most ${COMPONENT_OPTION_LIMITS.text.toLocaleString("en-US")} characters`);
    case "easing": {
      const value = strictEasing(raw);
      return value ? { ok: true, value } : misfit('an easing and a duration, such as "ease-out 150ms", "cubic-bezier(0.2, 0, 0, 1) 200ms" or "spring(0.2) 300ms"');
    }
  }
}

// ── Declarations ───────────────────────────────────────────────

const attributesOf = (element: ComponentDeclarationElement) => {
  const map = new Map<string, string>();
  for (const { name, value } of element.attributes) if (!map.has(name)) map.set(name, value);
  return map;
};
const finiteNumber = (raw: string | undefined): number | undefined | null =>
  raw === undefined ? undefined : NUMBER.test(raw.trim()) ? Number(raw) : null;

function readOption(element: ComponentDeclarationElement, problem: (message: string) => void): ComponentOption | null {
  const attributes = attributesOf(element);
  const name = attributes.get("name") ?? "";
  const nameProblem = componentOptionNameProblem(name);
  if (nameProblem) return problem(nameProblem), null;
  const kind = attributes.get("type") as ComponentOptionKind | undefined;
  if (!kind || !KINDS.includes(kind)) return problem(`The option ${name}'s type must be one of ${formatList(KINDS)}.`), null;
  const label = attributes.get("label") ?? sentence(name);
  if (label.length === 0 || label.length > COMPONENT_OPTION_LIMITS.label)
    return problem(`The option ${name}'s label must be 1 to ${COMPONENT_OPTION_LIMITS.label} characters.`), null;
  const group = attributes.get("group");
  if (group !== undefined && (group.length === 0 || group.length > COMPONENT_OPTION_LIMITS.label))
    return problem(`The option ${name}'s group must be 1 to ${COMPONENT_OPTION_LIMITS.label} characters.`), null;
  const base = { name, label, ...(group ? { group } : {}), offset: element.offset };
  const raw = attributes.get("default");
  if (raw === undefined && kind !== "text") return problem(`The option ${name} needs a default.`), null;
  let option: ComponentOption;
  if (kind === "number") {
    const min = finiteNumber(attributes.get("min"));
    const max = finiteNumber(attributes.get("max"));
    const step = finiteNumber(attributes.get("step"));
    const unit = attributes.get("unit");
    if (min === null || max === null || step === null) return problem(`The option ${name}'s min, max and step must be numbers.`), null;
    if (min !== undefined && max !== undefined && min > max) return problem(`The option ${name}'s min is above its max.`), null;
    if (step !== undefined && step <= 0) return problem(`The option ${name}'s step must be above 0.`), null;
    if (unit !== undefined && !UNITS.has(unit)) return problem(`The option ${name}'s unit must be one of ${formatList([...UNITS])}.`), null;
    option = { ...base, kind, default: 0, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}),
      ...(step !== undefined ? { step } : {}), ...(unit ? { unit } : {}) };
  } else if (kind === "choice") {
    const choices = (attributes.get("choices") ?? "").split(/\s+/).filter(Boolean);
    if (choices.length < 2 || choices.length > COMPONENT_OPTION_LIMITS.choices)
      return problem(`The option ${name} needs 2 to ${COMPONENT_OPTION_LIMITS.choices} choices.`), null;
    const repeated = choices.find((choice, index) => choices.indexOf(choice) !== index);
    if (repeated) return problem(`The option ${name} lists the choice ${repeated} twice.`), null;
    const bad = choices.find((choice) => !NAME.test(choice));
    if (bad) return problem(`The option ${name}'s choice ${JSON.stringify(bad)} must use lowercase letters, digits and single hyphens.`), null;
    const written = attributes.get("choice-labels")?.split("|").map((entry) => entry.trim());
    if (written && (written.length !== choices.length || written.some((entry) => !entry || entry.length > COMPONENT_OPTION_LIMITS.label)))
      return problem(`The option ${name}'s choice-labels must name each choice once, separated by |.`), null;
    option = { ...base, kind, default: "", choices, choiceLabels: written ?? choices.map(sentence) };
  } else {
    option = { ...base, kind, default: kind === "boolean" ? false : kind === "easing" ? { curve: "linear", duration: 0 } : "" } as ComponentOption;
  }
  const parsed = parseComponentOptionValue(option, raw ?? "");
  if (!parsed.ok) return problem(`The option ${name}'s default ${parsed.message.slice(name.length + 1)}`), null;
  return { ...option, default: parsed.value } as ComponentOption;
}

/** Read a component's declaration. Problems are errors unless marked; an
 * element with a problem is left out, so the rest still applies. */
export function readComponentDeclaration(
  elements: readonly ComponentDeclarationElement[],
): { declaration: ComponentDeclaration; problems: ComponentOptionProblem[] } {
  const problems: ComponentOptionProblem[] = [];
  const declaration: ComponentDeclaration = { options: [], derived: [], variants: [] };
  const names = new Set<string>();
  const counts = { "zd-option": 0, "zd-derive": 0, "zd-variant": 0 };
  for (const element of elements) {
    if (element.tag in counts) counts[element.tag as keyof typeof counts] += 1;
  }
  if (counts["zd-option"] > COMPONENT_OPTION_LIMITS.options)
    return { declaration, problems: [{ message: `A component may declare at most ${COMPONENT_OPTION_LIMITS.options} options.`, severity: "error" }] };
  if (counts["zd-variant"] > COMPONENT_OPTION_LIMITS.variants)
    return { declaration, problems: [{ message: `A component may declare at most ${COMPONENT_OPTION_LIMITS.variants} variants.`, severity: "error" }] };
  if (counts["zd-derive"] > COMPONENT_OPTION_LIMITS.derived)
    return { declaration, problems: [{ message: `A component may declare at most ${COMPONENT_OPTION_LIMITS.derived} derived values.`, severity: "error" }] };
  for (const element of elements) {
    const problem = (message: string) => problems.push({ message, severity: "error", offset: element.offset });
    if (element.tag === "zd-option") {
      const option = readOption(element, problem);
      if (!option) continue;
      if (names.has(option.name)) {
        problem(`The option ${option.name} is declared twice.`);
        continue;
      }
      names.add(option.name);
      declaration.options.push(option);
    }
  }
  const scopeNames = new Map<string, ComponentExpressionValue>(declaration.options.map((option) => [option.name, 0]));
  for (const element of elements) {
    const problem = (message: string) => problems.push({ message, severity: "error", offset: element.offset });
    const attributes = attributesOf(element);
    if (element.tag === "zd-option") continue;
    if (element.tag === "zd-derive") {
      const name = attributes.get("name") ?? "";
      const nameProblem = componentOptionNameProblem(name);
      if (nameProblem) {
        problem(nameProblem);
        continue;
      }
      if (names.has(name)) {
        problem(`The name ${name} is declared twice.`);
        continue;
      }
      const source = attributes.get("value") ?? "";
      const unit = attributes.get("unit");
      if (unit !== undefined && !UNITS.has(unit)) {
        problem(`The derived value ${name}'s unit must be one of ${formatList([...UNITS])}.`);
        continue;
      }
      let expression: ComponentExpression;
      try {
        expression = parseComponentExpression(source);
        // Check names against what is declared so far, with default values.
        checkNames(expression, scopeNames);
      } catch (error) {
        problem(`The derived value ${name}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      names.add(name);
      scopeNames.set(name, 0);
      declaration.derived.push({ name, source, expression, ...(unit ? { unit } : {}), offset: element.offset });
      continue;
    }
    if (element.tag === "zd-variant") {
      const name = attributes.get("name") ?? "";
      if (!NAME.test(name) || name.length > COMPONENT_OPTION_LIMITS.name) {
        problem(`A variant needs a name of lowercase letters, digits and single hyphens.`);
        continue;
      }
      if (name === "default") {
        problem("A variant cannot be named default: Default is the declared defaults.");
        continue;
      }
      if (declaration.variants.some((variant) => variant.name === name)) {
        problem(`The variant ${name} is declared twice.`);
        continue;
      }
      const values = new Map<string, ComponentOptionValue>();
      for (const [attribute, raw] of attributes) {
        if (attribute === "name") continue;
        const option = declaration.options.find((entry) => entry.name === attribute);
        if (!option) {
          problem(`The variant ${name} sets ${attribute}, but there is no option ${attribute}.`);
          continue;
        }
        const parsed = parseComponentOptionValue(option, raw);
        if (!parsed.ok) problem(`The variant ${name}: ${parsed.message}`);
        else values.set(attribute, parsed.value);
      }
      declaration.variants.push({ name, values, offset: element.offset });
      continue;
    }
    problem(`Use zd-option, zd-derive or zd-variant inside <template data-zd-options>, not <${element.tag}>.`);
  }
  // A derived value's type follows from the defaults; one with a unit must be a number.
  try {
    const scope = componentExpressionScope(declaration, defaultValues(declaration));
    for (const derived of declaration.derived) {
      if (derived.unit && typeof scope.get(derived.name) !== "number")
        problems.push({ message: `The derived value ${derived.name} has a unit, so it must be a number.`, severity: "error", offset: derived.offset });
    }
  } catch (error) {
    if (!(error instanceof ComponentExpressionError)) throw error;
    problems.push({ message: `A derived value cannot be worked out from the defaults: ${error.message}`, severity: "error" });
  }
  return { declaration, problems };
}

function checkNames(expression: ComponentExpression, scope: ReadonlyMap<string, ComponentExpressionValue>): void {
  const visit = (node: ComponentExpression): void => {
    switch (node.kind) {
      case "name":
        if (!scope.has(node.name)) evaluateComponentExpression(node, scope);
        return;
      case "list":
        return node.items.forEach(visit);
      case "call":
        return node.args.forEach(visit);
      case "unary":
        return visit(node.arg);
      case "binary":
        visit(node.left);
        return visit(node.right);
      case "conditional":
        visit(node.test);
        visit(node.yes);
        return visit(node.no);
      default:
        return;
    }
  };
  visit(expression);
}

// ── Instances ──────────────────────────────────────────────────

const defaultValues = (declaration: ComponentDeclaration) =>
  new Map<string, ComponentOptionValue>(declaration.options.map((option) => [option.name, option.default]));

/** What an instance would take without its own option attributes: its
 * variant's value, else the default. */
export function componentInheritedValues(declaration: ComponentDeclaration, variant: string | null | undefined): Map<string, ComponentOptionValue> {
  const values = defaultValues(declaration);
  const chosen = variant ? declaration.variants.find((entry) => entry.name === variant) : undefined;
  if (chosen) for (const [name, value] of chosen.values) values.set(name, value);
  return values;
}

/** An instance's values from its attributes: each option attribute over its
 * `zd-variant` over the defaults. An attribute that does not fit keeps the
 * inherited value and is reported. Host attributes are left alone. */
export function componentOptionValues(
  declaration: ComponentDeclaration,
  attributes: ReadonlyMap<string, string>,
): { values: Map<string, ComponentOptionValue>; problems: ComponentOptionProblem[] } {
  const problems: ComponentOptionProblem[] = [];
  const variant = attributes.get(COMPONENT_VARIANT_ATTRIBUTE);
  if (variant !== undefined && variant !== "default" && !declaration.variants.some((entry) => entry.name === variant))
    problems.push({ message: `There is no variant ${variant}; the defaults apply.`, severity: "error" });
  const values = componentInheritedValues(declaration, variant);
  const options = new Map(declaration.options.map((option) => [option.name, option]));
  for (const [name, raw] of attributes) {
    if (name === COMPONENT_VARIANT_ATTRIBUTE) continue;
    const option = options.get(name);
    if (!option) {
      if (!HOST_ATTRIBUTES.has(name) && !/^(?:data|aria|zd)-/.test(name) && !/^on/.test(name))
        problems.push({ message: `This component has no option ${name}.`, severity: "warning" });
      continue;
    }
    const parsed = parseComponentOptionValue(option, raw);
    if (parsed.ok) values.set(name, parsed.value);
    else problems.push({ message: parsed.message, severity: "error" });
  }
  return { values, problems };
}

/** The names a template's expressions see: every option but an easing, then
 * each derived value in order. Throws ComponentExpressionError. */
export function componentExpressionScope(
  declaration: ComponentDeclaration,
  values: ReadonlyMap<string, ComponentOptionValue>,
  budget: ComponentExpressionBudget = createComponentExpressionBudget(),
): Map<string, ComponentExpressionValue> {
  const scope = new Map<string, ComponentExpressionValue>();
  for (const option of declaration.options) {
    const value = values.get(option.name) ?? option.default;
    if (option.kind !== "easing") scope.set(option.name, value as ComponentExpressionValue);
  }
  for (const derived of declaration.derived) {
    const value = evaluateComponentExpression(derived.expression, scope, budget);
    scope.set(derived.name, value);
  }
  return scope;
}

// ── CSS ────────────────────────────────────────────────────────

const cssNumber = (value: number) => {
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

/** A spring as linear() stops: a damped oscillator settling by the end. */
function springCurve(bounce: number): string {
  const damping = 1 - Math.min(Math.max(bounce, 0), 1) * 0.9;
  const omega = 2 * Math.PI * 1.6;
  const stops: string[] = [];
  const STOPS = 32;
  for (let index = 0; index < STOPS; index += 1) {
    const t = index / (STOPS - 1);
    let x: number;
    if (damping >= 1) x = 1 - Math.exp(-omega * t) * (1 + omega * t);
    else {
      const damped = omega * Math.sqrt(1 - damping * damping);
      x = 1 - Math.exp(-damping * omega * t) * (Math.cos(damped * t) + ((damping * omega) / damped) * Math.sin(damped * t));
    }
    stops.push(index === STOPS - 1 ? "1" : cssNumber(x));
  }
  return `linear(${stops.join(", ")})`;
}

const easingCss = (easing: ComponentEasing) => {
  const spring = /^spring\(([^)]*)\)$/.exec(easing.curve);
  return spring ? springCurve(Number(spring[1])) : easing.curve;
};

/** The custom properties an instance (or a main frame) sets: every number,
 * colour and easing option and every numeric derived value, defaults
 * included, so nothing an outer instance sets reaches an inner one. */
export function componentOptionCss(
  declaration: ComponentDeclaration,
  values: ReadonlyMap<string, ComponentOptionValue>,
  derived?: ReadonlyMap<string, ComponentExpressionValue>,
): string {
  const declarations: string[] = [];
  for (const option of declaration.options) {
    const value = values.get(option.name) ?? option.default;
    if (option.kind === "number") declarations.push(`--zd-${option.name}: ${cssNumber(value as number)}${option.unit ?? ""};`);
    else if (option.kind === "color") {
      const color = strictColor(String(value));
      if (color) declarations.push(`--zd-${option.name}: ${color};`);
    } else if (option.kind === "easing") {
      const easing = value as ComponentEasing;
      declarations.push(`--zd-${option.name}-easing: ${easingCss(easing)};`, `--zd-${option.name}-duration: ${cssNumber(easing.duration)}ms;`);
    }
  }
  let scope = derived;
  if (!scope && declaration.derived.length > 0) {
    try {
      scope = componentExpressionScope(declaration, values);
    } catch (error) {
      if (!(error instanceof ComponentExpressionError)) throw error;
    }
  }
  for (const entry of declaration.derived) {
    const value = scope?.get(entry.name);
    if (typeof value === "number" && Number.isFinite(value)) declarations.push(`--zd-${entry.name}: ${cssNumber(value)}${entry.unit ?? ""};`);
  }
  return declarations.join(" ");
}

/** css: the option reaches the frame only through its custom property (or a
 * derived one), so a preview can set the property. structure: a hole, a
 * condition or a loop reads it, directly or through a derived value, so the
 * frame changes only once the option is written. Text, choices and booleans
 * never reach CSS and are always structure. */
export type ComponentOptionReach = "css" | "structure";

export function componentOptionReach(
  declaration: ComponentDeclaration,
  templateNames: ReadonlySet<string>,
): Record<string, ComponentOptionReach> {
  const structural = new Set(templateNames);
  // A derived value the template reads makes what it reads structural too.
  for (const derived of [...declaration.derived].reverse())
    if (structural.has(derived.name)) componentExpressionNames(derived.expression, structural);
  return Object.fromEntries(declaration.options.map((option): [string, ComponentOptionReach] => [
    option.name,
    (option.kind === "number" || option.kind === "color" || option.kind === "easing") && !structural.has(option.name) ? "css" : "structure",
  ]));
}
