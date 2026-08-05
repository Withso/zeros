// ──────────────────────────────────────────────────────────
// DiffHoverPreview — shared chat diff preview surface
// ──────────────────────────────────────────────────────────
//
// Edit/Write rows and persisted turn-footer file pills both render their exact
// patch here. The caller owns the patch source; this component owns only the
// bounded, themed preview surface and its honest cold/error/empty states.
// ──────────────────────────────────────────────────────────

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { PatchDiff } from "@pierre/diffs/react";

import { zerosDiffOptions } from "@/renderer/shared/theme/diff-theme";
import { useCodeTheme } from "@/renderer/shared/theme/use-code-theme";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/renderer/shared/ui/primitives";

interface DiffHoverPreviewProps {
  /** File identity announced to assistive technology and optionally rendered. */
  path: string;
  /** Exact unified patch; undefined means the first read has not settled. */
  patch: string | undefined;
  /** Whether the exact-key patch request is still on its first load. */
  loading?: boolean;
  /** Read failure shown only when no last-confirmed patch is available. */
  error?: Error | null;
  /** Footer previews need the path header; Edit rows already show it below. */
  showPath?: boolean;
  /** Hover surfaces share a strict 350px outer cap; expanded transcript diffs
   * keep the existing larger reading viewport. */
  compact?: boolean;
}

/** Shared by footer-pill and Edit/Write hover portals. 450px is the requested
 * reading width; the viewport fallback preserves collision safety on a window
 * narrower than that fixed geometry. */
export const DIFF_HOVER_CONTENT_CLASS =
  "w-[450px] max-w-[calc(100vw-24px)] max-h-[min(350px,var(--diff-hover-available-height,350px))] overflow-hidden p-0";

const DIFF_HOVER_BOUNDARY_SELECTOR = "[data-agent-diff-collision-boundary]";
const DIFF_HOVER_MAX_HEIGHT_PX = 350;
const DIFF_HOVER_COLLISION_PADDING_PX = 12;
const DIFF_HOVER_SIDE_OFFSET_PX = 4;
const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

interface DiffHoverCardProps {
  trigger: ReactElement;
  children: ReactNode;
}

interface DiffHoverPlacement {
  side: "top" | "bottom";
  availableHeight: number;
}

/**
 * Shared collision-aware shell for every compact diff hover.
 *
 * The browser viewport is not the useful top edge in the app: each transcript
 * starts below the global workspace bar and its own pane-tab strip, and a
 * vertically split pane can start much farther down. The trigger therefore
 * resolves its nearest real transcript scroller when it opens. We measure the
 * diff's full desired height (including scrollable content) and prefer `top`
 * only when the entire card clears that boundary; otherwise it opens below.
 */
