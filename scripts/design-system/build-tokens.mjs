// ============================================================
// build-tokens.mjs
// ------------------------------------------------------------
// DTCG 2025.10 values → existing CSS names, aliases and cascade order.
// This dependency-free emitter implements the local resolver/token subset
// documented in styles/tokens/README.md. Unsupported input fails explicitly.
// Only marked declaration groups change; imports, explanations, theme resets,
// type/radius wiring, native color-scheme hints and base rules stay authored.
// ============================================================
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { declarations, extractBlock, extractBlockRange, hslToRgb, toHex, TOKENS_FILE } from "./token-palette.mjs";

export const TOKEN_RESOLVER_FILE = "styles/tokens/zeros.resolver.json";
export const MARKETING_TOKENS_FILE = "apps/marketing/src/index.css";
const EXTENSION = "org.zeros";
const ALIAS = /^\{([a-z0-9-]+(?:\.[a-z0-9-]+)*)\}$/;
const SECTION = /^[a-z0-9-]+$/;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const number = (value) => typeof value === "number" && Number.isFinite(value);

function fail(message, file = TOKEN_RESOLVER_FILE) {
  const error = new Error(`${file}: ${message}`);
  error.file = file;
  throw error;
}

function json(root, file) {
  try {
    const value = JSON.parse(readFileSync(join(root, file), "utf8"));
    if (!object(value)) fail("JSON root must be an object", file);
    return value;
  } catch (error) {
    if (error.file) throw error;
    fail(`Cannot read JSON: ${error.message}`, file);
  }
}

function flatten(document, file, path = [], inheritedType, tokens = new Map()) {
  if (!object(document)) fail(`Invalid token/group at ${path.join(".")}`, file);
  if ("$extends" in document || "$root" in document || "$ref" in document) {
    fail(`Unsupported token inheritance or JSON pointer at ${path.join(".")}`, file);
  }
  const type = document.$type ?? inheritedType;
  if ("$value" in document) {
    const name = path.join(".");
    const metadata = document.$extensions?.[EXTENSION];
    if (!type || typeof document.$description !== "string" || !document.$description.trim()) {
      fail(`${name} requires $type and a nonempty $description`, file);
    }
    if (document.$description.includes("*/")) fail(`Unsafe description at ${name}`, file);
    if (!object(metadata) || !/^--[a-z][a-z0-9-]*$/.test(metadata.cssName) || !SECTION.test(metadata.section ?? "")) {
      fail(`${name} requires org.zeros cssName and section metadata`, file);
    }
    if (metadata.cssFormat !== undefined && metadata.cssFormat !== "multiline") {
      fail(`Unsupported cssFormat at ${name}`, file);
    }
    if (metadata.utility !== undefined && (
      type !== "color" || !/^--color-[a-z][a-z0-9-]*$/.test(metadata.utility) ||
      !SECTION.test(metadata.utilitySection ?? "") || !Number.isInteger(metadata.utilityOrder) || metadata.utilityOrder < 0
    )) fail(`Invalid utility wiring at ${name}`, file);
    const token = { ...document, $type: type };
    tokens.set(name, { path: name, token, cssName: metadata.cssName, metadata, file });
    return tokens;
  }
  for (const [name, child] of Object.entries(document)) {
    if (name.startsWith("$")) continue;
    if (!/^[a-z0-9-]+$/.test(name)) fail(`Unsupported token/group name ${name}`, file);
    flatten(child, file, [...path, name], type, tokens);
  }
  return tokens;
}

function sourceSet(root, sources) {
  if (!Array.isArray(sources)) fail("Token sources must be an array");
  const tokens = new Map();
  const folder = resolve(root, "styles/tokens");
  for (const source of sources) {
    if (!object(source) || Object.keys(source).length !== 1 || typeof source.$ref !== "string") {
      fail("Only local .tokens.json source references are supported");
    }
    const absolute = resolve(folder, source.$ref);
    if (!absolute.startsWith(`${folder}${sep}`) || !source.$ref.endsWith(".tokens.json")) {
      fail(`Unsupported token source ${source.$ref}`);
    }
    const file = `styles/tokens/${source.$ref}`;
    for (const [path, entry] of flatten(json(root, file), file)) tokens.set(path, entry);
  }
  return tokens;
}

