// ============================================
// COMPONENT: Design agent drafts on the canvas
// PURPOSE: Show a Local agent's in-flight frame edits as they stream
// USED IN: DesignCanvas (frame overlay, unregistered-file ghosts, status)
// ============================================
//
// The engine renders the content an agent's Write/Edit has streamed so far
// into a sanitized, script-free document (engine/design/agent-drafts.ts). It
// is shown here in a fully sandboxed iframe over the frame it will replace, or
// as a ghost frame while the file is not yet registered in meta/canvas.json.
// The live frame stays mounted beneath: once the tool reports success, the
// draft stays until that frame has painted the saved generation, so the hand-
// off never flashes the previous version or a blank buffer. A chip in the
// canvas chrome names every file being written, including stylesheets and the
// canvas document, reveals it on request and can follow the agent.

import { Check, ChevronUp, LoaderCircle, LocateFixed, ScanSearch } from "lucide-react";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DesignPageSummary } from "@zeros/protocol/design-pages";

import type { DesignCanvasFrameWire } from "../../platform/git";
import { cn } from "../../shared/ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { useSessionsStore } from "../agent/sessions-store";
import {
  DESIGN_CANVAS_INVERSE_ZOOM,
  designCanvasScreenPixels,
} from "./design-canvas-camera";
import { DesignToolbarButton } from "./design-inspector-kit";
import { useDesignSavedEditing } from "./design-saved-editing";
import {
  designAgentDraftPlacements,
  designAgentDraftsByFile,
  isDesignAgentCanvasDraftFile,
  retireDesignAgentDraft,
  setDesignAgentFollowing,
  useDesignAgentDrafts,
  useDesignAgentFollowStore,
  type DesignAgentDraftEntry,
} from "./state/design-agent-drafts";

/** Bounded wait for the saved generation before a settled draft retires. */
const DESIGN_AGENT_DRAFT_HANDOFF_MS = 6_000;
/** Unregistered saved drafts linger briefly after their turn ends. */
const DESIGN_AGENT_GHOST_TURN_END_MS = 3_000;
const MAX_DESIGN_AGENT_GHOSTS = 3;
const GHOST_GAP = 160;
const THEME_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

/** Apply the canvas theme the way the frame runtime does, as an attribute on
 * the document element. The draft document runs no script of its own. */
