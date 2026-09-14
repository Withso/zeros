// ──────────────────────────────────────────────────────────
// File-type icons — Zeros' own sprite for the Files tab + @-mention pills
// ──────────────────────────────────────────────────────────
//
// @pierre/trees ships a "complete" glyph set, but its shapes are FILLED
// paths (no stroke to thin) and read heavy next to 13px row text. This module
// replaces them with a hand-drawn 16×16 set in the editor-tree idiom (the
// Seti / Cursor look): thin strokes for punctuation and letter-marks (`{}`,
// `<>`, `M↓`, `TS`), compact filled marks for objects and brands where an
// outline would smear at 14px (npm, git, eslint, the Vite bolt, the gear).
//
// The tree consumes it through the library's public `icons` config
// (`set: "none"` + `spriteSheet` + the byFileName/byFileExtension tables), and
// the @-mention pill through `createFileTreeIconResolver` on the SAME config,
// so both surfaces resolve a path to the same symbol.
//
// Color: each symbol paints with `var(--zeros-fi, var(--zeros-fi-<hue>))`.
// Custom properties inherit into a <use> element's shadow tree, so the host
// only has to define the palette (FILE_ICON_PALETTE_CSS) once — on `:host`
// inside the tree's shadow root, inline on the pill's <svg> — and can set the
// `--zeros-fi` escape hatch to recolor a glyph wholesale (the tree does this
// for .gitignore'd rows). The hues are light-dark() pairs tuned per theme;
// this file is on the check:ui allowlist for that reason.
//
// Grid conventions: viewBox 0 0 16 16, 1.25px stroke (1.4 for letter-marks
// so a 14px render keeps the letters legible), round caps/joins, ~1.5px of
// margin. `%c` in a body is replaced with the color expression.
// ──────────────────────────────────────────────────────────

import type { FileTreeIconConfig } from "@pierre/trees";

/** Palette hue → light-dark() pair. */
export const FILE_ICON_PALETTE = {
  /** Prose, plain text, generic files, settings. */
  gray: "light-dark(#86868b, #a9a9ae)",
  /** JSON braces, JavaScript, Babel, favicon star. */
  yellow: "light-dark(#b58f2a, #d9b56b)",
  /** TypeScript, HTML, images. */
  blue: "light-dark(#3b82c4, #6aa6e6)",
  /** The lighter blue: LICENSE, Docker, React, databases. */
  steel: "light-dark(#5d8fb8, #93bbe0)",
  /** npm. */
  rose: "light-dark(#d1506f, #ec7a95)",
  /** YAML. */
  coral: "light-dark(#c9606a, #e88088)",
  /** CSS, Prettier. */
  mauve: "light-dark(#a565b0, #c98fd0)",
  /** git, test variants (spec.ts), Rust, Swift, zip. */
  orange: "light-dark(#c9764a, #e0a07c)",
  /** ESLint, Vite, Astro, Sass. */
  purple: "light-dark(#7f5fd0, #a98cf0)",
  /** Shell, TODO, Markdown-adjacent greens, Vue. */
  green: "light-dark(#3f9f5c, #6ccc7c)",
  /** Ruby, Svelte. */
  red: "light-dark(#c93f4a, #ef6b74)",
  /** Go, Tailwind, MCP, Oxc. */
  teal: "light-dark(#2d9db5, #6dcbe0)",
  /** Terraform, WebAssembly, Bootstrap. */
  indigo: "light-dark(#5c58c9, #8f8cf0)",
} as const;

export type FileIconHue = keyof typeof FILE_ICON_PALETTE;

/** `--zeros-fi-<hue>: …;` declarations, for a `:host` rule or inline style. */
export const FILE_ICON_PALETTE_CSS = Object.entries(FILE_ICON_PALETTE)
  .map(([hue, value]) => `--zeros-fi-${hue}: ${value};`)
  .join(" ");

/** Same palette as a React style object (the pill's <svg>). */
export const FILE_ICON_PALETTE_STYLE: Record<string, string> =
  Object.fromEntries(
    Object.entries(FILE_ICON_PALETTE).map(([hue, value]) => [
      `--zeros-fi-${hue}`,
      value,
    ]),
  );

const SYMBOL_PREFIX = "zeros-fi-";

