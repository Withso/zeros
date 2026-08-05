// ──────────────────────────────────────────────────────────
// FileTypeIcon — the Files-tab's colored file-type glyphs, standalone
// ──────────────────────────────────────────────────────────
//
// The @-mention pill uses the same icon as the file tab. The Files tab wraps
// @pierre/trees with its bundled
// "complete" colored icon set. Those icons aren't exported as a React
// component, but two public helpers let us reuse them exactly:
//
//   • getBuiltInSpriteSheet("complete") — an SVG <symbol> sprite (injected
//     ONCE into the light DOM; every <use href="#…"> then resolves).
//   • createFileTreeIconResolver(...).resolveIcon("file-tree-icon-file", name)
//     — maps a filename → the exact builtin symbol id + a color token.
//
// The sprite glyphs paint with `currentColor`, so we apply the color
// ourselves via @pierre's real light-dark() palette keyed on the token —
// giving glyph-exact + color-faithful parity with the Files tab in both
// app themes. Folders/selection have no sprite glyph, so they fall back
// to lucide.
// ──────────────────────────────────────────────────────────

import { Folder, MousePointer2 } from "lucide-react";
import {
  createFileTreeIconResolver,
  getBuiltInSpriteSheet,
} from "@pierre/trees";

import { cn } from "../../../shared/ui/cn";

const SPRITE_DOM_ID = "zeros-file-icon-sprite";

// Inject the colored sprite sheet exactly once. Idempotent + guarded on a
// DOM lookup so HMR / re-imports don't duplicate it. Runs at module eval
// (Electron renderer — document.body exists by the time app modules load).
function ensureSprite(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(SPRITE_DOM_ID)) return;
  const holder = document.createElement("div");
  holder.id = SPRITE_DOM_ID;
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText =
    "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;";
  holder.innerHTML = getBuiltInSpriteSheet("complete");
  document.body.appendChild(holder);
}

ensureSprite();

const resolver = createFileTreeIconResolver({ set: "complete", colored: true });

// Explicit library boundary: @pierre's "complete" icon palette
// (mirrored 1:1 from the package's `--trees-icon-*: light-dark(…)` CSS vars),
// keyed by palette-color name. Glyphs are exact; this reproduces the Files-tab
// coloring without coupling to the tree's shadow-DOM CSS context. @pierre
// defines the tree's icon colors on `:host` inside its shadow root, so they
// can't be recolored from our `:root` tokens — the pill mirrors @pierre's OWN
// light-dark() pairs here to match the Files tab exactly in BOTH app themes
// (the light DOM's color-scheme follows data-theme via zeros-tokens.css, so
// these resolve against the app variant, not the OS — same as the tree after
// its `color-scheme: inherit` unsafeCSS override). This file is on the
// check:ui allowlist for that reason (same exemption as the xterm
// TERMINAL_THEME). Re-extract BOTH tables when bumping @pierre/trees.
const ICON_PALETTE: Record<string, string> = {
  blue: "light-dark(#1a85d4, #69b1ff)",
  cyan: "light-dark(#1ca1c7, #68cdf2)",
  gray: "light-dark(#84848a, #adadb1)",
  green: "light-dark(#199f43, #5ecc71)",
  indigo: "light-dark(#693acf, #9d6afb)",
  mauve: "light-dark(#594c5b, #79697b)",
  orange: "light-dark(#d47628, #ffa359)",
  pink: "light-dark(#d32a61, #ff678d)",
  purple: "light-dark(#a631be, #d568ea)",
  red: "light-dark(#d52c36, #ff6762)",
  teal: "light-dark(#17a5af, #64d1db)",
  vermilion: "light-dark(#ff8c5b, #d5512f)",
  yellow: "light-dark(#d5a910, #ffd452)",
};

// Resolver token → palette color, mirrored from the package stylesheet's
// `[data-icon-token='…'] { color: var(--trees-file-icon-color-…) }` rules
// (which in turn point at the --trees-icon-* colors above). Tokens the tree
// leaves unstyled (e.g. "font") fall through to the tree's muted foreground —
// our --fg3, exactly what TREE_THEME_VARS feeds --trees-fg-muted.
const TOKEN_PALETTE: Record<string, string> = {
  astro: "purple",
  babel: "yellow",
  bash: "green",
  biome: "blue",
  bootstrap: "indigo",
  browserslist: "yellow",
  bun: "mauve",
  c: "blue",
  claude: "orange",
  cpp: "blue",
  css: "indigo",
  database: "purple",
  default: "gray",
  docker: "blue",
  eslint: "indigo",
  git: "vermilion",
  go: "cyan",
  graphql: "pink",
  html: "orange",
  image: "pink",
  javascript: "yellow",
  json: "orange",
  markdown: "green",
  mcp: "teal",
  npm: "red",
  oxc: "cyan",
  postcss: "red",
  prettier: "teal",
  python: "blue",
  react: "cyan",
  ruby: "red",
  rust: "orange",
  sass: "pink",
  svelte: "red",
  svg: "orange",
  svgo: "green",
  swift: "orange",
  table: "teal",
  tailwind: "cyan",
  terraform: "indigo",
  text: "gray",
  typescript: "blue",
  vite: "purple",
  vscode: "blue",
  vue: "green",
  wasm: "indigo",
  webpack: "blue",
  yml: "red",
  zig: "orange",
  zip: "orange",
};

/** The color the Files tab paints this token with (see the tables above). */
function tokenColor(token: string): string {
  const palette = TOKEN_PALETTE[token];
  return palette ? ICON_PALETTE[palette] : "var(--fg3)";
}

export interface FileTypeIconProps {
  /** File/dir path or name used to resolve the glyph (e.g. "src/foo.ts"). */
  name: string;
  /** Mention kind — folders + selection use lucide; files use the sprite. */
  kind?: "file" | "folder" | "selection";
  size?: number;
  className?: string;
}

/** A single file-type glyph matching the Files tab. */
export function FileTypeIcon({
  name,
  kind = "file",
  size = 14,
  className,
}: FileTypeIconProps) {
  if (kind === "folder") {
    return (
      <Folder size={size} className={cn("text-fg2 shrink-0", className)} />
    );
  }
  if (kind === "selection") {
    return (
      <MousePointer2
        size={size}
        className={cn("text-fg2 shrink-0", className)}
      />
    );
  }
  const icon = resolver.resolveIcon("file-tree-icon-file", name);
  const color = tokenColor(icon.token ?? "default");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={cn("shrink-0", className)}
      style={{ color }}
      aria-hidden="true"
    >
      <use href={`#${icon.name}`} />
    </svg>
  );
}