export function designAgentDraftThemeDocument(
  srcDoc: string,
  theme: string | null,
): string {
  if (!theme || !THEME_NAME.test(theme)) return srcDoc;
  const attribute = ` data-zd-theme="${theme}"`;
  const html = /<html\b([^>]*)>/i.exec(srcDoc);
  if (html) {
    const attributes = html[1]!.replace(/\sdata-zd-theme\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, "");
    return `${srcDoc.slice(0, html.index)}<html${attributes}${attribute}>${srcDoc.slice(html.index + html[0].length)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(srcDoc);
  const at = doctype ? doctype[0].length : 0;
  return `${srcDoc.slice(0, at)}<html${attribute}>${srcDoc.slice(at)}`;
}

/** Two immutable srcdoc buffers: a new revision loads beneath the shown one
 * and replaces it only after its own load, so streaming never blanks. */
interface DraftBuffer {
  revision: number;
  document: string;
}

const DesignAgentDraftDocument = React.memo(function DesignAgentDraftDocument({
  srcDoc,
  title,
}: {
  srcDoc: string;
  title: string;
}) {
  const revisionRef = useRef(0);
  const [buffers, setBuffers] = useState<{ shown: DraftBuffer | null; incoming: DraftBuffer | null }>(
    () => ({ shown: null, incoming: { revision: 0, document: srcDoc } }),
  );
  useEffect(() => {
    setBuffers((current) => {
      if (current.incoming?.document === srcDoc) return current;
      if (!current.incoming && current.shown?.document === srcDoc) return current;
      revisionRef.current += 1;
      return { shown: current.shown, incoming: { revision: revisionRef.current, document: srcDoc } };
    });
  }, [srcDoc]);
  const swapRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (swapRef.current !== null) cancelAnimationFrame(swapRef.current);
    },
    [],
  );
  const loaded = (revision: number) => {
    if (swapRef.current !== null) cancelAnimationFrame(swapRef.current);
    // One presentation frame lets the loaded buffer raster before it shows.
    swapRef.current = requestAnimationFrame(() => {
      swapRef.current = null;
      setBuffers((current) =>
        current.incoming?.revision === revision
          ? { shown: current.incoming, incoming: null }
          : current,
      );
    });
  };
  return (
    <>
      {[
        ...(buffers.shown ? [{ buffer: buffers.shown, role: "shown" as const }] : []),
        ...(buffers.incoming ? [{ buffer: buffers.incoming, role: "incoming" as const }] : []),
      ].map(({ buffer, role }) => (
        <iframe
          key={buffer.revision}
          // No allow-scripts: the draft document is inert markup and CSS.
          sandbox=""
          srcDoc={buffer.document}
          referrerPolicy="no-referrer"
          tabIndex={-1}
          aria-hidden
          title={title}
          data-design-agent-draft-buffer={role}
          className={cn(
            "bg-bg1 pointer-events-none absolute inset-0 block size-full border-0",
            role === "shown" ? "z-1" : "z-0",
          )}
          onLoad={role === "incoming" ? () => loaded(buffer.revision) : undefined}
        />
      ))}
    </>
  );
});

function phaseLabel(entry: DesignAgentDraftEntry): string {
  if (entry.savedAt !== null) return "Saved";
  return entry.draft.phase === "saving" ? "Saving" : "Agent writing";
}

/** Screen-sized status beside a frame's label, kept clear of the title. */
function DesignAgentDraftBadge({ entry }: { entry: DesignAgentDraftEntry }) {
  const saved = entry.savedAt !== null;
  return (
    <div
      data-design-agent-draft-status={saved ? "saved" : entry.draft.phase}
      className="pointer-events-none absolute right-0 bottom-full flex origin-bottom-right items-center"
      style={{
        transform: `translateY(${designCanvasScreenPixels(-8)}) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
      }}
    >
      <span className="border-border2 bg-bg1 text-fg2 text-2xxs inline-flex items-center gap-1 rounded-sm border px-1.5 leading-4 font-medium whitespace-nowrap">
        {saved ? (
          <Check aria-hidden className="size-3" />
        ) : (
          <LoaderCircle aria-hidden className="size-3 motion-safe:animate-spin" />
        )}
        {phaseLabel(entry)}
      </span>
    </div>
  );
}

/** The live document of a frame shows this generation, ready and swapped in. */
function displaysGeneration(element: Element | null, sourceVersion: string): boolean {
  const frame = element?.closest("[data-design-frame]");
  if (!frame) return false;
  for (const iframe of frame.querySelectorAll(
    'iframe[data-design-document-buffer="displayed"][data-design-document-ready]',
  )) {
    if (iframe.getAttribute("data-design-document-source-version") === sourceVersion)
      return true;
  }
  return false;
}

