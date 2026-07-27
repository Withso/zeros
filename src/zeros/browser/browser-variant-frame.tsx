// ──────────────────────────────────────────────────────────
// Browser tab variant frame — srcdoc preview beside live iframe
// ──────────────────────────────────────────────────────────

import React, {
  useMemo,
  useState,
  useCallback,
  useEffect,
} from "react";
import { Check, Copy, Trash2 } from "lucide-react";
import type { BrowserTabVariant } from "./variant-types";
import {
  BROWSER_VARIANT_MIN_HEIGHT,
  BROWSER_VARIANT_MIN_WIDTH,
} from "./variant-types";
import { buildVariantSrcdoc } from "./build-variant-srcdoc";
import {
  CanvasKnobHandles,
  type CanvasKnobAxis,
} from "./canvas-knob-handles";
import DOMPurify from "dompurify";
import { copyToClipboard } from "../utils/clipboard";
import { Input } from "../ui";
import { Tooltip } from "@/zeros/ui/primitives";
import { toast } from "../ui/primitives/elements";

interface BrowserVariantFrameProps {
  variant: BrowserTabVariant;
  canvasZoom: number;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onResize: (id: string, width: number, contentHeight: number) => void;
  onMove: (id: string, offsetX: number, offsetY: number) => void;
}

const CHROME_H = 34;

