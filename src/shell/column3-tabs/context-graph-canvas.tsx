// ============================================
// COMPONENT: ContextGraphCanvas
// PURPOSE: Lightweight pan/zoom canvas over the workspace's .context-graph —
//          auto-laid-out cards (attachments + docs) the user can look around
//          but never drag. Pan: drag / trackpad scroll / space+drag. Zoom:
//          pinch or ⌘/Ctrl+scroll, anchored at the cursor.
// USED IN: ContextRow1Tab (the pinned Context tab body)
// ============================================

// --- IMPORTS ---
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { File as FileIcon, FileText, Image as ImageIcon } from "lucide-react";

import type { ContextGraphItemWire } from "@/native/context-graph";
import { readWorkspaceFile } from "@/native/files";
import { Checkbox, Tooltip } from "@/zeros/ui/primitives";

// --- TYPES ---

interface ContextGraphCanvasProps {
  /** Workspace folder the items belong to (image reads resolve against it). */
  cwd: string;
  /** Canvas cards, already sorted oldest-first (stable slots). */
  items: ContextGraphItemWire[];
  /** Only the visible tab binds wheel/key listeners and loads images. */
  active: boolean;
  /** Share-checkbox commit; resolves when the engine finished the move. */
  onToggleShared: (attachmentId: string, shared: boolean) => Promise<void>;
  /** Attachment ids with an in-flight toggle (checkbox disabled). */
  pendingToggles: ReadonlySet<string>;
}

/** One placed card: the item plus its canvas-space slot. */
interface PlacedItem {
  item: ContextGraphItemWire;
  x: number;
  y: number;
}

/** A category band's floating label. */
interface SectionLabel {
  key: string;
  label: string;
  x: number;
  y: number;
}

export interface ContextGraphLayout {
  placed: PlacedItem[];
  sections: SectionLabel[];
  /** Canvas-space bounding size, used by the fit-to-view math. */
  width: number;
  height: number;
}

// --- LAYOUT CONSTANTS ---
// Card geometry is fixed so layout is pure math (no measure pass): slots are
// generous enough to absorb the tallest card plus the deterministic jitter.
const CARD_W = 224;
const SLOT_X = 312;
const SLOT_Y = 296;
const JITTER_X = 26;
const JITTER_Y = 34;
const SECTION_HEADER_H = 44;
const SECTION_GAP = 96;
const CANVAS_PAD = 96;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
/** Wheel-tick zoom sensitivity — matches the Browser tab's canvas mode. */
const ZOOM_SENSITIVITY = 0.005;

// --- LAYOUT ---

/** Deterministic per-path jitter so the grid reads as a loose canvas rather
 *  than a table, without positions shifting between renders or sessions. */
function jitterFor(seed: string): { dx: number; dy: number } {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = ((h >>> 0) % 1000) / 1000;
  const b = ((h >>> 10) % 1000) / 1000;
  return {
    dx: Math.round((a * 2 - 1) * JITTER_X),
    dy: Math.round((b * 2 - 1) * JITTER_Y),
  };
}

/** Auto-place items: attachments band first, docs band below. Items are never
 *  user-movable, so the layout is a pure function of the (stable-sorted) list
 *  — new items take the next slot instead of reshuffling the canvas. */
export function computeContextGraphLayout(
  items: ContextGraphItemWire[],
): ContextGraphLayout {
  const attachments = items.filter((i) => i.category === "attachment");
  const docs = items.filter((i) => i.category !== "attachment");
  const placed: PlacedItem[] = [];
  const sections: SectionLabel[] = [];
  const showHeaders = attachments.length > 0 && docs.length > 0;
  let cursorY = CANVAS_PAD;
  let width = 0;

  const placeBand = (band: ContextGraphItemWire[], label: string) => {
    if (band.length === 0) return;
    if (showHeaders) {
      sections.push({ key: label, label, x: CANVAS_PAD, y: cursorY });
      cursorY += SECTION_HEADER_H;
    }
    const cols = Math.max(3, Math.min(6, Math.ceil(Math.sqrt(band.length * 1.6))));
    band.forEach((item, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const { dx, dy } = jitterFor(item.relPath);
      placed.push({
        item,
        x: CANVAS_PAD + col * SLOT_X + dx,
        y: cursorY + row * SLOT_Y + dy,
      });
    });
    const rows = Math.ceil(band.length / cols);
    width = Math.max(width, CANVAS_PAD * 2 + (cols - 1) * SLOT_X + CARD_W);
    cursorY += rows * SLOT_Y + SECTION_GAP;
  };

  placeBand(attachments, "Attachments");
  placeBand(docs, "Docs");

  return {
    placed,
    sections,
    width: Math.max(width, CANVAS_PAD * 2 + CARD_W),
    height: Math.max(cursorY - SECTION_GAP + CANVAS_PAD, CANVAS_PAD * 2),
  };
}

