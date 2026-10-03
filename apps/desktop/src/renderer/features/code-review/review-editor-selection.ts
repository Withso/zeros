import type { SelectionRange, Text } from "@codemirror/state";
import type { SelectedLineRange } from "@pierre/diffs";

/** CodeMirror text ranges have an exclusive end; review anchors are inclusive. */
export function editorReviewLineRange(
  doc: Text,
  selection: SelectionRange,
): SelectedLineRange {
  const last =
    doc.lines > 1 && doc.line(doc.lines).length === 0
      ? doc.lines - 1
      : doc.lines;
  const start = Math.min(last, doc.lineAt(selection.from).number);
  const endPosition =
    selection.to > selection.from ? selection.to - 1 : selection.to;
  return { start, end: Math.min(last, doc.lineAt(endPosition).number) };
}