export function BrowserVariantFrame({
  variant,
  canvasZoom,
  onDelete,
  onRename,
  onResize,
  onMove,
}: BrowserVariantFrameProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(variant.name);
  const [copied, setCopied] = useState(false);
  const [dragDims, setDragDims] = useState<{
    w: number;
    h: number;
    axis: CanvasKnobAxis;
  } | null>(null);
  const [dragOffset, setDragOffset] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const isResizing = dragDims !== null;

  useEffect(() => {
    if (!editing) setName(variant.name);
  }, [variant.name, editing]);

  const srcdoc = useMemo(
    () => buildVariantSrcdoc(variant.html, variant.css),
    [variant.html, variant.css],
  );

  const width = dragDims?.w ?? variant.sourceViewportWidth;
  const viewportH = dragDims?.h ?? variant.sourceContentHeight;
  const height = Math.max(viewportH, BROWSER_VARIANT_MIN_HEIGHT) + CHROME_H;
  const offsetX = dragOffset?.x ?? variant.offsetX ?? 0;
  const offsetY = dragOffset?.y ?? variant.offsetY ?? 0;

  const handleRename = useCallback(() => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== variant.name) {
      onRename(variant.id, trimmed);
    }
    setEditing(false);
  }, [name, variant.id, variant.name, onRename]);

  const handleCopyHtml = useCallback(() => {
    // M14: the captured HTML can carry <script>/handlers from the forked page.
    // Sanitize before it lands on the clipboard (and from there into wherever
    // the user pastes it).
    const safeHtml = DOMPurify.sanitize(variant.html);
    const bundle = `<style>\n${variant.css}\n</style>\n${safeHtml}`;
    copyToClipboard(bundle);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
    toast.success("Copied HTML + CSS to clipboard");
  }, [variant.html, variant.css]);

  const startResize = useCallback(
    (e: React.PointerEvent, axis: CanvasKnobAxis, handle: HTMLElement) => {
      if (axis !== "right" && axis !== "bottom") return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = variant.sourceViewportWidth;
      const startH = variant.sourceContentHeight;
      const zoom = canvasZoom;
      let lastW = startW;
      let lastH = startH;
      setDragDims({ w: startW, h: startH, axis });

      const onMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / zoom;
        const dy = (ev.clientY - startY) / zoom;
        if (axis === "right") {
          lastW = Math.max(BROWSER_VARIANT_MIN_WIDTH, Math.round(startW + dx));
        }
        if (axis === "bottom") {
          lastH = Math.max(
            BROWSER_VARIANT_MIN_HEIGHT,
            Math.round(startH + dy),
          );
        }
        setDragDims({
          w: axis === "right" ? lastW : startW,
          h: axis === "bottom" ? lastH : startH,
          axis,
        });
      };
      const onUp = () => {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        setDragDims(null);
        onResize(variant.id, lastW, lastH);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [
      canvasZoom,
      onResize,
      variant.id,
      variant.sourceContentHeight,
      variant.sourceViewportWidth,
    ],
  );

  const startHeaderDrag = useCallback(
    (e: React.PointerEvent) => {
      if (editing) return;
      if ((e.target as HTMLElement).closest("button, input")) return;
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startY = e.clientY;
      const startOX = variant.offsetX ?? 0;
      const startOY = variant.offsetY ?? 0;
      const zoom = canvasZoom;
      let lastX = startOX;
      let lastY = startOY;

      const handlePointerMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / zoom;
        const dy = (ev.clientY - startY) / zoom;
        lastX = Math.round(startOX + dx);
        lastY = Math.round(startOY + dy);
        setDragOffset({ x: lastX, y: lastY });
      };
      const handlePointerUp = () => {
        target.releasePointerCapture(e.pointerId);
        target.removeEventListener("pointermove", handlePointerMove);
        target.removeEventListener("pointerup", handlePointerUp);
        target.removeEventListener("pointercancel", handlePointerUp);
        setDragOffset(null);
        onMove(variant.id, lastX, lastY);
      };
      target.addEventListener("pointermove", handlePointerMove);
      target.addEventListener("pointerup", handlePointerUp);
      target.addEventListener("pointercancel", handlePointerUp);
    },
    [canvasZoom, editing, onMove, variant.id, variant.offsetX, variant.offsetY],
  );

  return (
    <div
      className="relative shrink-0 pointer-events-auto"
      style={{
        transform: `translate(${offsetX}px, ${offsetY}px)`,
      }}
      data-zeros-browser-variant={variant.id}
    >
      <div
        className="relative flex flex-col overflow-visible bg-bg1 shadow-md ring-1 ring-fg1/5"
        style={{ width, height }}
      >
        <div
          className="flex h-[34px] shrink-0 cursor-grab items-center gap-1 border-b border-border1 bg-bg2 px-2 text-xxs select-none active:cursor-grabbing"
          data-zeros-canvas-chrome
          onPointerDown={startHeaderDrag}
        >
          {editing ? (
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={handleRename}
              onKeyDown={(e) => e.key === "Enter" && handleRename()}
              onPointerDown={(e) => e.stopPropagation()}
              className="h-6 min-w-0 flex-1 px-1.5 text-xxs"
              autoFocus
            />
          ) : (
            <Tooltip label="Drag to move">
              <span
                className="min-w-0 flex-1 cursor-grab truncate font-medium text-fg1 active:cursor-grabbing"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setName(variant.name);
                  setEditing(true);
                }}
              >
                {variant.name}
              </span>
            </Tooltip>
          )}
          <Tooltip label="Copy HTML + CSS">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleCopyHtml();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="inline-flex size-6 items-center justify-center rounded-sm text-fg2 hover:bg-bg2-hover hover:text-fg1"
              aria-label="Copy HTML and CSS"
            >
              {copied ? (
                <Check className="size-3 text-green-primary" />
              ) : (
                <Copy className="size-3" />
              )}
            </button>
          </Tooltip>
          <Tooltip label="Delete variant">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(variant.id);
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="inline-flex size-6 items-center justify-center rounded-sm text-fg2 hover:bg-bg2-hover hover:text-fg1"
              aria-label="Delete variant"
            >
              <Trash2 className="size-3" />
            </button>
          </Tooltip>
        </div>
        {/* Fixed viewport — content scrolls inside the iframe like the live frame. */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <iframe
            srcDoc={srcdoc}
            // `title` is the iframe's accessible name (axe frame-title). A hover
            // Tooltip is unreliable over an iframe (its document eats pointer
            // events) and doesn't set a name, so this stays a plain attribute.
            title={variant.name}
            // M14: no `allow-same-origin` — the static preview never needs the
            // embedder's origin, and granting it would become dangerous the
            // moment scripts are ever enabled. Empty sandbox = render-only.
            sandbox=""
            className="block size-full border-0"
            style={{
              pointerEvents: isResizing ? "none" : "auto",
            }}
          />
        </div>
        <CanvasKnobHandles
          axes={["right", "bottom"]}
          activeAxis={dragDims?.axis ?? null}
          onStart={startResize}
        />
      </div>
    </div>
  );
}
