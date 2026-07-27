#!/usr/bin/env node
// ============================================================
// check-ui-consistency.mjs
// ------------------------------------------------------------
// Lint guardrail for RULES.md Rule 4, 11, 12, 14, 15.
//
// Scans src/**/*.{ts,tsx,css,mjs,js,jsx} and reports:
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
//
// Zero dependencies. Run: `node scripts/check-ui-consistency.mjs`
// Exit code is 0 (clean) or 1 (violations).
// ============================================================
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

// Files that ARE allowed to contain raw values (token definitions, etc.)
// Entries are freshness-checked (checkAllowlistFresh) — a deleted file must
// not keep a standing exemption.
const ALLOWLIST = new Set([
  "styles/zeros-tokens.css",
  // xterm.js theme object — the terminal emulator takes raw hex
  // strings in a JS object, cannot consume CSS custom properties.
  "src/shell/terminal/terminal-session-view.tsx",
  // @pierre/trees glyph palette — RULES.md §2.2 library boundary. These
  // hexes are @pierre's OWN "complete" light-dark() icon colors (mirrored
  // from the package), reproduced so the @-mention pill matches the Files
  // tab EXACTLY in both themes. @pierre colors the tree's icons on `:host`
  // in its shadow root, so they can't be recolored from our tokens — the
  // pill mirrors @pierre's values directly (see file header).
  "src/zeros/agent/composer-editor/file-type-icon.tsx",
]);

// Skip entire directories
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-engine",
  ".git",
  "target",
]);

