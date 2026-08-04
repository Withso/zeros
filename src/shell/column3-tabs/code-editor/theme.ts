// ──────────────────────────────────────────────────────────
// CodeMirror editor CHROME, bound to the Zeros foundation tokens
// ──────────────────────────────────────────────────────────
//
// Chrome only — background, gutter, cursor, active line, selection, and the
// bracket/selection-match tints. It rides the Zeros CSS variables (--bg*/--fg*/
// --font-mono…) so the editor matches the surrounding Files-tab surface, with
// color-mix overlays keeping the tints subtle and theme-agnostic.
//
// TOKEN COLOR is owned entirely by the Shiki layer (shiki-highlight.ts) for
// exact parity with the diff view + code blocks — so there is NO
// syntaxHighlighting() here. The Lezer language extension still loads for
// STRUCTURE (folding, indent, bracket matching). The BASE foreground is the
// active code theme's own `fg` (resolved by the caller, see use-code-theme-fg),
// applied here as CHROME rather than imperatively by the plugin: a CSS rule
// lands on the very first painted frame, so even the rare cold-highlighter open
// starts in the code theme instead of the app's --fg1 and repainting. It falls
// back to --fg1 until the theme resolves. The background stays the app surface
// (--bg1) for every code theme so the editor matches the diff + code-block
// surfaces. See project_files_tab_editor memory.
//
// The `dark` flag tells CM which polarity its UNSTYLED internals (autocomplete
// tooltip, fold placeholder, panels it invents) should default to — it must
// track the app variant, so the theme is a factory, not a constant (the caller
// passes the active code theme's appearance, which always matches the variant).
// ──────────────────────────────────────────────────────────

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

const chrome = (dark: boolean, baseFg: string | null): Extension =>
  EditorView.theme(
    {
      "&": {
        backgroundColor: "var(--bg1)",
        color: baseFg ?? "var(--fg1)",
        height: "100%",
        fontSize: "12px",
      },
      ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        lineHeight: "1.6",
        overflow: "auto",
      },
      ".cm-content": { padding: "12px 0", caretColor: "var(--fg1)" },
      "&.cm-focused": { outline: "none" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg1)" },
      ".cm-gutters": {
        backgroundColor: "var(--bg1)",
        color: "color-mix(in srgb, var(--fg2) 60%, transparent)",
        border: "none",
      },
      ".cm-gutters .cm-gutterElement": { padding: "0 12px" },
      // The line the cursor is on (line + gutter) is clearly LIFTED so you always
      // know which line you're editing. A translucent overlay (not a token) so it
      // lifts off the editor's --bg1 in any theme; ~3× stronger than the
      // scope tint below. In the chrome theme (higher precedence than the scope's
      // baseTheme), so it WINS over the enclosing scope on the cursor's line.
      ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--fg1) 5%, transparent)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "color-mix(in srgb, var(--fg1) 5%, transparent)",
        color: "var(--fg1)",
      },
      ".cm-foldGutter .cm-gutterElement": { color: "var(--fg2)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
          backgroundColor: "color-mix(in srgb, var(--fg1) 18%, transparent)",
        },
      ".cm-selectionMatch": {
        backgroundColor: "color-mix(in srgb, var(--fg1) 14%, transparent)",
      },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: "color-mix(in srgb, var(--fg1) 16%, transparent)",
        outline: "1px solid color-mix(in srgb, var(--fg1) 30%, transparent)",
      },
      ".cm-nonmatchingBracket": {
        backgroundColor:
          "color-mix(in srgb, var(--red-primary) 25%, transparent)",
      },
      ".cm-searchMatch": {
        backgroundColor:
          "color-mix(in srgb, var(--yellow-primary) 35%, transparent)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor:
          "color-mix(in srgb, var(--yellow-primary) 55%, transparent)",
      },
      ".cm-panels": { backgroundColor: "var(--bg2)", color: "var(--fg1)" },
      ".cm-panel.cm-search input, .cm-panel.cm-search button": {
        backgroundColor: "var(--bg1)",
        color: "var(--fg1)",
        border: "1px solid var(--border2)",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--bg2)",
        border: "1px solid var(--border2)",
        color: "var(--fg1)",
      },
    },
    { dark },
  );

/** Editor chrome only — token color comes from the Shiki layer
 *  (shiki-highlight.ts). `dark` must be the active code theme's appearance
 *  (=== the app variant); `baseFg` is that theme's own foreground for text Shiki
 *  leaves uncolored (null → the app's --fg1 until the theme is loaded). */
export function zerosEditorTheme(
  dark: boolean,
  baseFg: string | null = null,
): Extension {
  return chrome(dark, baseFg);
}
