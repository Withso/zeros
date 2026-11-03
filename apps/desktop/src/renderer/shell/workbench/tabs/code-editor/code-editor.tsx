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
// Shared by the standalone editor and file-viewer.tsx Edit mode.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { ExternalChange } from "@uiw/react-codemirror";
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
  type ViewUpdate,
} from "@codemirror/view";
import { Compartment, EditorSelection, EditorState, Prec, Transaction, type Extension, type Text } from "@codemirror/state";
import { indentOnInput, bracketMatching } from "@codemirror/language";
import {
  history,
  defaultKeymap,
  historyKeymap,
  indentWithTab,
  redo,
} from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { resolveLanguage } from "./language";
import { zerosEditorTheme } from "./theme";
import { shikiColors } from "./shiki-highlight";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { wrappedLineIndent } from "./wrapped-line-indent";
import { indentGuideClickSnap } from "./indent-click-snap";
import { shikiLangForPath } from "./shiki-lang";
import { useCodeThemeFg } from "./use-code-theme-fg";
import { useCodeTheme } from "@/renderer/shared/theme/use-code-theme";
import { resolveCodeTheme } from "@/renderer/shared/theme/code-themes";
import { useScrollMemory } from "../../../scroll-memory";

export interface CodeEditorProps {
  /** Opted in by a Local owner; embedded and cloud editors keep their policy. */
  tokenCacheScope?: "local";
  /** Current file contents (controlled). */
  value: string;
  /** An explicit discard/reload also retires history when the text is equal. */
  historyRevision?: number;
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
  /** Feature-owned extensions share this editor's scroller and lifecycle. */
  additionalExtensions?: Extension;
  onCreateView?: (view: EditorView) => void;
  className?: string;
}

const editorHistory = new Compartment();

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
  // Those guides sit on the indentation itself, so clicking one used to drop the
  // caret INSIDE the indent (the leftmost guide is column 0) and typing broke
  // the line out of its block. A plain click there now lands at the line's
  // content start; drag/⇧/⌘/⌥/double-click keep CM's behavior.
  indentGuideClickSnap(),
  closeBrackets(),
  highlightSelectionMatches(),
  editorHistory.of(history()),
  rectangularSelection(),
  crosshairCursor(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    { key: "Mod-Shift-z", run: redo, preventDefault: true },
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
  tokenCacheScope,
  value,
  historyRevision = 0,
  filePath,
  readOnly = false,
  onChange,
  onSave,
  compact = false,
  ariaLabel,
  editorId,
  offscreen = false,
  scrollMemoryKey,
  additionalExtensions,
  onCreateView,
  className,
}: CodeEditorProps) {
  const [langExt, setLangExt] = useState<Extension[]>([]);
  const viewRef = useRef<EditorView | null>(null);
  const initialValue = useRef(value.replace(/\r\n?/g, "\n"));
  const received = useRef({ value, historyRevision, filePath });
  const pendingChanges = useRef<Text[]>([]);

  // CodeMirror owns its scroll container (.cm-scroller); capture it once the
  // view exists so the keyed memory can save/restore the reading offset.
  const [scrollDom, setScrollDom] = useState<HTMLElement | null>(null);
  const handleCreateEditor = useCallback(
    (view: EditorView) => {
      viewRef.current = view;
      setScrollDom(view.scrollDOM);
      onCreateView?.(view);
    },
    [onCreateView],
  );
  useScrollMemory(scrollDom, scrollMemoryKey ?? null);

  // UIW queues controlled writes while typing, and a newer matching value does
  // not cancel that queue. Own reconciliation so a late echo cannot overwrite
  // the document or enter its undo stack. Explicit replacements start history.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = received.current;
    const reset = previous.historyRevision !== historyRevision || previous.filePath !== filePath;
    if (!reset && previous.value === value) return;
    received.current = { value, historyRevision, filePath };
    const incoming = view.state.toText(value);
    if (!reset && view.state.doc.eq(incoming)) {
      pendingChanges.current = [];
      return;
    }
    const acknowledged = pendingChanges.current.findIndex(doc => doc.eq(incoming));
    if (!reset && acknowledged !== -1) {
      pendingChanges.current.splice(0, acknowledged + 1);
      return;
    }
    pendingChanges.current = [];
    const selection = EditorSelection.create(view.state.selection.ranges.map(range =>
      EditorSelection.range(Math.min(range.anchor, incoming.length), Math.min(range.head, incoming.length))), view.state.selection.mainIndex);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: incoming },
      selection,
      annotations: [ExternalChange.of(true), Transaction.addToHistory.of(false)],
      effects: editorHistory.reconfigure([]),
    });
    view.dispatch({ effects: editorHistory.reconfigure(history()) });
  }, [value, historyRevision, filePath, scrollDom]);

  // Unified code theme → exact Shiki color parity with diffs + code blocks. The
  // Lezer language (langExt) stays for structure; Shiki only paints color.
  const codeThemeOpt = resolveCodeTheme(useCodeTheme());
  const shikiLang = useMemo(() => shikiLangForPath(filePath), [filePath]);
  // The theme's own base foreground, so uncolored text (and the pre-token frame
  // of a cold open) reads as the code theme rather than the app's chrome white.
  const baseFg = useCodeThemeFg(codeThemeOpt.shiki);

  // Keep the latest onSave for the ⌘S keymap WITHOUT re-creating the
  // extension on every keystroke (that would churn the whole editor config).
  const latest = useRef({ onSave, offscreen });
  latest.current = { onSave, offscreen };

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
            run: (view) => {
              if (!latest.current.offscreen)
                latest.current.onSave?.(view.state.doc.toString());
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
      ...(additionalExtensions ? [additionalExtensions] : []),
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
        cacheScope: tokenCacheScope,
        lang: shikiLang,
        theme: codeThemeOpt.shiki,
        syncFirstPaint: !offscreen,
      }),
    ],
    [
      saveKeymap,
      contentAttributes,
      additionalExtensions,
      compact,
      langExt,
      shikiLang,
      codeThemeOpt.shiki,
      codeThemeOpt.appearance,
      baseFg,
      offscreen,
      tokenCacheScope,
    ],
  );

  const handleChange = useCallback(
    (next: string, update: ViewUpdate) => {
      if (onChange) {
        pendingChanges.current = [...pendingChanges.current.slice(-63), update.state.doc];
        onChange(next);
      }
    },
    [onChange],
  );

  return (
    <CodeMirror
      value={initialValue.current}
      editable={!readOnly && !offscreen}
      readOnly={readOnly || offscreen}
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