function resolvedValue(entry, tokens, seen = new Set()) {
  if (seen.has(entry.path)) fail(`Alias cycle at ${entry.path}`, entry.file);
  const visited = new Set([...seen, entry.path]);
  const follow = (value, expectedType) => {
    if (typeof value === "string" && ALIAS.test(value)) {
      const path = value.match(ALIAS)[1];
      const target = tokens.get(path);
      if (!target) fail(`Unknown alias ${path} at ${entry.path}`, entry.file);
      if (expectedType && target.token.$type !== expectedType) {
        fail(`Alias type mismatch at ${entry.path}: ${path} is ${target.token.$type}, expected ${expectedType}`, entry.file);
      }
      return resolvedValue(target, tokens, visited);
    }
    if (Array.isArray(value)) return value.map((item) => follow(item, expectedType));
    if (object(value)) {
      const fields = expectedType === "shadow"
        ? { color: "color", offsetX: "dimension", offsetY: "dimension", blur: "dimension", spread: "dimension" }
        : expectedType === "color"
          ? { components: "number", alpha: "number" }
          : expectedType === "dimension" ? { value: "number" } : {};
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, follow(item, fields[key])]));
    }
    return value;
  };
  return follow(entry.token.$value, entry.token.$type);
}

function validColor(value) {
  if (!object(value) || !Array.isArray(value.components) || value.components.length !== 3 || !value.components.every(number)) return false;
  if (value.alpha !== undefined && (!number(value.alpha) || value.alpha < 0 || value.alpha > 1)) return false;
  const [h, s, l] = value.components;
  return value.colorSpace === "hsl"
    ? h >= 0 && h < 360 && s >= 0 && s <= 100 && l >= 0 && l <= 100
    : value.colorSpace === "srgb" && value.components.every((channel) => channel >= 0 && channel <= 1);
}

const validDimension = (value) => object(value) && number(value.value) && ["px", "rem"].includes(value.unit);
const validShadow = (value) => object(value) && validColor(value.color) &&
  ["offsetX", "offsetY", "blur", "spread"].every((field) => validDimension(value[field])) &&
  value.blur.value >= 0 && (value.inset === undefined || typeof value.inset === "boolean");

function validate(tokens) {
  const names = new Set();
  const utilityNames = new Set();
  const utilityOrders = new Set();
  for (const entry of tokens.values()) {
    if (names.has(entry.cssName)) fail(`Duplicate CSS name ${entry.cssName}`, entry.file);
    names.add(entry.cssName);
    const { utility, utilityOrder } = entry.metadata;
    if (utility !== undefined) {
      if (utilityNames.has(utility) || utilityOrders.has(utilityOrder)) fail(`Duplicate utility or order at ${entry.path}`, entry.file);
      utilityNames.add(utility);
      utilityOrders.add(utilityOrder);
    }
    const value = resolvedValue(entry, tokens);
    const valid = {
      color: validColor,
      dimension: validDimension,
      fontWeight: (weight) => number(weight) && weight >= 1 && weight <= 1000,
      shadow: (shadow) => Array.isArray(shadow) ? shadow.length > 0 && shadow.every(validShadow) : validShadow(shadow),
    }[entry.token.$type];
    if (!valid || !valid(value)) fail(`Invalid or unsupported ${entry.token.$type} value at ${entry.path}`, entry.file);
  }
}

function validateMarketingExports(resolver, base, themes) {
  const groups = resolver.$extensions?.[EXTENSION]?.marketing?.groups;
  if (!object(groups) || Object.keys(groups).length === 0) fail("Marketing exports require nonempty groups");
  const names = new Set();
  const exported = new Set();
  for (const [section, paths] of Object.entries(groups)) {
    if (!SECTION.test(section) || !Array.isArray(paths) || paths.length === 0) fail(`Invalid marketing group ${section}`);
    for (const path of paths) {
      const entry = base.get(path);
      if (typeof path !== "string" || !entry || entry.token.$type !== "color" || names.has(entry.cssName)) {
        fail(`Unknown, duplicate or non-color marketing export ${path}`);
      }
      names.add(entry.cssName);
      exported.add(path);
    }
  }
  // Live var() chains must resolve entirely within the site's exported palette.
  for (const [appearance, tokens] of Object.entries(themes)) {
    for (const path of exported) {
      let entry = tokens.get(path);
      let alias;
      while (typeof entry.token.$value === "string" && (alias = entry.token.$value.match(ALIAS))) {
        const dependency = alias[1];
        if (!exported.has(dependency)) {
          fail(`Marketing export ${path} (${appearance}) depends on unexported ${dependency}`, entry.file);
        }
        entry = tokens.get(dependency);
      }
    }
  }
  return { groups, names };
}