/** A registered frame's in-flight draft, over its live document. */
export const DesignAgentDraftFrameOverlay = React.memo(function DesignAgentDraftFrameOverlay({
  workspaceId,
  directory,
  frame,
  live,
  active,
  theme,
}: {
  workspaceId: string;
  directory: string | undefined;
  frame: DesignCanvasFrameWire;
  live: boolean;
  active: boolean;
  theme: string | null;
}) {
  const drafts = useDesignAgentDrafts(workspaceId);
  const { session: savedEditingSession, state: savedEditing } = useDesignSavedEditing();
  const entry = useMemo(
    () => designAgentDraftsByFile(drafts, directory).get(frame.file) ?? null,
    [directory, drafts, frame.file],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  // The generation shown when this draft first reached the frame. A newer
  // one is the saved file; a frame first seen after the save already is.
  const baseRef = useRef<{ id: string; sourceVersion: string; seenAt: number } | null>(null);
  if (entry && baseRef.current?.id !== entry.draft.id) {
    baseRef.current = {
      id: entry.draft.id,
      sourceVersion: frame.sourceVersion,
      seenAt: Date.now(),
    };
  }
  const savedAt = entry?.savedAt ?? null;
  const draftId = entry?.draft.id ?? null;
  const settled =
    savedAt !== null &&
    baseRef.current !== null &&
    (frame.sourceVersion !== baseRef.current.sourceVersion ||
      baseRef.current.seenAt >= savedAt);
  useLayoutEffect(() => {
    if (!active || savedAt === null || !draftId) return;
    const deadline = savedAt + DESIGN_AGENT_DRAFT_HANDOFF_MS;
    let handle = 0;
    let painted = false;
    const check = () => {
      handle = 0;
      if (Date.now() >= deadline) {
        retireDesignAgentDraft(workspaceId, draftId);
        return;
      }
      if (settled && (!live || displaysGeneration(rootRef.current, frame.sourceVersion))) {
        // Retire one frame after the saved buffer paints, never before.
        if (painted) {
          retireDesignAgentDraft(workspaceId, draftId);
          return;
        }
        painted = true;
      } else {
        painted = false;
      }
      handle = requestAnimationFrame(check);
    };
    handle = requestAnimationFrame(check);
    return () => {
      if (handle) cancelAnimationFrame(handle);
    };
  }, [active, draftId, frame.sourceVersion, live, savedAt, settled, workspaceId]);
  const srcDoc = entry?.preview?.srcDoc;
  const themed = useMemo(
    () => (srcDoc ? designAgentDraftThemeDocument(srcDoc, theme) : null),
    [srcDoc, theme],
  );
  useLayoutEffect(() => {
    if (!active || !themed || !savedEditingSession) return;
    return savedEditingSession.registerPreparation(() => {
      if (previewRef.current) previewRef.current.style.display = "none";
    });
  }, [active, savedEditingSession, themed]);
  if (!active || !entry) return null;
  return (
    <div ref={rootRef} data-design-agent-draft={entry.draft.id} className="contents">
      <DesignAgentDraftBadge entry={entry} />
      {themed && !savedEditing ? (
        <div ref={previewRef} className="pointer-events-none absolute inset-0 z-1 overflow-hidden">
          <DesignAgentDraftDocument srcDoc={themed} title={`${frame.title} draft`} />
        </div>
      ) : null}
    </div>
  );
});

interface DesignAgentGhostRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a not-yet-registered file's ghost sits: where an in-flight canvas
 * document places it, or else right of the page's frames (and of placed
 * ghosts), top-aligned, one after another. */
export function designAgentGhostRects(
  frames: readonly Pick<DesignCanvasFrameWire, "x" | "y" | "width" | "height">[],
  items: readonly {
    width: number;
    height: number;
    placement?: DesignAgentGhostRect | null;
  }[],
): DesignAgentGhostRect[] {
  const placed = items.flatMap((item) => (item.placement ? [item.placement] : []));
  const occupied = [...frames, ...placed];
  let x = occupied.length > 0 ? Math.max(...occupied.map((frame) => frame.x + frame.width)) + GHOST_GAP : 0;
  const tops = frames.length > 0 ? frames : placed;
  const y = tops.length > 0 ? Math.min(...tops.map((frame) => frame.y)) : 0;
  return items.map((item) => {
    if (item.placement) {
      const { x: left, y: top, width, height } = item.placement;
      return { x: left, y: top, width, height };
    }
    const rect = { x: Math.min(x, 1_000_000), y, width: item.width, height: item.height };
    x += item.width + GHOST_GAP;
    return rect;
  });
}

