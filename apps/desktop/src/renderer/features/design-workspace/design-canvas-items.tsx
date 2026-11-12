// PURPOSE: Section titles, notes and link cards on a page. They are canvas
// chrome in world coordinates: no iframe, no runtime, culled with the same
// spatial index as frames, and never part of a frame or its exports. Every
// create, move, resize, text edit and delete is one engine write and one
// Undo step; gestures paint locally and write on release.

import { File as FileIcon } from "lucide-react";
import React, { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DESIGN_CANVAS_ITEM_LIMITS,
  designCanvasItemBounds,
  designCanvasItemInputProblem,
  designCanvasItemTitle,
  designCanvasLinkTargetProblem,
  type DesignCanvasItem,
  type DesignCanvasItemSummary,
} from "@zeros/protocol/design-canvas-items";
import { DESIGN_MAX_FRAMES_PER_PAGE } from "@zeros/protocol/design-pages";
import type { DesignCanvasItemInput } from "../../platform/bridge/design-bridge";
import { cn } from "../../shared/ui/cn";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  Input,
  Popover,
  PopoverAnchor,
  PopoverContent,
  Textarea,
  toast,
} from "../../shared/ui/primitives";
import { COMMAND_EMPTY_CLS } from "../../shared/ui/primitives/command";
import { loadWorkspaceFiles, peekWorkspaceFiles } from "../../shell/workspace-files-cache";
import { searchWorkspaceFiles } from "../../shell/workbench/quick-open";
import { observeDesignCanvasPaint } from "./design-canvas-camera";
import { DesignFrameSpatialIndex } from "./design-frame-spatial-index";
import { DESIGN_FRAME_OVERSCAN_PIXELS } from "./design-frame-residency";
import { errorMessage } from "./design-workspace-error";
import { deleteDesignCanvasItemCached, putDesignCanvasItemCached } from "./state/design-workspace-cache";

export type DesignCanvasItemTool = DesignCanvasItem["kind"];
export const DESIGN_CANVAS_ITEM_TOOLS: readonly DesignCanvasItemTool[] = ["section", "note", "link"];
export const isDesignCanvasItemTool = (tool: string): tool is DesignCanvasItemTool =>
  tool === "section" || tool === "note" || tool === "link";

export function DesignCanvasItemsLimitNotice({ count }: { count?: number }) {
  if (!Number.isSafeInteger(count) || !count || count < 0) return null;
  return (
    <div data-design-canvas-items-not-shown="" role="status"
      className="border-border2 bg-bg1 text-fg2 pointer-events-none absolute bottom-4 left-1/2 z-2 -translate-x-1/2 rounded-md border px-3 py-2 text-xs shadow-[var(--shadow-dropdown)]">
      {count} more {count === 1 ? "item is" : "items are"} not shown
    </div>
  );
}

export interface DesignCanvasItemsHandle {
  /** Start placing an item of this kind at a world point. */
  place(kind: DesignCanvasItemTool, point: { x: number; y: number }): void;
}

const NEW_SIZE = { section: { width: 480 }, note: { width: 240, height: 160 }, link: { width: 280 } } as const;
const MIN_SIZE = { section: 48, note: 64, link: 160 } as const;
const MIN_NOTE_HEIGHT = 40;
const DRAG_THRESHOLD = 3;
const EMPTY: readonly DesignCanvasItemSummary[] = [];
const MAX_PICKER_ROWS = 40;

type Geometry = { x: number; y: number; width: number; height?: number };
type Editing = { id: string | null; kind: DesignCanvasItemTool; geometry: Geometry; text: string; target?: string };

const clampSize = (value: number) => Math.min(DESIGN_CANVAS_ITEM_LIMITS.maxSize, Math.max(1, Math.round(value)));
const clampCoordinate = (value: number) =>
  Math.min(DESIGN_CANVAS_ITEM_LIMITS.coordinate, Math.max(-DESIGN_CANVAS_ITEM_LIMITS.coordinate, Math.round(value)));

