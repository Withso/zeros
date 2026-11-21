import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  StreamLanguage,
  codeFolding,
  foldGutter,
  foldKeymap,
  foldService,
  language,
} from "@codemirror/language";

const CHEVRON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';

function indentColumns(text: string, tabSize: number): number | null {
  let column = 0;
  for (const char of text) {
    if (char === " ") column++;
    else if (char === "\t") column += tabSize - (column % tabSize);
    else return column;
  }
  return null;
}

/** The block under a line: the following lines indented deeper than it, with
 *  blank lines inside the block kept and trailing blank lines left out. */
export function indentationFoldRange(
  state: EditorState,
  lineStart: number,
): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineStart);
  const indent = indentColumns(line.text, state.tabSize);
  if (indent === null) return null;
  let end = line.to;
  for (let number = line.number + 1; number <= state.doc.lines; number++) {
    const next = state.doc.line(number);
    const nextIndent = indentColumns(next.text, state.tabSize);
    if (nextIndent === null) continue;
    if (nextIndent <= indent) break;
    end = next.to;
  }
  return end > line.to ? { from: line.to, to: end } : null;
}

// Lezer grammars fold by syntax. Legacy stream modes and unknown files have no
// fold structure, so their ranges come from indentation instead.
const indentationFallback = foldService.of((state, lineStart) => {
  const active = state.facet(language);
  if (active && !(active instanceof StreamLanguage)) return null;
  return indentationFoldRange(state, lineStart);
});

function marker(open: boolean): HTMLElement {
  const element = document.createElement("span");
  element.dataset.fold = open ? "open" : "folded";
  element.title = open ? "Click to collapse the range." : "Click to expand the range.";
  element.innerHTML = CHEVRON;
  return element;
}

const foldTheme = EditorView.theme({
  ".cm-foldGutter .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 4px 0 0",
    cursor: "pointer",
  },
  ".cm-foldGutter [data-fold]": {
    display: "inline-flex",
    color: "var(--fg3)",
    transition: "opacity 120ms ease",
  },
  ".cm-foldGutter [data-fold]:hover": { color: "var(--fg1)" },
  ".cm-foldGutter [data-fold='open']": { opacity: "0" },
  ".cm-gutters:hover .cm-foldGutter [data-fold='open']": { opacity: "1" },
  ".cm-foldGutter [data-fold='folded'] svg": { transform: "rotate(-90deg)" },
  ".cm-foldPlaceholder": {
    margin: "0 4px",
    padding: "0 4px",
    border: "none",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--bg2-highlight)",
    color: "var(--fg2)",
    cursor: "pointer",
  },
});

/** Collapse/expand for full file editors: syntax ranges where the grammar has
 *  them, indentation everywhere else, a hover-revealed chevron gutter and the
 *  standard fold shortcuts. */
export function fileFolding(): Extension {
  return [
    indentationFallback,
    codeFolding({ placeholderText: "…" }),
    foldGutter({ markerDOM: marker }),
    keymap.of(foldKeymap),
    foldTheme,
  ];
}
