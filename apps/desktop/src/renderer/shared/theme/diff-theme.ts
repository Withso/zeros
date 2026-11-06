// ──────────────────────────────────────────────────────────
// @pierre/diffs ⇄ Zeros theme bridge (shared)
// ──────────────────────────────────────────────────────────
//
// Used by every surface that renders a <PatchDiff>: the Changes + Review tabs
// (shell/workbench/tabs) and the agent chat's EditCard (features/agent/renderers).
// Lives in `shared/theme/` alongside resolve-tokens.ts — both bridge Zeros design
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
// (--diffs-bg) is a Zeros structural surface (--sidebar-bg in workbench, --bg1
// in EditCards),
// and the CHROME (add/remove row wash, changed-word emphasis, edge bars, line
// numbers) is the Zeros palette — both bridged via @pierre's `--diffs-*` slots in
// diffShadowCss() below; @pierre derives every tint from the three color bases.
//
// Mirrors files-tab.tsx's TREE_THEME_VARS / TREE_SHADOW_CSS pattern.

import type { CodeViewOptions, ThemesType } from "@pierre/diffs";
import { DEFAULT_CODE_VIEW_LAYOUT } from "@pierre/diffs";
import { getPrefs } from "./store";
import { resolveCodeTheme } from "./code-themes";