/** An item's own fields, as the canvas writes them. */
function itemInput(item: DesignCanvasItemSummary, geometry: Geometry = item, text?: string): DesignCanvasItemInput {
  const base = { id: item.id, x: clampCoordinate(geometry.x), y: clampCoordinate(geometry.y), width: clampSize(geometry.width) };
  if (item.kind === "section") return { ...base, kind: "section", text: text ?? item.text };
  if (item.kind === "note") return { ...base, kind: "note", height: clampSize(geometry.height ?? item.height), text: text ?? item.text };
  const title = text === undefined ? item.title : text.trim() || undefined;
  return { ...base, kind: "link", target: item.target, ...(title ? { title } : {}) };
}

function sameGeometry(item: DesignCanvasItemSummary, geometry: Geometry): boolean {
  return item.x === geometry.x && item.y === geometry.y && item.width === geometry.width &&
    (item.kind !== "note" || geometry.height === undefined || item.height === geometry.height);
}

/** Line breaks and tabs become spaces; the protocol validates the result. */
function sectionText(value: string): string {
  return value.replace(/[\r\n\t]/g, " ");
}

export interface DesignCanvasItemsLayerProps {
  workspaceId: string;
  pageId: string;
  folder: string | null;
  items: readonly DesignCanvasItemSummary[];
  world: React.RefObject<HTMLDivElement | null>;
  view: { zoom: number; panX: number; panY: number };
  viewport: { width: number; height: number };
  active: boolean;
  editable: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** The painted camera zoom, which a wheel gesture may be ahead of `view`. */
  zoom: () => number;
  /** Space is held: the press pans instead. */
  panning: () => boolean;
  focusCanvas: () => void;
  onOpenFile?: (path: string) => void;
}

/** Items in the camera's view and its overscan, from the spatial index. */
function visibleItemIds(
  index: DesignFrameSpatialIndex<{ file: string; x: number; y: number; width: number; height: number }> | null,
  view: { zoom: number; panX: number; panY: number },
  viewport: { width: number; height: number },
): ReadonlySet<string> {
  if (!index || !(view.zoom > 0) || !(viewport.width > 0 && viewport.height > 0)) return new Set();
  const overscan = DESIGN_FRAME_OVERSCAN_PIXELS / view.zoom;
  return new Set(index.search({
    x: -view.panX / view.zoom - overscan, y: -view.panY / view.zoom - overscan,
    width: viewport.width / view.zoom + overscan * 2, height: viewport.height / view.zoom + overscan * 2,
  }).map((entry) => entry.file));
}

const sameIds = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
  left.size === right.size && [...left].every((id) => right.has(id));

