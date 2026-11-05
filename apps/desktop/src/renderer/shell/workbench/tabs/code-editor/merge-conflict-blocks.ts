// ──────────────────────────────────────────────────────────
// Merge conflicts in place, for the Files editor
// ──────────────────────────────────────────────────────────
//
// Each block's rows are tinted where they stand (current green under its
// HEAD band, incoming blue above its branch band) and an accept row above the
// block rewrites it. Accepting is one ordinary transaction, so ⌘Z undoes it
// and the file saves like any other edit. Markers that cannot all be paired
// get no rows and no actions; the editor shows one notice instead.
//
// ──────────────────────────────────────────────────────────

import { RangeSet, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutterLineClass,
  gutterWidgetClass,
  type DecorationSet,
} from "@codemirror/view";
import {
  conflictReplacement,
  parseMergeConflicts,
  type ConflictChoice,
  type MergeConflictParseResult,
} from "@zeros/protocol/merge-conflicts";
import {
  CONFLICT_CHOICES,
  actionableConflicts,
  conflictPosition,
  conflictRowKind,
  type ConflictRowKind,
} from "@/renderer/features/code-review/merge-conflict-rows";

const parsedConflicts = StateField.define<MergeConflictParseResult>({
  create: (state) => parseMergeConflicts(state.doc.toString()),
  update: (value, tr) =>
    tr.docChanged ? parseMergeConflicts(tr.state.doc.toString()) : value,
});

/** The editor's parsed blocks, or null when it does not mark conflicts. */
export function editorConflicts(
  state: EditorState,
): MergeConflictParseResult | null {
  return state.field(parsedConflicts, false) ?? null;
}

export function acceptConflict(
  view: EditorView,
  index: number,
  choice: ConflictChoice,
): boolean {
  if (view.state.readOnly) return false;
  const conflict = actionableConflicts(editorConflicts(view.state))[index];
  if (!conflict) return false;
  view.dispatch({
    changes: {
      from: conflict.start,
      to: conflict.end,
      insert: conflictReplacement(view.state.doc.toString(), conflict, choice),
    },
    selection: { anchor: conflict.start },
    userEvent: "input.conflict",
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** Move the caret to the next or previous block, centred, wrapping around. */
export function goToConflict(view: EditorView, direction: 1 | -1): boolean {
  const conflicts = actionableConflicts(editorConflicts(view.state));
  if (!conflicts.length) return false;
  const line = view.state.doc.lineAt(view.state.selection.main.head).number;
  const position = conflictPosition(conflicts, line);
  const target = conflicts[direction > 0 ? position.next : position.previous]!;
  view.dispatch({
    selection: { anchor: target.start },
    effects: EditorView.scrollIntoView(target.start, { y: "center" }),
  });
  view.focus();
  return true;
}

class ConflictActions extends WidgetType {
  constructor(
    readonly index: number,
    readonly count: number,
  ) {
    super();
  }
  eq(other: ConflictActions) {
    return other.index === this.index && other.count === this.count;
  }
  get estimatedHeight() {
    return 28;
  }
  toDOM(view: EditorView) {
    const row = document.createElement("div");
    row.className = "cm-conflict-actions";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", `Conflict ${this.index + 1} of ${this.count}`);
    for (const { choice, label } of CONFLICT_CHOICES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `cm-conflict-accept cm-conflict-accept-${choice}`;
      button.textContent = label;
      // Keep the caret and focus where they are until the edit moves them.
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        acceptConflict(view, this.index, choice);
      });
      row.append(button);
    }
    return row;
  }
  ignoreEvent() {
    return true;
  }
}

class ConflictGutterClass extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
}

const KINDS: readonly ConflictRowKind[] = [
  "current-marker",
  "current",
  "base",
  "separator",
  "incoming",
  "incoming-marker",
];
const rowClass = (kind: ConflictRowKind) => `cm-conflict-row cm-conflict-${kind}`;
const LINE_DECORATION = Object.fromEntries(
  KINDS.map((kind) => [kind, Decoration.line({ class: rowClass(kind) })]),
) as Record<ConflictRowKind, Decoration>;
const GUTTER_CLASS = Object.fromEntries(
  KINDS.map((kind) => [kind, new ConflictGutterClass(rowClass(kind))]),
) as Record<ConflictRowKind, ConflictGutterClass>;
const ACTIONS_GUTTER = new ConflictGutterClass("cm-conflict-actions-gutter");

interface ConflictView {
  decorations: DecorationSet;
  gutters: RangeSet<GutterMarker>;
}

function buildView(state: EditorState): ConflictView {
  const conflicts = actionableConflicts(state.field(parsedConflicts));
  const decorations: Range<Decoration>[] = [];
  const gutters: Range<GutterMarker>[] = [];
  conflicts.forEach((conflict, index) => {
    const start = state.doc.line(conflict.startLine);
    decorations.push(
      Decoration.widget({
        widget: new ConflictActions(index, conflicts.length),
        block: true,
        side: -1,
      }).range(start.from),
    );
    for (let number = conflict.startLine; number <= conflict.endLine; number++) {
      const line = state.doc.line(number);
      const kind = conflictRowKind(conflict, number);
      decorations.push(LINE_DECORATION[kind].range(line.from));
      gutters.push(GUTTER_CLASS[kind].range(line.from));
    }
  });
  return {
    decorations: Decoration.set(decorations, true),
    gutters: RangeSet.of(gutters, true),
  };
}

