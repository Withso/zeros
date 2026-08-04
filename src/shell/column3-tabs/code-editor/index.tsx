// ──────────────────────────────────────────────────────────
// CodeEditor — the editable CodeMirror 6 surface for Files-tab Edit mode
// ──────────────────────────────────────────────────────────
//
// A focused, "basic but effective" editor (no LSP / no autocomplete popups). It
// ships exactly the behaviours from the reference screenshots: active-line
// highlight, bracket/tag matching, selection-match (double-click a word →
// every occurrence lights up), line numbers, code folding, and undo/redo —
// plus ⌘S to save. Language (structure: folding/indent/brackets) is lazy-loaded
// per file; the Zeros-token theme supplies chrome + colors.
//
// Standalone in Phase 2 — wired into file-viewer.tsx Edit mode in Phase 3.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  keymap,
} from "@codemirror/view";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { indentOnInput, bracketMatching } from "@codemirror/language";
import {
  history,
  defaultKeymap,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { resolveLanguage } from "./language";
import { zerosEditorTheme } from "./theme";
import { shikiColors } from "./shiki-highlight";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { wrappedLineIndent } from "./wrapped-line-indent";
import { shikiLangForPath } from "./shiki-lang";
import { useCodeThemeFg } from "./use-code-theme-fg";
import { useCodeTheme } from "@/zeros/appearance/use-code-theme";
import { resolveCodeTheme } from "@/zeros/appearance/code-themes";
import { useScrollMemory } from "../../scroll-memory";

export interface CodeEditorProps {
  /** Current file contents (controlled). */
  value: string;
  /** File path — drives lazy language detection. */
  filePath?: string;
  /** Read-only "preview" mode (still selectable; no edits). */
  readOnly?: boolean;
  /** Fires on user edits with the new document text. */
  onChange?: (value: string) => void;
  /** Fires on ⌘S / Ctrl-S with the current document text. */
  onSave?: (value: string) => void;
  /** Compact, content-height layout for small embedded command editors. */
  compact?: boolean;
  /** Accessible name applied to CodeMirror's contenteditable surface. */
  ariaLabel?: string;
  /** Optional id applied to CodeMirror's contenteditable surface. */
  editorId?: string;
  /** True when this editor mounts behind another surface (the file viewer keeps
   *  one alive behind Diff / Markdown preview so drafts survive a view switch).
   *  Skips the synchronous first-paint tokenize — nothing is painted to get
   *  right, so that work belongs off the click. */
  offscreen?: boolean;
  /** Keyed scroll memory for `.cm-scroller` (see shell/scroll-memory). File
   *  editors remount per cwd::path::revision, so a stable key restores the
   *  reading offset across tab/workspace round-trips. Omit for embedded
   *  command editors — their content fits without scrolling. */
  scrollMemoryKey?: string;
  className?: string;
}

// Editor essentials only — the curated set (NOT basicSetup, so no autocompletion
// popups). Stable module-level array → no extension churn across renders.
const BASE_EXTENSIONS: Extension[] = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightActiveLine(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  // Indentation "tree" guides — faint vertical lines at each nesting level, with
  // the active block's guide brightened (your current scope). Indentation-based,
  // so it works for every language (incl. legacy-mode ones like Swift). Replaces
  // the earlier syntax-tree scope tint. Guides are fg1-derived overlays so they
  // read on both themes (near-white on the dark editor, near-black on light);
  // both of the plugin's light/dark slots get the same token-driven value.
  indentationMarkers({
    highlightActiveBlock: true,
    markerType: "fullScope",
    thickness: 1,
    colors: {
      light: "color-mix(in srgb, var(--fg1) 5%, transparent)",
      dark: "color-mix(in srgb, var(--fg1) 5%, transparent)",
      activeLight: "color-mix(in srgb, var(--fg1) 14%, transparent)",
      activeDark: "color-mix(in srgb, var(--fg1) 14%, transparent)",
    },
  }),
  closeBrackets(),
  highlightSelectionMatches(),
  history(),
  rectangularSelection(),
  crosshairCursor(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    indentWithTab,
  ]),
  // zerosEditorTheme is NOT here — its `dark` flag tracks the code theme's
  // appearance, so it lives in the per-render extensions memo below.
];

// The file editor fills its tab. Embedded command editors instead start at
// CodeMirror's natural one-line height, grow with the document, and become an
// inner scroller at the settings-page cap. This only changes geometry — all
// chrome, active-line, and Shiki color behavior still comes from the same
// extensions as the Files tab.
const COMPACT_EDITOR_THEME = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    height: "auto",
    maxHeight: "320px",
  },
  ".cm-scroller": {
    height: "auto !important",
    maxHeight: "320px",
    overflow: "auto",
  },
  ".cm-content": {
    minHeight: "35px",
    padding: "8px 0 12px",
  },
  ".cm-gutters .cm-gutterElement": {
    padding: "0 10px",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    borderRight: "1px solid var(--border1)",
  },
  "&:not(.cm-focused) .cm-activeLine": {
    backgroundColor: "transparent",
  },
  "&:not(.cm-focused) .cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "color-mix(in srgb, var(--fg2) 60%, transparent)",
  },
});