export const DesignCanvasItemsLayer = React.memo(React.forwardRef<DesignCanvasItemsHandle, DesignCanvasItemsLayerProps>(
  function DesignCanvasItemsLayer(props, ref) {
    const { workspaceId, pageId, items, world, view, viewport, active, editable, selectedId, onSelect } = props;
    const propsRef = useRef(props);
    propsRef.current = props;
    const [editing, setEditing] = useState<Editing | null>(null);
    const [picking, setPicking] = useState<{ x: number; y: number } | null>(null);
    // A released gesture shows its geometry until the engine confirms it.
    const [pending, setPending] = useState<{ id: string; geometry: Geometry } | null>(null);
    const owner = `${workspaceId}\0${pageId}`;
    const ownerRef = useRef(owner);
    ownerRef.current = owner;

    const index = useMemo(() => items.length
      ? new DesignFrameSpatialIndex(items.map((item) => ({ file: item.id, ...designCanvasItemBounds(item) })))
      : null, [items]);
    const [shown, setShown] = useState<ReadonlySet<string>>(() => visibleItemIds(index, view, viewport));
    const settled = useMemo(() => visibleItemIds(index, view, viewport), [index, view, viewport]);
    const shownRef = useRef(shown);
    useLayoutEffect(() => {
      if (!sameIds(shownRef.current, settled)) setShown((shownRef.current = settled));
    }, [settled]);
    // A wheel or pinch paints the camera ahead of the settled view; follow it
    // so items enter as frames do. Only a page with items listens.
    useEffect(() => {
      const element = world.current;
      if (!active || !index || !element) return;
      return observeDesignCanvasPaint(element, (camera, size) => {
        const next = visibleItemIds(index, camera, size);
        if (!sameIds(shownRef.current, next)) setShown((shownRef.current = next));
      });
    }, [active, index, world]);

    // Escape or a new page ends an edit, a pick or a held preview.
    useEffect(() => { setEditing(null); setPicking(null); setPending(null); }, [owner]);
    useEffect(() => {
      if (selectedId && !items.some((item) => item.id === selectedId)) onSelect(null);
    }, [items, onSelect, selectedId]);
    useEffect(() => {
      if (!pending) return;
      const item = items.find((candidate) => candidate.id === pending.id);
      if (!item || sameGeometry(item, pending.geometry)) setPending(null);
    }, [items, pending]);

    const write = useCallback((input: DesignCanvasItemInput, label: string) => {
      const writeOwner = ownerRef.current;
      return putDesignCanvasItemCached(workspaceId, pageId, input).catch((error: unknown) => {
        if (ownerRef.current === writeOwner) toast.error(label, { description: errorMessage(error) });
        throw error;
      });
    }, [pageId, workspaceId]);

    useImperativeHandle(ref, () => ({
      place(kind, point) {
        if (!propsRef.current.editable) return;
        const geometry = { x: clampCoordinate(point.x), y: clampCoordinate(point.y), ...NEW_SIZE[kind] };
        onSelect(null);
        if (kind === "link") {
          setPicking(geometry);
          if (props.folder) void loadWorkspaceFiles(props.folder).catch(() => {});
          return;
        }
        setEditing({ id: null, kind, geometry, text: "" });
      },
    }), [onSelect, props.folder]);

    const commitEdit = useCallback(async (draft: Editing, value: string): Promise<string | null> => {
      // A write can settle after another item's editor opened; close only this draft.
      const close = () => setEditing((current) => current === draft ? null : current);
      const text = draft.kind === "section" ? sectionText(value).trim() : value.replace(/\r\n?/g, "\n");
      // Like a Layers rename, an empty title keeps the confirmed one and places nothing.
      if (draft.kind === "section" && !text) {
        close();
        return null;
      }
      const item = draft.id === null ? null : propsRef.current.items.find((candidate) => candidate.id === draft.id);
      if (draft.id !== null && !item) return "That item is not on this page any more. Refresh before editing it.";
      if (item) {
        const current = item.kind === "link" ? item.title ?? "" : item.text;
        if (text === current || (item.kind === "link" && text.trim() === current)) {
          close();
          return null;
        }
      }
      const input: DesignCanvasItemInput = draft.id === null
        ? draft.kind === "section"
          ? { kind: "section", x: draft.geometry.x, y: draft.geometry.y, width: draft.geometry.width, text }
          : { kind: "note", x: draft.geometry.x, y: draft.geometry.y, width: draft.geometry.width, height: draft.geometry.height ?? NEW_SIZE.note.height, text }
        : itemInput(item!, item!, text);
      const problem = designCanvasItemInputProblem(input);
      if (problem) return problem;
      if (!propsRef.current.editable) return "Canvas items are read-only while history or the active view is changing.";
      const writeOwner = ownerRef.current;
      try {
        const result = await putDesignCanvasItemCached(workspaceId, pageId, input);
        if (ownerRef.current !== writeOwner) return null;
        close();
        if (draft.id === null && result.itemId) propsRef.current.onSelect(result.itemId);
        return null;
      } catch (error) {
        return errorMessage(error);
      }
    }, [pageId, workspaceId]);

    const pickFile = useCallback((target: string) => {
      const at = picking;
      setPicking(null);
      propsRef.current.focusCanvas();
      if (!at || designCanvasLinkTargetProblem(target)) return;
      const writeOwner = ownerRef.current;
      void write({ kind: "link", x: at.x, y: at.y, width: NEW_SIZE.link.width, target }, "Couldn't add the link card")
        .then((result) => { if (ownerRef.current === writeOwner && result.itemId) propsRef.current.onSelect(result.itemId); })
        .catch(() => {});
    }, [picking, write]);

    const remove = useCallback((id: string) => {
      const writeOwner = ownerRef.current;
      void deleteDesignCanvasItemCached(workspaceId, pageId, id).catch((error: unknown) => {
        if (ownerRef.current === writeOwner) toast.error("Couldn't delete the item", { description: errorMessage(error) });
      });
    }, [pageId, workspaceId]);

    const startEdit = useCallback((item: DesignCanvasItemSummary) => {
      if (!propsRef.current.editable) return;
      setEditing({ id: item.id, kind: item.kind, geometry: item,
        text: item.kind === "link" ? item.title ?? "" : item.text,
        ...(item.kind === "link" ? { target: item.target } : {}) });
    }, []);

    // Keys for the selected item, while the canvas owns focus.
    useEffect(() => {
      if (!active || !selectedId || editing) return;
      const keyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
        const viewport = propsRef.current.world.current?.closest("[data-design-canvas-viewport]");
        if (!viewport?.contains(document.activeElement)) return;
        const item = propsRef.current.items.find((candidate) => candidate.id === selectedId);
        if (!item) return;
        if (event.key === "Backspace" || event.key === "Delete") {
          if (!propsRef.current.editable) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          remove(item.id);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          onSelect(null);
        } else if (event.key === "Enter") {
          event.preventDefault();
          event.stopImmediatePropagation();
          startEdit(item);
        }
      };
      window.addEventListener("keydown", keyDown, true);
      return () => window.removeEventListener("keydown", keyDown, true);
    }, [active, editing, onSelect, remove, selectedId, startEdit]);

    /** Move or resize: the element paints locally and one write follows the
     * release. Escape puts it back and writes nothing. */
    const startGesture = useCallback((event: React.PointerEvent<HTMLElement>, item: DesignCanvasItemSummary,
      mode: "move" | "width" | "height" | "corner") => {
      const current = propsRef.current;
      if (!event.isPrimary || event.button !== 0 || current.panning()) return;
      event.stopPropagation();
      current.focusCanvas();
      onSelect(item.id);
      if (!current.editable) return;
      event.preventDefault();
      const element = (event.currentTarget.closest("[data-design-canvas-item]") ?? event.currentTarget) as HTMLElement;
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      handle.setPointerCapture?.(pointerId);
      const zoom = current.zoom() || 1;
      const start = { x: event.clientX, y: event.clientY };
      const from = designCanvasItemBounds(item);
      let moved = false;
      let geometry: Geometry = { x: from.x, y: from.y, width: from.width, ...(item.kind === "note" ? { height: from.height } : {}) };
      // React owns these inline values; a gesture borrows and returns them.
      const owned = { transform: element.style.transform, width: element.style.width, height: element.style.height };
      const paint = (next: Geometry | null) => {
        if (!next) {
          Object.assign(element.style, owned);
          return;
        }
        element.style.transform = `translate(${next.x - from.x}px, ${next.y - from.y}px)`;
        element.style.width = `${next.width}px`;
        if (next.height !== undefined) element.style.height = `${next.height}px`;
      };
      const finish = (commit: boolean) => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", escape, true);
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
        if (!commit || !moved || sameGeometry(item, geometry)) {
          paint(null);
          return;
        }
        // Hold the released geometry in React before clearing the local paint.
        setPending({ id: item.id, geometry });
        paint(null);
        void write(itemInput(item, geometry), mode === "move" ? "Couldn't move the item" : "Couldn't resize the item")
          .catch(() => setPending((value) => (value?.id === item.id ? null : value)));
      };
      const move = (pointer: PointerEvent) => {
        const dx = (pointer.clientX - start.x) / zoom;
        const dy = (pointer.clientY - start.y) / zoom;
        if (!moved && Math.hypot(pointer.clientX - start.x, pointer.clientY - start.y) < DRAG_THRESHOLD) return;
        moved = true;
        const minimum = MIN_SIZE[item.kind];
        geometry = mode === "move"
          ? { ...geometry, x: Math.round(from.x + dx), y: Math.round(from.y + dy) }
          : {
              ...geometry,
              ...(mode !== "height" ? { width: Math.min(DESIGN_CANVAS_ITEM_LIMITS.maxSize, Math.max(minimum, Math.round(from.width + dx))) } : {}),
              ...(mode !== "width" && item.kind === "note"
                ? { height: Math.min(DESIGN_CANVAS_ITEM_LIMITS.maxSize, Math.max(MIN_NOTE_HEIGHT, Math.round(from.height + dy))) } : {}),
            };
        paint(geometry);
      };
      const up = () => finish(true);
      const cancel = () => finish(false);
      const escape = (key: KeyboardEvent) => {
        if (key.key !== "Escape") return;
        key.preventDefault();
        key.stopImmediatePropagation();
        finish(false);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", escape, true);
    }, [onSelect, write]);

    const cancelEdit = useCallback(() => setEditing(null), []);
    const openFile = useCallback((target: string) => propsRef.current.onOpenFile?.(target), []);
    const cancelPick = useCallback(() => { setPicking(null); propsRef.current.focusCanvas(); }, []);
    const focusCanvas = useCallback(() => propsRef.current.focusCanvas(), []);

    const visible = useMemo(() => items.length
      ? items.filter((item) => shown.has(item.id) || item.id === selectedId || item.id === editing?.id || item.id === pending?.id)
      : EMPTY, [editing?.id, items, pending?.id, selectedId, shown]);

    if (!items.length && !editing && !picking) return null;
    return (
      // Frames stack by their page z (0 to the page frame limit); items sit above all of them.
      <div data-design-canvas-items="" className="pointer-events-none absolute inset-0" style={{ zIndex: DESIGN_MAX_FRAMES_PER_PAGE + 1 }}>
        {visible.map((item) => (
          <DesignCanvasItemView
            key={item.id}
            item={item}
            geometry={pending?.id === item.id ? pending.geometry : undefined}
            selected={item.id === selectedId}
            editable={editable}
            editing={editing?.id === item.id ? editing : null}
            onGesture={startGesture}
            onEdit={startEdit}
            onCommitEdit={commitEdit}
            onCancelEdit={cancelEdit}
            onKeyboardSettle={focusCanvas}
            onOpen={openFile}
          />
        ))}
        {editing?.id === null ? (
          <DesignCanvasItemEditor draft={editing} onCommit={commitEdit} onCancel={cancelEdit} onKeyboardSettle={focusCanvas} />
        ) : null}
        {picking ? (
          <DesignCanvasLinkPicker
            folder={props.folder}
            at={picking}
            onPick={pickFile}
            onCancel={cancelPick}
          />
        ) : null}
      </div>
    );
  },
));