const ALLOWED_FONT_SIZES_PX = new Set([10, 11, 12, 13, 15, 18]);
const ALLOWED_RADII_PX = new Set([0, 4, 6, 8, 12]);
// Spacing scale — matches --space-1..--space-12 in tokens.css.
// 1px is also allowed for column seams / dividers (Rule 13: "1px
// seams, not tone steps"). Everything else must snap to scale.
const ALLOWED_SPACE_PX = new Set([0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32, 40, 48]);

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
  const props = body.split(",").map((p) => p.trim()).filter(Boolean);
  const bad = [];
  for (const p of props) {
    const colon = p.indexOf(":");
    if (colon === -1) continue;
    const key = p.slice(0, colon).trim().replace(/^["']|["']$/g, "");
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
    if (/^(none|auto|inherit|initial|unset|currentColor|transparent)$/i.test(value)) continue;
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

const WEB_FONT_RE = /font-family\s*:\s*[^;]*\b(Inter|Roboto|Lato|Montserrat|Open Sans|Source Sans|IBM Plex|Poppins|Nunito)\b/i;

// --- 2026-07-12 audit-gap rules (color-theme audit §13) ---

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
// text-primary-button-fg, bg-muted-fg→fg3) from matching.
const DEAD_SHADCN_CLASS_RE =
  /(?<![\w-])(bg|text|border|ring|divide|outline|fill|stroke|from|to|via)-(background|foreground|card|popover|muted|accent|destructive|input|ring|border|primary|secondary)(?![\w-])/;

// bg3 as a FILL outside popover surfaces — foundation §5.4: in light, bg3 =
// bg1 = pure white, so a bg3 chip/state fill on a lower surface vanishes.
// Solid `bg-bg3` and `bg-bg3-hover` only; bg-bg3/α veils (75% drag scrims)
// are excluded — the broken alpha washes were migrated to bg-bg2/60.
const BG3_FILL_RE = /(?<![\w-])bg-bg3(?:-hover)?(?![\w/-])/;
// Files whose components ARE popover surfaces (popover/dropdown/menu content
// panels + their internal chips/hovers) — the one place bg3 fills belong.
// Add a file here ONLY if it owns a floating bg3 panel; chips on bg1/bg2
// surfaces take bg-bg2-hover, sidebar takes sidebar-bg-hover.
const BG3_SURFACE_FILES = new Set([
  "src/zeros/ui/primitives/dropdown-menu.tsx",
  "src/zeros/ui/primitives/context-menu.tsx",
  "src/zeros/ui/primitives/popover.tsx",
  // hover-card moved to bg-bg2 (a raised card, not a floating menu) 2026-07-15
  "src/zeros/ui/primitives/select.tsx",
  "src/zeros/ui/primitives/command.tsx",
  "src/shell/column2-new-chat-menu.tsx",
  "src/shell/dispatcher/create-from-source.tsx",
  "src/zeros/agent/agent-model-menu.tsx",
  "src/zeros/agent/project-context-chip.tsx",
  // Element-picker floating chip panel (browser tab's in-canvas popover).
  "src/shell/column3-tabs/browser-tab.tsx",
  // PopoverContent panels with internal menu-item hovers (Compact-now /
  // Copy-breakdown buttons rest transparent on the bg3 surface, hover bg3-hover).
  "src/zeros/agent/context-gauge.tsx",
  "src/zeros/agent/turn-footer.tsx",
]);

// bg3 as a RAW CSS background fill. BG3_FILL_RE above is Tailwind-class-based
// and skips .css, so `background: var(--bg3)` in globals.css (markdown
// <details>/<kbd> callouts, the react-flow canvas) slipped past the sweep
// (audit §13.4, CSS variant — fixed 2026-07-15). bg3 is floating-only: in
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
const PRIMITIVES_DIR = "src/zeros/ui/primitives/";

// --- Brand-accent surfaces (RULES.md Rule 6, Phase 8 lint) ---
//
// The v0 brand token surface — `--v0-brand` and its Tailwind
// utility classes (`bg-brand`, `text-brand`, `ring-brand`,
// `border-brand`, plus the `-foreground` variants) — must stay
// under 5% of pixels and follow the allowlist in RULES.md Rule 6.
//
// Files inside the appearance system + the v0 primitive surface
// + the token-definition layer are exempt. Everywhere else, an
// inline `check:ui ignore-line (accent: <reason>)` is required.
//
// Legacy `--accent`, `--accent-hover`, `--accent-soft-bg`,
// `--text-link`, `--ring-focus` are NOT flagged — they're
// scoped to die during the Phase 9 mass-migration in Roadmap 01.

const BRAND_TAILWIND_RE =
  /\b(bg|text|border|ring|fill|stroke|outline|caret|placeholder|decoration|shadow|divide)-brand(?:-foreground)?\b/;
const BRAND_VAR_RE = /var\s*\(\s*--v0-brand(?:-foreground)?\s*[,)]/;

// Files allowed to reference the brand token without a per-line
// justification. The appearance system computes `--zeros-accent`
// (which drives `--v0-brand` via the @theme alias); the v0
// primitives consume brand in their stock variants; the token
// files themselves declare the brand.
const BRAND_EXEMPT_FILES = new Set([
  "styles/tokens.css",
  "styles/zeros-tokens.css",
]);
const BRAND_EXEMPT_DIR_PREFIXES = [
  "src/zeros/ui/primitives/",
  "src/zeros/appearance/",
];

function isBrandExempt(rel) {
  if (BRAND_EXEMPT_FILES.has(rel)) return true;
  for (const prefix of BRAND_EXEMPT_DIR_PREFIXES) {
    if (rel.startsWith(prefix)) return true;
  }
  return false;
}

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
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".css"].includes(ext)) return false;
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
  const isPrimitivesCss = false; // primitives.css was retired in Phase 9.B/D

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
        if (!open && line.startsWith("/*", j)) { open = true; j += 2; continue; }
        if (open && line.startsWith("*/", j)) { open = false; j += 2; continue; }
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
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*");
      if (!isComment) {
        for (const m of hexMatches) {
          // Skip URL-looking contexts (anchor links, href="#…")
          const before = line.slice(Math.max(0, m.index - 5), m.index);
          if (before.includes("#")) continue;
          push(rel, ln, `Hex color "${m[0]}" — use a token from tokens.css (see RULES.md).`);
        }
      }
    }

    // --- rgba literals ---
    if (!isAllowlisted && /\brgba?\(/.test(line)) {
      const trimmed = line.trim();
      const isComment =
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*");
      if (!isComment) {
        push(rel, ln, "rgba() literal — use a primitive token from styles/zeros-tokens.css (e.g. --bg3, --border3, --highlighted-bright) or add a new one there.");
      }
    }

    // --- Primitive token leaks ---
    if (!isAllowlisted && PRIMITIVE_TOKEN_RE.test(line)) {
      push(rel, ln, "Primitive token referenced outside tokens.css — use a SEMANTIC token (e.g. --surface-0, --text-muted, --primary).");
    }

    // --- Zeros raw-ramp via var() (numeric step, not an anchor) ---
    if (!isAllowlisted) {
      const m = line.match(ZEROS_RAMP_VAR_RE);
      if (m) {
        push(rel, ln, `Raw palette ramp "${m[0]})" — numeric steps (--red-50…950) are private to zeros-tokens.css. Use a family anchor: var(--<family>-primary|secondary|bg|fg).`);
      }
    }

    // --- Tailwind color utility ---
    if (!isAllowlisted && !isCss && TAILWIND_COLOR_RE.test(line)) {
      push(rel, ln, "Tailwind color class — use a semantic token or a primitive component (see RULES.md Rule 12).");
    }

    // --- Zeros raw-ramp Tailwind class (numeric step, not an anchor) ---
    if (!isAllowlisted && !isCss) {
      const m = line.match(ZEROS_RAMP_CLASS_RE);
      if (m) {
        push(rel, ln, `Raw palette ramp "${m[0]}" — numeric steps (red-50…950) are private. Use a family anchor: text-<family>-primary | bg-<family>-bg | text-<family>-fg (see zeros-foundation.md §2.4).`);
      }
    }

    // --- Brand-accent surface (RULES.md Rule 6, Phase 8) ---
    // New v0 brand usage must be deliberate — < 5% of pixels, on
    // the allowlist surfaces only. The v0 primitive surface +
    // appearance system are exempt because they legitimately
    // wire the brand token through. Everywhere else requires a
    // `check:ui ignore-line (accent: <reason>)` justification.
    if (!isBrandExempt(rel)) {
      const tailwindBrand = !isCss && line.match(BRAND_TAILWIND_RE);
      const varBrand = line.match(BRAND_VAR_RE);
      if (tailwindBrand) {
        push(
          rel,
          ln,
          `Brand surface "${tailwindBrand[0]}" — needs allowlist justification (RULES.md Rule 6). Add "check:ui ignore-line (accent: <reason>)" if intentional.`,
        );
      } else if (varBrand) {
        push(
          rel,
          ln,
          `Brand var "var(--v0-brand…)" — needs allowlist justification (RULES.md Rule 6). Add "check:ui ignore-line (accent: <reason>)" if intentional.`,
        );
      }
    }

    // --- Web font ---
    if (!isAllowlisted && WEB_FONT_RE.test(line)) {
      push(rel, ln, "Web font referenced directly — use var(--font-ui) or var(--font-mono).");
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
        push(rel, ln, "hsl()/oklch() literal — raw colors live in styles/zeros-tokens.css; reference a token via var(--…).");
      }

      // *-white / *-black Tailwind classes
      if (!isAllowlisted && !isCss && !isComment) {
        const m = line.match(WHITE_BLACK_CLASS_RE);
        if (m) {
          push(rel, ln, `Theme-static class "${m[0]}" — use a token (overlay veils: bg-scrim; inverted content: inverted-bg/inverted-fg).`);
        }
      }

      // Dead shadcn alias classes (generate NO color — ring-1 paints solid currentColor)
      if (!isAllowlisted && !isCss && !isComment) {
        const m = line.match(DEAD_SHADCN_CLASS_RE);
        if (m) {
          push(rel, ln, `Dead shadcn class "${m[0]}" — no such token exists here, so it renders no color (a paired ring-N paints solid currentColor). Use a Zeros token (fg1/border1/highlighted-bright…).`);
        }
      }

      // bg3 as a fill outside popover surfaces (foundation §5.4)
      if (!isAllowlisted && !isCss && !isComment && !BG3_SURFACE_FILES.has(rel)) {
        const m = line.match(BG3_FILL_RE);
        if (m) {
          push(rel, ln, `"${m[0]}" fill outside a popover surface — in light bg3 = bg1 (white), the fill vanishes. Chips → bg-bg2-hover; sidebar → sidebar-bg-hover; real popover panels → add the file to BG3_SURFACE_FILES.`);
        }
      }

      // bg3 as a raw CSS background fill (the .css gap BG3_FILL_RE can't see)
      if (!isAllowlisted && isCss && !isComment) {
        const m = line.match(BG3_CSS_FILL_RE);
        if (m) {
          push(rel, ln, `"${m[0]}" — bg3 is floating-only (light bg3=bg1, dark bg3=sidebar-bg; a fill vanishes in both). Lifted content on bg1 → var(--bg1-highlight); a base surface → var(--bg2).`);
        }
      }

      // Tailwind shadow-md/lg/xl on floating primitives
      if (!isComment && rel.startsWith(PRIMITIVES_DIR)) {
        const m = line.match(TAILWIND_SHADOW_RE);
        if (m) {
          push(rel, ln, `"${m[0]}" on a floating primitive — use shadow-[var(--shadow-dropdown)] so the lift re-themes (it's load-bearing in light).`);
        }
      }
    }

    // --- font-size: Npx off-scale (CSS only, skip tokens file) ---
    if (isCss && !isAllowlisted && !isPrimitivesCss) {
      const fs = line.match(/font-size\s*:\s*(\d+(?:\.\d+)?)px\b/);
      if (fs) {
        const n = Number(fs[1]);
        if (!ALLOWED_FONT_SIZES_PX.has(n)) {
          push(rel, ln, `Off-scale font-size: ${n}px — snap to {10,11,12,13,15,18} via --text-N.`);
        }
      }
      // --- border-radius: Npx off-scale ---
      const br = line.match(/border-radius\s*:\s*(\d+(?:\.\d+)?)px\b/);
      if (br) {
        const n = Number(br[1]);
        if (!ALLOWED_RADII_PX.has(n) && n !== 9999 && n !== 50) {
          push(rel, ln, `Off-scale border-radius: ${n}px — use --radius-xs|sm|md|lg|pill|circle.`);
        }
      }
      // --- numeric z-index in CSS outside tokens + primitives ---
      const zi = line.match(/z-index\s*:\s*(\d+)/);
      if (zi) {
        push(rel, ln, `Numeric z-index: ${zi[1]} — use --z-chrome|panel|dropdown|modal|toast.`);
      }
      // --- odd space values in padding / gap / margin ---
      // Only flag solitary odd pixel values (e.g. `padding: 13px`).
      const spaceMatch = line.match(/\b(padding|margin|gap)\b\s*:\s*([^;]+)/);
      if (spaceMatch) {
        const values = spaceMatch[2].match(/\b(\d+(?:\.\d+)?)px\b/g) || [];
        for (const v of values) {
          const n = Number(v.replace("px", ""));
          if (!ALLOWED_SPACE_PX.has(n) && n > 0) {
            push(rel, ln, `Off-scale ${spaceMatch[1]} value: ${n}px — snap to even step via --space-N.`);
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
          push(rel, ln, `Inline style "${b.key}: ${b.value}" — use a class or primitive with a token (RULES.md Rule 14).`);
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
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  };
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);
  const re = /--[a-z0-9-]+:\s*hsl\(([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\)\s*;\s*\/\*\s*(#[0-9a-fA-F]{6})/;
  lines.forEach((line, idx) => {
    if (/check:ui\s+ignore-line/.test(line)) return;
    const m = line.match(re);
    if (!m) return;
    const actual = hslToRgb(+m[1], +m[2], +m[3]);
    const commented = [1, 3, 5].map((i) => parseInt(m[4].slice(i, i + 2), 16));
    const delta = Math.max(...actual.map((v, i) => Math.abs(v - commented[i])));
    if (delta > 8) {
      const hex = "#" + actual.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
      push(rel, idx + 1, `Comment-hex drift: value computes to ${hex} but the comment says ${m[4]} (Δ${delta}/channel) — fix the comment (or the value, deliberately).`);
    }
  });
}

// --- Stale allowlist entries: a deleted file must not keep an exemption ---
function checkAllowlistFresh() {
  for (const rel of ALLOWLIST) {
    if (!existsSync(join(ROOT, rel))) {
      push("scripts/check-ui-consistency.mjs", 1, `Stale ALLOWLIST entry "${rel}" — the file no longer exists; remove the entry.`);
    }
  }
}

// Run
const files = walk(SRC).filter(shouldScan);
for (const f of files) scanFile(f);
checkTokenCommentDrift();
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

console.log(`check:ui — ${violations.length} violation(s) across ${byFile.size} file(s)`);
console.log("");
for (const [file, vs] of [...byFile.entries()].sort()) {
  console.log(`  ${file}`);
  for (const v of vs) console.log(`    ${String(v.line).padStart(4)}: ${v.message}`);
  console.log("");
}
console.log('Fix violations above. See RULES.md — "Quick Decision Table" maps UI needs to tokens.');
process.exit(1);
