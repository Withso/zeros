// ──────────────────────────────────────────────────────────
// indentGuideClickSnap — a click never drops the caret inside the indentation
// ──────────────────────────────────────────────────────────
//
// The indentation guides ("tree lines") are painted across a line's leading
// whitespace, which makes them the most inviting click target on an indented
// line — and the leftmost one sits exactly on column 0. CodeMirror, asked for
// the text position nearest the pointer, answers with a column INSIDE the
// indent, so typing splits the indentation:
//
//   before:        "!docs/**",        ← click the leftmost guide, type "dfs"
//   after:  dfs      "!docs/**",      ← column 0; the nesting is gone
//
// That also strips the line of everything that depends on its leading
// whitespace: the guides themselves (indent level 0 now) and the hanging indent
// from wrapped-line-indent.ts (a line that doesn't start with whitespace has no
// indent to hang, so long text stops wrapping inside its own block).
//
// So a plain click anywhere in the leading whitespace puts the caret at the
// line's first non-whitespace character — the one position where what you type
// continues the nested structure and keeps wrapping at its own level. Only that
// one gesture is redirected. Every deliberate request for a position inside the
// indent still gets it: drag (the anchor stays where the press landed, so
// selecting an indent still works), double-click (selects the whitespace run),
// triple-click, ⇧-click, ⌘-click multi-cursors, ⌥-drag rectangles, Home, and the
// arrow keys.
//
// Wired into BASE_EXTENSIONS beside indentationMarkers() — the guides are what
// invite the click, so every editor that paints them gets this.
// ──────────────────────────────────────────────────────────

import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** A line's leading whitespace, in CHARACTERS (document offsets are characters;
 *  the guides' own column math lives in wrapped-line-indent.ts). Same
 *  whitespace set as those columns and as the guides: space, NBSP, tab. */
export function indentEndOffset(text: string): number {
  const indents = (code: number) =>
    code === 32 /* space */ || code === 0xa0 /* nbsp */ || code === 9; /* tab */
  let i = 0;
  while (i < text.length && indents(text.charCodeAt(i))) i++;
  return i;
}

/** Where a clicked caret belongs: the line's content start when the click landed
 *  in (or before) its indentation, otherwise the clicked position untouched.
 *  On a whitespace-only line the content start is the line end — its full
 *  indentation, which is exactly where typing should continue. */
export function snapClickOutOfIndent(
  line: { from: number; text: string },
  pos: number,
): number {
  const contentStart = line.from + indentEndOffset(line.text);
  return pos >= line.from && pos < contentStart ? contentStart : pos;
}

/** The one gesture this redirects: a plain primary-button click. A modifier or a
 *  repeat click means the user asked for something more specific (extend,
 *  multi-cursor, rectangle, word/line selection), so CodeMirror keeps it. */
export function isPlainPointerClick(
  event: Pick<
    MouseEvent,
    "button" | "detail" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey"
  >,
): boolean {
  return (
    event.button === 0 &&
    event.detail <= 1 &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  );
}

/** Re-derive a held gesture after the document changed underneath it (an agent
 *  or Git write adopted mid-click). The press is MAPPED — it names a place in
 *  the text the user pointed at — while the target is RE-DERIVED from the new
 *  line, because the edit may have changed how much indentation that line has.
 *
 *  `reselect` is CodeMirror's `MouseSelectionStyle.update` contract: the caret
 *  CM already holds was mapped through the change, and returning true is the
 *  only way a newly derived target reaches it (CM answers by calling `get`
 *  again). So it asks for that re-dispatch exactly when the mapped caret is no
 *  longer where the new text says the caret belongs. */
export function remapGestureAfterChange(
  gesture: { pressed: number; target: number },
  mapPos: (pos: number) => number,
  lineAt: (pos: number) => { from: number; text: string },
): { pressed: number; target: number; reselect: boolean } {
  const pressed = mapPos(gesture.pressed);
  const target = snapClickOutOfIndent(lineAt(pressed), pressed);
  return { pressed, target, reselect: target !== mapPos(gesture.target) };
}

/** Plain clicks in a line's indentation land at its content start. Pair with
 *  indentationMarkers() — the guides are the click target this exists for. */
export function indentGuideClickSnap(): Extension {
  return EditorView.mouseSelectionStyle.of((view, event) => {
    if (!isPlainPointerClick(event)) return null;
    const press = { x: event.clientX, y: event.clientY };
    // Not precise: a press below the last line still resolves to a position,
    // same as the default mouse selection.
    const pressed = view.posAtCoords(press, false);
    let gesture = {
      pressed,
      target: snapClickOutOfIndent(view.state.doc.lineAt(pressed), pressed),
    };
    // Nothing to redirect (unindented line, or the press was already at/after
    // the content) → null hands the gesture back to CodeMirror untouched.
    if (gesture.target === gesture.pressed) return null;
    return {
      get(moveEvent: MouseEvent) {
        // Whether the POINTER moved is checked before where it resolves to: on
        // the re-run that follows a mid-gesture edit, CM replays the original
        // mousedown event, and the text under those same coordinates may have
        // shifted — resolving them again would read as a drag and select to it.
        const moved =
          moveEvent.clientX !== press.x || moveEvent.clientY !== press.y;
        if (moved) {
          const head = view.posAtCoords(
            { x: moveEvent.clientX, y: moveEvent.clientY },
            false,
          );
          // Off the press by a whole position → a drag, an explicit range
          // request: both ends stay raw so an indent can still be selected by
          // dragging it. Within it (a click's pixel of jitter) → still a click.
          if (head !== gesture.pressed)
            return EditorSelection.single(gesture.pressed, head);
        }
        // assoc 1 keeps the caret with the content it precedes rather than with
        // the whitespace behind it.
        return EditorSelection.create([
          EditorSelection.cursor(gesture.target, 1),
        ]);
      },
      update(update) {
        if (!update.docChanged) return false;
        const next = remapGestureAfterChange(
          gesture,
          (pos) => update.changes.mapPos(pos),
          (pos) => update.state.doc.lineAt(pos),
        );
        gesture = { pressed: next.pressed, target: next.target };
        return next.reselect;
      },
    };
  });
}
