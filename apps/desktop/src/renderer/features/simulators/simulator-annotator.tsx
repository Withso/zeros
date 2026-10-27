import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  Circle,
  LoaderCircle,
  MessageSquarePlus,
  MoveUpRight,
  Pencil,
  Redo2,
  Slash,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { SimulatorAnnotationSnapshot } from "@zeros/protocol/simulator-captures";

import { useThemeId } from "../../shared/theme/use-theme-variant";
import { cn } from "../../shared/ui/cn";
import { Button } from "../../shared/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { toast } from "../../shared/ui/primitives/elements";
import { IconButton } from "../../shared/ui/primitives/icon-button";
import { Input } from "../../shared/ui/primitives/input";
import { Popover, PopoverAnchor, PopoverContent } from "../../shared/ui/primitives/popover";
import { Separator } from "../../shared/ui/primitives/separator";
import { Toolbar } from "../../shared/ui/primitives/toolbar";
import { Tooltip } from "../../shared/ui/primitives/tooltip";
import { useWorkspaceStore } from "../../state/workspace-store";
import { addAnnotationToChat, leaveSimulatorAnnotation } from "./simulator-annotation-actions";
import {
  ANNOTATION_COLORS,
  ANNOTATION_TOOLS,
  MAX_ANNOTATION_MARKS,
  MAX_ANNOTATION_NOTE,
  dragMark,
  markAtBadge,
  markBadgeCenter,
  markBadgeRadius,
  markIsDrawn,
  screenPoint,
  setMarkNote,
  startMark,
  type AnnotationColor,
  type AnnotationMark,
  type AnnotationPoint,
  type AnnotationTool,
} from "./simulator-annotation-model";
import {
  annotationTextLineHeight,
  paintAnnotationMarks,
  readAnnotationPalette,
  type AnnotationPalette,
} from "./simulator-annotation-painter";
import { simulatorAnnotations, type SimulatorAnnotation } from "./simulator-annotation-store";
import { turnedArea, type QuarterTurns } from "./simulator-geometry";
import { useElementSize } from "./simulator-hooks";

/** An annotation whose screen has frozen, ready to draw on. */
export type FrozenSimulatorAnnotation = SimulatorAnnotation & {
  readonly snapshot: SimulatorAnnotationSnapshot;
};

export function isFrozenAnnotation(
  annotation: SimulatorAnnotation | null,
): annotation is FrozenSimulatorAnnotation {
  return annotation?.snapshot != null;
}

const TOOLS: Record<AnnotationTool, { label: string; Icon: LucideIcon }> = {
  pen: { label: "Pen", Icon: Pencil },
  line: { label: "Line", Icon: Slash },
  arrow: { label: "Arrow", Icon: MoveUpRight },
  rectangle: { label: "Rectangle", Icon: Square },
  ellipse: { label: "Ellipse", Icon: Circle },
  text: { label: "Text", Icon: Type },
};

const COLORS: Record<AnnotationColor, { label: string; swatch: string }> = {
  red: { label: "Red", swatch: "bg-red-primary" },
  yellow: { label: "Yellow", swatch: "bg-yellow-primary" },
  green: { label: "Green", swatch: "bg-green-primary" },
  blue: { label: "Blue", swatch: "bg-blue-primary" },
  violet: { label: "Violet", swatch: "bg-violet-primary" },
};

/** Esc leaves; ⌘Z and ⇧⌘Z undo and redo. A key a menu or field already used
 * is theirs. */
function onAnnotationKeyDown(tabId: string, event: KeyboardEvent<HTMLElement>): void {
  const native = event.nativeEvent;
  if (native.defaultPrevented || native.isComposing) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    leaveSimulatorAnnotation(tabId);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) simulatorAnnotations.redo(tabId);
    else simulatorAnnotations.undo(tabId);
  }
}

function useObjectUrl(bytes: Uint8Array, type: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes, type]);
  return url;
}