// --- IMAGE CACHE ---
// Small module-level LRU of decoded data URLs so revisiting the tab (or
// panning back to a card) doesn't re-read the file. Deliberately NOT the
// shared workspace-file-data-cache: a graph can hold hundreds of images and
// subscribed entries there are unevictable — this cache caps by count and
// skips oversized payloads instead.
const imageUrlCache = new Map<string, string | null>();
const IMAGE_CACHE_MAX = 40;
const IMAGE_CACHE_MAX_URL_LENGTH = 2_000_000;

function cacheImageUrl(key: string, url: string | null): void {
  if (url && url.length > IMAGE_CACHE_MAX_URL_LENGTH) return;
  imageUrlCache.delete(key);
  imageUrlCache.set(key, url);
  while (imageUrlCache.size > IMAGE_CACHE_MAX) {
    const oldest = imageUrlCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    imageUrlCache.delete(oldest);
  }
}

// --- COMPONENT ---

export function ContextGraphCanvas({
  cwd,
  items,
  active,
  onToggleShared,
  pendingToggles,
}: ContextGraphCanvasProps) {
  // --- STATE ---
  // Space bar held → hand-tool affordance (pan still works without it; the
  // key exists because muscle memory from design tools expects it).
  const [spaceHeld, setSpaceHeld] = useState(false);

  // Scroll container element — wheel/pointer listeners + fit math live here.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Transformed content element — pan/zoom writes its transform directly.
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Zoom readout element — textContent is written directly per apply().
  const zoomPillRef = useRef<HTMLButtonElement | null>(null);
  // The viewport (canvas → screen): translate + uniform scale. A ref, not
  // state: pan/zoom mutates it at pointer-move rate and paints via rAF —
  // React re-renders would make the canvas feel like a spreadsheet.
  const vp = useRef({ x: 0, y: 0, scale: 1 });
  // Pending rAF handle so a burst of wheel events paints once per frame.
  const rafHandle = useRef<number | null>(null);
  // True while a drag-pan is active (drives the grabbing cursor).
  const panningRef = useRef(false);
  // The folder whose content was last auto-fit — refit only on real change.
  const fittedForRef = useRef<string | null>(null);

  const layout = useMemo(() => computeContextGraphLayout(items), [items]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // --- WORKFLOWS ---

  /** Paint vp onto the content element (compositor-only transform write). */
  const apply = useCallback(() => {
    const el = contentRef.current;
    if (el) {
      const { x, y, scale } = vp.current;
      el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    }
    const pill = zoomPillRef.current;
    if (pill) pill.textContent = `${Math.round(vp.current.scale * 100)}%`;
  }, []);

  const scheduleApply = useCallback(() => {
    if (rafHandle.current != null) return;
    rafHandle.current = requestAnimationFrame(() => {
      rafHandle.current = null;
      apply();
    });
  }, [apply]);

  /** Center the whole graph in the viewport at a comfortable zoom. */
  const fitToView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    const { width, height } = layoutRef.current;
    const scale = Math.min(
      1,
      Math.max(MIN_ZOOM, Math.min(rect.width / width, rect.height / height)),
    );
    vp.current = {
      x: (rect.width - width * scale) / 2,
      y: Math.max((rect.height - height * scale) / 2, 12),
      scale,
    };
    apply();
  }, [apply]);

  // --- EVENT HANDLERS ---

  /** Drag anywhere (cards aren't movable) = pan. Interactive card controls
   *  opt out via data-context-card-control. */
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    const hit = e.target as HTMLElement;
    if (hit.closest("[data-context-card-control]")) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    panningRef.current = true;
    target.dataset.panning = "true";
    const startX = e.clientX;
    const startY = e.clientY;
    const startVX = vp.current.x;
    const startVY = vp.current.y;
    const onMove = (ev: PointerEvent) => {
      vp.current.x = startVX + (ev.clientX - startX);
      vp.current.y = startVY + (ev.clientY - startY);
      scheduleApply();
    };
    const onUp = () => {
      panningRef.current = false;
      delete target.dataset.panning;
      try {
        target.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }, [scheduleApply]);

  // Wheel: pinch (ctrlKey) and ⌘/Ctrl+scroll zoom to the cursor — the
  // "everything flows out from under your fingers" feel — while a plain
  // two-finger scroll pans. passive:false is required for preventDefault.
  useEffect(() => {
    if (!active) return;
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = vp.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const next = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, v.scale * (1 - e.deltaY * ZOOM_SENSITIVITY)),
        );
        if (next === v.scale) return;
        // Anchor the logical point under the cursor: same screen position
        // before and after the scale change.
        const k = next / v.scale;
        v.x = cx - (cx - v.x) * k;
        v.y = cy - (cy - v.y) * k;
        v.scale = next;
      } else {
        v.x -= e.deltaX;
        v.y -= e.deltaY;
      }
      scheduleApply();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [active, scheduleApply]);

  // Space-key tracking — active tab only, never while typing, and ONLY while
  // the pointer is over the canvas. Unlike the Browser tab's transient canvas
  // mode, this surface is ALWAYS a canvas, so an unconditional preventDefault
  // would permanently swallow Space-activation of focused buttons and
  // Space-to-scroll everywhere else in the window (review 2026-08-02 #1).
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.matches("input, textarea, [contenteditable]")) return;
      if (!viewportRef.current?.matches(":hover")) return;
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      setSpaceHeld(false);
    };
  }, [active]);

  // First fit: when the tab first shows content for this folder (or the
  // folder changes), frame everything. Panned/zoomed state then survives tab
  // switches — the body stays mounted like Changes/Review.
  useEffect(() => {
    if (!active || items.length === 0) return;
    if (fittedForRef.current === cwd) return;
    fittedForRef.current = cwd;
    // One tick so the viewport has its layout rect on first mount.
    const t = window.setTimeout(fitToView, 0);
    return () => window.clearTimeout(t);
  }, [active, cwd, items.length, fitToView]);

  // Re-assert the transform + zoom readout after EVERY commit: React owns the
  // pill's text child and the content div's style prop, so an unrelated
  // re-render (a checkbox toggle, fresh items) would otherwise reset the pill
  // to its literal "100%" while the canvas sits at another scale.
  useEffect(() => {
    apply();
  });

  // Cancel any queued paint on unmount.
  useEffect(
    () => () => {
      if (rafHandle.current != null) cancelAnimationFrame(rafHandle.current);
    },
    [],
  );

  // --- RENDER ---
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div
        ref={viewportRef}
        onPointerDown={onPointerDown}
        data-space-held={spaceHeld || undefined}
        className="bg-bg1 relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden select-none data-[panning]:cursor-grabbing data-[space-held]:cursor-grab"
        role="application"
        aria-label="Context canvas"
      >
        <div
          ref={contentRef}
          className="absolute top-0 left-0 origin-top-left will-change-transform"
          // Runtime-computed canvas extent; transform is written directly.
          style={{ width: layout.width, height: layout.height }}
        >
          {layout.sections.map((s) => (
            <div
              key={s.key}
              className="text-fg3 absolute text-2xxs font-medium tracking-wide uppercase"
              style={{ left: s.x, top: s.y }}
            >
              {s.label}
            </div>
          ))}
          {layout.placed.map(({ item, x, y }) => (
            <ContextGraphCard
              key={`${item.scope}|${item.relPath}`}
              cwd={cwd}
              item={item}
              x={x}
              y={y}
              active={active}
              viewportRef={viewportRef}
              onToggleShared={onToggleShared}
              togglePending={
                !!item.attachmentId && pendingToggles.has(item.attachmentId)
              }
            />
          ))}
        </div>
        <button
          ref={zoomPillRef}
          type="button"
          data-context-card-control=""
          onClick={fitToView}
          className="text-fg2 bg-bg2 border-border1 hover:bg-bg2-hover hover:text-fg1 absolute right-3 bottom-3 h-6 rounded-sm border px-2 text-2xxs tabular-nums"
          aria-label="Zoom level — click to fit the canvas"
        >
          100%
        </button>
      </div>
    </div>
  );
}