const conflictView = StateField.define<ConflictView>({
  create: buildView,
  update: (value, tr) => (tr.docChanged ? buildView(tr.state) : value),
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    gutterLineClass.from(field, (value) => value.gutters),
  ],
});

export interface EditorConflictStatus {
  /** Blocks with accept actions; 0 when none remain or markers are broken. */
  count: number;
  /** 1-based block at or after the caret. */
  shown: number;
  /** The first marker error, which the editor shows instead of actions. */
  parsed: MergeConflictParseResult;
}

function status(state: EditorState): EditorConflictStatus {
  const parsed = state.field(parsedConflicts);
  const conflicts = actionableConflicts(parsed);
  const line = state.doc.lineAt(state.selection.main.head).number;
  return {
    count: conflicts.length,
    shown: conflictPosition(conflicts, line).shown,
    parsed,
  };
}

/** Report only when the count, the block shown or the parse changes, so a
 * caret move inside one block does not re-render the editor's owner. */
function reportStatus(onStatus: (status: EditorConflictStatus) => void) {
  return ViewPlugin.define((view) => {
    let last = status(view.state);
    onStatus(last);
    return {
      update(update) {
        if (!update.docChanged && !update.selectionSet) return;
        const next = status(update.state);
        if (
          next.count === last.count &&
          next.shown === last.shown &&
          next.parsed === last.parsed
        )
          return;
        last = next;
        onStatus(next);
      },
    };
  });
}

// The palette is tokens (zeros-tokens.css): translucent rows, so the selection
// layer below the text still shows, and solid accept fills in white type.
const conflictTheme = EditorView.baseTheme({
  // Two classes beat the chrome's active-line fill; the caret line then lifts
  // by the same fg1 5% over its tint. (Theme keys split on every comma, so
  // these list each selector rather than use :is().)
  ".cm-line.cm-conflict-current-marker, .cm-gutterElement.cm-conflict-current-marker": {
    backgroundColor: "var(--conflict-current-band)",
  },
  ".cm-line.cm-conflict-current, .cm-gutterElement.cm-conflict-current": {
    backgroundColor: "var(--conflict-current)",
  },
  ".cm-line.cm-conflict-base, .cm-gutterElement.cm-conflict-base, .cm-line.cm-conflict-separator, .cm-gutterElement.cm-conflict-separator, .cm-gutterElement.cm-conflict-actions-gutter":
    { backgroundColor: "var(--conflict-neutral)" },
  ".cm-line.cm-conflict-incoming, .cm-gutterElement.cm-conflict-incoming": {
    backgroundColor: "var(--conflict-incoming)",
  },
  ".cm-line.cm-conflict-incoming-marker, .cm-gutterElement.cm-conflict-incoming-marker": {
    backgroundColor: "var(--conflict-incoming-band)",
  },
  ".cm-activeLine.cm-conflict-row, .cm-activeLineGutter.cm-conflict-row": {
    backgroundImage:
      "linear-gradient(color-mix(in srgb, var(--fg1) 5%, transparent), color-mix(in srgb, var(--fg1) 5%, transparent))",
  },
  ".cm-line.cm-conflict-current-marker::after, .cm-line.cm-conflict-incoming-marker::after":
    {
      marginLeft: "8px",
      color: "var(--fg3)",
      fontFamily: "var(--font-sans)",
      pointerEvents: "none",
    },
  ".cm-line.cm-conflict-current-marker::after": { content: '"(Current change)"' },
  ".cm-line.cm-conflict-incoming-marker::after": { content: '"(Incoming change)"' },
  ".cm-conflict-actions": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 6px 4px 4px",
    backgroundColor: "var(--conflict-neutral)",
  },
  ".cm-conflict-accept": {
    display: "inline-flex",
    height: "20px",
    alignItems: "center",
    padding: "0 8px",
    border: "none",
    borderRadius: "4px",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    lineHeight: "16px",
    fontWeight: "var(--weight-medium)",
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  ".cm-conflict-accept:focus-visible": {
    outline: "2px solid var(--highlighted-bright)",
    outlineOffset: "1px",
  },
  ".cm-conflict-accept-current": {
    backgroundColor: "var(--green-secondary)",
    color: "var(--green-secondary-fg)",
  },
  ".cm-conflict-accept-current:hover": { backgroundColor: "var(--green-secondary-hover)" },
  ".cm-conflict-accept-incoming": {
    backgroundColor: "var(--blue-secondary)",
    color: "var(--blue-secondary-fg)",
  },
  ".cm-conflict-accept-incoming:hover": { backgroundColor: "var(--blue-secondary-hover)" },
  ".cm-conflict-accept-both": {
    backgroundColor: "var(--neutral-secondary)",
    color: "var(--neutral-secondary-fg)",
  },
  ".cm-conflict-accept-both:hover": { backgroundColor: "var(--neutral-secondary-hover)" },
});

/** Mark conflicts in place. `onStatus` hears the block count, the block at
 * the caret and the parse on every edit or caret move. */
export function mergeConflictBlocks(
  onStatus?: (status: EditorConflictStatus) => void,
): Extension {
  return [
    parsedConflicts,
    conflictView,
    gutterWidgetClass.of((_view, widget) =>
      widget instanceof ConflictActions ? ACTIONS_GUTTER : null,
    ),
    conflictTheme,
    ...(onStatus ? [reportStatus(onStatus)] : []),
  ];
}
