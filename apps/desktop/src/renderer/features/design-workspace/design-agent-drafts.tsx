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
// off never flashes the previous version or a blank buffer.

import { Check, LoaderCircle } from "lucide-react";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DesignPageSummary } from "@zeros/protocol/design-pages";

import type { DesignCanvasFrameWire } from "../../platform/git";
import { cn } from "../../shared/ui/cn";
import { useSessionsStore } from "../agent/sessions-store";
import {
  DESIGN_CANVAS_INVERSE_ZOOM,
  designCanvasScreenPixels,
} from "./design-canvas-camera";
import {
  designAgentDraftsByFile,
  retireDesignAgentDraft,
  useDesignAgentDrafts,
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
  const entry = useMemo(
    () => designAgentDraftsByFile(drafts, directory).get(frame.file) ?? null,
    [directory, drafts, frame.file],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
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
  if (!active || !entry) return null;
  return (
    <div ref={rootRef} data-design-agent-draft={entry.draft.id} className="contents">
      <DesignAgentDraftBadge entry={entry} />
      {themed ? (
        <div className="pointer-events-none absolute inset-0 z-1 overflow-hidden">
          <DesignAgentDraftDocument srcDoc={themed} title={`${frame.title} draft`} />
        </div>
      ) : null}
    </div>
  );
});

/** Where a not-yet-registered file's ghost sits: right of the page's frames,
 * top-aligned, one after another. */
export function designAgentGhostRects(
  frames: readonly Pick<DesignCanvasFrameWire, "x" | "y" | "width" | "height">[],
  sizes: readonly { width: number; height: number }[],
): Array<{ x: number; y: number; width: number; height: number }> {
  let x = frames.length > 0 ? Math.max(...frames.map((frame) => frame.x + frame.width)) + GHOST_GAP : 0;
  const y = frames.length > 0 ? Math.min(...frames.map((frame) => frame.y)) : 0;
  return sizes.map((size) => {
    const rect = { x: Math.min(x, 1_000_000), y, width: size.width, height: size.height };
    x += size.width + GHOST_GAP;
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
  theme,
}: {
  workspaceId: string;
  entry: DesignAgentDraftEntry;
  rect: { x: number; y: number; width: number; height: number };
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
          {entry.preview?.title || name}
        </span>
      </div>
      <DesignAgentDraftBadge entry={entry} />
      <div className="absolute inset-0 overflow-hidden">
        <DesignAgentDraftDocument srcDoc={themed} title={`${name} draft`} />
      </div>
    </article>
  );
});

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
  frames: readonly DesignCanvasFrameWire[];
  active: boolean;
  theme: string | null;
}) {
  const drafts = useDesignAgentDrafts(workspaceId);
  const ghosts = useMemo(() => {
    if (!active || !pages?.length) return [];
    const page = pages.find((candidate) => candidate.id === activePageId) ?? pages[0]!;
    const registered = new Set(pages.flatMap((candidate) => candidate.frameFiles));
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
      entries.map((entry) => ({ width: entry.preview!.width, height: entry.preview!.height })),
    );
    return entries.map((entry, index) => ({ entry, rect: rects[index]! }));
  }, [active, activePageId, directory, drafts, frames, pages]);
  return (
    <>
      {ghosts.map(({ entry, rect }) => (
        <DesignAgentDraftGhost
          key={entry.draft.id}
          workspaceId={workspaceId}
          entry={entry}
          rect={rect}
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
