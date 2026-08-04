// ──────────────────────────────────────────────────────────
// @pierre/diffs ⇄ Zeros theme bridge (shared)
// ──────────────────────────────────────────────────────────
//
// Used by every surface that renders a <PatchDiff>: the Changes + Review tabs
// (shell/column3-tabs) and the agent chat's EditCard (zeros/agent/renderers).
// Lives in `appearance/` alongside resolve-tokens.ts — both bridge Zeros design
// tokens into an isolated rendering context that can't read the document's CSS.
//
// `@pierre/diffs` renders into a shadow DOM (DIFFS_TAG_NAME) with its own
// stylesheet, so global CSS can't reach it — exactly like @pierre/trees.
// Two knobs cross the boundary:
//
//   1. CSS custom properties INHERIT through the shadow root, so anything
//      we reference as `var(--…)` inside `unsafeCSS` resolves against the
//      live Zeros tokens on the host — themes track automatically, no JS.
//   2. `options.unsafeCSS` injects a stylesheet INTO the shadow root, the
//      same mechanism files-tab.tsx uses for @pierre/trees.
//
// Syntax-token colors come from the user's unified code theme (resolveDiffTheme
// — any Shiki bundled theme name, which @pierre/diffs resolves). The diff SURFACE
// (--diffs-bg) is a warm Zeros bg (--sidebar-bg in column 3, --bg1 in EditCards),
// and the CHROME (add/remove row wash, changed-word emphasis, edge bars, line
// numbers) is the Zeros palette — both bridged via @pierre's `--diffs-*` slots in
// diffShadowCss() below; @pierre derives every tint from the three color bases.
//
// Mirrors files-tab.tsx's TREE_THEME_VARS / TREE_SHADOW_CSS pattern.

import type { CodeViewOptions, ThemesType } from "@pierre/diffs";
import { DEFAULT_CODE_VIEW_LAYOUT } from "@pierre/diffs";
import { getPrefs } from "./store";
import { resolveCodeTheme } from "./code-themes";

/** Resolve the live diff theme from the user's unified codeTheme setting. The
 *  picked Shiki theme drives BOTH dark/light keys (so `themeType` just selects
 *  it), and `themeType` tracks the theme's appearance. @pierre/diffs accepts any
 *  bundled Shiki theme name. Read per-render by the option builders below;
 *  surfaces re-render via useCodeTheme so a picker change applies live. */
export function resolveDiffTheme(codeThemeId?: string): {
  theme: ThemesType;
  themeType: "dark" | "light";
} {
  const opt = resolveCodeTheme(codeThemeId ?? getPrefs().codeTheme);
  return {
    theme: { dark: opt.shiki, light: opt.shiki },
    themeType: opt.appearance,
  };
}

/** unsafeCSS injected into the diffs shadow root. Two knobs cross the boundary
 *  (custom properties inherit through the shadow root, so var(--…) resolves
 *  against zeros-tokens.css):
 *
 *  1. SURFACE — `--diffs-bg` is set to a warm Zeros surface (--sidebar-bg in
 *     column 3, --bg1 in chat EditCards), NOT @pierre's cool #000. @pierre derives
 *     context rows, gutter, and separator from it, so the whole diff matches the
 *     app. Syntax token colors still come from the picked Shiki theme.
 *  2. PALETTE — three base overrides; @pierre DERIVES the add/remove row wash,
 *     the changed-word emphasis, the edge bars, and the line numbers from them:
 *       addition → --green-primary · deletion → --red-primary
 *       modified/selection → --highlighted-bright (neutral warm-gray; replaces
 *       the package's navy #69b1ff). @pierre leaves the -override slots unset, so
 *       ours win. Fine-tune washes via --diffs-bg-*(-emphasis)-override.
 *  Preview: .context/diff-theme-preview.html. */
function diffShadowCss(surface: "bg1" | "bg2" | "sidebar-bg"): string {
  return `
  :host, pre, code {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  }
  pre, code { background: transparent; }
  :host {
    background: var(--${surface});
    --diffs-bg: var(--${surface});
    --diffs-addition-color-override: var(--green-primary);
    --diffs-deletion-color-override: var(--red-primary);
    --diffs-modified-color-override: var(--highlighted-bright);
  }
`;
}

