import { TriangleAlert } from "lucide-react";
import type { CSSProperties } from "react";
import { Button } from "../../shared/ui/primitives/button";
import { cn } from "../../shared/ui/cn";
import { DESIGN_CANVAS_INVERSE_ZOOM, designCanvasScreenPixels } from "./design-canvas-camera";

const LOAD_ERROR = "Couldn’t load this frame.";

/** Why a frame carries a problem mark. A closed set: the canvas and tests
 * select marks by it. */
export type DesignFrameProblemKind = "load-error" | "missing-component" | "options-not-applied";

/** A screen-size red mark for a frame that could not be shown, or whose
 * options could not be applied. */
export function DesignFrameProblemMark({ kind = "load-error", message, className }: {
  kind?: DesignFrameProblemKind;
  message?: string;
  className?: string;
}) {
  const fallback = kind === "load-error" ? LOAD_ERROR : undefined;
  return (
    <span
      data-design-frame-problem={kind}
      role="img"
      aria-label={kind === "load-error" && message ? `${LOAD_ERROR} ${message}` : message ?? fallback}
      title={message ?? fallback}
      className={cn("text-red-primary inline-flex size-[11px] shrink-0", className)}
    >
      <TriangleAlert className="size-[11px]" aria-hidden="true" />
    </span>
  );
}

/** The name above a frame that was never shown, carrying its problem mark so
 * the problem stays visible at any zoom. */
export function DesignFrameProblemLabel({ title, message, width }: {
  title: string;
  message?: string;
  /** The frame's world width; the label never runs past the frame on screen. */
  width?: number;
}) {
  return (
    <div
      data-design-frame-chrome=""
      className="pointer-events-auto absolute bottom-full left-0 flex h-7 origin-bottom-left items-center"
      style={{
        // The mark itself stays visible even on a frame narrower than it on screen.
        maxWidth: width === undefined ? undefined : `max(12px, calc(${width}px * var(--design-canvas-zoom, 1)))`,
        transform: `translateY(${designCanvasScreenPixels(-8)}) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
      }}
    >
      <span
        title={`${title}: ${message ?? LOAD_ERROR}`}
        className="text-2xxs text-muted-fg flex max-w-full min-w-0 items-center gap-1 overflow-hidden leading-4 font-medium whitespace-nowrap"
      >
        <DesignFrameProblemMark message={message} />
        <span className="block min-w-0 overflow-hidden text-ellipsis">{title}</span>
      </span>
    </div>
  );
}

/** A frame that could not be shown: fills that frame only, so the rest of
 * the canvas and the Design tab stay usable. The message and Retry are drawn
 * at screen size and only where the frame is large enough on screen to hold
 * them; a smaller frame shows its mark instead. */
export function DesignFrameLoadError({
  message,
  className,
  labelled = false,
  onRetry,
}: {
  /** The engine's reason, offered on hover. */
  message?: string;
  className?: string;
  /** The frame's label already carries the problem mark. */
  labelled?: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      data-design-frame-load-error=""
      data-design-frame-problem-surface=""
      title={message}
      className={cn("bg-bg1 absolute inset-0 z-[2] overflow-hidden", className)}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div
        className="zd-design-frame-problem-screen absolute top-0 left-0 origin-top-left"
        style={{
          width: "calc(100% * var(--design-canvas-zoom, 1))",
          height: "calc(100% * var(--design-canvas-zoom, 1))",
          transform: `scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
        } as CSSProperties}
      >
        <div data-design-frame-problem-message="" className="text-muted-fg h-full flex-col items-center justify-center gap-2 text-xs">
          <span>{LOAD_ERROR}</span>
          <Button
            size="sm"
            variant="secondary"
            data-design-frame-retry=""
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
          >
            Retry frame
          </Button>
        </div>
        {labelled ? null : <DesignFrameProblemMark message={message} className="absolute inset-0 m-auto" />}
      </div>
    </div>
  );
}
