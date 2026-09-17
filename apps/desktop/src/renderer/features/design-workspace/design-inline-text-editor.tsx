import React, { useEffect, useLayoutEffect, useRef } from "react";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import {
  designSelectionBox,
  designSelectionOverlayFrame,
} from "./design-canvas-math";
import { designCanvasScreenPixels } from "./design-canvas-camera";

export interface InlineTextEditBase {
  id: string;
  nodeId: string;
  initialText: string;
  status: "editing" | "committing" | "settling";
}

export interface ExistingInlineTextEdit extends InlineTextEditBase {
  kind: "existing";
  frame: string;
  sourceVersion: string;
  whiteSpace: string;
  /** Runtime details captured when editing began. The editor mounts from
   * these in the same commit that starts the edit, so glyph ownership can
   * never sit with a suppressed iframe while selection readback is still in
   * flight — the exact failure that rendered text invisible. */
  initialDetails: DesignRuntimeNodeDetails;
}

export interface NewInlineTextEdit extends InlineTextEditBase {
  kind: "new";
  owner: "frame" | "canvas";
  frame: string | null;
  sourceVersion: string | null;
  parentNodeId: string | null;
  previousFrame: string | null;
  previousNodeId: string | null;
  previousNodeIds: readonly string[];
  canvasX: number;
  canvasY: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  placement: "absolute" | "flow";
  /** Exact inherited runtime typography for an element that does not exist in
   * source yet. Canvas-owned text falls back to the same black system text the
   * generated document uses. */
  inheritedStyles: Record<string, string>;
}

export type InlineTextEdit = ExistingInlineTextEdit | NewInlineTextEdit;

export const DESIGN_TEXT_WHITE_SPACE_PRESERVES_LINES = new Set([
  "pre",
  "pre-wrap",
  "pre-line",
  "break-spaces",
]);
export const DESIGN_CANVAS_DEFAULT_TEXT_COLOR =
  "var(--design-canvas-default-text)";

export function designInlineTextPaintColor(value: string | undefined): string {
  const color = value?.trim() ?? "";
  if (
    !color ||
    (color.includes("var(") && color !== DESIGN_CANVAS_DEFAULT_TEXT_COLOR) ||
    color === "transparent" ||
    /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(color) ||
    /^rgb\([^)]*\/\s*0(?:\.0+)?\s*\)$/i.test(color)
  ) {
    return "var(--design-selection-stroke)";
  }
  return color;
}

export function positiveCssPixels(value: string | undefined): number | null {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))px$/i.exec(value?.trim() ?? "");
  if (!match) return null;
  const pixels = Number(match[1]);
  return Number.isFinite(pixels) && pixels > 0 ? pixels : null;
}