/** What the note field is writing: a mark's note, or a text mark's words
 * before the mark exists. */
type Editing =
  | {
      id: number;
      kind: "note";
      mark: AnnotationMark;
      /** Part of the step that drew the mark, so one undo takes both. */
      amend: boolean;
      text: string;
    }
  | { id: number; kind: "text"; at: AnnotationPoint; color: AnnotationColor; text: string };

/** The frozen screen in the device's frame, and the marks on it. The device
 * may be drawn turned; this layer turns back so it reads upright, as the
 * screenshot and its elements are. */
export function SimulatorAnnotator({
  annotation,
  turns,
  active,
}: {
  annotation: FrozenSimulatorAnnotation;
  turns: QuarterTurns;
  active: boolean;
}) {
  const { tabId, snapshot, tool, color, adding, deviceName } = annotation;
  const marks = annotation.history.marks;
  const screen = useMemo(
    () => ({ width: snapshot.width, height: snapshot.height }),
    [snapshot],
  );
  const { ref: measure, size } = useElementSize(active);
  const upright = size ? turnedArea(size, turns) : null;
  const uprightWidth = upright?.width ?? 0;
  const uprightHeight = upright?.height ?? 0;
  const surface = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const imageUrl = useObjectUrl(snapshot.png, "image/png");
  const hintId = useId();

  const themeId = useThemeId();
  const [palette, setPalette] = useState<AnnotationPalette | null>(null);
  useLayoutEffect(() => {
    if (surface.current) setPalette(readAnnotationPalette(surface.current));
  }, [themeId]);

  const marksRef = useRef(marks);
  marksRef.current = marks;
  const draft = useRef<{ pointerId: number; mark: AnnotationMark } | null>(null);
  const pendingText = useRef<{ pointerId: number; at: AnnotationPoint } | null>(null);

  const paint = useCallback(() => {
    const node = canvas.current;
    const context = node?.getContext("2d");
    if (!node || !context || !palette || uprightWidth <= 0 || uprightHeight <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(uprightWidth * ratio));
    const height = Math.max(1, Math.round(uprightHeight * ratio));
    if (node.width !== width) node.width = width;
    if (node.height !== height) node.height = height;
    context.clearRect(0, 0, width, height);
    paintAnnotationMarks(context, marksRef.current, {
      scale: width / screen.width,
      palette,
      screen,
      draft: draft.current?.mark ?? null,
    });
  }, [palette, screen, uprightWidth, uprightHeight]);
  useLayoutEffect(() => paint(), [paint, marks]);

  const frame = useRef(0);
  const schedulePaint = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      paint();
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const [editing, setEditingState] = useState<Editing | null>(null);
  const editingRef = useRef<Editing | null>(null);
  const editingSerial = useRef(0);
  /** Escape ends the note field without keeping what it says. */
  const cancelled = useRef(false);
  const setEditing = useCallback((next: Editing | null) => {
    editingRef.current = next;
    setEditingState(next);
  }, []);
  /** The marks as they are now, even before this render has seen them. */
  const currentMarks = () => simulatorAnnotations.get(tabId)?.history.marks ?? marksRef.current;
  const editNote = (mark: AnnotationMark, amend: boolean) => {
    editingSerial.current += 1;
    setEditing({ id: editingSerial.current, kind: "note", mark, amend, text: mark.note });
  };
  /** Ends the note field, keeping what it says unless `save` is false. */
  const finishEditing = (save: boolean) => {
    const current = editingRef.current;
    if (!current) return;
    setEditing(null);
    if (!save) return;
    if (current.kind === "text") {
      simulatorAnnotations.commit(tabId, (list) => {
        const mark: AnnotationMark = { kind: "text", color: current.color, note: "", at: current.at };
        const next = setMarkNote([...list, mark], list.length, current.text);
        return next.length > list.length ? next : list;
      });
      return;
    }
    const update = (list: readonly AnnotationMark[]) => {
      const index = list.indexOf(current.mark);
      return index < 0 ? list : setMarkNote(list, index, current.text);
    };
    if (current.amend) simulatorAnnotations.amend(tabId, update);
    else simulatorAnnotations.commit(tabId, update);
  };

  // Undo or Clear can take away the mark being written on.
  useEffect(() => {
    const current = editingRef.current;
    if (current?.kind === "note" && !marks.includes(current.mark)) setEditing(null);
  }, [marks, setEditing]);

  useEffect(() => {
    const focused = document.activeElement;
    if (active && (!focused || focused === document.body)) {
      surface.current?.focus({ preventScroll: true });
    }
  }, [active]);

  const pointAt = (event: { clientX: number; clientY: number }): AnnotationPoint | null => {
    // This layer reads upright on the page, so its box is the screen's.
    const rect = surface.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return screenPoint(
      {
        x: ((event.clientX - rect.left) / rect.width) * screen.width,
        y: ((event.clientY - rect.top) / rect.height) * screen.height,
      },
      screen,
    );
  };

  const [overBadge, setOverBadge] = useState(false);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || draft.current || pendingText.current || adding) return;
    event.preventDefault();
    const wasEditing = editingRef.current !== null;
    finishEditing(true);
    event.currentTarget.focus({ preventScroll: true });
    const at = pointAt(event);
    if (!at) return;
    const current = currentMarks();
    const badge = markAtBadge(current, at, screen);
    if (badge >= 0) {
      editNote(current[badge]!, false);
      return;
    }
    // A click away from the text being written only puts it down.
    if (tool === "text" && wasEditing) return;
    if (current.length >= MAX_ANNOTATION_MARKS) {
      toast.info(`An annotation holds up to ${MAX_ANNOTATION_MARKS} marks.`, {
        id: `simulator-annotate-full:${tabId}`,
      });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "text") {
      pendingText.current = { pointerId: event.pointerId, at };
      return;
    }
    draft.current = { pointerId: event.pointerId, mark: startMark(tool, color, at) };
    schedulePaint();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const at = pointAt(event);
    if (!at) return;
    const current = draft.current;
    if (current?.pointerId === event.pointerId) {
      draft.current = { ...current, mark: dragMark(current.mark, at) };
      schedulePaint();
      return;
    }
    if (!draft.current && !pendingText.current) {
      setOverBadge(markAtBadge(marksRef.current, at, screen) >= 0);
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const text = pendingText.current;
    if (text?.pointerId === event.pointerId) {
      pendingText.current = null;
      editingSerial.current += 1;
      setEditing({ id: editingSerial.current, kind: "text", at: text.at, color, text: "" });
      return;
    }
    const current = draft.current;
    if (current?.pointerId !== event.pointerId) return;
    draft.current = null;
    const to = pointAt(event);
    const mark = to ? dragMark(current.mark, to) : current.mark;
    if (markIsDrawn(mark)) {
      simulatorAnnotations.commit(tabId, (list) => [...list, mark]);
      // A shape asks what it is about; a pen stroke may be one of many.
      const drawn = simulatorAnnotations.get(tabId)?.history.marks.includes(mark) ?? false;
      if (drawn && mark.kind !== "pen") editNote(mark, true);
    }
    schedulePaint();
  };

  const endPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (pendingText.current?.pointerId === event.pointerId) pendingText.current = null;
    if (draft.current?.pointerId !== event.pointerId) return;
    draft.current = null;
    schedulePaint();
  };

  const cssPerPoint = uprightWidth / screen.width;
  const anchor = (() => {
    if (!editing) return null;
    if (editing.kind === "text") {
      const lineHeight = annotationTextLineHeight(screen) * cssPerPoint;
      return { left: editing.at.x * cssPerPoint, top: editing.at.y * cssPerPoint, width: 1, height: lineHeight };
    }
    const center = markBadgeCenter(editing.mark, screen);
    const radius = markBadgeRadius(screen) * cssPerPoint;
    return {
      left: center.x * cssPerPoint - radius,
      top: center.y * cssPerPoint - radius,
      width: radius * 2,
      height: radius * 2,
    };
  })();
  const editingIndex = editing?.kind === "note" ? marks.indexOf(editing.mark) : -1;
  const editingText = editing?.kind === "text" || editing?.mark.kind === "text";

  return (
    <div ref={measure} className="absolute inset-0">
      <div
        className="absolute"
        style={{
          left: Math.round(((size?.width ?? 0) - uprightWidth) / 2),
          top: Math.round(((size?.height ?? 0) - uprightHeight) / 2),
          width: uprightWidth,
          height: uprightHeight,
          transform: turns === 0 ? undefined : `rotate(${-turns * 90}deg)`,
        }}
      >
        <div
          ref={surface}
          role="application"
          aria-label={`Annotate ${deviceName}'s screen`}
          aria-describedby={hintId}
          aria-busy={adding || undefined}
          tabIndex={0}
          data-simulator-annotator=""
          data-annotation-marks={marks.length}
          className={cn(
            "focus-visible:ring-highlighted-bright absolute inset-0 touch-none outline-none select-none focus-visible:ring-2 focus-visible:ring-inset",
            overBadge ? "cursor-pointer" : tool === "text" ? "cursor-text" : "cursor-crosshair",
          )}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={endPointer}
          onLostPointerCapture={endPointer}
          onPointerLeave={() => setOverBadge(false)}
          onKeyDown={(event) => onAnnotationKeyDown(tabId, event)}
        >
          {imageUrl && (
            <img
              src={imageUrl}
              alt=""
              draggable={false}
              className="pointer-events-none absolute inset-0 block size-full select-none"
            />
          )}
          <canvas
            ref={canvas}
            aria-hidden
            className="pointer-events-none absolute inset-0 block size-full"
          />
          <span id={hintId} className="sr-only">
            Drag to draw. Click a mark&apos;s number to write a note about it. Escape leaves.
          </span>
        </div>
        <Popover
          open={editing !== null}
          onOpenChange={(open) => {
            if (open) return;
            finishEditing(!cancelled.current);
            cancelled.current = false;
          }}
        >
          <PopoverAnchor asChild>
            <span
              aria-hidden
              className="pointer-events-none absolute"
              style={anchor ?? { left: 0, top: 0, width: 0, height: 0 }}
            />
          </PopoverAnchor>
          {editing && (
            <PopoverContent
              key={editing.id}
              side="bottom"
              align="start"
              padding="none"
              className="w-64 p-2"
              data-simulator-annotate-editor=""
              // The screen ends the field itself, before it draws the next mark.
              onInteractOutside={(event) => {
                if (event.target instanceof Node && surface.current?.contains(event.target)) {
                  event.preventDefault();
                }
              }}
              onEscapeKeyDown={() => {
                cancelled.current = true;
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const focused = document.activeElement;
                if (!focused || focused === document.body) {
                  surface.current?.focus({ preventScroll: true });
                }
              }}
            >
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  finishEditing(true);
                }}
              >
                <Input
                  autoFocus
                  value={editing.text}
                  maxLength={MAX_ANNOTATION_NOTE}
                  aria-label={
                    editingText
                      ? "Text"
                      : `Note for mark ${editingIndex >= 0 ? editingIndex + 1 : marks.length + 1}`
                  }
                  placeholder={editingText ? "Type, then press Return" : "Add a note for the agent"}
                  onChange={(event) => {
                    const current = editingRef.current;
                    if (current) setEditing({ ...current, text: event.target.value });
                  }}
                />
              </form>
            </PopoverContent>
          )}
        </Popover>
      </div>
    </div>
  );
}

