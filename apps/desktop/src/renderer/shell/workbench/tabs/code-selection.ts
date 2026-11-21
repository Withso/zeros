import { EditorView } from "@codemirror/view";

/** Lines of one file a selection covers. `removed` marks a selection made only
 *  of removed diff lines, whose numbers are the old file's. */
export interface CodeLineRange {
  start: number;
  end: number;
  removed: boolean;
}

export interface CodeSelection extends CodeLineRange {
  /** The selection's first line on screen, read at call time. */
  rect(): DOMRect | null;
}

/** `path:L20` or `path:L20-22`; removed lines say so. */
export function formatLineReference(path: string, range: CodeLineRange): string {
  const lines = range.start === range.end ? `L${range.start}` : `L${range.start}-${range.end}`;
  return `${path}:${lines}${range.removed ? " (removed)" : ""}`;
}

function visible(element: Element): boolean {
  return element.getClientRects().length > 0 && !element.closest("[inert]");
}

function editorSelection(root: HTMLElement): CodeSelection | null {
  for (const element of root.querySelectorAll<HTMLElement>(".cm-editor")) {
    if (!visible(element)) continue;
    const view = EditorView.findFromDOM(element);
    if (!view?.hasFocus) continue;
    const { from, to } = view.state.selection.main;
    if (from === to) continue;
    const first = view.state.doc.lineAt(from);
    let last = view.state.doc.lineAt(to);
    // A selection ending at a line's start does not reach into that line.
    if (to === last.from && last.number > first.number) last = view.state.doc.line(last.number - 1);
    return {
      start: first.number,
      end: last.number,
      removed: false,
      rect: () => {
        const start = view.coordsAtPos(from, 1);
        return start ? new DOMRect(start.left, start.top, 1, start.bottom - start.top) : null;
      },
    };
  }
  return null;
}

type ComposedSelection = Selection & {
  getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[];
};

function selectedText(range: Range, from: [Node, number], to: [Node, number]): boolean {
  const part = new Range();
  part.setStart(...from);
  part.setEnd(...to);
  return part.toString() !== "" && range.toString() !== "";
}

function diffRows(range: Range, root: ShadowRoot): CodeLineRange | null {
  const changed: number[] = [];
  const removed: number[] = [];
  for (const row of root.querySelectorAll<HTMLElement>("[data-line][data-line-type]")) {
    if (!range.intersectsNode(row)) continue;
    // A drag that starts after a row's text or stops at a row's start
    // touches that row without selecting any of it.
    if (row.contains(range.startContainer) && !selectedText(range, [range.startContainer, range.startOffset], [row, row.childNodes.length])) continue;
    if (row.contains(range.endContainer) && !selectedText(range, [row, 0], [range.endContainer, range.endOffset])) continue;
    const line = Number(row.dataset.line);
    const type = row.dataset.lineType ?? "";
    if (type === "change-deletion") removed.push(line);
    else if (type.startsWith("context") && row.closest("[data-deletions]")) changed.push(Number(row.dataset.altLine ?? line));
    else changed.push(line);
  }
  const lines = changed.length ? changed : removed;
  if (!lines.length) return null;
  return { start: Math.min(...lines), end: Math.max(...lines), removed: !changed.length };
}

function diffSelection(root: HTMLElement): CodeSelection | null {
  const selection = document.getSelection() as ComposedSelection | null;
  // isCollapsed describes the selection as retargeted to the document, which
  // is collapsed at the host for any range inside a shadow root.
  if (!selection?.rangeCount || !selection.getComposedRanges) return null;
  for (const host of root.querySelectorAll("diffs-container")) {
    const shadow = host.shadowRoot;
    if (!shadow || !visible(host)) continue;
    const composed = selection.getComposedRanges({ shadowRoots: [shadow] })[0];
    if (!composed || composed.collapsed || composed.startContainer.getRootNode() !== shadow) continue;
    const range = new Range();
    range.setStart(composed.startContainer, composed.startOffset);
    range.setEnd(composed.endContainer, composed.endOffset);
    const lines = diffRows(range, shadow);
    if (!lines) continue;
    return {
      ...lines,
      rect: () => {
        const first = range.getClientRects()[0];
        return first && first.height > 0 ? first : null;
      },
    };
  }
  return null;
}

/** The focused source editor's or rendered diff's selection inside `root`. */
export function readCodeSelection(root: HTMLElement): CodeSelection | null {
  return editorSelection(root) ?? diffSelection(root);
}