const DesignCanvasItemView = React.memo(function DesignCanvasItemView({
  item, geometry, selected, editable, editing, onGesture, onEdit, onCommitEdit, onCancelEdit, onKeyboardSettle, onOpen,
}: {
  item: DesignCanvasItemSummary;
  geometry?: Geometry;
  selected: boolean;
  editable: boolean;
  editing: Editing | null;
  onGesture: (event: React.PointerEvent<HTMLElement>, item: DesignCanvasItemSummary, mode: "move" | "width" | "height" | "corner") => void;
  onEdit: (item: DesignCanvasItemSummary) => void;
  onCommitEdit: (draft: Editing, value: string) => Promise<string | null>;
  onCancelEdit: () => void;
  onKeyboardSettle: () => void;
  onOpen: (target: string) => void;
}) {
  const bounds = designCanvasItemBounds(item);
  const shown = geometry ?? bounds;
  const height = item.kind === "note" ? (shown.height ?? bounds.height) : bounds.height;
  const title = designCanvasItemTitle(item);
  const missing = item.kind === "link" && "missing" in item && item.missing === true;
  return (
    <div
      data-design-controls=""
      data-design-canvas-item={item.id}
      data-design-canvas-item-kind={item.kind}
      data-selected={selected ? "" : undefined}
      data-missing={missing ? "" : undefined}
      role="group"
      aria-label={item.kind === "section" ? `Section ${title}` : item.kind === "note" ? "Note" : `Link card ${title}`}
      className={cn("zd-canvas-item pointer-events-auto absolute", `zd-canvas-${item.kind}`)}
      style={{ left: shown.x, top: shown.y, width: shown.width, height }}
      onPointerDown={(event) => { if (!editing) onGesture(event, item, "move"); }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (item.kind === "link") {
          if (!missing) onOpen(item.target);
        } else onEdit(item);
      }}
    >
      {editing ? (
        <DesignCanvasItemEditor draft={editing} onCommit={onCommitEdit} onCancel={onCancelEdit} onKeyboardSettle={onKeyboardSettle} inline />
      ) : item.kind === "section" ? (
        <span className="zd-canvas-section-text">{item.text}</span>
      ) : item.kind === "note" ? (
        <span className="zd-canvas-note-text">{item.text}</span>
      ) : (
        <>
          <FileIcon className="zd-canvas-link-icon" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="zd-canvas-link-title">{title}</span>
            <span className="zd-canvas-link-path" data-design-link-status={missing ? "missing" : undefined}>
              {missing ? "File not found" : item.target}
            </span>
          </span>
        </>
      )}
      {selected && editable && !editing ? (
        <>
          <span
            data-design-canvas-item-handle="width"
            aria-hidden="true"
            className="zd-canvas-item-handle zd-canvas-item-handle-width"
            onPointerDown={(event) => onGesture(event, item, "width")}
          />
          {item.kind === "note" ? (
            <>
              <span data-design-canvas-item-handle="height" aria-hidden="true" className="zd-canvas-item-handle zd-canvas-item-handle-height"
                onPointerDown={(event) => onGesture(event, item, "height")} />
              <span data-design-canvas-item-handle="corner" aria-hidden="true" className="zd-canvas-item-handle zd-canvas-item-handle-corner"
                onPointerDown={(event) => onGesture(event, item, "corner")} />
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
});

/** In place over an item, or at a new item's point. Enter commits a title;
 * a note commits with Command-Enter or by leaving it. Escape writes nothing. */
function DesignCanvasItemEditor({ draft, onCommit, onCancel, onKeyboardSettle, inline = false }: {
  draft: Editing;
  onCommit: (draft: Editing, value: string) => Promise<string | null>;
  onCancel: () => void;
  /** Enter or Escape hands the keyboard back to the canvas. */
  onKeyboardSettle: () => void;
  inline?: boolean;
}) {
  const [value, setValue] = useState(draft.text);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const settledRef = useRef(false);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const problemId = useId();
  useLayoutEffect(() => {
    fieldRef.current?.focus({ preventScroll: true });
    fieldRef.current?.select();
  }, []);
  const settle = (commit: boolean, keyboard = false) => {
    if (settledRef.current || pendingRef.current) return;
    if (!commit) {
      settledRef.current = true;
      onCancel();
      if (keyboard) onKeyboardSettle();
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setProblem(null);
    void onCommit(draft, value).then((nextProblem) => {
      pendingRef.current = false;
      setPending(false);
      // Focus stays where the user put it: a keyboard commit never left the
      // field, and a click-away must not be pulled back.
      if (nextProblem) {
        setProblem(nextProblem);
        return;
      }
      settledRef.current = true;
      if (keyboard) onKeyboardSettle();
    }).catch((error: unknown) => {
      pendingRef.current = false;
      setPending(false);
      setProblem(errorMessage(error));
    });
  };
  const common = {
    ref: fieldRef,
    value,
    readOnly: pending,
    "aria-busy": pending || undefined,
    "aria-invalid": problem ? true : undefined,
    "aria-describedby": problem ? problemId : undefined,
    "data-design-canvas-item-editor": draft.kind,
    "aria-label": draft.kind === "section" ? "Section title" : draft.kind === "note" ? "Note text" : "Link card title",
    onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
    onBlur: () => settle(true),
  };
  const field = draft.kind === "note" ? (
    <Textarea
      {...common}
      className="zd-canvas-item-editor zd-canvas-note-text"
      onChange={(event) => { setValue(event.target.value); setProblem(null); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); settle(false, true); }
        else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); settle(true, true); }
      }}
    />
  ) : (
    <Input
      {...common}
      placeholder={draft.kind === "section" ? "Section" : draft.kind === "link" && draft.target ? draft.target.split("/").at(-1) : undefined}
      className={cn("zd-canvas-item-editor", draft.kind === "section" ? "zd-canvas-section-text" : "zd-canvas-link-title")}
      onChange={(event) => { setValue(event.target.value); setProblem(null); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); settle(false, true); }
        else if (event.key === "Enter") { event.preventDefault(); settle(true, true); }
      }}
    />
  );
  const error = problem ? (
    <div id={problemId} role="alert"
      className="border-border2 bg-bg1 text-red-primary absolute left-0 top-full z-2 mt-1 w-72 rounded-md border p-2 text-xs leading-4 shadow-[var(--shadow-dropdown)]">
      {problem}
    </div>
  ) : null;
  if (inline) return <>{field}{error}</>;
  const { geometry } = draft;
  return (
    <div
      data-design-controls=""
      data-design-canvas-item-draft={draft.kind}
      className={cn("zd-canvas-item pointer-events-auto absolute", `zd-canvas-${draft.kind}`)}
      style={{ left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height }}
    >
      {field}
      {error}
    </div>
  );
}

