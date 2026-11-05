import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, ZoomIn, ZoomOut } from "lucide-react";
import {
  Button,
  IconButton,
  Input,
  Toolbar,
  ToolbarSeparator,
  ToolbarText,
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
      {/* The floating island every preview shares: one 36px bar of 28px
          tools with 10px corners, the page stepper, a divider, then zoom. */}
      <Toolbar
        data-document-controls
        aria-label={label}
        className="pointer-events-auto max-w-full flex-wrap justify-center"
      >
        <div className="flex items-center gap-0.5">
          <Tooltip label="Previous page">
            <IconButton
              label="Previous page"
              disabled={page <= 1}
              onClick={() => onPage(page - 1)}
            >
              <ChevronUp />
            </IconButton>
          </Tooltip>
          <Input
            aria-label="Page number"
            inputMode="numeric"
            value={pageInput}
            className="hover:bg-bg2-highlight h-7 w-8 border-transparent px-0 text-center tabular-nums"
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={commitPage}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitPage();
              if (event.key === "Escape") setPageInput(String(page));
            }}
          />
          <ToolbarText className="pl-0.5 tabular-nums">/ {pageCount}</ToolbarText>
          <Tooltip label="Next page">
            <IconButton
              label="Next page"
              disabled={page >= pageCount}
              onClick={() => onPage(page + 1)}
            >
              <ChevronDown />
            </IconButton>
          </Tooltip>
        </div>
        <ToolbarSeparator />
        <div className="flex items-center gap-0.5">
          <Tooltip label="Zoom out">
            <IconButton
              label="Zoom out"
              disabled={scale <= 0.25}
              onClick={() => onZoom(Math.max(0.25, scale - 0.25))}
            >
              <ZoomOut />
            </IconButton>
          </Tooltip>
          <Tooltip label="Zoom in">
            <IconButton
              label="Zoom in"
              disabled={scale >= maxScale}
              onClick={() => onZoom(Math.min(maxScale, scale + 0.25))}
            >
              <ZoomIn />
            </IconButton>
          </Tooltip>
          <Tooltip label="Fit page">
            <Button
              variant="ghost"
              aria-label="Fit page"
              aria-pressed={fit}
              className="w-12 px-1 tabular-nums"
              onClick={() => onZoom(null)}
            >
              {Math.round(scale * 100)}%
            </Button>
          </Tooltip>
        </div>
      </Toolbar>
    </div>
  );
}