/** A saved file the agent never registered leaves once its turn ends. */
function GhostTurnEnd({
  workspaceId,
  entry,
}: {
  workspaceId: string;
  entry: DesignAgentDraftEntry;
}) {
  const chatId = entry.draft.chatId;
  const streaming = useSessionsStore((state) =>
    chatId ? state.sessions[chatId]?.status === "streaming" : false,
  );
  const draftId = entry.draft.id;
  const saved = entry.savedAt !== null;
  useEffect(() => {
    if (streaming || !saved) return;
    const timer = window.setTimeout(
      () => retireDesignAgentDraft(workspaceId, draftId),
      DESIGN_AGENT_GHOST_TURN_END_MS,
    );
    return () => window.clearTimeout(timer);
  }, [draftId, saved, streaming, workspaceId]);
  return null;
}

const DesignAgentDraftGhost = React.memo(function DesignAgentDraftGhost({
  workspaceId,
  entry,
  rect,
  title,
  theme,
}: {
  workspaceId: string;
  entry: DesignAgentDraftEntry;
  rect: DesignAgentGhostRect;
  title: string;
  theme: string | null;
}) {
  const name = entry.draft.file.split("/").at(-1)!;
  const srcDoc = entry.preview?.srcDoc ?? "";
  const themed = useMemo(() => designAgentDraftThemeDocument(srcDoc, theme), [srcDoc, theme]);
  return (
    <article
      data-design-agent-draft-ghost={entry.draft.file}
      aria-label={`${name}: ${phaseLabel(entry)}`}
      className="outline-border2 pointer-events-none absolute outline outline-dashed"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        outlineWidth: designCanvasScreenPixels(1),
      }}
    >
      <GhostTurnEnd workspaceId={workspaceId} entry={entry} />
      <div
        className="absolute bottom-full left-0 flex origin-bottom-left items-center"
        style={{
          maxWidth: `calc(${rect.width}px * var(--design-canvas-zoom))`,
          transform: `translateY(${designCanvasScreenPixels(-8)}) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
        }}
      >
        <span className="text-muted-fg text-2xxs block truncate leading-4 font-medium">
          {title}
        </span>
      </div>
      <DesignAgentDraftBadge entry={entry} />
      <div className="absolute inset-0 overflow-hidden">
        <DesignAgentDraftDocument srcDoc={themed} title={`${name} draft`} />
      </div>
    </article>
  );
});

export interface DesignAgentGhost {
  entry: DesignAgentDraftEntry;
  rect: DesignAgentGhostRect;
  title: string;
}

/** The ghosts the active page shows: drafts of its files the saved canvas does
 * not list yet, placed where an in-flight canvas document puts them. */
export function designAgentGhostLayout(
  drafts: Readonly<Record<string, DesignAgentDraftEntry>>,
  directory: string | null | undefined,
  pages: readonly DesignPageSummary[] | undefined,
  activePageId: string | null | undefined,
  frames: readonly Pick<DesignCanvasFrameWire, "x" | "y" | "width" | "height">[],
): DesignAgentGhost[] {
  if (!pages?.length) return [];
  const page = pages.find((candidate) => candidate.id === activePageId) ?? pages[0]!;
  const registered = new Set(pages.flatMap((candidate) => candidate.frameFiles));
  const placements = designAgentDraftPlacements(drafts, directory);
  const entries = [...designAgentDraftsByFile(drafts, directory).values()]
    .filter((entry) => {
      const file = entry.draft.file;
      if (registered.has(file) || !entry.preview) return false;
      const segments = file.split("/");
      return page.folder
        ? segments.length === 2 && segments[0] === page.folder
        : segments.length === 1;
    })
    .slice(0, MAX_DESIGN_AGENT_GHOSTS)
    .reverse();
  const rects = designAgentGhostRects(
    frames,
    entries.map((entry) => ({
      width: entry.preview!.width,
      height: entry.preview!.height,
      placement: placements.get(entry.draft.file) ?? null,
    })),
  );
  return entries.map((entry, index) => ({
    entry,
    rect: rects[index]!,
    title:
      placements.get(entry.draft.file)?.title ||
      entry.preview?.title ||
      entry.draft.file.split("/").at(-1)!,
  }));
}

/** Ghost frames for drafts of active-page files the canvas does not list yet. */
export const DesignAgentDraftGhosts = React.memo(function DesignAgentDraftGhosts({
  workspaceId,
  directory,
  pages,
  activePageId,
  frames,
  active,
  theme,
}: {
  workspaceId: string;
  directory: string | undefined;
  pages: readonly DesignPageSummary[] | undefined;
  activePageId: string | null | undefined;
  frames: readonly Pick<DesignCanvasFrameWire, "file" | "title" | "x" | "y" | "width" | "height">[];
  active: boolean;
  theme: string | null;
}) {
  const drafts = useDesignAgentDrafts(workspaceId);
  const ghosts = useMemo(
    () => (active ? designAgentGhostLayout(drafts, directory, pages, activePageId, frames) : []),
    [active, activePageId, directory, drafts, frames, pages],
  );
  return (
    <>
      {ghosts.map(({ entry, rect, title }) => (
        <DesignAgentDraftGhost
          key={entry.draft.id}
          workspaceId={workspaceId}
          entry={entry}
          rect={rect}
          title={title}
          theme={theme}
        />
      ))}
    </>
  );
});

/** Registered frames an agent is drafting, to rank with the selection for a
 * live runtime so the saved result paints in place. */
export function useDesignAgentDraftFrameFiles(
  workspaceId: string | null | undefined,
  directory: string | undefined,
): readonly string[] {
  const drafts = useDesignAgentDrafts(workspaceId);
  const files = [...designAgentDraftsByFile(drafts, directory).keys()]
    .filter((file) => /\.html$/i.test(file))
    .join("\0");
  return useMemo(() => (files ? files.split("\0") : []), [files]);
}

// ============================================
// COMPONENT: DesignAgentActivityChip
// PURPOSE: Name what a Local agent is writing on this canvas, reveal it on
//          request, and optionally follow it
// USED IN: DesignCanvas (bottom-centre chrome)
// ============================================

/** A saved draft no overlay hands off (a stylesheet, the canvas document,
 * another file, or a frame not on this page) leaves shortly after its save. */
const DESIGN_AGENT_DRAFT_SAVED_LINGER_MS = 1_500;

/** What Show reveals: frames of one page (switching to it first when it is
 * not the active page) and placed or ghost rectangles on the active page. */
export interface DesignAgentRevealTarget {
  pageId: string | null;
  files: string[];
  rects: DesignAgentGhostRect[];
}

interface DesignAgentCanvasContext {
  pages: readonly DesignPageSummary[] | undefined;
  activePageId: string | null | undefined;
  frames: readonly Pick<DesignCanvasFrameWire, "file" | "title">[];
  ghosts: readonly DesignAgentGhost[];
}

function activePage(context: Pick<DesignAgentCanvasContext, "pages" | "activePageId">) {
  return context.pages?.find((page) => page.id === context.activePageId) ?? context.pages?.[0] ?? null;
}

/** A person-readable name for a drafted file. */
export function designAgentDraftLabel(
  entry: DesignAgentDraftEntry,
  context: Pick<DesignAgentCanvasContext, "frames" | "ghosts">,
): string {
  const file = entry.draft.file;
  if (isDesignAgentCanvasDraftFile(file)) return "Canvas layout";
  const frame = context.frames.find((candidate) => candidate.file === file);
  if (frame?.title) return frame.title;
  const ghost = context.ghosts.find((candidate) => candidate.entry.draft.file === file);
  return ghost?.title || entry.preview?.title || file.split("/").at(-1)!;
}

/** Where Show takes the canvas for a drafted file, or null when it has no
 * place on the canvas (rules, components, assets). */
export function designAgentRevealTarget(
  entry: DesignAgentDraftEntry,
  context: DesignAgentCanvasContext,
  placements: ReadonlyMap<string, DesignAgentGhostRect & { file: string }>,
): DesignAgentRevealTarget | null {
  const file = entry.draft.file;
  const current = activePage(context);
  if (/\.html$/i.test(file)) {
    const owner = context.pages?.find((page) => page.frameFiles.includes(file));
    if (owner) return { pageId: owner.id, files: [file], rects: [] };
    const ghost = context.ghosts.find((candidate) => candidate.entry.draft.file === file);
    return ghost ? { pageId: current?.id ?? null, files: [], rects: [ghost.rect] } : null;
  }
  if (/\.css$/i.test(file)) {
    const segments = file.split("/");
    const page =
      segments.length === 2 ? context.pages?.find((candidate) => candidate.folder === segments[0]) : current;
    return page && page.frameFiles.length > 0
      ? { pageId: page.id, files: [...page.frameFiles], rects: [] }
      : null;
  }
  if (isDesignAgentCanvasDraftFile(file) && current) {
    const rects = [...placements.values()].filter((placement) =>
      current.folder ? placement.file.startsWith(`${current.folder}/`) : !placement.file.includes("/"),
    );
    return rects.length > 0 ? { pageId: current.id, files: [], rects } : null;
  }
  return null;
}

/** When a saved draft nothing on the canvas hands off should leave, or null
 * while it stays (streaming, or handed off by a frame overlay or ghost). */
export function designAgentDraftRetireAt(
  entry: DesignAgentDraftEntry,
  context: Pick<DesignAgentCanvasContext, "pages" | "activePageId">,
): number | null {
  if (entry.savedAt === null) return null;
  const file = entry.draft.file;
  const settled = entry.savedAt + DESIGN_AGENT_DRAFT_SAVED_LINGER_MS;
  if (isDesignAgentCanvasDraftFile(file)) {
    // Hold the placements until the saved canvas registers every frame, so
    // a ghost never jumps back before its frame appears.
    const registered = new Set(context.pages?.flatMap((page) => page.frameFiles) ?? []);
    return (entry.registrations ?? []).every((registration) => registered.has(registration.file))
      ? settled
      : entry.savedAt + DESIGN_AGENT_DRAFT_HANDOFF_MS;
  }
  if (!/\.html$/i.test(file)) return settled;
  // An active-page frame's overlay or ghost hands its draft off itself.
  const current = activePage(context);
  if (!current) return settled;
  if (current.frameFiles.includes(file)) return null;
  const segments = file.split("/");
  const onPage = current.folder
    ? segments.length === 2 && segments[0] === current.folder
    : segments.length === 1;
  const registeredElsewhere = context.pages?.some((page) => page.frameFiles.includes(file));
  return onPage && !registeredElsewhere ? null : settled;
}

export const DesignAgentActivityChip = React.memo(function DesignAgentActivityChip({
  workspaceId,
  directory,
  pages,
  activePageId,
  frames,
  active,
  motionOpen,
  onReveal,
}: {
  workspaceId: string;
  directory: string | undefined;
  pages: readonly DesignPageSummary[] | undefined;
  activePageId: string | null | undefined;
  frames: readonly Pick<DesignCanvasFrameWire, "file" | "title" | "x" | "y" | "width" | "height">[];
  /** Hidden retained canvases show, follow and retire nothing. */
  active: boolean;
  motionOpen: boolean;
  onReveal: (target: DesignAgentRevealTarget) => void;
}) {
  const drafts = useDesignAgentDrafts(workspaceId);
  const following = useDesignAgentFollowStore((state) => Boolean(state.following[workspaceId]));
  const entries = useMemo(
    () => [...designAgentDraftsByFile(drafts, directory).values()],
    [directory, drafts],
  );
  const ghosts = useMemo(
    () => designAgentGhostLayout(drafts, directory, pages, activePageId, frames),
    [activePageId, directory, drafts, frames, pages],
  );
  const placements = useMemo(() => {
    const byFile = new Map<string, DesignAgentGhostRect & { file: string }>();
    for (const [file, placement] of designAgentDraftPlacements(drafts, directory))
      byFile.set(file, { file, x: placement.x, y: placement.y, width: placement.width, height: placement.height });
    return byFile;
  }, [directory, drafts]);
  const context = useMemo(
    () => ({ pages, activePageId, frames, ghosts }),
    [activePageId, frames, ghosts, pages],
  );

  // Retire saved drafts nothing on this canvas hands off.
  useEffect(() => {
    if (!active) return;
    const due = entries.flatMap((entry) => {
      const at = designAgentDraftRetireAt(entry, context);
      return at === null ? [] : [{ id: entry.draft.id, at }];
    });
    if (due.length === 0) return;
    const next = Math.min(...due.map((item) => item.at));
    const timer = window.setTimeout(() => {
      const now = Date.now();
      for (const item of due) if (item.at <= now) retireDesignAgentDraft(workspaceId, item.id);
    }, Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [active, context, entries, workspaceId]);

  const primary = entries[0] ?? null;
  const primaryTarget = primary ? designAgentRevealTarget(primary, context, placements) : null;
  // Following reveals each new draft once; the camera stays the person's
  // between drafts.
  const followedRef = useRef<string | null>(null);
  const primaryId = primary?.draft.id ?? null;
  useEffect(() => {
    if (!active || !following || !primaryId || followedRef.current === primaryId) return;
    if (!primaryTarget) return;
    followedRef.current = primaryId;
    onReveal(primaryTarget);
  }, [active, following, onReveal, primaryId, primaryTarget]);

  if (!active || !primary) return null;
  const saved = primary.savedAt !== null;
  const status = saved ? "Saved" : primary.draft.phase === "saving" ? "Saving" : "Writing";
  const label = designAgentDraftLabel(primary, context);
  return (
    <div
      role="group"
      aria-label="Agent activity"
      data-design-agent-activity=""
      data-design-controls=""
      data-motion-open={motionOpen ? "" : undefined}
      className="zd-design-floating-toolbar zd-design-agent-activity absolute z-chrome flex items-center"
    >
      <span role="status" className="zd-design-agent-activity-status">
        {saved ? (
          <Check aria-hidden="true" />
        ) : (
          <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
        )}
        <span className="min-w-0 truncate" data-design-agent-activity-label="">
          {status} {label}
        </span>
      </span>
      {entries.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <DesignToolbarButton
              label={`All ${entries.length} files the agent is writing`}
              tooltip={`${entries.length - 1} more`}
              tooltipSide="top"
              data-design-agent-activity-more=""
            >
              <ChevronUp />
            </DesignToolbarButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="center" className="max-w-sm">
            {entries.map((entry) => {
              const target = designAgentRevealTarget(entry, context, placements);
              const entryStatus =
                entry.savedAt !== null ? "Saved" : entry.draft.phase === "saving" ? "Saving" : "Writing";
              return (
                <DropdownMenuItem
                  key={entry.draft.id}
                  disabled={!target}
                  onSelect={() => target && onReveal(target)}
                >
                  <span className="min-w-0 flex-1 truncate">{designAgentDraftLabel(entry, context)}</span>
                  <span className="text-muted-fg text-3xxs">{entryStatus}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <span className="zd-canvas-toolbar-divider" aria-hidden="true" />
      <DesignToolbarButton
        label="Show in canvas"
        tooltip={primaryTarget ? `Show ${label}` : "Not on the canvas"}
        tooltipSide="top"
        disabled={!primaryTarget}
        data-design-agent-activity-show=""
        onClick={() => primaryTarget && onReveal(primaryTarget)}
      >
        <ScanSearch />
      </DesignToolbarButton>
      <DesignToolbarButton
        label="Follow the agent"
        tooltip={following ? "Stop following" : "Follow agent"}
        tooltipSide="top"
        pressed={following}
        data-design-agent-activity-follow=""
        onClick={() => {
          followedRef.current = following ? followedRef.current : null;
          setDesignAgentFollowing(workspaceId, !following);
        }}
      >
        <LocateFixed />
      </DesignToolbarButton>
    </div>
  );
});