/** Symbol id for a token (`typescript` → `zeros-fi-typescript`). */
export function fileIconSymbolId(token: string): string {
  return `${SYMBOL_PREFIX}${token}`;
}

interface IconDef {
  hue: FileIconHue;
  /** Symbol body. `%c` → the color expression. */
  body: string;
}

// Shared attribute bundles. Kept as strings so each body stays readable.
const S = `fill="none" stroke="%c" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"`;
/** Letter-marks: a touch heavier so they hold up at 14px. */
const L = `fill="none" stroke="%c" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"`;
const F = `fill="%c"`;
const FE = `fill="%c" fill-rule="evenodd"`;

// ── Computed outlines ──────────────────────────────────────
// Regular shapes are generated rather than hand-typed so the teeth/points
// come out symmetric. Output is rounded to 2dp to keep the sprite small.

const pt = (x: number, y: number) => `${+x.toFixed(2)} ${+y.toFixed(2)}`;

/** Closed polygon through points on alternating radii (gear teeth, stars). */
function radialPolygon(
  cx: number,
  cy: number,
  radii: number[],
  count: number,
  phase = -Math.PI / 2,
): string {
  const parts: string[] = [];
  const total = count * radii.length;
  for (let index = 0; index < total; index += 1) {
    const angle = phase + (index / total) * Math.PI * 2;
    const radius = radii[index % radii.length]!;
    parts.push(
      `${index === 0 ? "M" : "L"}${pt(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius)}`,
    );
  }
  return `${parts.join("")}z`;
}

/** Gear: 8 flat-topped teeth (4 points per tooth) around a punched hub. */
const GEAR = `${radialPolygon(8, 8, [6.75, 6.75, 5.1, 5.1], 8, -Math.PI / 2 - Math.PI / 16)}M8 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 1 0 0-5.2z`;
const STAR = radialPolygon(8, 8.4, [7, 3.1], 5);
const HEXAGON = `M8 1.75l5.4 3.125v6.25L8 14.25l-5.4-3.125v-6.25z`;

// The `#` shared by the stylesheet family (css / sass / postcss / stylelint),
// distinguished by hue only — same idea as one `{}` for every JSON flavor.
const HASH = `<path ${S} d="M6.25 2.5 4.75 13.5M11.25 2.5 9.75 13.5M2.5 6h11M2 10h11"/>`;

// Letter-marks. Two-letter marks sit on a 4–12 baseline, ~1px apart.
const LETTER_S = `M14 5.25c-.4-.9-1.3-1.35-2.4-1.35-1.4 0-2.35.75-2.35 1.85 0 2.4 4.9 1.1 4.9 3.7 0 1.2-1 2-2.5 2-1.2 0-2.2-.5-2.6-1.5`;
const JS = `<path ${L} d="M6.5 4v5.5a2.25 2.25 0 0 1-4.5 0"/><path ${L} d="${LETTER_S}"/>`;
const TS = `<path ${L} d="M1.5 4h5.5M4.25 4v8"/><path ${L} d="${LETTER_S}"/>`;
const REACT = `<ellipse ${S} cx="8" cy="8" rx="6.5" ry="2.5"/><ellipse ${S} cx="8" cy="8" rx="6.5" ry="2.5" transform="rotate(60 8 8)"/><ellipse ${S} cx="8" cy="8" rx="6.5" ry="2.5" transform="rotate(120 8 8)"/><circle ${F} cx="8" cy="8" r="1.1"/>`;