const HUNK_CARD_HEIGHT = 28;
const HUNK_CARD_GAP = 8;
// Include both gaps in the separator's measured region, even at file edges.
// Pierre's virtualizer must reserve the same space that its shadow DOM paints.
const HUNK_SEPARATOR_HEIGHT = HUNK_CARD_HEIGHT + HUNK_CARD_GAP * 2;

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
 *  1. SURFACE — `--diffs-bg` is set to a Zeros structural surface
 *     (--sidebar-bg in workbench, --bg1 in chat EditCards), NOT @pierre's cool
 *     #000. @pierre derives context rows, gutter, and separator from it, so the
 *     whole diff matches the app. Syntax token colors still come from the picked
 *     Shiki theme.
 *  2. PALETTE — three base overrides; @pierre DERIVES the add/remove row wash,
 *     the changed-word emphasis, the edge bars, and the line numbers from them:
 *       addition → --green-primary · deletion → --red-primary
 *       modified/selection → --highlighted-bright (structural neutral; replaces
 *       the package's navy #69b1ff). @pierre leaves the -override slots unset, so
 *       ours win. Fine-tune washes via --diffs-bg-*(-emphasis)-override.
 *  Preview: styles/Artifacts/diff-theme-preview.html. */
function diffShadowCss(surface: "bg1" | "bg2" | "sidebar-bg"): string {
  return `
  :host, pre, code {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  }
  pre, code { background: transparent; }
  /* The document disables chrome selection. Opt only source lines back in
     inside the shadow root; headers, gutters and separators stay chrome. */
  [data-line] { -webkit-user-select: text; user-select: text; }
  :host {
    background: var(--${surface});
    --diffs-gap-block: 0px;
    --diffs-bg: var(--${surface});
    --diffs-addition-color-override: var(--diff-addition);
    --diffs-deletion-color-override: var(--diff-deletion);
    --diffs-modified-color-override: var(--highlighted-bright);
    --diffs-bg-separator-override: var(--bg2);
    --diffs-bg-addition-override: color-mix(in lab, var(--diffs-bg) 15%, color-mix(in srgb, var(--diff-addition) 65%, var(--diff-neutral)));
    --diffs-bg-deletion-override: color-mix(in lab, var(--diffs-bg) 15%, color-mix(in srgb, var(--diff-deletion) 65%, var(--diff-neutral)));
  }
  [data-separator="line-info"] {
    height: ${HUNK_SEPARATOR_HEIGHT}px;
    margin-block: 0;
    background: var(--diffs-bg);
  }
  [data-separator="line-info"] [data-separator-wrapper] {
    top: ${HUNK_CARD_GAP}px;
    height: ${HUNK_CARD_HEIGHT}px;
    grid-template-columns: ${HUNK_CARD_HEIGHT}px auto;
  }
  [data-separator="line-info"] [data-expand-button] {
    min-width: ${HUNK_CARD_HEIGHT}px;
  }
  [data-separator="line-info"] [data-expand-button] [data-icon] {
    width: 12px;
    height: 12px;
  }
  @media (pointer: coarse) {
    [data-separator="line-info"] [data-separator-multi-button] {
      grid-template-columns: ${HUNK_CARD_HEIGHT}px ${HUNK_CARD_HEIGHT}px auto;
    }
  }
`;
}

/** Pierre owns these shadow-DOM text nodes and offers no label option. Its
 * post-render hook also runs after context expansion and virtual remounts, so
 * the visible and accessible trailing label stay in sync on every surface. */
export function finishDiffRender(node: HTMLElement): void {
  for (const label of node.shadowRoot?.querySelectorAll(
    "[data-separator-last] [data-unmodified-lines]",
  ) ?? []) {
    if (label.textContent !== "More unmodified lines") {
      label.textContent = "More unmodified lines";
    }
  }
}

/** Workbench diffs (Changes and the Files Diff view) read in the plain
 *  editor's type, so turning Diff view on or off moves no text: 12px mono on
 *  a 1.6 line, numbers padded 12px each side with code 4px past them, and the
 *  editor's fg1 18% selection over any row wash. The virtualizer's line estimate is the same
 *  height, or the estimates drift from the painted rows across files. Chat
 *  EditCards and Review keep the 13/20 chat code style. */
const WORKBENCH_DIFF_LINE_HEIGHT = 19.2;

/** A new or untracked file keeps its bars and signs but no row or gutter
 *  wash, so a whole file never turns green; its numbers read as context. */
const NEW_FILE_ROWS = `
    --diffs-bg-addition-override: var(--diffs-bg);
    --diffs-bg-addition-number-override: var(--diffs-bg);
    --diffs-fg-number-addition-override: var(--diffs-fg-number);
`;
/** Each change drawn into its row: a solid 2px bar on the gutter edge (Pierre
 *  draws 4px, striped for deletions) and a + or − in the number's right
 *  padding, on the first visual line of a wrapped row like the number. The
 *  comment chip takes that corner on the row it shows on. */
const CHANGE_GUTTER_CSS = `
  [data-indicators="bars"] [data-column-number]:is([data-line-type="change-addition"], [data-line-type="change-deletion"])::before {
    width: 2px;
  }
  [data-indicators="bars"] [data-column-number][data-line-type="change-deletion"]::before {
    background-image: none;
    background-color: var(--diffs-deletion-base);
  }
  [data-column-number]:is([data-line-type="change-addition"], [data-line-type="change-deletion"])::after {
    position: absolute;
    top: 0;
    right: 1px;
    width: 10px;
    text-align: center;
    user-select: none;
    pointer-events: none;
  }
  [data-column-number][data-line-type="change-addition"]::after { content: "+"; }
  [data-column-number][data-line-type="change-deletion"]::after { content: "\\2212"; }
  [data-column-number]:has([data-utility-button])::after { content: none; }
  [data-diffs-header][data-change-type="new"] ~ pre {${NEW_FILE_ROWS}  }
`;
/** The editor's caret line lifts by fg1 5% over any row colour, number cell
 *  included, instead of Pierre's outlined theme highlight. */
const CARET_LINE_CSS = `
  [data-line][data-editor-active-line], [data-column-number][data-editor-active-line] {
    --diffs-computed-editor-active-line-bg: color-mix(in srgb, var(--diffs-computed-selected-line-bg) 95%, var(--fg1));
  }
  /* Pierre layers this sheet but not its editor's, so only important wins. */
  [data-line][data-editor-active-line]::after { box-shadow: none !important; }
  [data-column-number][data-editor-active-line][data-line-type^="context"] { color: var(--fg1); }
  [data-column-number][data-editor-active-line][data-line-type="change-addition"] {
    color: var(--diffs-fg-number-addition-override, var(--diffs-addition-base));
  }
  [data-column-number][data-editor-active-line][data-line-type="change-deletion"] {
    color: var(--diffs-fg-number-deletion-override, var(--diffs-deletion-base));
  }
`;
const WORKBENCH_DIFF_CSS = `
  :host {
    --diffs-font-size: 12px;
    --diffs-line-height: ${WORKBENCH_DIFF_LINE_HEIGHT}px;
  }
  [data-column-number] { padding-inline: 12px; border-right-width: 0; }
  [data-line] { padding-inline: 4px 6px; }
  ::selection { background-color: color-mix(in srgb, var(--fg1) 18%, transparent); }
${CHANGE_GUTTER_CSS}${CARET_LINE_CSS}`;

/** For a single-file diff whose base is empty (the Files Diff view of a new
 *  or untracked file), which has no Pierre file header to key on. */
export const NEW_FILE_DIFF_CSS = `
  pre {${NEW_FILE_ROWS}  }
`;

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
  /** Diff surface bg. Workbench diffs use "sidebar-bg" (default); EditCards "bg1". */
  surface?: "bg1" | "bg2" | "sidebar-bg";
}): {
  theme: ThemesType;
  themeType: "dark" | "light";
  unsafeCSS: string;
  diffStyle: "unified" | "split";
  overflow: "wrap";
  hunkSeparators: "line-info";
  onPostRender: (node: HTMLElement) => void;
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
  hunkSeparators: "line-info";
  onPostRender: (node: HTMLElement) => void;
} {
  const { theme, themeType } = resolveDiffTheme(opts?.codeThemeId);
  return {
    theme,
    themeType,
    unsafeCSS: diffShadowCss(opts?.surface ?? "sidebar-bg"),
    diffStyle: opts?.diffStyle ?? "unified",
    hunkSeparators: "line-info",
    onPostRender: finishDiffRender,
    // One file-reading contract across Review, Changes, chat, and hover
    // previews: long source lines reflow inside the available width instead of
    // creating a second horizontal navigation axis.
    overflow: "wrap",
  };
}

