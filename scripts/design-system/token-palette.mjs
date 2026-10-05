// ============================================================
// token-palette.mjs
// ------------------------------------------------------------
// Reads the color primitives in styles/zeros-tokens.css as data: the dark
// `:root` block and the `[data-theme="light"]` override (light inherits every
// token it does not redeclare). Resolves `var(--x)` aliases and `hsl()`
// literals to sRGB and computes WCAG 2.x contrast, including alpha
// composites such as `red-secondary/0.9@bg1` (the /90 hover fill over bg1).
//
// Shared by the contrast-contract test and the generated token reference
// (scripts/design-system/build-design-docs.mjs), so both read the palette the
// same way.
// ============================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const TOKENS_FILE = "styles/zeros-tokens.css";

export function extractBlock(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing CSS block: ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    if (depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`Unclosed CSS block: ${selector}`);
}

export function declarations(block) {
  const out = new Map();
  const source = block.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of source.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1], match[2].replace(/\s+/g, " ").trim());
  }
  return out;
}

/** { dark, light } maps of raw token values; light falls back to dark. */
export function readThemes(root = process.cwd(), css) {
  const source = css ?? readFileSync(join(root, TOKENS_FILE), "utf8");
  const dark = declarations(extractBlock(source, ":root"));
  const light = new Map([...dark, ...declarations(extractBlock(source, '[data-theme="light"]'))]);
  return { dark, light };
}

export function hslToRgb(h, s, l) {
  const sat = s / 100;
  const light = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

/** Literal value of a token after following var() aliases. */
export function resolveValue(theme, name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`Alias cycle at --${name}`);
  seen.add(name);
  const value = theme.get(name);
  if (value === undefined) throw new Error(`Unknown token --${name}`);
  const alias = value.match(/^var\(\s*--([a-z0-9-]+)\s*\)$/);
  return alias ? resolveValue(theme, alias[1], seen) : value;
}

/** sRGB channels (0–1), quantized to 8 bits like the rendered color. */
export function resolveRgb(theme, name) {
  const value = resolveValue(theme, name);
  const hsl = value.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/);
  if (!hsl) throw new Error(`--${name} is not an hsl() literal: ${value}`);
  return hslToRgb(+hsl[1], +hsl[2], +hsl[3]).map((c) => Math.round(c * 255) / 255);
}

/**
 * A surface reference: a token name, or `fg/alpha@base` for a translucent
 * fill composited over an opaque base (source-over in encoded sRGB, which is
 * what the browser paints).
 */
export function resolveSurface(theme, ref) {
  const composite = ref.match(/^([a-z0-9-]+)\/([\d.]+)@([a-z0-9-]+)$/);
  if (!composite) return resolveRgb(theme, ref);
  const [, fill, alpha, base] = composite;
  const top = resolveRgb(theme, fill);
  const bottom = resolveRgb(theme, base);
  return top.map((c, i) => Math.round((+alpha * c + (1 - +alpha) * bottom[i]) * 255) / 255);
}

const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function relativeLuminance([r, g, b]) {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function toHex(rgb) {
  return `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/**
 * Expand "@rest"/"@hover" surface-set references from the contract. An unknown
 * or empty set throws: a typo must never silently drop assertions.
 */
export function expandSurfaces(contract, on) {
  const list = Array.isArray(on) ? on : [on];
  const surfaces = list.flatMap((ref) => {
    if (!ref.startsWith("@")) return [ref];
    const set = contract.surfaces?.[ref.slice(1)];
    if (!Array.isArray(set) || set.length === 0) {
      throw new Error(`Unknown or empty surface set ${ref} in the contrast contract`);
    }
    return set;
  });
  if (surfaces.length === 0) throw new Error("A contrast pairing declares no surfaces");
  return surfaces;
}

/** Every declared pairing evaluated in both themes. */
export function evaluateContract(contract, themes) {
  const results = [];
  for (const [themeName, theme] of Object.entries(themes)) {
    for (const pair of contract.pairs) {
      const role = contract.roles[pair.role];
      if (!role || typeof role.min !== "number") {
        throw new Error(`Unknown contrast role "${pair.role}"`);
      }
      if (!Array.isArray(pair.fg) || pair.fg.length === 0) {
        throw new Error(`A ${pair.role} pairing declares no foregrounds`);
      }
      const min = role.min;
      for (const fg of pair.fg) {
        for (const surface of expandSurfaces(contract, pair.on)) {
          const ratio = contrastRatio(resolveRgb(theme, fg), resolveSurface(theme, surface));
          results.push({ theme: themeName, role: pair.role, fg, surface, ratio, min, pass: ratio >= min });
        }
      }
    }
  }
  return results;
}

export function evaluateLadders(contract, themes) {
  const results = [];
  for (const [themeName, theme] of Object.entries(themes)) {
    for (const ladder of contract.ladders ?? []) {
      const surface = resolveRgb(theme, ladder.on);
      const ratios = ladder.tiers.map((tier) => contrastRatio(resolveRgb(theme, tier), surface));
      for (let i = 1; i < ratios.length; i += 1) {
        const step = ratios[i - 1] / ratios[i];
        results.push({
          theme: themeName,
          upper: ladder.tiers[i - 1],
          lower: ladder.tiers[i],
          step,
          minStep: ladder.minStep,
          pass: step >= ladder.minStep,
        });
      }
    }
  }
  return results;
}
