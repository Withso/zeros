import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, ZoomIn, ZoomOut } from "lucide-react";
import {
  Button,
  IconButton,
  Input,
  Tooltip,
} from "@/renderer/shared/ui/primitives";
import "./document-controls.css";

/** Shared page navigation for the document viewers. The viewport reserves
 * bottom space so Fit and the end of a zoomed page stay above the island. */
export function DocumentControls({
  label,
  page,
  pageCount,
  scale,
  fit,
  maxScale,
  onPage,
  onZoom,
}: {
  label: string;
  page: number;
  pageCount: number;
  scale: number;
  fit: boolean;
  maxScale: number;
  onPage(page: number): void;
  onZoom(scale: number | null): void;
}) {
  const [pageInput, setPageInput] = useState(String(page));
  useEffect(() => setPageInput(String(page)), [page]);
  const commitPage = () => {
    const value = Number(pageInput);
    const next =
      pageInput.trim() && Number.isFinite(value)
        ? Math.min(pageCount, Math.max(1, Math.trunc(value)))
        : page;
    setPageInput(String(next));
    onPage(next);
  };
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 z-1 flex justify-center">
      <div
        data-document-controls
        role="group"
        aria-label={label}
        className="border-border2 bg-bg2 text-fg2 pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-full border p-1 shadow-[var(--shadow-dropdown)]"
      >
        <div className="flex items-center gap-1">
          <Tooltip label="Previous page">
            <IconButton
              label="Previous page"
              size="compact"
              className="rounded-full"
              disabled={page <= 1}
              onClick={() => onPage(page - 1)}
            >
              <ChevronUp className="size-3.5" />
            </IconButton>
          </Tooltip>
          <Input
            aria-label="Page number"
            inputMode="numeric"
            value={pageInput}
            className="hover:bg-bg2-hover h-6 w-8 border-transparent px-0 text-center text-xs tabular-nums shadow-none"
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={commitPage}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitPage();
              if (event.key === "Escape") setPageInput(String(page));
            }}
          />
          <span className="text-xs tabular-nums">/ {pageCount}</span>
          <Tooltip label="Next page">
            <IconButton
              label="Next page"
              size="compact"
              className="rounded-full"
              disabled={page >= pageCount}
              onClick={() => onPage(page + 1)}
            >
              <ChevronDown className="size-3.5" />
            </IconButton>
          </Tooltip>
        </div>
        <div className="border-border2 flex items-center gap-1 border-l pl-1">
          <Tooltip label="Zoom out">
            <IconButton
              label="Zoom out"
              size="compact"
              className="rounded-full"
              disabled={scale <= 0.25}
              onClick={() => onZoom(Math.max(0.25, scale - 0.25))}
            >
              <ZoomOut className="size-3.5" />
            </IconButton>
          </Tooltip>
          <Tooltip label="Zoom in">
            <IconButton
              label="Zoom in"
              size="compact"
              className="rounded-full"
              disabled={scale >= maxScale}
              onClick={() => onZoom(Math.min(maxScale, scale + 0.25))}
            >
              <ZoomIn className="size-3.5" />
            </IconButton>
          </Tooltip>
          <Tooltip label="Fit page">
            <Button
              variant="ghost"
              size="compact"
              aria-label="Fit page"
              aria-pressed={fit}
              className="w-12 rounded-full px-1 text-xs tabular-nums"
              onClick={() => onZoom(null)}
            >
              {Math.round(scale * 100)}%
            </Button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