const ICONS: Record<string, IconDef> = {
  // ── generic ──
  default: {
    hue: "gray",
    body: `<path ${S} d="M5.5 1.75h3.75L13 5.5v7.25a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 4 12.75V3.25a1.5 1.5 0 0 1 1.5-1.5z"/><path ${S} d="M9.25 1.75V5.5H13"/>`,
  },
  text: {
    hue: "gray",
    body: `<path ${S} d="M3 4h10M3 7h10M3 10h10M3 13h6"/>`,
  },
  settings: { hue: "gray", body: `<path ${FE} d="${GEAR}"/>` },
  markdown: {
    hue: "gray",
    body: `<path ${L} d="M1.5 12V4.5l3 3.5 3-3.5V12M12 4.5v7.5M9.75 9.75 12 12l2.25-2.25"/>`,
  },
  todo: {
    hue: "green",
    // Filled rounded square with the check punched out (evenodd), so it
    // reads on any background without knowing the background colour.
    body: `<path ${FE} d="M4 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM4.1 8.9l1.3-1.3L7 9.2l3.85-3.85 1.3 1.3L7 11.8z"/>`,
  },
  license: {
    hue: "steel",
    body: `<path ${F} d="M1.5 3.4c2.3-.35 4.3 0 5.9 1.25v9.2C5.8 12.7 3.8 12.35 1.5 12.7zM14.5 3.4c-2.3-.35-4.3 0-5.9 1.25v9.2c1.6-1.15 3.6-1.5 5.9-1.15z"/>`,
  },
  image: {
    hue: "blue",
    body: `<path ${FE} d="M3 2.5h10A1.5 1.5 0 0 1 14.5 4v8a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12V4A1.5 1.5 0 0 1 3 2.5zM10.75 4.75a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 1 0 0-2.5zM2.75 12.25h10.5L9.5 7.75l-2.25 2.5-1.5-1.5z"/>`,
  },
  favicon: { hue: "yellow", body: `<path ${F} d="${STAR}"/>` },
  svg: {
    hue: "orange",
    // Overlapping square and circle: the vector-shapes glyph.
    body: `<path ${S} d="M6.5 2.5h7v7h-7z"/><circle ${S} cx="6" cy="10" r="3.75"/>`,
  },
  video: {
    hue: "rose",
    body: `<path ${FE} d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13zM6.25 5 11 8l-4.75 3z"/>`,
  },
  audio: {
    hue: "rose",
    body: `<path ${S} d="M6 12.5V3.5l7-1.5v9"/><circle ${F} cx="4" cy="12.5" r="2"/><circle ${F} cx="11" cy="11" r="2"/>`,
  },
  font: {
    hue: "gray",
    body: `<path ${S} d="M2 13 6 3l4 10M3.6 9h4.8"/><circle ${S} cx="12.5" cy="10.75" r="1.75"/><path ${S} d="M14.25 8.5v4.5"/>`,
  },
  zip: {
    hue: "orange",
    body: `<path ${S} d="M4 1.75h8a1 1 0 0 1 1 1v10.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1z"/><path ${S} d="M8 1.75v2M8 5.5v2M6.75 10.25h2.5v2.5h-2.5z"/>`,
  },
  database: {
    hue: "steel",
    // Three filled discs.
    body: `<ellipse ${F} cx="8" cy="3.75" rx="5.75" ry="2.15"/><path ${F} d="M2.25 6.25c1.1 1.15 3.2 1.7 5.75 1.7s4.65-.55 5.75-1.7v2.1c-1.1 1.15-3.2 1.7-5.75 1.7S3.35 9.5 2.25 8.35zM2.25 10.35c1.1 1.15 3.2 1.7 5.75 1.7s4.65-.55 5.75-1.7v2.1c-1.1 1.15-3.2 1.7-5.75 1.7S3.35 13.6 2.25 12.45z"/>`,
  },
  table: {
    hue: "teal",
    body: `<path ${S} d="M2 3.5h12v9H2zM2 7h12M2 10h12M6.5 3.5v9"/>`,
  },

  // ── data / config ──
  json: {
    hue: "yellow",
    body: `<path ${S} d="M5.5 2.5c-1.4 0-2 .8-2 2.2v1.6c0 .9-.5 1.5-1.5 1.7 1 .2 1.5.8 1.5 1.7v1.6c0 1.4.6 2.2 2 2.2M10.5 2.5c1.4 0 2 .8 2 2.2v1.6c0 .9.5 1.5 1.5 1.7-1 .2-1.5.8-1.5 1.7v1.6c0 1.4-.6 2.2-2 2.2"/>`,
  },
  yml: {
    hue: "coral",
    body: `<path ${L} d="M4 3l4 5.5L12 3M8 8.5V13"/>`,
  },
  git: {
    hue: "orange",
    // Filled diamond, the branch glyph (a stroke and its node) punched out.
    body: `<path ${FE} d="M8 1.5 14.5 8 8 14.5 1.5 8zM6.35 9.05l2.7-2.7.65.65-2.7 2.7zM10.4 4.4a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 1 0 0-2.4zM5.6 9.2a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 1 0 0-2.4z"/>`,
  },
  npm: {
    hue: "rose",
    body: `<path ${FE} d="M2 2h12v12H2zM5 5v6h2.25V7.25h1.5V11H11V5z"/>`,
  },
  bash: {
    hue: "green",
    body: `<path ${S} d="M8 1.5v13"/><path ${L} d="M11 4.75c-.5-1-1.6-1.4-3-1.4-1.8 0-3 .9-3 2.2 0 2.8 6 1.3 6 4.4 0 1.4-1.3 2.3-3 2.3-1.5 0-2.7-.6-3.2-1.7"/>`,
  },
  docker: {
    hue: "steel",
    // Whale: three containers riding the hull.
    body: `<path ${F} d="M4 4.25h2v2H4zM6.5 4.25h2v2h-2zM9 4.25h2v2H9zM6.5 1.75h2v2h-2zM1 7.25h13.75c.5 0 .75.5.35 1-.45.55-1.1.9-1.85 1C12.8 12.1 10.4 13.75 7 13.75 3.9 13.75 2 12.1 1 7.25z"/>`,
  },
  mcp: {
    hue: "teal",
    body: `<path ${S} d="M5.5 1.75v3.25M10.5 1.75v3.25M3.5 5h9v2.5a4.5 4.5 0 0 1-9 0zM8 12v2.25"/>`,
  },
  terraform: {
    hue: "indigo",
    body: `<path ${F} d="M1 3.25 4.75 5.4v4.35L1 7.6zM5.75 5.9 9.5 8.05v4.35L5.75 10.25zM10.5 5.9l3.75-2.15v4.35L10.5 10.25z"/>`,
  },
  vscode: {
    hue: "blue",
    body: `<path ${FE} d="M11.25 1.75 14.5 3.25v9.5l-3.25 1.5L4.5 8.75 2.5 10.25l-1-.5v-3.5l1-.5 2 1.5zM11.25 5 7 8l4.25 3z"/>`,
  },

  // ── languages ──
  javascript: { hue: "yellow", body: JS },
  "javascript-test": { hue: "orange", body: JS },
  typescript: { hue: "blue", body: TS },
  "typescript-test": { hue: "orange", body: TS },
  react: { hue: "steel", body: REACT },
  "react-test": { hue: "orange", body: REACT },
  html: {
    hue: "blue",
    body: `<path ${L} d="M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3"/>`,
  },
  css: { hue: "mauve", body: HASH },
  sass: { hue: "purple", body: HASH },
  postcss: { hue: "orange", body: HASH },
  stylelint: { hue: "gray", body: HASH },
  python: {
    hue: "blue",
    body: `<path ${L} d="M2.5 12.5V3.5h3.25a2.5 2.5 0 0 1 0 5H2.5M9 7l2.25 4.5L13.5 7M9.75 14l1.5-2.5"/>`,
  },
  ruby: {
    hue: "red",
    body: `<path ${S} d="M4.5 2.5h7L15 6.25 8 14 1 6.25zM1 6.25h14M4.5 2.5 8 14l3.5-11.5"/>`,
  },
  rust: {
    hue: "orange",
    body: `<path ${L} d="M4 13V3h3.5a2.75 2.75 0 0 1 0 5.5H4M7.75 8.5 11 13"/>`,
  },
  go: {
    hue: "teal",
    body: `<path ${L} d="M7.25 5.5A3.5 3.5 0 1 0 7.5 10.5V8H5"/><circle ${L} cx="11.75" cy="9" r="2.5"/>`,
  },
  c: {
    hue: "blue",
    body: `<path ${L} d="M12.5 5A5.5 5.5 0 1 0 12.5 11"/>`,
  },
  cpp: {
    hue: "blue",
    body: `<path ${L} d="M9.5 5.25A4.25 4.25 0 1 0 9.5 10.75"/><path ${S} d="M11 5h3M12.5 3.5v3M11 11h3M12.5 9.5v3"/>`,
  },
  swift: {
    hue: "orange",
    body: `<path ${F} d="M12.75 10.75c.8-2.6-.25-5.75-2.75-8 1.5 2.5 1.75 4.75 1 6.5C8.5 7 6 4.75 3.25 3c1.5 2.75 3.5 5.25 6 7.25C7.25 11 4.75 10.5 2.25 9c1.75 2.5 4.5 4.25 7.5 4.25 1.5 0 2.75-.4 3.5-1 .6.3 1.1.8 1.5 1.25-.2-.9-.9-1.9-2-2.75z"/>`,
  },
  zig: {
    hue: "orange",
    body: `<path ${L} d="M3 3.5h10L3 12.5h10"/>`,
  },
  wasm: {
    hue: "indigo",
    body: `<path ${S} d="M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><path ${S} d="M4 6.25l1.5 4.5L8 6.25l2.5 4.5L12 6.25"/>`,
  },
  graphql: {
    hue: "rose",
    body: `<path ${S} d="M8 2l5.2 3v6L8 14l-5.2-3V5zM8 2l5.2 9H2.8z"/><path ${F} d="M8 .9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 1 1 0-2.2zM13.2 3.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 1 1 0-2.2zM13.2 9.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 1 1 0-2.2zM8 12.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 1 1 0-2.2zM2.8 9.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 1 1 0-2.2zM2.8 3.9a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 1 1 0-2.2z"/>`,
  },

  // ── frameworks / tools ──
  vue: {
    hue: "green",
    body: `<path ${S} d="M1.75 3.5 8 14l6.25-10.5M5.25 3.5 8 8.25l2.75-4.75"/>`,
  },
  svelte: {
    hue: "red",
    body: `<path ${L} d="M12 4.75c-.6-1.1-1.8-1.65-3.3-1.65-2 0-3.3 1-3.3 2.4 0 3 7.2 1.5 7.2 5 0 1.6-1.5 2.6-3.6 2.6-1.7 0-3-.7-3.6-2"/>`,
  },
  astro: {
    hue: "purple",
    body: `<path ${L} d="M3 13.5 8 2.5l5 11M5.25 9h5.5"/>`,
  },
  nextjs: {
    hue: "gray",
    body: `<path ${L} d="M3 13V3l10 10V3"/>`,
  },
  vite: {
    hue: "purple",
    body: `<path ${F} stroke="%c" stroke-width=".75" stroke-linejoin="round" d="M9.75 1.5 3 8.75h4.25L6.25 14.5 13 7.25H8.75z"/>`,
  },
  webpack: {
    hue: "blue",
    body: `<path ${S} d="${HEXAGON}M2.6 4.875 8 8l5.4-3.125M8 8v6.25"/>`,
  },
  eslint: {
    hue: "purple",
    // Filled hexagon, hollow ring, filled hub.
    body: `<path ${FE} d="${HEXAGON}M8 5.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 1 0 0-5.5zM8 6.75a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 1 0 0-2.5z"/>`,
  },
  prettier: {
    hue: "mauve",
    body: `<path ${L} d="M2.5 3.5h7M11.5 3.5h2M2.5 6h3M7.5 6h6M2.5 8.5h9M2.5 11h5M9.5 11h4M2.5 13.5h6"/>`,
  },
  babel: {
    hue: "yellow",
    body: `<path ${L} d="M4 3v10M4 3h4.25a2.25 2.25 0 0 1 0 4.5H4M4 7.5h5a2.75 2.75 0 0 1 0 5.5H4"/>`,
  },
  biome: {
    hue: "blue",
    body: `<path ${S} d="M8 2 14 13H2z"/><path ${S} d="M5.5 11c.5-1.5 1.5-2.25 2.5-2.25S10 9.5 10.5 11"/>`,
  },
  bootstrap: {
    hue: "indigo",
    body: `<path ${S} d="M4 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 12 13.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5z"/><path ${S} d="M6 5v6M6 5h2.25a1.5 1.5 0 0 1 0 3H6M6 8h2.75a1.5 1.5 0 0 1 0 3H6"/>`,
  },
  browserslist: {
    hue: "yellow",
    body: `<circle ${S} cx="8" cy="8" r="6"/><path ${S} d="M2 8h12M8 2c-2.5 2.5-2.5 9.5 0 12M8 2c2.5 2.5 2.5 9.5 0 12"/>`,
  },
  bun: {
    hue: "yellow",
    body: `<circle ${S} cx="8" cy="8" r="6"/><path ${S} stroke-width="1.8" d="M5.75 7.5h.01M10.25 7.5h.01"/><path ${S} d="M6.25 10.25c1 .75 2.5.75 3.5 0"/>`,
  },
  oxc: {
    hue: "teal",
    body: `<circle ${L} cx="5" cy="8" r="3.5"/><path ${L} d="M10 5.5l4 5M14 5.5l-4 5"/>`,
  },
  tailwind: {
    hue: "teal",
    body: `<path ${S} d="M1.5 6.5c1-2.5 2.6-3.75 4.75-3.75 3.25 0 3.5 2.5 5.25 2.5 1.2 0 2.2-.6 3-2M1.5 12.5c1-2.5 2.6-3.75 4.75-3.75 3.25 0 3.5 2.5 5.25 2.5 1.2 0 2.2-.6 3-2"/>`,
  },
};

