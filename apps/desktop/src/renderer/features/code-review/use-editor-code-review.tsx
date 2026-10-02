import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import type { LineAnnotation, SelectedLineRange } from "@pierre/diffs";
import {
  reviewContentRevision,
  type ReviewCodeSnapshot,
} from "./review-anchors";
import {
  reviewSelectionKey,
  reviewUnplacedThreads,
  type ReviewAnnotationPayload,
} from "./review-annotations";
import { ReviewUnplacedThreads } from "./review-annotation-view";
import { ReviewFeedback } from "./review-feedback";
import { editorReviewLineRange } from "./review-editor-selection";
import { useInlineReview } from "./use-inline-review";
import type { CodeReviewController } from "./use-code-review";

interface EditorReviewSlot {
  id: string;
  line: number;
  host: HTMLElement;
}
const setReviewSlots = StateEffect.define<readonly EditorReviewSlot[]>();

class ReviewWidget extends WidgetType {
  constructor(readonly host: HTMLElement) {
    super();
  }
  eq(other: ReviewWidget): boolean {
    return this.host === other.host;
  }
  toDOM(): HTMLElement {
    return this.host;
  }
  // A thread's prose, code blocks, links and composers own their pointer and
  // keyboard events. They must never become code selections or editor input.
  ignoreEvent(): boolean {
    return true;
  }
}

const reviewWidgets = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(previous, transaction) {
    let result = previous.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setReviewSlots)) continue;
      result = Decoration.set(
        effect.value.map((slot) => {
          const line = Math.min(transaction.state.doc.lines, slot.line);
          const position =
            line > 0
              ? transaction.state.doc.line(line).to
              : transaction.state.doc.length;
          return Decoration.widget({
            widget: new ReviewWidget(slot.host),
            block: true,
            side: 1,
          }).range(position);
        }),
        true,
      );
    }
    return result;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class CommentMarker extends GutterMarker {
  constructor(readonly line: number) {
    super();
  }
  eq(other: CommentMarker): boolean {
    return this.line === other.line;
  }
  toDOM(): HTMLElement {
    // Native CodeMirror gutters render DOM markers; React owns the discussion
    // controls in portal widgets, rather than creating a root for every line.
    const button = document.createElement("button");
    button.type = "button";
    button.className = "zeros-review-comment-button";
    button.setAttribute("aria-label", `Comment on line ${this.line}`);
    button.title = "Comment on line · drag to select a range";
    button.textContent = "+";
    return button;
  }
}

const reviewEditorTheme = EditorView.theme({
  ".zeros-review-gutter": { width: "24px" },
  ".zeros-review-gutter .cm-gutterElement": {
    padding: "0",
    display: "flex",
    justifyContent: "center",
  },
  ".zeros-review-comment-button": {
    width: "20px",
    height: "20px",
    padding: "0",
    border: "0",
    borderRadius: "var(--radius-sm)",
    background: "transparent",
    color: "var(--fg2)",
    font: "inherit",
    cursor: "pointer",
    opacity: "0",
  },
  ".cm-gutterElement:hover .zeros-review-comment-button, .zeros-review-comment-button:focus-visible":
    { opacity: "1" },
  ".zeros-review-comment-button:hover": {
    background: "var(--bg2-hover)",
    color: "var(--fg1)",
  },
  ".zeros-review-comment-button:focus-visible": {
    outline: "1px solid var(--fg2)",
    outlineOffset: "1px",
  },
  ".zeros-review-editor-annotation": {
    fontFamily: "var(--font-sans)",
    whiteSpace: "normal",
    minWidth: "0",
  },
});

// CodeMirror hides its entire gutter container by default and offers no gutter
// accessibility option. Expose native review controls while hiding decoration.
const reviewGutterAccessibility = ViewPlugin.define((view) => {
  let live = true;
  let queued = false;
  const expose = () => {
    queued = false;
    if (!live) return;
    for (const container of view.dom.querySelectorAll<HTMLElement>(
      ".cm-gutters",
    )) {
      if (!container.querySelector(".zeros-review-gutter")) continue;
      container.removeAttribute("aria-hidden");
      for (const child of container.children) {
        if (child.classList.contains("zeros-review-gutter"))
          child.removeAttribute("aria-hidden");
        else child.setAttribute("aria-hidden", "true");
      }
    }
  };
  const schedule = () => {
    if (!queued) {
      queued = true;
      queueMicrotask(expose);
    }
  };
  schedule();
  return {
    update: (update) => {
      if (
        update.viewportChanged ||
        update.docChanged ||
        update.transactions.some((transaction) => transaction.reconfigured)
      )
        schedule();
    },
    destroy: () => {
      live = false;
    },
  };
});