export const DiffHoverCard = memo(function DiffHoverCard({
  trigger,
  children,
}: DiffHoverCardProps) {
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  const boundaryRef = useRef<Element | null>(null);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<DiffHoverPlacement>({
    side: "top",
    availableHeight: DIFF_HOVER_MAX_HEIGHT_PX,
  });

  const recomputePlacement = useCallback(() => {
    const triggerElement = triggerRef.current;
    if (!triggerElement || !contentElement) return;

    // The HoverCard opens from a delayed native pointer/focus timer. Resolve
    // again here as a guard for portals that mount after the Root's open-state
    // callback; this also follows a retained chat moved into another pane.
    boundaryRef.current =
      triggerElement.closest(DIFF_HOVER_BOUNDARY_SELECTOR) ?? null;

    const triggerRect = triggerElement.getBoundingClientRect();
    const boundaryRect = boundaryRef.current?.getBoundingClientRect();
    const boundaryTop = boundaryRect?.top ?? 0;
    const boundaryBottom = boundaryRect?.bottom ?? window.innerHeight;
    const preview = contentElement.querySelector<HTMLElement>(
      "[data-agent-diff-preview]",
    );
    const scrollBody = preview?.lastElementChild;
    const bodyHeight =
      scrollBody instanceof HTMLElement ? scrollBody.scrollHeight : 0;
    const fixedHeight = preview
      ? Array.from(preview.children).reduce(
          (height, child) =>
            child === scrollBody || !(child instanceof HTMLElement)
              ? height
              : height + child.offsetHeight,
          0,
        )
      : 0;
    const outerChrome = Math.max(
      0,
      contentElement.offsetHeight - (preview?.offsetHeight ?? 0),
    );
    const desiredHeight = Math.min(
      DIFF_HOVER_MAX_HEIGHT_PX,
      Math.max(
        contentElement.scrollHeight,
        fixedHeight + bodyHeight + outerChrome,
      ),
    );
    const topLimit = boundaryTop + DIFF_HOVER_COLLISION_PADDING_PX;
    const bottomLimit = boundaryBottom - DIFF_HOVER_COLLISION_PADDING_PX;
    const fitsAbove =
      triggerRect.top - DIFF_HOVER_SIDE_OFFSET_PX - desiredHeight >= topLimit;
    const side = fitsAbove ? "top" : "bottom";
    const availableHeight = Math.max(
      0,
      Math.min(
        DIFF_HOVER_MAX_HEIGHT_PX,
        Math.floor(
          side === "top"
            ? triggerRect.top - DIFF_HOVER_SIDE_OFFSET_PX - topLimit
            : bottomLimit - triggerRect.bottom - DIFF_HOVER_SIDE_OFFSET_PX,
        ),
      ),
    );

    setPlacement((current) =>
      current.side === side && current.availableHeight === availableHeight
        ? current
        : { side, availableHeight },
    );
  }, [contentElement]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      boundaryRef.current =
        triggerRef.current?.closest(DIFF_HOVER_BOUNDARY_SELECTOR) ?? null;
      setPlacement({
        side: "top",
        availableHeight: DIFF_HOVER_MAX_HEIGHT_PX,
      });
    }
    setOpen(nextOpen);
  }, []);

  useBrowserLayoutEffect(() => {
    if (!open || !contentElement) return;
    const preview = contentElement.querySelector<HTMLElement>(
      "[data-agent-diff-preview]",
    );
    const observer = new ResizeObserver(recomputePlacement);
    observer.observe(contentElement);
    if (preview) observer.observe(preview);
    const boundaryElement = boundaryRef.current;
    if (boundaryElement) observer.observe(boundaryElement);
    boundaryElement?.addEventListener("scroll", recomputePlacement, {
      passive: true,
    });
    window.addEventListener("resize", recomputePlacement);
    const frame = window.requestAnimationFrame(recomputePlacement);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", recomputePlacement);
      boundaryElement?.removeEventListener("scroll", recomputePlacement);
      observer.disconnect();
    };
  }, [children, contentElement, open, recomputePlacement]);

  const contentStyle = {
    "--diff-hover-available-height": `${placement.availableHeight}px`,
  } as CSSProperties;

  return (
    <HoverCard
      open={open}
      onOpenChange={handleOpenChange}
      openDelay={350}
      closeDelay={120}
    >
      <HoverCardTrigger ref={triggerRef} asChild>
        {trigger}
      </HoverCardTrigger>
      <HoverCardContent
        ref={setContentElement}
        side={placement.side}
        align="start"
        sideOffset={DIFF_HOVER_SIDE_OFFSET_PX}
        collisionBoundary={boundaryRef.current ?? undefined}
        collisionPadding={DIFF_HOVER_COLLISION_PADDING_PX}
        style={contentStyle}
        className={DIFF_HOVER_CONTENT_CLASS}
      >
        {children}
      </HoverCardContent>
    </HoverCard>
  );
});

/** A textual unified patch must contain at least one ordinary hunk. Binary and
 * metadata-only patches deliberately fall through to the honest empty state. */
export function hasTextualDiffHunk(patch: string): boolean {
  return /(?:^|\n)@@ -\d/.test(patch);
}

export const DiffHoverPreview = memo(function DiffHoverPreview({
  path,
  patch,
  loading = false,
  error = null,
  showPath = false,
  compact = false,
}: DiffHoverPreviewProps) {
  // Existing open previews follow code-theme changes without remounting.
  const codeTheme = useCodeTheme();
  const options = useMemo(
    () =>
      zerosDiffOptions({
        disableFileHeader: true,
        // Use the same diff canvas and renderer contract as Changes/Review.
        // The optional filename header remains bg1 as requested.
        surface: "sidebar-bg",
        codeThemeId: codeTheme,
      }),
    [codeTheme],
  );
  const hasPatch = patch !== undefined && hasTextualDiffHunk(patch);

  return (
    <section
      aria-label={`Diff preview for ${path}`}
      data-agent-diff-preview
      className={
        compact
          ? "flex max-h-[min(350px,var(--diff-hover-available-height,350px))] min-h-0 w-full max-w-full min-w-0 flex-col overflow-hidden"
          : "flex max-h-[480px] min-h-0 max-w-full min-w-0 flex-col overflow-hidden"
      }
    >
      {showPath && (
        <div className="border-border2 bg-bg1 text-fg2 shrink-0 truncate border-b px-3 py-2 font-mono text-xs">
          {path}
        </div>
      )}
      {/* @pierre owns visual-line measurement in overflow:"wrap" mode. This
          wrapper owns only the single remaining scroll axis. */}
      <div className="bg-sidebar-bg min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        {hasPatch ? (
          <PatchDiff patch={patch} options={options} disableWorkerPool />
        ) : (
          <div className="text-fg2 px-3 py-3 font-mono text-xs" role="status">
            {patch === undefined && loading
              ? "Loading changes…"
              : patch === undefined && error
                ? "Couldn’t load this diff."
                : "No textual diff to preview."}
          </div>
        )}
      </div>
    </section>
  );
});
