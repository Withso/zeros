import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { Image, LoaderCircle, MessageSquarePlus, Video, X } from "lucide-react";
import type { SimulatorCapture } from "@zeros/protocol/simulator-captures";

import { useWorkspaceStore } from "../../state/store";
import { cn } from "../../shared/ui/cn";
import { usePrefersReducedMotion } from "../../shared/ui/loading/use-prefers-reduced-motion";
import { useNativeSurfaceOverlayIntent } from "../../shared/ui/native-surface-overlay";
import { TOAST_OFFSET_PX, useToastReach } from "../../shared/ui/primitives/elements";
import { IconButton } from "../../shared/ui/primitives/icon-button";
import { Toolbar } from "../../shared/ui/primitives/toolbar";
import { Tooltip } from "../../shared/ui/primitives/tooltip";
import { useBrowserAgentPipSurface } from "../browser/browser-float-store";
import { addSimulatorCaptureToChat, dragSimulatorCaptureFile } from "./simulator-capture-actions";
import {
  captureCardLabel,
  captureLabel,
  captureStackLayout,
  captureThumbnailSize,
  formatRecordingElapsed,
} from "./simulator-capture-model";
import { captureThumbnails, useCaptureThumbnails } from "./simulator-capture-store";
import type { Size } from "./simulator-geometry";

/** Space kept between the thumbnails and a toast or picture in picture under
 * them. */
const CORNER_GAP_PX = 12;
/** A native drag that never reports back lets go of the thumbnails after
 * this long. */
const DRAG_HOLD_MS = 30_000;
const ARRIVE_MS = 200;

const CARD_LAYERS = ["z-2", "z-1", "z-0"] as const;