// ── Cards ──────────────────────────────────────────────────

interface CardProps {
  cwd: string;
  item: ContextGraphItemWire;
  x: number;
  y: number;
  active: boolean;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  onToggleShared: (attachmentId: string, shared: boolean) => Promise<void>;
  togglePending: boolean;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

const ContextGraphCard = React.memo(function ContextGraphCard({
  cwd,
  item,
  x,
  y,
  active,
  viewportRef,
  onToggleShared,
  togglePending,
}: CardProps) {
  const isImage = item.kind === "image";
  return (
    <div
      className="bg-bg2 border-border1 absolute flex flex-col overflow-hidden rounded-lg border"
      // Runtime-computed slot from the auto-layout.
      style={{ left: x, top: y, width: CARD_W }}
    >
      {isImage ? (
        <ImageCardMedia
          cwd={cwd}
          item={item}
          active={active}
          viewportRef={viewportRef}
        />
      ) : (
        <TextCardBody item={item} />
      )}
      <div className="border-border1 flex min-w-0 items-center gap-1.5 border-t px-2.5 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-fg1 truncate text-2xxs font-medium">
            {item.name}
          </div>
          <div className="text-fg3 truncate text-xxs">
            {item.category === "attachment" ? "Attachment" : "Doc"} ·{" "}
            {formatBytes(item.bytes)}
          </div>
        </div>
        {item.attachmentId && (
          <Tooltip label="Checked = shared in the repo (not gitignored)">
            <label
              data-context-card-control=""
              className="text-fg2 flex shrink-0 cursor-pointer items-center gap-1 text-xxs"
            >
              <Checkbox
                checked={item.scope === "shared"}
                disabled={togglePending}
                onChange={() =>
                  void onToggleShared(
                    item.attachmentId!,
                    item.scope !== "shared",
                  )
                }
                aria-label={`Share ${item.name} in the repo`}
              />
              Shared
            </label>
          </Tooltip>
        )}
      </div>
    </div>
  );
});

/** Markdown / text / other body: the monospace preview owns the whole area
 *  (the footer already carries the filename); icon fallback without one. */
function TextCardBody({ item }: { item: ContextGraphItemWire }) {
  const Icon =
    item.kind === "markdown" || item.kind === "text" ? FileText : FileIcon;
  return (
    <div className="flex h-[148px] min-h-0 flex-col px-2.5 pt-2.5">
      {item.previewText ? (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <pre className="text-fg2 font-mono text-xxs leading-[1.5] whitespace-pre-wrap">
            {item.previewText}
          </pre>
          {/* Same tokened gradient fade the tab strip uses for long titles —
              the preview trails off instead of hitting a hard clip. */}
          <div className="from-bg2 pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t to-transparent" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Icon className="text-fg3 size-7" />
        </div>
      )}
    </div>
  );
}

/** Image media: lazy-loads the bytes only when the card scrolls into view
 *  (IntersectionObserver against the canvas viewport) and only while the tab
 *  is active — a hidden retained tab must not fire reads. */
function ImageCardMedia({
  cwd,
  item,
  active,
  viewportRef,
}: Omit<CardProps, "x" | "y" | "onToggleShared" | "togglePending">) {
  const cacheKey = `${cwd}|${item.relPath}|${item.mtimeMs}`;
  // Resolved data URL: undefined = not loaded yet, null = unrenderable
  // (too large / binary / read failure) → icon fallback.
  const [url, setUrl] = useState<string | null | undefined>(() =>
    imageUrlCache.has(cacheKey) ? imageUrlCache.get(cacheKey) : undefined,
  );
  // The media element the observer watches.
  const mediaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active || url !== undefined) return;
    const el = mediaRef.current;
    const root = viewportRef.current;
    if (!el || !root) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await readWorkspaceFile(cwd, item.relPath);
        const next = res?.kind === "image" && res.dataUrl ? res.dataUrl : null;
        cacheImageUrl(cacheKey, next);
        if (!cancelled) setUrl(next);
      } catch {
        // Transport hiccup: leave `undefined` so a later pass retries.
      }
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          io.disconnect();
          void load();
        }
      },
      { root, rootMargin: "384px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [active, url, cacheKey, cwd, item.relPath, viewportRef]);

  return (
    <div
      ref={mediaRef}
      className="bg-bg2-hover flex h-[148px] items-center justify-center overflow-hidden"
    >
      {url ? (
        <img
          src={url}
          alt={item.name}
          draggable={false}
          className="h-full w-full object-cover"
        />
      ) : (
        <ImageIcon className="text-fg3 size-7" />
      )}
    </div>
  );
}
