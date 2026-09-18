#!/usr/bin/env node
// ============================================================
// check-ui-consistency.mjs
// ------------------------------------------------------------
// Lint guardrail for the UI and styling section of RULES.md.
//
// Scans desktop source plus styles/global/**/*.{css} and reports:
//   • Hex colors outside tokens.css
//   • rgba() literals outside tokens.css / primitives.css
//   • Off-scale font-size: Npx (N not in {10,11,12,13,15,18})
//   • Off-scale border-radius: Npx (N not in {4,6,8,12})
//   • Odd space values (3,5,7,9,11,13,15) in CSS padding/gap/margin
//   • Numeric z-index in component files (not in tokens/primitives)
//   • Tailwind color classes: bg|text|border-(red|blue|...)-\d+
//   • Primitive tokens referenced outside tokens.css
//   • Inline style with static visual properties
//   • `Inter` or other web font names
//   • Class names in files no Tailwind @source scans (see below)
//
// Zero dependencies. Run: `node scripts/check-ui-consistency.mjs`
// Exit code is 0 (clean) or 1 (violations).
// ============================================================
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "apps", "desktop", "src");
const GLOBAL_STYLES = join(ROOT, "styles", "global");

// Files that ARE allowed to contain raw values (token definitions, etc.)
// Entries are freshness-checked (checkAllowlistFresh) — a deleted file must
// not keep a standing exemption.
const ALLOWLIST = new Set([
  "styles/zeros-tokens.css",
  // xterm.js theme object — the terminal emulator takes raw hex
  // strings in a JS object, cannot consume CSS custom properties.
  "apps/desktop/src/renderer/shell/terminal/terminal-session-view.tsx",
  // File-type icon sprite + its light-dark() palette. The glyphs render inside
  // @pierre/trees' shadow root AND in the light DOM (@-mention pills), and a
  // <use>'d symbol can only be colored through custom properties defined on
  // its host — so the palette lives with the sprite, not in zeros-tokens.css
  // (see file header).
  "apps/desktop/src/renderer/shared/theme/file-icons.ts",
  // Portable design-document boundary. This module emits an authored
  // `Zeros Design/tokens.css` seed whose palette cannot consume app-chrome
  // custom properties (the resulting files also render outside Zeros).
  "apps/desktop/src/engine/design/document-seeds.ts",
]);

// Skip entire directories
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-engine",
  ".git",
  "target",
]);

const ALLOWED_FONT_SIZES_PX = new Set([
  8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20,
]);
const ALLOWED_RADII_PX = new Set([0, 4, 6, 8, 12]);
// Spacing scale — matches --space-1..--space-12 in tokens.css.
// 1px is also allowed for column seams and dividers. Everything else must snap
// to the shared spacing scale.
const ALLOWED_SPACE_PX = new Set([
  0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48,
]);

// Non-Zeros families (orange/purple/gray/…) are raw Tailwind defaults — always
// banned in components; snap to a Zeros token instead.
const TAILWIND_COLOR_RE =
  /\b(bg|text|border|ring|divide|from|to|via|shadow|fill|stroke|outline|accent|caret|placeholder|decoration)-(orange|purple|pink|gray|grey|zinc|slate|neutral|stone|emerald|teal|cyan|sky|indigo|fuchsia|rose|amber|lime)-\d{2,3}\b/;

// The 6 Zeros families (red/green/yellow/blue/violet/brown) are a TWO-TIER system:
//   • ANCHORS — `-primary` / `-secondary` / `-bg` / `-fg` — ARE the semantic
//     layer; components use them directly (text-red-primary, bg-green-bg, …).
//   • RAW RAMPS — the numeric steps `-50 … -950` — are the private palette
//     backing the anchors; components must NEVER touch a numeric step.
// This RE matches ONLY the numeric ramp classes — anchors are non-numeric, so
// `\d{2,3}` can't match `-primary` / `-secondary` / `-bg` / `-fg`.
const ZEROS_RAMP_CLASS_RE =
  /\b(bg|text|border|ring|divide|from|to|via|shadow|fill|stroke|outline|accent|caret|placeholder|decoration)-(red|green|yellow|blue|violet|brown)-\d{2,3}\b/;

// Match hex colors like #fff, #ffffff, #ffff80 — but avoid URL fragments
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;