function AnnotationColorMenu({
  tabId,
  color,
  disabled,
}: {
  tabId: string;
  color: AnnotationColor;
  disabled: boolean;
}) {
  return (
    <DropdownMenu>
      <Tooltip label="Color" delayDuration={1500}>
        <DropdownMenuTrigger asChild>
          <IconButton
            size="compact"
            label={`Color: ${COLORS[color].label}`}
            disabled={disabled}
            className="data-[state=open]:bg-bg2-hover"
          >
            <span aria-hidden className={cn("size-3 rounded-full", COLORS[color].swatch)} />
          </IconButton>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent side="top" align="center">
        <DropdownMenuRadioGroup
          value={color}
          onValueChange={(value) => {
            const next = ANNOTATION_COLORS.find((entry) => entry === value);
            if (next) simulatorAnnotations.setColor(tabId, next);
          }}
        >
          {ANNOTATION_COLORS.map((entry) => (
            <DropdownMenuRadioItem key={entry} value={entry} indicator="check" className="gap-2">
              <span aria-hidden className={cn("size-3 rounded-full", COLORS[entry].swatch)} />
              {COLORS[entry].label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Annotate's tools in place of the island: what to draw and in which color,
 * undo, redo and clear, Add to chat, and Close. */
export function SimulatorAnnotateToolbar({
  annotation,
}: {
  annotation: FrozenSimulatorAnnotation;
}) {
  const { tabId, tool, color, adding, history, deviceName } = annotation;
  const toolbar = useRef<HTMLDivElement>(null);
  const add = () => {
    const themed = toolbar.current;
    if (!themed) return;
    void addAnnotationToChat(tabId, useWorkspaceStore.getState().activeChatId, themed);
  };
  return (
    <Toolbar
      ref={toolbar}
      aria-label={`Annotate ${deviceName}`}
      data-simulator-annotate=""
      className="max-w-full flex-wrap justify-center"
      onKeyDown={(event) => onAnnotationKeyDown(tabId, event)}
    >
      {ANNOTATION_TOOLS.map((entry) => {
        const { label, Icon } = TOOLS[entry];
        const pressed = entry === tool;
        return (
          <Tooltip key={entry} label={label}>
            <IconButton
              size="compact"
              label={label}
              aria-pressed={pressed}
              disabled={adding}
              className={cn(pressed && "bg-bg2-hover text-fg1")}
              onClick={() => simulatorAnnotations.setTool(tabId, entry)}
            >
              <Icon aria-hidden />
            </IconButton>
          </Tooltip>
        );
      })}
      <AnnotationColorMenu tabId={tabId} color={color} disabled={adding} />
      <Separator orientation="vertical" className="mx-0.5 h-4" />
      <Tooltip label="Undo" shortcut="⌘Z">
        <IconButton
          size="compact"
          label="Undo"
          disabled={adding || history.past.length === 0}
          onClick={() => simulatorAnnotations.undo(tabId)}
        >
          <Undo2 aria-hidden />
        </IconButton>
      </Tooltip>
      <Tooltip label="Redo" shortcut="⇧⌘Z">
        <IconButton
          size="compact"
          label="Redo"
          disabled={adding || history.future.length === 0}
          onClick={() => simulatorAnnotations.redo(tabId)}
        >
          <Redo2 aria-hidden />
        </IconButton>
      </Tooltip>
      <Tooltip label="Clear">
        <IconButton
          size="compact"
          label="Clear"
          disabled={adding || history.marks.length === 0}
          onClick={() => simulatorAnnotations.clear(tabId)}
        >
          <Trash2 aria-hidden />
        </IconButton>
      </Tooltip>
      <Separator orientation="vertical" className="mx-0.5 h-4" />
      <Button
        size="compact"
        variant="default"
        aria-busy={adding || undefined}
        disabled={adding}
        onClick={add}
      >
        {adding ? (
          <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
        ) : (
          <MessageSquarePlus aria-hidden />
        )}
        Add to chat
      </Button>
      <IconButton
        size="compact"
        label="Close"
        disabled={adding}
        onClick={() => leaveSimulatorAnnotation(tabId)}
      >
        <X aria-hidden />
      </IconButton>
    </Toolbar>
  );
}