// Full File-tab editors wrap every logical line and reserve vertical scrolling
// as the only navigation axis. Wrapped continuation rows hang at the line's
// own indentation so long lines stay inside their block instead of cutting
// across the indent guides. Kept out of compact command editors, whose
// single-line command ergonomics are a separate contract.
const FILE_LINE_WRAP_EXTENSIONS: Extension[] = [
  EditorView.lineWrapping,
  wrappedLineIndent(),
  EditorView.theme({
    ".cm-scroller": { overflowX: "hidden" },
  }),
];

export function CodeEditor({
  value,
  filePath,
  readOnly = false,
  onChange,
  onSave,
  compact = false,
  ariaLabel,
  editorId,
  offscreen = false,
  scrollMemoryKey,
  className,
}: CodeEditorProps) {
  const [langExt, setLangExt] = useState<Extension[]>([]);

  // CodeMirror owns its scroll container (.cm-scroller); capture it once the
  // view exists so the keyed memory can save/restore the reading offset.
  const [scrollDom, setScrollDom] = useState<HTMLElement | null>(null);
  const handleCreateEditor = useCallback(
    (view: EditorView) => setScrollDom(view.scrollDOM),
    [],
  );
  useScrollMemory(scrollDom, scrollMemoryKey ?? null);

  // Unified code theme → exact Shiki color parity with diffs + code blocks. The
  // Lezer language (langExt) stays for structure; Shiki only paints color.
  const codeThemeOpt = resolveCodeTheme(useCodeTheme());
  const shikiLang = useMemo(() => shikiLangForPath(filePath), [filePath]);
  // The theme's own base foreground, so uncolored text (and the pre-token frame
  // of a cold open) reads as the code theme rather than the app's chrome white.
  const baseFg = useCodeThemeFg(codeThemeOpt.shiki);

  // Keep the latest value + onSave for the ⌘S keymap WITHOUT re-creating the
  // extension on every keystroke (that would churn the whole editor config).
  const latest = useRef({ value, onSave });
  latest.current = { value, onSave };

  useEffect(() => {
    let cancelled = false;
    void resolveLanguage(filePath).then((ext) => {
      if (!cancelled) setLangExt(ext ? [ext] : []);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // ⌘S / Ctrl-S → save. Prec.highest so it beats any default binding.
  const saveKeymap = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              latest.current.onSave?.(latest.current.value);
              return true;
            },
          },
        ]),
      ),
    [],
  );

  const contentAttributes = useMemo(
    () =>
      EditorView.contentAttributes.of({
        ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
        ...(editorId ? { id: editorId } : {}),
        ...(compact
          ? {
              spellcheck: "false",
              autocapitalize: "off",
              autocomplete: "off",
            }
          : {}),
      }),
    [ariaLabel, compact, editorId],
  );

  const extensions = useMemo(
    () => [
      saveKeymap,
      contentAttributes,
      ...BASE_EXTENSIONS,
      // Chrome rides live CSS vars, but CM's `dark` flag (polarity of unstyled
      // internals like the autocomplete tooltip) is a JS boolean — recreate it
      // when the code theme's appearance (=== the app variant) flips. The base
      // foreground rides along so it applies on the first paint.
      zerosEditorTheme(codeThemeOpt.appearance === "dark", baseFg),
      ...(!compact ? FILE_LINE_WRAP_EXTENSIONS : []),
      ...(compact ? [Prec.highest(COMPACT_EDITOR_THEME)] : []),
      ...langExt,
      // Shiki color layer (exact parity). Recreated when the file's language or
      // the code theme changes; its field/plugin are module-level so reconfigure
      // preserves decorations and just re-tokenizes. A visible editor tokenizes
      // its document synchronously as the state is built, so the first painted
      // frame already wears the theme (no unthemed flash on open / tab switch).
      shikiColors({
        lang: shikiLang,
        theme: codeThemeOpt.shiki,
        syncFirstPaint: !offscreen,
      }),
    ],
    [
      saveKeymap,
      contentAttributes,
      compact,
      langExt,
      shikiLang,
      codeThemeOpt.shiki,
      codeThemeOpt.appearance,
      baseFg,
      offscreen,
    ],
  );

  const handleChange = useCallback(
    (next: string) => onChange?.(next),
    [onChange],
  );

  return (
    <CodeMirror
      value={value}
      editable={!readOnly}
      readOnly={readOnly}
      onChange={handleChange}
      onCreateEditor={handleCreateEditor}
      basicSetup={false}
      theme="none"
      extensions={extensions}
      height={compact ? undefined : "100%"}
      maxHeight={compact ? "320px" : undefined}
      style={compact ? undefined : { height: "100%" }}
      className={className}
    />
  );
}

export default CodeEditor;