// Primitive tokens (raw Tailwind-ish scales) referenced via var() outside
// tokens.css.
const PRIMITIVE_TOKEN_RE =
  /var\(--(grey|orange|purple|pink|teal|cyan|indigo|fuchsia|lime|sky)-\d{2,3}\b/;

// Zeros-family RAW RAMP referenced via var() — e.g. `var(--red-400)`,
// `var(--blue-500)`. Same two-tier rule as ZEROS_RAMP_CLASS_RE: numeric steps
// are private to zeros-tokens.css; anchors (var(--red-primary), var(--red-bg))
// are fine and NOT matched here.
const ZEROS_RAMP_VAR_RE =
  /var\(--(red|green|yellow|blue|violet|brown)-\d{2,3}\b/;

// Inline style with static visual property. We only flag when we can
// see a literal value (string or number). var(--…) and dynamic identifiers
// are allowed.
// Two-stage check: find each `style={{ ... }}` body, then for each
// visual property in the body, verify its value either starts with
// `var(` or is a runtime identifier (not a literal).
const STYLE_BODY_RE = /\bstyle=\{\{([^}]+)\}\}/g;
const VISUAL_PROPS = new Set([
  "color",
  "background",
  "backgroundColor",
  "padding",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "margin",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "fontSize",
  "fontWeight",
  "fontFamily",
  "border",
  "borderRadius",
  "borderTop",
  "borderBottom",
  "borderLeft",
  "borderRight",
  "borderColor",
  "borderStyle",
  "borderWidth",
  "boxShadow",
  "zIndex",
]);

// Within a style body, split into property: value pairs and test each.
// A value is "OK" if it starts with `var(` (token), or is a pure
// identifier/expression (no string / hex / number literal).
function findInlineVisualViolations(body) {
  // Strip nested braces / parens for split safety.
  const props = body
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const bad = [];
  for (const p of props) {
    const colon = p.indexOf(":");
    if (colon === -1) continue;
    const key = p
      .slice(0, colon)
      .trim()
      .replace(/^["']|["']$/g, "");
    const raw = p.slice(colon + 1).trim();
    if (!VISUAL_PROPS.has(key)) continue;
    // Strip surrounding quotes/backticks if any.
    let value = raw;
    if (/^["'`]/.test(value)) value = value.slice(1);
    if (/["'`]$/.test(value)) value = value.slice(0, -1);
    value = value.trim();
    // Allowed values:
    //   - `var(--…)` token reference
    //   - `0`, `"0"`, `"none"`, `"auto"`, `"inherit"`, `"initial"`, `"unset"`
    //   - `calc(…)` expressions (runtime layout)
    //   - pure JS identifiers (rect.y, dims.w, foo?.bar, a ? b : c)
    if (/^var\s*\(/.test(value)) continue;
    if (/^0+$/.test(value)) continue;
    if (
      /^(none|auto|inherit|initial|unset|currentColor|transparent)$/i.test(
        value,
      )
    )
      continue;
    if (/^calc\s*\(/.test(value)) continue;
    // Runtime identifier / ternary expression: starts with identifier,
    // may include method calls, ternaries, string literals (for
    // `.startsWith("var(")` style checks). Must NOT start with a digit,
    // quote, or `#`.
    if (
      /^[A-Za-z_$]/.test(value) &&
      !/^(true|false)$/.test(value) &&
      /^[A-Za-z_$][A-Za-z0-9_$.?!()[\]\s"'`:|&+\-*/,<>=]*$/.test(value)
    )
      continue;
    // Flag anything else — it's a literal value.
    bad.push({ key, value });
  }
  return bad;
}

const WEB_FONT_RE =
  /font-family\s*:\s*[^;]*\b(Inter|Roboto|Lato|Montserrat|Open Sans|Source Sans|IBM Plex|Poppins|Nunito)\b/i;

// --- Raw-color and unsupported-token checks ---

// hsl()/oklch() literals — same class as hex/rgba: raw color values belong in
// zeros-tokens.css. `hsl(var(--…))` wrappers are ALSO wrong (our tokens are
// full colors, double-wrapping yields an invalid color) and still match here.
const HSL_OKLCH_RE = /\b(?:hsla?|oklch)\s*\(/;

// `bg-white` / `text-black` etc. — theme-static Tailwind colors. Overlay
// veils use the theme-scoped `bg-scrim` token; everything else has a token.
const WHITE_BLACK_CLASS_RE =
  /(?<![\w-])(bg|text|border|ring|from|to|via|fill|stroke|outline|divide)-(white|black)(?:\/\d+)?(?![\w-])/;

// DEAD shadcn alias classes — zeros-tokens.css defines no shadcn tokens, so
// these generate NO color; a paired `ring-1`/`ring-2` then paints solid
// full-opacity currentColor (the ring-foreground/ring-border/ring-accent
// family of bugs). The lookarounds keep real tokens (border-border1,
// text-primary-button-fg, text-muted-fg) from matching — `muted` is in the
// alternation, so only the trailing `(?![\w-])` keeps `muted-fg` out.
const DEAD_SHADCN_CLASS_RE =
  /(?<![\w-])(bg|text|border|ring|divide|outline|fill|stroke|from|to|via)-(background|foreground|card|popover|muted|accent|destructive|input|ring|border|primary|secondary)(?![\w-])/;

// bg3 as a FILL outside popover surfaces — foundation §5.4: in light, bg3 =
// bg1 = pure white, so a bg3 chip/state fill on a lower surface vanishes.
// Solid `bg-bg3` and `bg-bg3-hover` only; bg-bg3/α veils (75% drag scrims)
// are excluded — the broken alpha washes were migrated to bg-bg2/60.
// NOTE: a temporary RESERVED_FG3_RE rule lived here while --fg3 was declared but
// had zero consumers (the foreground-tier consolidation, foundation §9.1.1). The
// middle tier has since been adopted — placeholders and the file tree's ignored
// rows consume it — so the rule was removed as that change's final step. --fg3 is
// now an ordinary token needing no special guard.

const BG3_FILL_RE = /(?<![\w-])bg-bg3(?:-hover)?(?![\w/-])/;
// Files whose components ARE popover surfaces (popover/dropdown/menu content
// panels + their internal chips/hovers) — the one place bg3 fills belong.
// Add a file here ONLY if it owns a floating bg3 panel; chips on bg1/bg2
// surfaces take bg-bg2-hover, sidebar takes sidebar-bg-hover.
const BG3_SURFACE_FILES = new Set([
  "apps/desktop/src/renderer/shared/ui/primitives/dropdown-menu.tsx",
  "apps/desktop/src/renderer/shared/ui/primitives/context-menu.tsx",
  "apps/desktop/src/renderer/shared/ui/primitives/popover.tsx",
  // hover-card moved to bg-bg2 (a raised card, not a floating menu) 2026-07-15
  "apps/desktop/src/renderer/shared/ui/primitives/select.tsx",
  "apps/desktop/src/renderer/shared/ui/primitives/command.tsx",
  "apps/desktop/src/renderer/shell/conversation/new-chat-menu.tsx",
  "apps/desktop/src/renderer/shell/dispatcher/create-from-source.tsx",
  "apps/desktop/src/renderer/features/agent/agent-model-menu.tsx",
  "apps/desktop/src/renderer/features/agent/project-context-chip.tsx",
  // Element-picker floating chip panel (browser tab's in-canvas popover).
  "apps/desktop/src/renderer/shell/workbench/tabs/browser-tab.tsx",
  // PopoverContent panels with internal menu-item hovers (Compact-now /
  // Copy-breakdown buttons rest transparent on the bg3 surface, hover bg3-hover).
  "apps/desktop/src/renderer/features/agent/context-gauge.tsx",
  "apps/desktop/src/renderer/features/agent/turn-footer.tsx",
]);

// bg3 as a RAW CSS background fill. BG3_FILL_RE above is Tailwind-class-based
// and skips .css, so `background: var(--bg3)` in globals.css (markdown
// <details>/<kbd> callouts and the react-flow canvas are not covered by the
// Tailwind-class check. bg3 is floating-only: in
// light bg3 == bg1 (white), in dark bg3 == sidebar-bg (barely above bg1), so a
// fill vanishes in both. Lifted content on bg1 → --bg1-highlight; a base
// surface → --bg2. Matches the property, so `--color-bg3: var(--bg3)` (the
// @theme alias in the allowlisted tokens file) is NOT caught.
const BG3_CSS_FILL_RE = /background(?:-color)?\s*:\s*var\(--bg3(?:-hover)?\)/;

// Off-system Tailwind shadows on floating primitives — floating surfaces get
// their lift from the re-theming `--shadow-dropdown` (load-bearing in light,
// where a borderless white panel has no other separation). Scoped to the
// primitives dir; app-level decorative shadows aren't flagged.
const TAILWIND_SHADOW_RE = /(?<![\w-])shadow-(md|lg|xl|2xl)(?![\w-])/;
const PRIMITIVES_DIR = "apps/desktop/src/renderer/shared/ui/primitives/";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function shouldScan(file) {
  const ext = extname(file).toLowerCase();
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".css"].includes(ext))
    return false;
  if (file.includes("/scripts/")) return false;
  return true;
}

function toRel(abs) {
  return relative(ROOT, abs).split(sep).join("/");
}

const violations = [];

function push(file, line, message) {
  violations.push({ file, line, message });
}

function scanFile(absPath) {
  const rel = toRel(absPath);
  const src = readFileSync(absPath, "utf8");
  const lines = src.split(/\r?\n/);
  const isAllowlisted = ALLOWLIST.has(rel);
  const isCss = absPath.endsWith(".css");
  const isPrimitivesCss = false; // primitives.css has been retired

  // Per-line "inside a /* … */ block comment" flags — continuation lines of a
  // block comment often carry no leading `*`, so the trim-prefix heuristic
  // misses them (e.g. prose mentioning bg-bg3 or hsl() in a CSS comment).
  // Line-granular by design: code sharing a line with a comment still scans.
  const inBlock = new Array(lines.length).fill(false);
  {
    let open = false;
    lines.forEach((line, i) => {
      inBlock[i] = open;
      let j = 0;
      while (j < line.length) {
        if (!open && line.startsWith("/*", j)) {
          open = true;
          j += 2;
          continue;
        }
        if (open && line.startsWith("*/", j)) {
          open = false;
          j += 2;
          continue;
        }
        j++;
      }
    });
  }

  lines.forEach((line, idx) => {
    const ln = idx + 1;
    // Per-line suppression directive. Either:
    //   • place `check:ui ignore-line` on the SAME line as the
    //     violation (in a trailing comment), OR
    //   • place `check:ui ignore-next` on the line immediately
    //     ABOVE the violation (useful for long string literals).
    // Use sparingly, always with a reason in the same comment.
    if (/check:ui\s+ignore-line/.test(line)) return;
    if (idx > 0 && /check:ui\s+ignore-next/.test(lines[idx - 1])) return;

    // --- HEX colors ---
    // Allow in allowlisted files and in comments in any file.
    if (!isAllowlisted) {
      const hexMatches = [...line.matchAll(HEX_RE)];
      // Ignore comment lines (CSS `/*`, JS `//` or `*`)
      const trimmed = line.trim();
      const isComment =
        inBlock[idx] ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*");
      if (!isComment) {
        for (const m of hexMatches) {
          // Skip URL-looking contexts (anchor links, href="#…")
          const before = line.slice(Math.max(0, m.index - 5), m.index);
          if (before.includes("#")) continue;
          push(
            rel,
            ln,
            `Hex color "${m[0]}" — use a token from tokens.css (see RULES.md).`,
          );
        }
      }
    }

    // --- rgba literals ---
    if (!isAllowlisted && /\brgba?\(/.test(line)) {
      const trimmed = line.trim();
      const isComment =
        inBlock[idx] ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*");
      if (!isComment) {
        push(
          rel,
          ln,
          "rgba() literal — use a primitive token from styles/zeros-tokens.css (e.g. --bg3, --border3, --highlighted-bright) or add a new one there.",
        );
      }
    }

    // --- Primitive token leaks ---
    if (!isAllowlisted && PRIMITIVE_TOKEN_RE.test(line)) {
      push(
        rel,
        ln,
        "Primitive token referenced outside tokens.css — use a SEMANTIC token (e.g. --surface-0, --text-muted, --primary).",
      );
    }

    // --- Zeros raw-ramp via var() (numeric step, not an anchor) ---
    if (!isAllowlisted) {
      const m = line.match(ZEROS_RAMP_VAR_RE);
      if (m) {
        push(
          rel,
          ln,
          `Raw palette ramp "${m[0]})" — numeric steps (--red-50…950) are private to zeros-tokens.css. Use a family anchor: var(--<family>-primary|secondary|bg|fg).`,
        );
      }
    }

    // --- Tailwind color utility ---
    if (!isAllowlisted && !isCss && TAILWIND_COLOR_RE.test(line)) {
      push(
        rel,
        ln,
        "Tailwind color class — use a semantic token or a primitive component (see RULES.md UI and styling).",
      );
    }

    // --- Zeros raw-ramp Tailwind class (numeric step, not an anchor) ---
    if (!isAllowlisted && !isCss) {
      const m = line.match(ZEROS_RAMP_CLASS_RE);
      if (m) {
        push(
          rel,
          ln,
          `Raw palette ramp "${m[0]}" — numeric steps (red-50…950) are private. Use a family anchor: text-<family>-primary | bg-<family>-bg | text-<family>-fg (see zeros-foundation.md §2.4).`,
        );
      }
    }

    // --- Web font ---
    if (!isAllowlisted && WEB_FONT_RE.test(line)) {
      push(
        rel,
        ln,
        "Web font referenced directly — use var(--font-ui) or var(--font-mono).",
      );
    }

    // --- 2026-07-12 audit-gap rules (comments excluded like hex/rgba) ---
    {
      const trimmed = line.trim();
      const isComment =
        inBlock[idx] ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("{/*");

      // hsl()/oklch() literals
      if (!isAllowlisted && !isComment && HSL_OKLCH_RE.test(line)) {
        push(
          rel,
          ln,
          "hsl()/oklch() literal — raw colors live in styles/zeros-tokens.css; reference a token via var(--…).",
        );
      }

      // *-white / *-black Tailwind classes
      if (!isAllowlisted && !isCss && !isComment) {
        const m = line.match(WHITE_BLACK_CLASS_RE);
        if (m) {
          push(
            rel,
            ln,
            `Theme-static class "${m[0]}" — use a token (overlay veils: bg-scrim; inverted content: inverted-bg/inverted-fg).`,
          );
        }
      }

      // Dead shadcn alias classes (generate NO color — ring-1 paints solid currentColor)
      if (!isAllowlisted && !isCss && !isComment) {
        const m = line.match(DEAD_SHADCN_CLASS_RE);
        if (m) {
          push(
            rel,
            ln,
            `Dead shadcn class "${m[0]}" — no such token exists here, so it renders no color (a paired ring-N paints solid currentColor). Use a Zeros token (fg1/border1/highlighted-bright…).`,
          );
        }
      }

      // bg3 as a fill outside popover surfaces (foundation §5.4)
      if (
        !isAllowlisted &&
        !isCss &&
        !isComment &&
        !BG3_SURFACE_FILES.has(rel)
      ) {
        const m = line.match(BG3_FILL_RE);
        if (m) {
          push(
            rel,
            ln,
            `"${m[0]}" fill outside a popover surface — in light bg3 = bg1 (white), the fill vanishes. Chips → bg-bg2-hover; sidebar → sidebar-bg-hover; real popover panels → add the file to BG3_SURFACE_FILES.`,
          );
        }
      }

      // bg3 as a raw CSS background fill (the .css gap BG3_FILL_RE can't see)
      if (!isAllowlisted && isCss && !isComment) {
        const m = line.match(BG3_CSS_FILL_RE);
        if (m) {
          push(
            rel,
            ln,
            `"${m[0]}" — bg3 is floating-only (light bg3=bg1, dark bg3=sidebar-bg; a fill vanishes in both). Lifted content on bg1 → var(--bg1-highlight); a base surface → var(--bg2).`,
          );
        }
      }

      // Tailwind shadow-md/lg/xl on floating primitives
      if (!isComment && rel.startsWith(PRIMITIVES_DIR)) {
        const m = line.match(TAILWIND_SHADOW_RE);
        if (m) {
          push(
            rel,
            ln,
            `"${m[0]}" on a floating primitive — use shadow-[var(--shadow-dropdown)] so the lift re-themes (it's load-bearing in light).`,
          );
        }
      }
    }

    // --- font-size: Npx off-scale (CSS only, skip tokens file) ---
    if (isCss && !isAllowlisted && !isPrimitivesCss) {
      const fs = line.match(/font-size\s*:\s*(\d+(?:\.\d+)?)px\b/);
      if (fs) {
        const n = Number(fs[1]);
        if (!ALLOWED_FONT_SIZES_PX.has(n)) {
          push(
            rel,
            ln,
            `Off-scale font-size: ${n}px — use the documented type scale or a justified boundary exception.`,
          );
        }
      }
      // --- border-radius: Npx off-scale ---
      const br = line.match(/border-radius\s*:\s*(\d+(?:\.\d+)?)px\b/);
      if (br) {
        const n = Number(br[1]);
        if (!ALLOWED_RADII_PX.has(n) && n !== 9999 && n !== 50) {
          push(
            rel,
            ln,
            `Off-scale border-radius: ${n}px — use --radius-xs|sm|md|lg|pill|circle.`,
          );
        }
      }
      // --- numeric z-index in CSS outside tokens + primitives ---
      const zi = line.match(/z-index\s*:\s*(\d+)/);
      if (zi) {
        push(
          rel,
          ln,
          `Numeric z-index: ${zi[1]} — use --z-chrome|panel|dropdown|modal|toast.`,
        );
      }
      // --- odd space values in padding / gap / margin ---
      // Only flag solitary odd pixel values (e.g. `padding: 13px`).
      const spaceMatch = line.match(/\b(padding|margin|gap)\b\s*:\s*([^;]+)/);
      if (spaceMatch) {
        const values = spaceMatch[2].match(/\b(\d+(?:\.\d+)?)px\b/g) || [];
        for (const v of values) {
          const n = Number(v.replace("px", ""));
          if (!ALLOWED_SPACE_PX.has(n) && n > 0) {
            push(
              rel,
              ln,
              `Off-scale ${spaceMatch[1]} value: ${n}px — snap to even step via --space-N.`,
            );
          }
        }
      }
    }

    // --- inline visual style (two-stage) ---
    if (/\.tsx?$/.test(absPath)) {
      const matches = [...line.matchAll(STYLE_BODY_RE)];
      for (const m of matches) {
        const bad = findInlineVisualViolations(m[1]);
        for (const b of bad) {
          push(
            rel,
            ln,
            `Inline style "${b.key}: ${b.value}" — use a class or primitive with a token (see RULES.md UI and styling).`,
          );
        }
      }
    }
  });
}

// --- Tokens-file hygiene: hex comments must match the actual HSL values ---
//
// The light theme was specified with exact user-provided hexes, so a comment
// that no longer matches its value is dangerous documentation: someone
// "fixing" the value toward a stale comment hex can silently break contrast
// (the fg2 #8E8885-vs-#625D5B incident, 2026-07-12). Tolerance ±8/channel —
// hsl() quantization rounds a hex round-trip by a few points.
function checkTokenCommentDrift() {
  const rel = "styles/zeros-tokens.css";
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return;
  const hslToRgb = (h, s, l) => {
    s /= 100;
    l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) =>
      l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  };
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);
  const re =
    /--[a-z0-9-]+:\s*hsl\(([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)\s*;\s*\/\*\s*(#[0-9a-fA-F]{6})/;
  lines.forEach((line, idx) => {
    if (/check:ui\s+ignore-line/.test(line)) return;
    const m = line.match(re);
    if (!m) return;
    const actual = hslToRgb(+m[1], +m[2], +m[3]);
    const commented = [1, 3, 5].map((i) => parseInt(m[4].slice(i, i + 2), 16));
    const delta = Math.max(...actual.map((v, i) => Math.abs(v - commented[i])));
    if (delta > 8) {
      const hex =
        "#" +
        actual
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("")
          .toUpperCase();
      push(
        rel,
        idx + 1,
        `Comment-hex drift: value computes to ${hex} but the comment says ${m[4]} (Δ${delta}/channel) — fix the comment (or the value, deliberately).`,
      );
    }
  });
}

// KNOWN COVERAGE GAP (surfaced by the foreground-tier consolidation, 2026-08):
// the scan roots are apps/desktop/src and styles/global, so the root-level
// stylesheets main.tsx imports directly — styles/semantic-tokens.css and
// styles/globals.css — are reached by NO line rule. They are hand-authored and
// alias primitives, so they can drift past every check in this file.
// zeros-tokens.css is different: it is deliberately ALLOWLISTed and covered by
// checkTokenCommentDrift(). Widening the scan roots to include the other two
// needs a pass over which rules should legitimately apply there first.

// ============================================================
// Tailwind @source coverage
// ------------------------------------------------------------
// styles/zeros-tokens.css opens with `@import "tailwindcss" source(none)`
// and then names its sources explicitly. That turned off v4's automatic
// detection, which walks up to the nearest .git and scans the ENTIRE repo
// for anything shaped like a class name — it was shipping 155 rules the
// renderer never asked for (Playwright locators, npm script names, the
// marketing app's breakpoints, `!contents` from a TypeScript negation, and
// the very classes §14 bans, present only because the docs name them).
//
// The cost of that fix is this rule's reason to exist: an allowlist can go
// stale silently. A new class-bearing file outside the listed roots is not
// an error anywhere — Tailwind just never emits its utilities, and the UI
// renders unstyled. So: every file carrying class markup must be scanned by
// SOMETHING, or be explicitly exempt with a reason.
//
// The check is bidirectional, which is what keeps it cheap to maintain:
//   → uncovered class markup fails (the hole this rule exists to close);
//   → an exemption that no longer suppresses anything fails (dead entries
//     can't accumulate);
//   → a @source pointing into an exempt zone fails (prototypes and docs
//     can't be re-admitted by widening a root);
//   → dropping `source(none)` fails (it would silently restore repo-wide
//     scanning and make this whole table decorative).
// Nothing here needs touching until one of those actually changes.
const TAILWIND_ENTRY = "styles/zeros-tokens.css";

// Files whose class names are NOT meant for the desktop bundle. Each entry
// must suppress at least one real class-bearing file or it is reported as
// stale, so this table stays the size of the problem.
const SOURCE_EXEMPT = [
  {
    why: "test files and fixtures — asserted against, never shipped markup",
    match: (rel) =>
      /(^|\/)__tests__\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel),
  },
  {
    why: "standalone design prototypes — deliberately free-form, self-styled, and explicitly NOT held to the design system",
    match: (rel) => rel.startsWith("styles/Artifacts/"),
  },
  {
    why: "build and smoke harnesses — Playwright selectors and fixture markup that never reach a bundle",
    match: (rel) => rel.startsWith("scripts/"),
  },
  {
    why: "separate app with its own Tailwind entry (apps/marketing/src/index.css)",
    match: (rel) => rel.startsWith("apps/marketing/"),
  },
  {
    why: "standalone static pages served by apps/web, styled by hand-written CSS in apps/web/public",
    match: (rel) => rel.startsWith("apps/web/"),
  },
  {
    why: "standalone package preview page, opened directly and styled by its own inline <style>",
    match: (rel) => rel === "packages/zeros-logo-particles/preview.html",
  },
];

// What counts as class markup: a JSX `className=` attribute, a `className:`
// prop in an object, an HTML `class=`, or one of the class-string helpers this
// app builds variants with. The `(?<![.\w])` guards matter — without them
// `wrapper.className = parent.className` in electron/iframe-picker-script.ts
// reads as markup, which is the same mistake that made Tailwind compile
// `!contents` out of a TypeScript negation.
const CLASS_MARKUP_RE =
  /(?<![.\w])className\s*=\s*["'{`]|(?<![.\w])className\s*:\s*["'`]|\sclass\s*=\s*["']|\b(?:cva|clsx|twMerge)\s*\(/;
const MARKUP_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".html",
]);

// Every non-ignored file, tracked or not — the same set Tailwind's own
// detection would consider (it reads the filesystem and honours .gitignore),
// and far cheaper than walking the tree ourselves. `--others` matters: a
// brand-new component is exactly when this rule has something to say, and
// waiting for `git add` to say it would make the check useless locally.
function scannableFiles() {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter(Boolean);
}

// This rule's whole job is to notice silence, so it must never BE silent: if
// the file list can't be built, say so and fail rather than report clean.
function scannableFilesOrReport() {
  try {
    return scannableFiles();
  } catch (err) {
    push(
      "scripts/check-ui-consistency.mjs",
      1,
      `Could not list files to check @source coverage (${err.message.split("\n")[0]}) — this rule needs \`git ls-files\` and was NOT applied. Run from inside the repo.`,
    );
    return null;
  }
}

function checkTailwindSourceCoverage() {
  const entryAbs = join(ROOT, TAILWIND_ENTRY);
  if (!existsSync(entryAbs)) return;
  const entry = readFileSync(entryAbs, "utf8");
  const entryLine = (re) => {
    const idx = entry.split(/\r?\n/).findIndex((l) => re.test(l));
    return idx === -1 ? 1 : idx + 1;
  };

  const importRe = /@import\s+["']tailwindcss["'][^;]*;/;
  const importStmt = entry.match(importRe);
  if (!importStmt) return;
  if (!/\bsource\(none\)/.test(importStmt[0])) {
    push(
      TAILWIND_ENTRY,
      entryLine(importRe),
      "Tailwind import dropped `source(none)` — automatic detection is back, so the whole repo (design prototypes, docs, scripts, the marketing app) feeds the renderer bundle again. Restore it, or delete the @source list and this rule together.",
    );
    return;
  }

  // `@source "…"` roots, resolved from the stylesheet's own directory.
  // `@source inline(…)` / `@source not …` name no filesystem path — skip them.
  const roots = [];
  for (const m of entry.matchAll(
    /@source\s+(?!inline|not\b)["']([^"']+)["']/g,
  )) {
    const rel = toRel(join(ROOT, dirname(TAILWIND_ENTRY), m[1]));
    roots.push({ raw: m[1], rel });
    if (!existsSync(join(ROOT, rel))) {
      push(
        TAILWIND_ENTRY,
        entryLine(
          new RegExp(
            `@source\\s+["']${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
          ),
        ),
        `Stale @source "${m[1]}" — the path no longer exists. Remove it, or repoint it at where the markup moved.`,
      );
    }
  }
  const covered = (rel) =>
    roots.some((r) => rel === r.rel || rel.startsWith(`${r.rel}/`));

  // A root that reaches into an exempt zone re-opens the hole from the other
  // side: widen `@source "../styles"` and every prototype ships again. Match
  // the root as a DIRECTORY too — the zones are written as `foo/` prefixes,
  // which the bare root path `foo` would slip past.
  const swallowed = new Set();
  for (const r of roots) {
    const i = SOURCE_EXEMPT.findIndex(
      (e) => e.match(r.rel) || e.match(`${r.rel}/`),
    );
    if (i === -1) continue;
    swallowed.add(i);
    push(
      TAILWIND_ENTRY,
      entryLine(
        new RegExp(
          `@source\\s+["']${r.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
        ),
      ),
      `@source "${r.raw}" points into an exempt zone (${SOURCE_EXEMPT[i].why}) — those class names would ship to the app. Narrow the root, or drop the exemption deliberately.`,
    );
  }

  // Only files OUTSIDE the roots can be uncovered, so covered paths are
  // dismissed on the path alone and never read.
  const credited = new Set();
  const files = scannableFilesOrReport();
  if (!files) return;
  for (const rel of files) {
    if (covered(rel)) continue;
    if (!MARKUP_EXT.has(extname(rel).toLowerCase())) continue;
    let src;
    try {
      src = readFileSync(join(ROOT, rel), "utf8");
    } catch {
      continue;
    }
    if (!CLASS_MARKUP_RE.test(src)) continue;

    const zone = SOURCE_EXEMPT.findIndex((e) => e.match(rel));
    if (zone !== -1) {
      credited.add(zone);
      continue;
    }
    // Suggest the directory, except for a lone file at the repo root
    // (`@source "../."` would re-admit the entire tree).
    const suggest = rel.includes("/")
      ? rel.slice(0, rel.lastIndexOf("/"))
      : rel;
    push(
      rel,
      1,
      `Class names here are compiled by nothing: no @source in ${TAILWIND_ENTRY} covers this file, so Tailwind never emits its utilities and the markup renders unstyled. Add \`@source "../${suggest}";\` there — or, if this is not app markup, an entry in SOURCE_EXEMPT (scripts/check-ui-consistency.mjs) saying why.`,
    );
  }

  SOURCE_EXEMPT.forEach((e, i) => {
    // `swallowed` zones are already reported above, with the cause; not
    // crediting them is a SYMPTOM of that, so don't say it twice.
    if (credited.has(i) || swallowed.has(i)) return;
    push(
      "scripts/check-ui-consistency.mjs",
      1,
      `Stale SOURCE_EXEMPT entry "${e.why}" — it no longer suppresses any class-bearing file; remove it.`,
    );
  });
}

// --- Stale allowlist entries: a deleted file must not keep an exemption ---
function checkAllowlistFresh() {
  for (const rel of ALLOWLIST) {
    if (!existsSync(join(ROOT, rel))) {
      push(
        "scripts/check-ui-consistency.mjs",
        1,
        `Stale ALLOWLIST entry "${rel}" — the file no longer exists; remove the entry.`,
      );
    }
  }
}

// Run
const files = [SRC, GLOBAL_STYLES].flatMap((root) =>
  existsSync(root) ? walk(root).filter(shouldScan) : [],
);
for (const f of files) scanFile(f);
checkTokenCommentDrift();
checkTailwindSourceCoverage();
checkAllowlistFresh();

if (violations.length === 0) {
  console.log("check:ui — clean");
  process.exit(0);
}

// Group by file for readable output
const byFile = new Map();
for (const v of violations) {
  if (!byFile.has(v.file)) byFile.set(v.file, []);
  byFile.get(v.file).push(v);
}

console.log(
  `check:ui — ${violations.length} violation(s) across ${byFile.size} file(s)`,
);
console.log("");
for (const [file, vs] of [...byFile.entries()].sort()) {
  console.log(`  ${file}`);
  for (const v of vs)
    console.log(`    ${String(v.line).padStart(4)}: ${v.message}`);
  console.log("");
}
console.log(
  'Fix violations above. See RULES.md — "Quick Decision Table" maps UI needs to tokens.',
);
process.exit(1);