/** The app's two appearances, preserving base and override declaration order. */
export function readTokenSources(root = process.cwd()) {
  const resolver = json(root, TOKEN_RESOLVER_FILE);
  if (resolver.version !== "2025.10") fail("Resolver version must be 2025.10");
  const order = [{ $ref: "#/sets/base" }, { $ref: "#/modifiers/appearance" }];
  if (JSON.stringify(resolver.resolutionOrder) !== JSON.stringify(order)) {
    fail("resolutionOrder must apply the base set before the appearance modifier");
  }
  const appearance = resolver.modifiers?.appearance;
  if (!object(resolver.sets) || Object.keys(resolver.sets).join() !== "base" ||
    !object(resolver.modifiers) || Object.keys(resolver.modifiers).join() !== "appearance" ||
    !object(appearance?.contexts) || Object.keys(appearance.contexts).sort().join() !== "dark,light" ||
    appearance.default !== "dark" || !Array.isArray(appearance.contexts.dark) || appearance.contexts.dark.length !== 0) {
    fail("Resolver must define one base set and appearance dark (default, no overrides)/light");
  }
  const base = sourceSet(root, resolver.sets.base?.sources);
  const lightOverrides = sourceSet(root, appearance.contexts.light);
  if (base.size === 0) fail("Base set contains no tokens");
  for (const [path, entry] of lightOverrides) {
    const original = base.get(path);
    if (!original) fail(`Light override declares unknown token ${path}`, entry.file);
    if (original.cssName !== entry.cssName || original.token.$type !== entry.token.$type) {
      fail(`Light must preserve CSS name and type for ${path}`, entry.file);
    }
    for (const key of ["utility", "utilitySection", "utilityOrder"]) {
      if (entry.metadata[key] !== original.metadata[key]) fail(`Light must preserve utility wiring for ${path}`, entry.file);
    }
  }
  const themes = { dark: base, light: new Map([...base, ...lightOverrides]) };
  for (const tokens of Object.values(themes)) validate(tokens);
  const marketing = validateMarketingExports(resolver, base, themes);
  return { base, lightOverrides, themes, marketing };
}

// Decimal rounding prevents binary floating-point artifacts in generated CSS.
const decimal = (value) => String(Number(value.toFixed(12)));
function colorCss(value, multiline = false) {
  const [h, s, l] = value.components;
  if (value.colorSpace === "hsl") {
    const body = `${decimal(h)} ${decimal(s)}% ${decimal(l)}%${value.alpha === undefined ? "" : ` / ${decimal(value.alpha)}`}`;
    return multiline ? `hsl(\n    ${body}\n  )` : `hsl(${body})`;
  }
  const channels = value.components.map((channel) => decimal(channel * 255)).join(", ");
  return value.alpha === undefined ? `rgb(${channels})` : `rgba(${channels}, ${decimal(value.alpha)})`;
}

const dimensionCss = (value, zeroUnit = true) => value.value === 0 && !zeroUnit ? "0" : `${decimal(value.value)}${value.unit}`;
function cssAlias(value, tokens) {
  const alias = typeof value === "string" && value.match(ALIAS);
  return alias ? `var(${tokens.get(alias[1]).cssName})` : undefined;
}

function shadowCss(value, tokens) {
  const layers = Array.isArray(value) ? value : [value];
  const dimension = (field) => cssAlias(field, tokens) ?? dimensionCss(field, false);
  return layers.map((layer) => cssAlias(layer, tokens) ?? [
    ...(layer.inset ? ["inset"] : []),
    dimension(layer.offsetX), dimension(layer.offsetY), dimension(layer.blur),
    ...(layer.spread.value === 0 ? [] : [dimension(layer.spread)]),
    cssAlias(layer.color, tokens) ?? colorCss(layer.color),
  ].join(" ")).join(", ");
}

function tokenCss(entry, tokens, multiline = entry.metadata.cssFormat === "multiline") {
  const alias = typeof entry.token.$value === "string" && entry.token.$value.match(ALIAS);
  if (alias) {
    const name = tokens.get(alias[1]).cssName;
    return multiline ? `var(\n    ${name}\n  )` : `var(${name})`;
  }
  const value = resolvedValue(entry, tokens);
  switch (entry.token.$type) {
    case "color": return colorCss(value, multiline);
    case "dimension": return dimensionCss(value);
    case "fontWeight": return decimal(value);
    case "shadow": return shadowCss(entry.token.$value, tokens);
    default: fail(`Unsupported type at ${entry.path}`, entry.file);
  }
}