/** How far above the window's bottom edge `element` reaches. */
function useReachFromBottom(element: HTMLElement | null): number {
  const [reach, setReach] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const next = Math.max(0, Math.round(window.innerHeight - element.getBoundingClientRect().top));
      setReach((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [element]);
  return element ? reach : 0;
}

function CaptureCard({
  capture,
  size,
  lift,
  scale,
  layer,
  onDragStart,
}: {
  capture: SimulatorCapture;
  size: Size;
  lift: number;
  scale: number;
  layer: (typeof CARD_LAYERS)[number];
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const card = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const label = captureLabel(capture);
  const KindIcon = capture.kind === "screenshot" ? Image : Video;

  // A new thumbnail slides in from the window's edge, as on macOS.
  useLayoutEffect(() => {
    if (reducedMotion) return;
    const animation = card.current?.animate(
      [{ translate: `calc(100% + ${TOAST_OFFSET_PX}px) 0` }, { translate: "0 0" }],
      { duration: ARRIVE_MS, easing: "ease-out" },
    );
    return () => animation?.cancel();
  }, [reducedMotion]);

  const add = () => {
    if (adding) return;
    setAdding(true);
    void addSimulatorCaptureToChat(capture, useWorkspaceStore.getState().activeChatId).finally(
      () => setAdding(false),
    );
  };

  return (
    <div
      ref={card}
      role="group"
      aria-label={captureCardLabel(capture)}
      data-simulator-capture={capture.kind}
      draggable
      onDragStart={onDragStart}
      className={cn(
        "group/capture ring-border2 bg-bg1 absolute right-0 bottom-0 origin-bottom-right cursor-grab overflow-hidden rounded-lg shadow-[var(--shadow-dropdown)] ring-1",
        "duration-200 ease-out motion-safe:transition-transform",
        layer,
      )}
      style={{
        width: size.width,
        height: size.height,
        transform: `translateY(${-lift}px) scale(${scale})`,
      }}
    >
      {capture.thumbnail ? (
        <img
          src={capture.thumbnail}
          alt=""
          draggable={false}
          className="pointer-events-none block size-full object-cover"
        />
      ) : (
        <div className="flex size-full items-center justify-center">
          <KindIcon aria-hidden strokeWidth={1.5} className="text-fg3 size-6" />
        </div>
      )}
      {capture.kind === "recording" && capture.durationMs !== undefined && (
        <span
          aria-hidden
          className="border-border2 bg-bg2 text-fg1 text-2xxs pointer-events-none absolute bottom-1 left-1 flex items-center gap-1 rounded-sm border px-1 tabular-nums"
        >
          <Video className="size-3" />
          {formatRecordingElapsed(capture.durationMs)}
        </span>
      )}
      <div className="pointer-events-none absolute inset-x-1 top-1 flex justify-end">
        <Toolbar
          aria-label={`${label} actions`}
          className={cn(
            "pointer-events-none p-0.5 opacity-0 transition-opacity duration-150",
            "group-hover/capture:pointer-events-auto group-hover/capture:opacity-100",
            "group-focus-within/capture:pointer-events-auto group-focus-within/capture:opacity-100",
          )}
        >
          <Tooltip label="Attach capture">
            <IconButton
              size="compact"
              label="Add to chat"
              aria-busy={adding || undefined}
              disabled={adding}
              onClick={add}
            >
              {adding ? (
                <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
              ) : (
                <MessageSquarePlus aria-hidden />
              )}
            </IconButton>
          </Tooltip>
          <IconButton
            size="compact"
            label="Close"
            onClick={() => captureThumbnails.dismiss(capture.id)}
          >
            <X aria-hidden />
          </IconButton>
        </Toolbar>
      </div>
    </div>
  );
}

function ShownCaptures({ captures }: { captures: readonly SimulatorCapture[] }) {
  const stack = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const held = hovered || focused || dragging;

  useEffect(() => (held ? captureThumbnails.hold() : undefined), [held]);

  // Native views composite above the page, so a browser in the corner steps
  // aside while thumbnails show, as it does for toasts.
  const overlay = useNativeSurfaceOverlayIntent();
  useLayoutEffect(() => overlay(true), [overlay]);

  // Main starts a native drag of the saved file, which the page never hears
  // end; the next move with no button down means it has.
  useEffect(() => {
    if (!dragging) return;
    const end = (event: Event) => {
      if (event instanceof PointerEvent && event.type === "pointermove" && event.buttons !== 0) {
        return;
      }
      setDragging(false);
      setHovered(event.target instanceof Node && !!stack.current?.contains(event.target));
    };
    const timer = window.setTimeout(() => setDragging(false), DRAG_HOLD_MS);
    window.addEventListener("pointermove", end, true);
    window.addEventListener("pointerdown", end, true);
    window.addEventListener("drop", end, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", end, true);
      window.removeEventListener("pointerdown", end, true);
      window.removeEventListener("drop", end, true);
    };
  }, [dragging]);

  const toastReach = useToastReach();
  const pip = useBrowserAgentPipSurface();
  const pipReach = useReachFromBottom(pip);
  const resting = Math.max(
    TOAST_OFFSET_PX,
    toastReach > 0 ? toastReach + CORNER_GAP_PX : 0,
    pipReach > 0 ? pipReach + CORNER_GAP_PX : 0,
  );
  // Held thumbnails stay put under the pointer as toasts come and go.
  const placed = useRef(resting);
  if (!held) placed.current = resting;

  const sizes = captures.map(captureThumbnailSize);
  const layout = captureStackLayout(sizes, held);

  return (
    <div
      ref={stack}
      role="region"
      aria-label="Captures"
      data-simulator-captures={held ? "spread" : "stacked"}
      className="z-chrome fixed right-6"
      style={{ bottom: placed.current, width: layout.width, height: layout.height }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        if (!dragging) setHovered(false);
      }}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocused(false);
      }}
    >
      {captures.map((capture, index) => (
        <CaptureCard
          key={capture.id}
          capture={capture}
          size={sizes[index]!}
          lift={layout.lifts[index]!}
          scale={layout.scales[index]!}
          layer={CARD_LAYERS[index] ?? "z-0"}
          onDragStart={(event) => {
            // The page's own drag would carry only a picture; main's carries
            // the file.
            event.preventDefault();
            setDragging(true);
            dragSimulatorCaptureFile(capture);
          }}
        />
      ))}
    </div>
  );
}

/** Thumbnails of the screenshots and recordings the user just made, at the
 * window's bottom right and clear of the toasts. Each leaves after a few
 * seconds unless the pointer or focus is on them; dragging one drops its
 * file, and Add to chat puts it in the open chat's composer. */
export function SimulatorCaptureStack() {
  const captures = useCaptureThumbnails();
  const newest = captures[0];
  return (
    <>
      <span className="sr-only" aria-live="polite">
        {newest ? `${captureLabel(newest)} saved to Downloads.` : ""}
      </span>
      {newest && <ShownCaptures captures={captures} />}
    </>
  );
}