/** Shared diff render options for the `options` prop of PatchDiff /
 *  MultiFileDiff / CodeView. `diffStyle` toggles unified vs split.
 *  `disableFileHeader` drops the in-diff file header — used by the agent chat's
 *  EditCard, whose own row already shows the path + counts, so the diff body
 *  starts straight at the code instead of repeating the filename.
 *  (`disableWorkerPool` is a TOP-LEVEL prop on those components, not an
 *  option — pass it on the element directly for small inline diffs.) */
export function zerosDiffOptions(opts?: {
  diffStyle?: "unified" | "split";
  disableFileHeader?: boolean;
  codeThemeId?: string;
  /** Diff surface bg. Column-3 diffs use "sidebar-bg" (default); EditCards "bg1". */
  surface?: "bg1" | "bg2" | "sidebar-bg";
}): {
  theme: ThemesType;
  themeType: "dark" | "light";
  unsafeCSS: string;
  diffStyle: "unified" | "split";
  overflow: "wrap";
  disableFileHeader?: boolean;
} {
  return {
    ...zerosSharedDiffPresentation(opts),
    ...(opts?.disableFileHeader ? { disableFileHeader: true } : {}),
  };
}

/** Visual contract shared by PatchDiff (Review/chat/hover) and CodeView
 * (Changes files). Keeping these keys built in one place prevents compact
 * previews from silently drifting in theme, diff style, chrome, or wrapping. */
function zerosSharedDiffPresentation(opts?: {
  diffStyle?: "unified" | "split";
  codeThemeId?: string;
  surface?: "bg1" | "bg2" | "sidebar-bg";
}): {
  theme: ThemesType;
  themeType: "dark" | "light";
  unsafeCSS: string;
  diffStyle: "unified" | "split";
  overflow: "wrap";
} {
  const { theme, themeType } = resolveDiffTheme(opts?.codeThemeId);
  return {
    theme,
    themeType,
    unsafeCSS: diffShadowCss(opts?.surface ?? "sidebar-bg"),
    diffStyle: opts?.diffStyle ?? "unified",
    // One file-reading contract across Review, Changes, chat, and hover
    // previews: long source lines reflow inside the available width instead of
    // creating a second horizontal navigation axis.
    overflow: "wrap",
  };
}

/** Same Zeros theme bridge, shaped for the `options` prop of the virtualized
 *  `<CodeView>` (the row-1 file Diff viewer). CodeView accepts the same
 *  theme/themeType/unsafeCSS/diffStyle pass-through keys as the single-file
 *  components, plus virtualization layout — so the diff chrome reads identically
 *  to the chat EditCard and the Review tab. */
export function zerosCodeViewOptions(opts?: {
  diffStyle?: "unified" | "split";
  disableFileHeader?: boolean;
  codeThemeId?: string;
  /** Diff surface bg. Column-3 file-tab diffs use "sidebar-bg" (default). */
  surface?: "bg1" | "bg2" | "sidebar-bg";
}): CodeViewOptions<undefined> {
  return {
    ...zerosSharedDiffPresentation(opts),
    ...(opts?.disableFileHeader ? { disableFileHeader: true } : {}),
    // Remove the leading top gap above the first line. With disableFileHeader,
    // @pierre/diffs stacks TWO top paddings that the file-viewer doesn't want
    // (its own toolbar already sits above): the CodeView layout's paddingTop AND
    // the file metrics' paddingTop (which falls back to `spacing` — ~8px — when
    // the header is disabled). Both together read as "too much gap before the
    // first line" that vanishes on scroll. Zero both so the diff starts flush
    // under the toolbar. Scoped to this builder (row-1 file viewer only); the
    // Changes/Review/EditCard PatchDiffs use zerosDiffOptions and keep the
    // library defaults.
    layout: { ...DEFAULT_CODE_VIEW_LAYOUT, paddingTop: 0 },
    itemMetrics: { paddingTop: 0 },
  };
}