export const DesignInlineTextEditor = React.memo(
  function DesignInlineTextEditor({
    edit,
    details,
    onMounted,
    onDraft,
    onCommit,
    onCancel,
  }: {
    edit: InlineTextEdit;
    details: DesignRuntimeNodeDetails | null;
    onMounted: (edit: InlineTextEdit) => void;
    onDraft: (edit: InlineTextEdit, draft: string) => void;
    onCommit: (
      edit: InlineTextEdit,
      measured: { width: number; height: number },
    ) => void;
    onCancel: (edit: InlineTextEdit) => void;
  }) {
    const editorRef = useRef<HTMLDivElement | null>(null);
    const composingRef = useRef(false);
    const blurredDuringCompositionRef = useRef(false);
    const publishedDraftRef = useRef(edit.initialText);
    // Selection readback may lag or fail entirely; the start-of-edit snapshot
    // keeps the editor mounted and painted so the text can never disappear.
    const resolvedDetails =
      details ?? (edit.kind === "existing" ? edit.initialDetails : null);
    const rect =
      edit.kind === "new"
        ? {
            x: edit.canvasX,
            y: edit.canvasY,
            width: edit.width,
            height: edit.height,
          }
        : resolvedDetails?.rect;

    useLayoutEffect(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.textContent = edit.initialText;
      composingRef.current = false;
      blurredDuringCompositionRef.current = false;
      publishedDraftRef.current = edit.initialText;
      editor.focus({ preventScroll: true });
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }, [edit.id, edit.initialText]);

    // Painted first, suppressed second: the runtime hides its glyphs only once
    // this editor exists with the same text, so a lost request or slow readback
    // degrades to a brief identical double-paint instead of invisible text.
    useEffect(() => {
      onMounted(edit);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [edit.id]);

    if (!rect) return null;
    const isExisting = edit.kind === "existing";
    // A rotated element paints its glyphs rotated, so the editor that stands in
    // for them has to turn with it — and take the element's own box, not the
    // larger upright box its rotation spans.
    const editedBox =
      isExisting && resolvedDetails
        ? designSelectionBox(resolvedDetails)
        : null;
    const turned =
      editedBox && editedBox.rotation
        ? designSelectionOverlayFrame(editedBox)
        : null;
    const painted =
      turned && editedBox
        ? {
            x: turned.left,
            y: turned.top,
            width: editedBox.width,
            height: editedBox.height,
          }
        : rect;
    const computed =
      resolvedDetails?.styles ??
      (edit.kind === "new" ? edit.inheritedStyles : {});
    const sizing = resolvedDetails?.textSizing;
    const intrinsicWidth =
      edit.kind === "new"
        ? edit.width === undefined
          ? "max-content"
          : null
        : sizing?.width && sizing.width !== "fixed"
          ? sizing.width === "auto"
            ? "max-content"
            : sizing.width
          : null;
    const fixedHeight =
      edit.kind === "new"
        ? edit.height !== undefined
        : sizing?.height === "fixed";
    // A new node inherits typography from its parent, but the parent's box
    // constraints (padding, borders, min/max sizes) are not inherited CSS and
    // never reach the committed text node — applying them here would shift the
    // draft relative to the final layout.
    const authoredMinHeight = isExisting
      ? positiveCssPixels(computed.minHeight)
      : null;
    const maxWidthPixels = isExisting
      ? positiveCssPixels(computed.maxWidth)
      : null;
    const intrinsicMaxWidth =
      intrinsicWidth === "fit-content" || sizing?.width === "auto"
        ? Math.min(
            sizing?.availableWidth ?? Number.POSITIVE_INFINITY,
            maxWidthPixels ?? Number.POSITIVE_INFINITY,
          )
        : maxWidthPixels;
    const authoredWhiteSpace =
      edit.kind === "new"
        ? "pre-wrap"
        : computed.whiteSpace || edit.whiteSpace || "normal";
    const paintColor = designInlineTextPaintColor(computed.color);
    const syncDraftLayout = (editor: HTMLDivElement, draft: string) => {
      editor.style.whiteSpace =
        draft.includes("\n") &&
        !DESIGN_TEXT_WHITE_SPACE_PRESERVES_LINES.has(authoredWhiteSpace)
          ? "pre-wrap"
          : authoredWhiteSpace;
    };
    const readDraft = (editor: HTMLDivElement) =>
      editor.innerText.replace(/\r\n?/g, "\n");
    const publishDraft = (editor: HTMLDivElement) => {
      let draft = readDraft(editor);
      if (draft.length > 10_000) {
        draft = draft.slice(0, 10_000);
        editor.textContent = draft;
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
      syncDraftLayout(editor, draft);
      if (publishedDraftRef.current === draft) return;
      publishedDraftRef.current = draft;
      onDraft(edit, draft);
    };
    const insertPlainText = (editor: HTMLDivElement, value: string) => {
      const text = value.replace(/\r\n?/g, "\n").slice(0, 10_000);
      const selection = window.getSelection();
      const range =
        selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      if (!range || !editor.contains(range.commonAncestorContainer)) {
        editor.append(document.createTextNode(text));
        const fallbackRange = document.createRange();
        fallbackRange.selectNodeContents(editor);
        fallbackRange.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(fallbackRange);
      } else {
        range.deleteContents();
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      publishDraft(editor);
    };
    const commit = (editor: HTMLDivElement) =>
      onCommit(edit, {
        width: Math.max(1, Math.ceil(editor.scrollWidth)),
        height: Math.max(1, Math.ceil(editor.scrollHeight)),
      });

    return (
      <div
        ref={editorRef}
        key={edit.id}
        data-design-controls
        data-design-inline-text-editor=""
        data-placeholder={edit.kind === "new" ? "Type something" : undefined}
        role="textbox"
        aria-label={
          edit.kind === "new"
            ? "New canvas text"
            : `Edit text for ${resolvedDetails?.name ?? edit.nodeId}`
        }
        aria-multiline="true"
        aria-busy={edit.status !== "editing"}
        contentEditable={edit.status === "editing" ? "plaintext-only" : false}
        suppressContentEditableWarning
        spellCheck
        className="zd-design-inline-text-editor absolute"
        style={{
          left: painted.x,
          top: painted.y,
          ...(turned
            ? {
                transform: `rotate(${turned.rotation}deg)`,
                transformOrigin: `${turned.pivotX}px ${turned.pivotY}px`,
              }
            : {}),
          width: intrinsicWidth ?? Math.max(1, painted.width ?? 1),
          maxWidth:
            intrinsicMaxWidth == null || !Number.isFinite(intrinsicMaxWidth)
              ? undefined
              : Math.max(1, intrinsicMaxWidth),
          minWidth: intrinsicWidth ? designCanvasScreenPixels(2) : undefined,
          height: fixedHeight ? Math.max(1, painted.height ?? 1) : undefined,
          minHeight: fixedHeight
            ? undefined
            : Math.max(
                edit.kind === "new" ? 24 : 1,
                authoredMinHeight ? (painted.height ?? authoredMinHeight) : 1,
              ),
          zIndex: 20,
          margin: 0,
          padding: isExisting ? computed.padding : 0,
          boxSizing:
            isExisting && intrinsicWidth
              ? (computed.boxSizing as React.CSSProperties["boxSizing"])
              : "border-box",
          borderTopWidth: isExisting ? computed.borderTopWidth : 0,
          borderRightWidth: isExisting ? computed.borderRightWidth : 0,
          borderBottomWidth: isExisting ? computed.borderBottomWidth : 0,
          borderLeftWidth: isExisting ? computed.borderLeftWidth : 0,
          borderStyle: "solid",
          borderColor: "transparent",
          overflow: "visible",
          outlineWidth: designCanvasScreenPixels(1),
          outlineStyle: "solid",
          outlineColor: "var(--design-selection-stroke)",
          outlineOffset: 0,
          background: "transparent",
          color: paintColor,
          WebkitTextFillColor: paintColor,
          caretColor: paintColor,
          fontFamily: computed.fontFamily || "inherit",
          fontSize: computed.fontSize || "16px",
          fontWeight: computed.fontWeight || "inherit",
          fontStyle: computed.fontStyle || "normal",
          fontStretch: computed.fontStretch,
          fontVariant: computed.fontVariant,
          fontKerning:
            computed.fontKerning as React.CSSProperties["fontKerning"],
          fontFeatureSettings: computed.fontFeatureSettings,
          fontVariationSettings: computed.fontVariationSettings,
          lineHeight: computed.lineHeight || "normal",
          letterSpacing: computed.letterSpacing || "normal",
          wordSpacing: computed.wordSpacing,
          textAlign: (computed.textAlign ||
            "start") as React.CSSProperties["textAlign"],
          textIndent: computed.textIndent,
          textTransform:
            computed.textTransform as React.CSSProperties["textTransform"],
          textDecoration: computed.textDecoration,
          whiteSpace: authoredWhiteSpace,
          wordBreak: computed.wordBreak as React.CSSProperties["wordBreak"],
          overflowWrap: (computed.overflowWrap ||
            (edit.kind === "new"
              ? "anywhere"
              : "normal")) as React.CSSProperties["overflowWrap"],
          hyphens: computed.hyphens as React.CSSProperties["hyphens"],
          writingMode:
            computed.writingMode as React.CSSProperties["writingMode"],
          direction: computed.direction as React.CSSProperties["direction"],
          unicodeBidi:
            computed.unicodeBidi as React.CSSProperties["unicodeBidi"],
          opacity: computed.opacity,
          pointerEvents: edit.status === "editing" ? "auto" : "none",
        }}
        onInput={(event) => publishDraft(event.currentTarget)}
        onCompositionStart={() => {
          composingRef.current = true;
          blurredDuringCompositionRef.current = false;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          publishDraft(event.currentTarget);
          if (
            blurredDuringCompositionRef.current &&
            document.activeElement !== event.currentTarget
          ) {
            blurredDuringCompositionRef.current = false;
            commit(event.currentTarget);
          }
        }}
        onPaste={(event) => {
          event.preventDefault();
          insertPlainText(
            event.currentTarget,
            event.clipboardData.getData("text/plain"),
          );
        }}
        onDrop={(event) => event.preventDefault()}
        onPointerDown={(event) => event.stopPropagation()}
        onBlur={() => {
          if (edit.status !== "editing") return;
          if (composingRef.current) {
            blurredDuringCompositionRef.current = true;
          } else {
            const editor = editorRef.current;
            if (editor) commit(editor);
          }
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (composingRef.current) return;
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel(edit);
          } else if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            edit.status === "editing"
          ) {
            event.preventDefault();
            commit(event.currentTarget);
          }
        }}
      />
    );
  },
);