/** Same Zeros theme bridge, shaped for the `options` prop of the virtualized
 *  `<CodeView>` (the workbench file Diff viewer). CodeView accepts the same
 *  theme/themeType/unsafeCSS/diffStyle pass-through keys as the single-file
 *  components, plus virtualization layout — so the diff chrome reads identically
 *  to the chat EditCard and the Review tab. */
export function zerosCodeViewOptions<
  LAnnotation = undefined,
  Caret = undefined,
>(opts?: {
  diffStyle?: "unified" | "split";
  disableFileHeader?: boolean;
  codeThemeId?: string;
  /** Diff surface bg. Workbench file-tab diffs use "sidebar-bg" (default). */
  surface?: "bg1" | "bg2" | "sidebar-bg";
}): CodeViewOptions<LAnnotation, Caret> {
  const presentation = zerosSharedDiffPresentation(opts);
  return {
    ...presentation,
    unsafeCSS: presentation.unsafeCSS + WORKBENCH_DIFF_CSS,
    ...(opts?.disableFileHeader ? { disableFileHeader: true } : {}),
    layout: {
      ...DEFAULT_CODE_VIEW_LAYOUT,
      paddingTop: 0,
      paddingBottom: 0,
      gap: 0,
    },
    itemMetrics: {
      paddingTop: 0,
      paddingBottom: 0,
      spacing: 0,
      hunkSeparatorHeight: HUNK_SEPARATOR_HEIGHT,
      lineHeight: WORKBENCH_DIFF_LINE_HEIGHT,
    },
  };
}
