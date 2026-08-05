// ──────────────────────────────────────────────────────────
// wrappedLineIndent — hanging indent for soft-wrapped lines
// ──────────────────────────────────────────────────────────
//
// With EditorView.lineWrapping, CodeMirror starts continuation rows at column
// 0, so a long indented line visually breaks out of its block: the wrapped
// text cuts left across the indentation guides instead of staying inside its
// own nesting level. This extension keeps every visual row of a line at the
// line's own indentation (VS Code's `wrappingIndent: "same"`), via the classic
// hanging-indent pair on the line element:
//
//   padding-left: calc(<indent>ch + 6px)  → every row starts past the indent
//   text-indent:  -<indent>ch             → …except row 1, pulled back so its
//                                           leading whitespace renders exactly
//                                           where it does today
//
// 6px is CM's base `.cm-line` padding-left ("0 2px 0 6px"); the inline value
// must restate it because inline padding-left replaces the shorthand. `ch`
// tracks the mono font with no measure pass, and CM's selection layer already
// reads `paddingLeft + min(0, textIndent)` per line, so this is the exact
// construction the library accounts for. The indentation-marker guides are
// absolutely-positioned overlays on the line block (out of text flow), so the
// hanging rows land beside the guides instead of crossing them.
//
// Only wired into the Files-tab wrap bundle (FILE_LINE_WRAP_EXTENSIONS) —
// compact command editors don't wrap, so they have nothing to hang.
// ──────────────────────────────────────────────────────────

import {
  Decoration,
  Direction,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";

/** CM base-theme `.cm-line` padding-left, restated because the inline
 *  `padding-left` below replaces the base shorthand. */
const LINE_BASE_PADDING_LEFT = 6;

/** A hanging indent wider than this fraction of the content is dropped
 *  entirely (Monaco-style fallback): in a narrow pane, a sliver of a text
 *  column is worse than today's flat wrapping. */
const MAX_INDENT_FRACTION = 0.5;

/** Visible columns of leading whitespace — tabs advance to the next tab stop,
 *  NBSP counts one, anything else ends the indent (matches the column math of
 *  the indentation-marker guides). */
export function leadingWhitespaceColumns(
  text: string,
  tabSize: number,
): number {
  let col = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 32 /* space */ || code === 0xa0 /* nbsp */) col += 1;
    else if (code === 9 /* tab */) col += tabSize - (col % tabSize);
    else break;
  }
  return col;
}

/** Inline hanging-indent style for one line, or null when the line has no
 *  indent (nothing to hang) or its indent exceeds `maxColumns` (fallback). */
export function hangingIndentStyle(
  text: string,
  tabSize: number,
  maxColumns: number,
): string | null {
  const columns = leadingWhitespaceColumns(text, tabSize);
  if (columns === 0 || columns > maxColumns) return null;
  return `padding-left: calc(${columns}ch + ${LINE_BASE_PADDING_LEFT}px); text-indent: -${columns}ch;`;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // Hanging indent is an LTR construction (padding-left + negative indent);
  // in an RTL editor it would indent the wrong edge, so leave flat wrapping.
  if (view.textDirection !== Direction.LTR) return builder.finish();
  const { state } = view;
  const charWidth = view.defaultCharacterWidth;
  const width = view.contentDOM.clientWidth;
  // Before the first measure (charWidth/width unknown) skip the cap rather
  // than the indent; geometryChanged re-runs this once real numbers exist.
  const maxColumns =
    charWidth > 0 && width > 0
      ? Math.floor((width * MAX_INDENT_FRACTION) / charWidth)
      : Number.MAX_SAFE_INTEGER;
  let lastLine = -1;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      if (line.number !== lastLine) {
        lastLine = line.number;
        const style = hangingIndentStyle(line.text, state.tabSize, maxColumns);
        if (style) {
          builder.add(
            line.from,
            line.from,
            Decoration.line({ attributes: { style } }),
          );
        }
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** Soft-wrap continuation rows hang at the line's own indentation. Pair with
 *  EditorView.lineWrapping — without wrapping it's a visual no-op. */
export function wrappedLineIndent(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.geometryChanged ||
          update.startState.tabSize !== update.state.tabSize
        ) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
