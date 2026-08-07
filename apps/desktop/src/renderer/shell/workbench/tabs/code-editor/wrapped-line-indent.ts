// ──────────────────────────────────────────────────────────
// wrappedLineIndent — hanging indent for soft-wrapped lines
// ──────────────────────────────────────────────────────────
//
// With EditorView.lineWrapping, CodeMirror starts continuation rows at column
// 0, so a long indented line visually breaks out of its block: the wrapped
// text cuts left across the indentation guides instead of staying inside its
// own nesting level. This extension keeps every visual row of a line at the
// line's own indentation (VS Code's `wrappingIndent: "same"`), with one
// declaration on the line element:
//
//   text-indent: <indent>ch hanging  → every row EXCEPT the first starts past
//                                      the indent; row 1 is left exactly as
//                                      CodeMirror lays it out
//
// `hanging` inverts which rows text-indent applies to, which IS the hanging
// indent — so, unlike the classic `padding-left: Nch; text-indent: -Nch` pair,
// row 1 never leaves the line's content box. That matters for TABS: CSS tab
// stops sit at multiples of tab-size measured from the block's start content
// edge, so a negative indent moves the tab-stop origin, and a leading tab on a
// line whose indent is not a whole number of tab stops then renders short. The
// pair drew `\t\t "x"` (9 columns at tab-size 4) with its content at column 6,
// three columns left of its own guides and of its continuation rows.
//
// `ch` tracks the mono font with no measure pass. CM's selection layer reads
// `paddingLeft + min(0, textIndent)` per line for the left edge of multi-row
// selection rectangles; a positive hanging indent leaves that at CM's own
// `.cm-line` padding, which is what it means. The indentation-marker guides are
// absolutely-positioned overlays on the line block (out of text flow), so the
// hanging rows land beside the guides instead of crossing them.
//
// Chromium has understood the `hanging` keyword for many majors (the pinned
// Electron ships 150); where an engine does not, the declaration is dropped and
// those lines wrap flat — exactly what they did before this extension existed.
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
  return `text-indent: ${columns}ch hanging;`;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // text-indent follows the writing direction, but the guides this keeps rows
  // inside are painted physically left-to-right, so an RTL editor has no block
  // to stay within. Leave those flat.
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