/** Choose a workspace file for a new link card. Only paths a card may point
 * to are offered; the list comes from the shared Files cache. */
function DesignCanvasLinkPicker({ folder, at, onPick, onCancel }: {
  folder: string | null;
  at: { x: number; y: number };
  onPick: (target: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<{ folder: string | null; paths: readonly string[] | null }>(() =>
    ({ folder, paths: folder ? peekWorkspaceFiles(folder) : null }));
  useEffect(() => {
    if (!folder) return;
    let current = true;
    void loadWorkspaceFiles(folder).then((paths) => { if (current) setFiles({ folder, paths }); }).catch(() => {
      if (current) setFiles((value) => (value.folder === folder ? value : { folder, paths: [] }));
    });
    return () => { current = false; };
  }, [folder]);
  const paths = useMemo(() => (files.folder === folder ? files.paths ?? [] : [])
    .filter((path) => designCanvasLinkTargetProblem(path) === null), [files, folder]);
  const results = useMemo(() => query.trim()
    ? searchWorkspaceFiles([...paths], query, MAX_PICKER_ROWS).map((result) => result.path)
    : paths.slice(0, MAX_PICKER_ROWS), [paths, query]);
  return (
    <Popover open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <PopoverAnchor asChild>
        <span data-design-canvas-link-anchor="" className="pointer-events-none absolute size-px" style={{ left: at.x, top: at.y }} />
      </PopoverAnchor>
      <PopoverContent
        aria-label="Link a file"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-72 p-0"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Command shouldFilter={false}>
          <CommandInput autoFocus placeholder="Search files…" value={query} onValueChange={setQuery}
            onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCancel(); } }} />
          <CommandList className="max-h-72">
            {results.length === 0 ? (
              <div className={COMMAND_EMPTY_CLS}>{files.paths === null ? "Loading files…" : "No files"}</div>
            ) : results.map((path) => (
              <CommandItem key={path} value={path} onSelect={() => onPick(path)}>
                <FileIcon className="size-3.5" />
                <span className="min-w-0 truncate">{path}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