/** Native block widgets + React portals keep threads in the one editor scroller. */
export function useEditorCodeReview({
  review,
  path,
  content,
  active,
}: {
  review: CodeReviewController;
  path: string;
  content: string;
  active: boolean;
}) {
  const inline = useInlineReview(review, active, path);
  const [view, setView] = useState<EditorView | null>(null);
  const snapshot = useMemo<Extract<ReviewCodeSnapshot, { kind: "file" }>>(
    () => ({
      kind: "file",
      path,
      content,
      revision: reviewContentRevision(content),
    }),
    [path, content],
  );
  const annotations = inline.annotationsForFile(path, snapshot);
  const unplaced = useMemo(
    () => reviewUnplacedThreads(snapshot, review.threads),
    [snapshot, review.threads],
  );
  const hosts = useMemo(
    () => new Map<string, HTMLElement>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- DOM portal hosts must be replaced when the semantic owner or file changes
    [review.ownerKey, path],
  );
  const latest = useRef({ review, path, active, inline });
  latest.current = { review, path, active, inline };
  const anchorLine = useRef(1);
  const stopDrag = useRef<(() => void) | null>(null);

  const select = useCallback(
    (
      editor: EditorView,
      range: SelectedLineRange,
      mode: "selection" | "composer",
    ) => {
      const current = latest.current;
      if (!current.active) return;
      const text = editor.state.doc.toString();
      // Selection comes from the current editor transaction, including text typed
      // in the same event before the controlled React value has rendered.
      current.inline.annotationsForFile(current.path, {
        kind: "file",
        path: current.path,
        content: text,
        revision: reviewContentRevision(text),
      });
      current.inline.select(current.path, range, mode);
    },
    [],
  );

  const beginGutterSelection = useCallback(
    (
      editor: EditorView,
      from: number,
      event: Event,
      mode: "selection" | "composer" = "composer",
    ) => {
      const pointer = event as PointerEvent;
      if (!latest.current.active || pointer.button !== 0) return false;
      event.preventDefault();
      stopDrag.current?.();
      const owner = latest.current.review.ownerKey;
      const selectedPath = latest.current.path;
      const clicked = editor.state.doc.lineAt(from).number;
      const start = pointer.shiftKey
        ? Math.min(anchorLine.current, editor.state.doc.lines)
        : clicked;
      anchorLine.current = start;
      let end = clicked;
      let moved = false;
      const paint = () => {
        const first = editor.state.doc.line(Math.min(start, end));
        const last = editor.state.doc.line(Math.max(start, end));
        editor.dispatch({
          selection: EditorSelection.range(first.from, last.to),
        });
      };
      editor.focus();
      paint();
      const move = (next: PointerEvent) => {
        if (
          !latest.current.active ||
          latest.current.review.ownerKey !== owner ||
          latest.current.path !== selectedPath
        ) {
          cleanup();
          return;
        }
        const position = editor.posAtCoords({
          x: editor.contentDOM.getBoundingClientRect().left + 8,
          y: next.clientY,
        });
        if (position === null) return;
        const nextEnd = editor.state.doc.lineAt(position).number;
        if (nextEnd === end) return;
        moved = true;
        end = nextEnd;
        paint();
      };
      const up = () => {
        cleanup();
        if (
          latest.current.review.ownerKey === owner &&
          latest.current.path === selectedPath
        )
          select(
            editor,
            { start, end },
            moved || pointer.shiftKey ? "selection" : mode,
          );
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("blur", cleanup);
        if (stopDrag.current === cleanup) stopDrag.current = null;
      };
      stopDrag.current = cleanup;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
      window.addEventListener("blur", cleanup, { once: true });
      return true;
    },
    [select],
  );

  const extensions = useMemo(
    () => [
      reviewWidgets,
      reviewEditorTheme,
      reviewGutterAccessibility,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        // Keep the Shift anchor attached to its source through edits. A drag's
        // endpoints belong to the old document and must retire before repaint.
        stopDrag.current?.();
        const previous = update.startState.doc.line(
          Math.min(anchorLine.current, update.startState.doc.lines),
        );
        anchorLine.current = update.state.doc.lineAt(
          update.changes.mapPos(previous.from, 1),
        ).number;
      }),
      gutter({
        class: "zeros-review-gutter",
        lineMarker: (editor, block) =>
          new CommentMarker(editor.state.doc.lineAt(block.from).number),
        lineMarkerChange: (update) => update.docChanged,
        domEventHandlers: {
          pointerdown: (editor, block, event) =>
            beginGutterSelection(editor, block.from, event),
          click: (editor, block, event) => {
            if (!latest.current.active || (event as MouseEvent).detail !== 0)
              return false;
            const line = editor.state.doc.lineAt(block.from).number;
            select(editor, { start: line, end: line }, "composer");
            return true;
          },
        },
      }),
      // Extend the existing native number gutter, preserving its geometry. A
      // number click/drag commits a range toolbar; the plus opens the composer.
      lineNumbers({
        domEventHandlers: {
          pointerdown: (editor, block, event) =>
            beginGutterSelection(editor, block.from, event, "selection"),
        },
      }),
      EditorView.domEventHandlers({
        mouseup: (_event, editor) => {
          if (!latest.current.active || stopDrag.current) return false;
          queueMicrotask(() => {
            if (!latest.current.active || editor.state.selection.main.empty)
              return;
            select(
              editor,
              editorReviewLineRange(
                editor.state.doc,
                editor.state.selection.main,
              ),
              "selection",
            );
          });
          return false;
        },
        keyup: (event, editor) => {
          if (
            latest.current.active &&
            event.shiftKey &&
            event.key.startsWith("Arrow") &&
            !editor.state.selection.main.empty
          )
            select(
              editor,
              editorReviewLineRange(
                editor.state.doc,
                editor.state.selection.main,
              ),
              "selection",
            );
          return false;
        },
      }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Shift-m",
            preventDefault: true,
            run: (editor) => {
              if (!latest.current.active) return false;
              select(
                editor,
                editorReviewLineRange(
                  editor.state.doc,
                  editor.state.selection.main,
                ),
                "composer",
              );
              return true;
            },
          },
          {
            key: "Escape",
            run: () => {
              const current = latest.current;
              const selection = current.inline.selection;
              if (
                !current.active ||
                !selection ||
                current.review.drafts.getSnapshot(
                  `new:${reviewSelectionKey(selection)}`,
                ).busy
              )
                return false;
              current.inline.cancel(selection);
              return true;
            },
          },
        ]),
      ),
    ],
    [beginGutterSelection, select],
  );

  const getHost = (id: string) => {
    let host = hosts.get(id);
    if (!host) {
      host = document.createElement("div");
      host.className = "zeros-review-editor-annotation";
      host.dataset.reviewEditorSlot = id;
      hosts.set(id, host);
    }
    return host;
  };
  const slots: EditorReviewSlot[] = annotations.map((annotation) => ({
    id: annotation.metadata.id,
    line: annotation.lineNumber,
    host: getHost(annotation.metadata.id),
  }));
  const portals = annotations.map(
    (annotation: LineAnnotation<ReviewAnnotationPayload>, index) =>
      createPortal(
        inline.renderAnnotation(annotation),
        slots[index]!.host,
        annotation.metadata.id,
      ),
  );
  const hasFooter = !!(
    unplaced.length ||
    review.error ||
    review.loading ||
    review.partial ||
    review.nextCursor ||
    review.external?.error ||
    review.external?.notice ||
    review.external?.loading
  );
  if (hasFooter) {
    const host = getHost("footer");
    slots.push({ id: "footer", line: 0, host });
    portals.push(
      createPortal(
        <>
          <ReviewUnplacedThreads
            entries={unplaced}
            review={review}
            active={active}
          />
          <ReviewFeedback review={review} />
        </>,
        host,
        "footer",
      ),
    );
  }
  const slotSignature = slots
    .map((slot) => `${slot.id}:${slot.line}`)
    .join("|");
  useLayoutEffect(() => {
    if (!active || !view) return;
    view.dispatch({ effects: setReviewSlots.of(slots) });
    view.requestMeasure();
    const observer = new ResizeObserver(() => {
      if (latest.current.active) view.requestMeasure();
    });
    for (const slot of slots) observer.observe(slot.host);
    const ids = new Set(slots.map((slot) => slot.id));
    for (const id of hosts.keys()) if (!ids.has(id)) hosts.delete(id);
    return () => observer.disconnect();
    // Payload changes are React portal updates; resize observation owns height.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slot positions, content and owner are the native layout identity
  }, [active, view, hosts, slotSignature, content]);
  useEffect(() => {
    if (!active) stopDrag.current?.();
    return () => stopDrag.current?.();
  }, [active]);
  const onCreateView = useCallback((editor: EditorView) => setView(editor), []);
  return { extensions, onCreateView, portals };
}