/** Every token this sprite defines, in definition order. */
export const FILE_ICON_TOKENS = Object.keys(ICONS);

/** Palette hue for a token (used by the contact sheet; the glyphs bake it in). */
export function fileIconHue(token: string): FileIconHue {
  return ICONS[token]?.hue ?? "gray";
}

function renderSymbol(token: string, def: IconDef): string {
  const color = `var(--zeros-fi, var(--zeros-fi-${def.hue}))`;
  return `<symbol id="${fileIconSymbolId(token)}" viewBox="0 0 16 16">${def.body.replaceAll("%c", color)}</symbol>`;
}

/** The complete <svg> sprite. Inject once per DOM (light or shadow). */
export const FILE_ICON_SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">${Object.entries(
  ICONS,
)
  .map(([token, def]) => renderSymbol(token, def))
  .join("")}</svg>`;

// ── Mapping ──────────────────────────────────────────────
// The library's lookup order is byFileName (exact, case-insensitive) →
// byFileNameContains → byFileExtension, where an extension candidate is every
// dot-suffix of the basename longest-first ("spec.ts" before "ts"). A bare
// "LICENSE" has NO extension candidates, which is why it needs the filename
// table. Tables seeded from @pierre's "complete" set, then aligned with the
// Seti conventions Cursor/VS Code users know: package-manager files → npm,
// .env/.toml/.ini → gear, spec/test sources → orange variants, TODO → check.

const FILE_NAME_TOKENS: Record<string, string> = {
  ".babelrc": "babel",
  ".babelrc.json": "babel",
  ".bash_profile": "bash",
  ".bashrc": "bash",
  ".browserslistrc": "browserslist",
  ".dockerignore": "docker",
  ".editorconfig": "settings",
  ".env": "settings",
  ".eslintignore": "eslint",
  ".eslintrc": "eslint",
  ".eslintrc.cjs": "eslint",
  ".eslintrc.js": "eslint",
  ".eslintrc.json": "eslint",
  ".eslintrc.yaml": "eslint",
  ".eslintrc.yml": "eslint",
  ".gitattributes": "git",
  ".gitignore": "git",
  ".gitkeep": "git",
  ".gitmodules": "git",
  ".npmignore": "npm",
  ".npmrc": "npm",
  ".nvmrc": "npm",
  ".oxlintrc.json": "oxc",
  ".postcssrc": "postcss",
  ".postcssrc.json": "postcss",
  ".postcssrc.yaml": "postcss",
  ".postcssrc.yml": "postcss",
  ".prettierignore": "prettier",
  ".prettierrc": "prettier",
  ".prettierrc.cjs": "prettier",
  ".prettierrc.js": "prettier",
  ".prettierrc.json": "prettier",
  ".prettierrc.mjs": "prettier",
  ".prettierrc.toml": "prettier",
  ".prettierrc.yaml": "prettier",
  ".prettierrc.yml": "prettier",
  ".stylelintignore": "stylelint",
  ".stylelintrc": "stylelint",
  ".stylelintrc.cjs": "stylelint",
  ".stylelintrc.js": "stylelint",
  ".stylelintrc.json": "stylelint",
  ".stylelintrc.mjs": "stylelint",
  ".stylelintrc.yaml": "stylelint",
  ".stylelintrc.yml": "stylelint",
  ".terraform.lock.hcl": "terraform",
  ".zprofile": "bash",
  ".zshenv": "bash",
  ".zshrc": "bash",
  "babel.config.cjs": "babel",
  "babel.config.js": "babel",
  "babel.config.json": "babel",
  "babel.config.mjs": "babel",
  "biome.json": "biome",
  "biome.jsonc": "biome",
  "bootstrap.bundle.js": "bootstrap",
  "bootstrap.bundle.min.js": "bootstrap",
  "bootstrap.css": "bootstrap",
  "bootstrap.js": "bootstrap",
  "bootstrap.min.css": "bootstrap",
  "bootstrap.min.js": "bootstrap",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  "bunfig.toml": "bun",
  "cargo.lock": "rust",
  "cargo.toml": "rust",
  "compose.yaml": "docker",
  "compose.yml": "docker",
  copying: "license",
  "docker-compose.override.yml": "docker",
  "docker-compose.yaml": "docker",
  "docker-compose.yml": "docker",
  dockerfile: "docker",
  "eslint.config.cjs": "eslint",
  "eslint.config.js": "eslint",
  "eslint.config.mjs": "eslint",
  "eslint.config.mts": "eslint",
  "eslint.config.ts": "eslint",
  "favicon.ico": "favicon",
  "favicon.png": "favicon",
  "favicon.svg": "favicon",
  gemfile: "ruby",
  "gemfile.lock": "ruby",
  "go.mod": "go",
  "go.sum": "go",
  licence: "license",
  "licence.md": "license",
  "licence.txt": "license",
  license: "license",
  "license.md": "license",
  "license.txt": "license",
  "next.config.js": "nextjs",
  "next.config.mjs": "nextjs",
  "next.config.mts": "nextjs",
  "next.config.ts": "nextjs",
  "package-lock.json": "npm",
  "package.json": "npm",
  "pnpm-lock.yaml": "npm",
  "prettier.config.cjs": "prettier",
  "prettier.config.js": "prettier",
  "prettier.config.mjs": "prettier",
  rakefile: "ruby",
  "readme.md": "markdown",
  "stylelint.config.cjs": "stylelint",
  "stylelint.config.js": "stylelint",
  "stylelint.config.mjs": "stylelint",
  "tailwind.config.cjs": "tailwind",
  "tailwind.config.js": "tailwind",
  "tailwind.config.mjs": "tailwind",
  "tailwind.config.ts": "tailwind",
  todo: "todo",
  "todo.md": "todo",
  "todo.txt": "todo",
  "vite.config.js": "vite",
  "vite.config.mjs": "vite",
  "vite.config.mts": "vite",
  "vite.config.ts": "vite",
  "webpack.config.babel.js": "webpack",
  "webpack.config.cjs": "webpack",
  "webpack.config.js": "webpack",
  "webpack.config.mjs": "webpack",
  "webpack.config.ts": "webpack",
  "yarn.lock": "npm",
};

const FILE_EXTENSION_TOKENS: Record<string, string> = {
  "7z": "zip",
  astro: "astro",
  aac: "audio",
  avi: "video",
  avif: "image",
  bash: "bash",
  bmp: "image",
  bz2: "zip",
  c: "c",
  cc: "cpp",
  cfg: "settings",
  cjs: "javascript",
  "code-workspace": "vscode",
  conf: "settings",
  cpp: "cpp",
  csh: "bash",
  css: "css",
  csv: "table",
  cts: "typescript",
  cxx: "cpp",
  db: "database",
  editorconfig: "settings",
  env: "settings",
  "env.development": "settings",
  "env.example": "settings",
  "env.local": "settings",
  "env.production": "settings",
  "env.test": "settings",
  eot: "font",
  erb: "ruby",
  fish: "bash",
  flac: "audio",
  gemspec: "ruby",
  gif: "image",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  gz: "zip",
  h: "c",
  hh: "cpp",
  hpp: "cpp",
  htm: "html",
  html: "html",
  hxx: "cpp",
  icns: "image",
  ico: "image",
  ini: "settings",
  inl: "cpp",
  jar: "zip",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  json: "json",
  json5: "json",
  jsonc: "json",
  jsonl: "json",
  jsx: "react",
  ksh: "bash",
  less: "css",
  log: "text",
  markdown: "markdown",
  mcp: "mcp",
  md: "markdown",
  mdx: "markdown",
  "mdx.tsx": "markdown",
  mjs: "javascript",
  mkv: "video",
  m4a: "audio",
  m4v: "video",
  mm: "cpp",
  mts: "typescript",
  mov: "video",
  mp3: "audio",
  mp4: "video",
  mpeg: "video",
  mpg: "video",
  ods: "table",
  ogg: "audio",
  otf: "font",
  png: "image",
  postcss: "css",
  properties: "settings",
  py: "python",
  pyi: "python",
  pyw: "python",
  pyx: "python",
  rake: "ruby",
  rar: "zip",
  rb: "ruby",
  rs: "rust",
  rst: "text",
  rtf: "text",
  sass: "sass",
  scss: "sass",
  sh: "bash",
  "spec.cjs": "javascript-test",
  "spec.js": "javascript-test",
  "spec.jsx": "react-test",
  "spec.mjs": "javascript-test",
  "spec.mts": "typescript-test",
  "spec.ts": "typescript-test",
  "spec.tsx": "react-test",
  sql: "database",
  sqlite: "database",
  sqlite3: "database",
  styl: "css",
  svelte: "svelte",
  svg: "svg",
  swift: "swift",
  tar: "zip",
  "test.cjs": "javascript-test",
  "test.js": "javascript-test",
  "test.jsx": "react-test",
  "test.mjs": "javascript-test",
  "test.mts": "typescript-test",
  "test.ts": "typescript-test",
  "test.tsx": "react-test",
  tf: "terraform",
  tfstate: "terraform",
  tfvars: "terraform",
  tgz: "zip",
  tif: "image",
  tiff: "image",
  toml: "settings",
  ts: "typescript",
  tsv: "table",
  tsx: "react",
  ttf: "font",
  txt: "text",
  vue: "vue",
  wav: "audio",
  war: "zip",
  wasm: "wasm",
  wast: "wasm",
  wat: "wasm",
  webm: "video",
  webp: "image",
  wmv: "video",
  woff: "font",
  woff2: "font",
  xhtml: "html",
  xls: "table",
  xlsx: "table",
  xz: "zip",
  yaml: "yml",
  yml: "yml",
  zig: "zig",
  zip: "zip",
  zsh: "bash",
};

function toSymbolMap(tokens: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tokens).map(([key, token]) => {
      if (!(token in ICONS)) {
        throw new Error(
          `file-icons: "${key}" maps to unknown token "${token}"`,
        );
      }
      return [key, fileIconSymbolId(token)];
    }),
  );
}

/**
 * The `icons` option for `useFileTree` / `createFileTreeIconResolver`.
 * `set: "none"` keeps the library's chevron/dot sprite (it always injects the
 * minimal tier) while `remap` points the generic file slot at our default
 * glyph so an unmatched file gets our page icon rather than the library's.
 */
export const FILE_ICON_TREE_CONFIG: FileTreeIconConfig = {
  set: "none",
  colored: false,
  spriteSheet: FILE_ICON_SPRITE,
  remap: { "file-tree-icon-file": fileIconSymbolId("default") },
  byFileName: toSymbolMap(FILE_NAME_TOKENS),
  byFileExtension: toSymbolMap(FILE_EXTENSION_TOKENS),
};

/** Sample filenames per token, for the contact sheet and tests. */
export const FILE_ICON_SAMPLES: Record<string, string> = Object.fromEntries(
  FILE_ICON_TOKENS.map((token) => {
    const byName = Object.entries(FILE_NAME_TOKENS).find(
      ([, t]) => t === token,
    );
    if (byName) return [token, byName[0]];
    const byExt = Object.entries(FILE_EXTENSION_TOKENS).find(
      ([, t]) => t === token,
    );
    return [token, byExt ? `file.${byExt[0]}` : "file"];
  }),
);

// ── Folders ──────────────────────────────────────────────
// Folders aren't part of the sprite: the tree paints them through a CSS mask
// (see workspace-file-tree.tsx) and the pill uses lucide directly. Both draw
// the same two lucide glyphs — `folder` closed, `folder-open` expanded — so
// the outlines are exported here as data URLs for the mask.

const lucideDataUrl = (d: string) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='${d}'/%3E%3C/svg%3E")`;

/** lucide `folder`. */
export const FOLDER_CLOSED_MASK_URL = lucideDataUrl(
  "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
);
/** lucide `folder-open`. */
export const FOLDER_OPEN_MASK_URL = lucideDataUrl(
  "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2",
);