function colorHex(value) {
  const rgb = value.colorSpace === "hsl" ? hslToRgb(...value.components) : value.components;
  const alpha = value.alpha === undefined || value.alpha === 1 ? "" : Math.round(value.alpha * 255).toString(16).padStart(2, "0").toUpperCase();
  return `${toHex(rgb)}${alpha}`;
}

function swatch(entry, tokens) {
  const value = resolvedValue(entry, tokens);
  return entry.token.$type === "color"
    ? colorHex(value)
    : entry.token.$type === "shadow"
      ? colorHex((Array.isArray(value) ? value[0] : value).color)
      : tokenCss(entry, tokens);
}

function description(entry, tokens) {
  return `/* ${swatch(entry, tokens)} — ${entry.token.$description.replace(/\s+/g, " ").trim()} */`;
}

function blockRange(css, selector, file = TOKENS_FILE) {
  try {
    return extractBlockRange(css, selector);
  } catch (error) {
    fail(error.message, file);
  }
}

const GENERATION_REGION = /\/\* @generated tokens:([a-z0-9-]+):start \*\/[\s\S]*?\/\* @generated tokens:\1:end \*\//g;

function replaceTokenRegions(source, regions, ranges, file) {
  const seen = new Set();
  const result = source.replace(GENERATION_REGION, (match, section, offset) => {
    const region = regions.get(section);
    if (!region || seen.has(section)) fail(`Unknown or duplicate generation marker ${section}`, file);
    const [start, end] = ranges.get(region.selector);
    if (offset < start || offset + match.length > end) fail(`Generation marker ${section} is outside its ${region.selector} block`, file);
    seen.add(section);
    return `/* @generated tokens:${section}:start */\n${region.declarations.join("\n")}\n${region.indent ?? "  "}/* @generated tokens:${section}:end */`;
  });
  const markers = [...source.matchAll(/\/\* @generated tokens:[a-z0-9-]+:(?:start|end) \*\//g)];
  if (seen.size !== regions.size || markers.length !== seen.size * 2) {
    fail(`Missing or unbalanced generation markers: ${[...regions.keys()].filter((section) => !seen.has(section)).join(", ")}`, file);
  }
  return result;
}

/** Expected CSS in memory; never changes the checkout during freshness checks. */
export function renderTokenCss(root = process.cwd(), css) {
  const source = css ?? readFileSync(join(root, TOKENS_FILE), "utf8");
  const { base, lightOverrides, themes } = readTokenSources(root);
  const regions = new Map();
  const add = (section, selector, declaration) => {
    const region = regions.get(section) ?? { selector, declarations: [] };
    if (region.selector !== selector) fail(`Generation region ${section} mixes selectors`, TOKENS_FILE);
    region.declarations.push(declaration);
    regions.set(section, region);
  };
  for (const [tokens, selector, theme] of [[base, ":root", themes.dark], [lightOverrides, '[data-theme="light"]', themes.light]]) {
    for (const entry of tokens.values()) {
      add(entry.metadata.section, selector, `  ${entry.cssName}: ${tokenCss(entry, theme)}; ${description(entry, theme)}`);
    }
  }
  const utilities = [...base.values()].filter((entry) => entry.metadata.utility).sort((a, b) => a.metadata.utilityOrder - b.metadata.utilityOrder);
  for (const entry of utilities) {
    add(entry.metadata.utilitySection, "@theme inline", `  ${entry.metadata.utility}: var(${entry.cssName}); ${description(entry, themes.dark)}`);
  }
  const ranges = new Map([":root", '[data-theme="light"]', "@theme inline"].map((selector) => [selector, blockRange(source, selector)]));
  const result = replaceTokenRegions(source, regions, ranges, TOKENS_FILE);
  // Values outside a generated region would make CSS a second token source.
  for (const selector of ranges.keys()) {
    const authored = extractBlock(source, selector).replace(GENERATION_REGION, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const unmarked = authored.match(selector === "@theme inline" ? /--color-[a-z0-9-]+\s*:/ : /--[a-z0-9-]+\s*:/);
    if (unmarked) fail(`Unmarked token declaration in ${selector} block: ${unmarked[0]}`, TOKENS_FILE);
  }
  const orderedGroups = [[":root", [...base.values()].map((entry) => entry.cssName)],
    ['[data-theme="light"]', [...lightOverrides.values()].map((entry) => entry.cssName)],
    ["@theme inline", utilities.map((entry) => entry.metadata.utility)]];
  for (const [selector, expected] of orderedGroups) {
    const actual = [...declarations(extractBlock(result, selector)).keys()]
      .map((name) => `--${name}`).filter((name) => selector !== "@theme inline" || name.startsWith("--color-"));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`Generated declaration order in ${selector} must match token/utility order in JSON`, TOKENS_FILE);
    }
  }
  return result;
}

/** The shared marketing palette uses compact values and its native media query. */
export function renderMarketingTokenCss(root = process.cwd(), css) {
  const source = css ?? readFileSync(join(root, MARKETING_TOKENS_FILE), "utf8");
  const { themes, marketing: { groups, names } } = readTokenSources(root);
  const [mediaStart, mediaEnd] = blockRange(source, "@media (prefers-color-scheme: light)", MARKETING_TOKENS_FILE);
  const lightRange = blockRange(source.slice(mediaStart, mediaEnd), ":root", MARKETING_TOKENS_FILE)
    .map((offset) => offset + mediaStart);
  const ranges = new Map([
    ["dark", blockRange(source, ":root", MARKETING_TOKENS_FILE)],
    ["light", lightRange],
  ]);
  const regions = new Map();
  for (const [appearance, theme] of Object.entries(themes)) {
    const indent = appearance === "dark" ? "  " : "    ";
    for (const [section, paths] of Object.entries(groups)) {
      regions.set(`marketing-${appearance}-${section}`, {
        selector: appearance, indent,
        declarations: paths.map((path) => {
          const entry = theme.get(path);
          return `${indent}${entry.cssName}: ${tokenCss(entry, theme, false)}; /* ${swatch(entry, theme)} */`;
        }),
      });
    }
  }
  const result = replaceTokenRegions(source, regions, ranges, MARKETING_TOKENS_FILE);
  const resultScopes = {
    dark: extractBlock(result, ":root"),
    light: extractBlock(extractBlock(result, "@media (prefers-color-scheme: light)"), ":root"),
  };
  for (const [appearance, [start, end]] of ranges) {
    const authored = declarations(source.slice(start, end).replace(GENERATION_REGION, ""));
    for (const name of authored.keys()) {
      if (names.has(`--${name}`)) fail(`Unmarked marketing token declaration in ${appearance}: --${name}`, MARKETING_TOKENS_FILE);
    }
    const actual = [...declarations(resultScopes[appearance]).keys()].map((name) => `--${name}`).filter((name) => names.has(name));
    if (JSON.stringify(actual) !== JSON.stringify([...names])) {
      fail(`Generated marketing declaration order in ${appearance} must match export groups in JSON`, MARKETING_TOKENS_FILE);
    }
  }
  return result;
}

const TOKEN_OUTPUTS = [[TOKENS_FILE, renderTokenCss], [MARKETING_TOKENS_FILE, renderMarketingTokenCss]];

export function buildTokens(root = process.cwd()) {
  // Prepare every output first so an invalid template cannot partially publish.
  const outputs = TOKEN_OUTPUTS.map(([file, render]) => {
    const current = readFileSync(join(root, file), "utf8");
    return { file, current, generated: render(root, current) };
  });
  for (const { file, current, generated } of outputs) {
    if (generated !== current) writeFileSync(join(root, file), generated);
  }
  return outputs[0].generated;
}

/** check:ui hook; malformed source is a finding, never a silently skipped gate. */
export function checkGeneratedTokens(root = process.cwd()) {
  const findings = [];
  for (const [file, render] of TOKEN_OUTPUTS) {
    try {
      const current = readFileSync(join(root, file), "utf8");
      if (render(root, current) !== current) findings.push({
        file, line: 1,
        message: "Generated token CSS is stale — run `pnpm design:docs` (source: styles/tokens/).",
      });
    } catch (error) {
      const errorFile = error.file ?? file;
      if (!findings.some((finding) => finding.file === errorFile)) {
        findings.push({ file: errorFile, line: 1, message: `Token generation failed: ${error.message}` });
      }
    }
  }
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const violations = checkGeneratedTokens();
    for (const violation of violations) console.error(`${violation.file}: ${violation.message}`);
    if (violations.length) process.exitCode = 1;
    else console.log("check:tokens — clean");
  } else {
    buildTokens();
    for (const [file] of TOKEN_OUTPUTS) console.log(`wrote ${file}`);
  }
}
