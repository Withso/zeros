import {
  retainLiveDesignFrameFiles,
  selectLiveDesignFrameFiles,
  type DesignViewport,
  type DesignViewportSize,
} from "./design-canvas-math";
import { DesignFrameSpatialIndex, type DesignSpatialFrame, type DesignSpatialRect } from "./design-frame-spatial-index";
import { selectDesignSourceSurfaces } from "./design-source-surfaces";
import type { DesignSurfaceCost } from "@zeros/protocol/design-surface";

export const DESIGN_FRAME_OVERSCAN_PIXELS = 240;
export const DESIGN_FRAME_RETENTION_PIXELS = 480;
export const DESIGN_MAX_NEARBY_FRAME_SURFACES = 12;
export const DESIGN_MAX_LIVE_FRAMES = 12;

export interface DesignFrameResidency<T extends DesignSpatialFrame> {
  readonly frames: readonly T[];
  readonly live: ReadonlySet<string>;
  readonly sources: ReadonlySet<string>;
  readonly visible: ReadonlySet<string>;
}

export interface DesignFrameResidencyInput<T extends DesignSpatialFrame> {
  readonly owner: string;
  readonly frames: readonly T[];
  readonly index: DesignFrameSpatialIndex<T>;
  readonly view: DesignViewport;
  readonly viewport: DesignViewportSize;
  readonly active: boolean;
  readonly hiddenLive?: ReadonlySet<string>;
  readonly selectedFrame: string | null;
  readonly requiredFiles: readonly string[];
  /** One editor/rename/drop target, never the whole semantic selection. */
  readonly protectedFiles?: readonly string[];
  readonly pictured: ReadonlySet<string>;
  /** Any decoded cover, even below the requested detail level. A visible
   * document without one cannot yield its slot just because the camera moved. */
  readonly covered?: ReadonlySet<string>;
  readonly devicePixelRatio: number;
  readonly sourceSurfacesEnabled?: boolean;
  readonly sourceReady?: ReadonlyMap<string, string>;
  readonly sourceUnavailable?: ReadonlyMap<string, string>;
  /** Small overlay for direct manipulation; the immutable index is unchanged. */
  readonly geometry?: ReadonlyMap<string, DesignSpatialRect>;
}

function intersects(a: DesignSpatialRect, b: DesignSpatialRect): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x &&
    a.y <= b.y + b.height && a.y + a.height >= b.y;
}

/** Metadata owns discovery and stacking. DOM lifetime is only a rendering
 * decision, so an offscreen frame remains selectable/movable/snappable. */
export function createDesignFrameResidencyReader<T extends DesignSpatialFrame>() {
  let previous: { owner: string; result: DesignFrameResidency<T> } | undefined;
  return (input: DesignFrameResidencyInput<T>): DesignFrameResidency<T> => {
    const prior = previous?.owner === input.owner ? previous.result : undefined;
    const available = new Map(input.frames.map((frame) => [frame.file, frame]));
    const mounted = new Set<string>();
    const visibleFiles = new Set<string>();
    let candidates: T[] = [];
    if (input.active && input.viewport.width > 0 && input.viewport.height > 0) {
      const { zoom, panX, panY } = input.view;
      const visible = {
        x: -panX / zoom, y: -panY / zoom,
        width: input.viewport.width / zoom, height: input.viewport.height / zoom,
      };
      const expanded = (pixels: number) => ({
        x: visible.x - pixels / zoom, y: visible.y - pixels / zoom,
        width: visible.width + pixels * 2 / zoom, height: visible.height + pixels * 2 / zoom,
      });
      const enter = expanded(DESIGN_FRAME_OVERSCAN_PIXELS);
      const retain = expanded(DESIGN_FRAME_RETENTION_PIXELS);
      const geometry = (frame: T) => input.geometry?.get(frame.file) ?? frame;
      const found = new Map(input.index.search(retain).map((frame) => [frame.file, frame]));
      // A moved frame can enter the view while its indexed position is far away.
      for (const [file, rect] of input.geometry ?? []) {
        const frame = available.get(file);
        if (frame && intersects(rect, retain)) found.set(file, frame);
      }
      const priorFiles = new Set(prior?.frames.map((frame) => frame.file));
      const nearby: T[] = [];
      for (const frame of found.values()) {
        const rect = geometry(frame);
        if (intersects(rect, visible)) { mounted.add(frame.file); visibleFiles.add(frame.file); }
        else if (intersects(rect, enter) || (priorFiles.has(frame.file) && intersects(rect, retain)))
          nearby.push(frame);
      }
      const center = { x: visible.x + visible.width / 2, y: visible.y + visible.height / 2 };
      const distance = (frame: T) => {
        const rect = geometry(frame);
        return Math.hypot(rect.x + rect.width / 2 - center.x, rect.y + rect.height / 2 - center.y);
      };
      nearby.sort((a, b) => Number(priorFiles.has(b.file)) - Number(priorFiles.has(a.file)) ||
        distance(a) - distance(b) || a.file.localeCompare(b.file));
      for (const frame of nearby.slice(0, DESIGN_MAX_NEARBY_FRAME_SURFACES)) mounted.add(frame.file);
      // Layer trees and editing can need a bounded runtime outside the viewport.
      const demanded = new Set([...mounted, ...(input.protectedFiles ?? []), ...input.requiredFiles, ...(input.selectedFrame ? [input.selectedFrame] : [])]);
      candidates = input.frames.filter((frame) => demanded.has(frame.file));
    }
    // Keep already-rendered passive documents inside the same explicit budget.
    // A return pan can reveal their existing layout in this paint instead of
    // starting a protocol navigation. New screen demand wins over warm entries.
    type SourceFrame = T & { sourceVersion?: string; surfaceCost?: DesignSurfaceCost | null; previous?: { file: string; sourceVersion: string; surfaceCost?: DesignSurfaceCost | null } };
    const sourceCandidates = input.sourceSurfacesEnabled && input.active
      ? [...input.frames.filter(frame => mounted.has(frame.file)),
          ...input.frames.filter(frame => !mounted.has(frame.file) && prior?.sources.has(frame.file))] as SourceFrame[] : [];
    // Previous source is paint-only. The original descriptors still exclude
    // these frames from live/editor admission and continue preparation demand.
    const admittedSources = selectDesignSourceSurfaces(sourceCandidates.map(frame => frame.sourceVersion ? frame : frame.previous ?? frame).filter(frame =>
      !!frame.sourceVersion && input.sourceUnavailable?.get(frame.file) !== frame.sourceVersion));
    const sources = prior && admittedSources.size === prior.sources.size && [...admittedSources].every(file => prior.sources.has(file)) ? prior.sources : admittedSources;
    for (const file of sources) mounted.add(file);
    const visible = prior && visibleFiles.size === prior.visible.size && [...visibleFiles].every(file => prior.visible.has(file)) ? prior.visible : visibleFiles;
    const next = input.active ? selectLiveDesignFrameFiles({
      // A descriptor has never mounted an editor. Do not later protect its
      // prospective slot as painted content while its passive HTML is loading.
      frames: candidates.filter(frame => (frame as T & { preparation?: string }).preparation !== "unprepared").map((frame) => {
        const rect = input.geometry?.get(frame.file);
        return rect ? { ...frame, ...rect } : frame;
      }),
      view: input.view, viewport: input.viewport,
      selectedFrame: input.selectedFrame, requiredFiles: [
        ...(input.protectedFiles ?? []), ...input.requiredFiles,
        ...[...(prior?.live ?? [])].filter(file => visibleFiles.has(file) && !(input.covered ?? input.pictured).has(file) &&
          !(sources.has(file) && input.sourceReady?.get(file) === (available.get(file) as T & { sourceVersion?: string })?.sourceVersion)),
      ],
      pictured: input.pictured, devicePixelRatio: input.devicePixelRatio,
      sourceSurfaces: sources,
      maxLive: DESIGN_MAX_LIVE_FRAMES,
    }) : new Set<string>();
    const hidden = input.hiddenLive && [...input.hiddenLive].every((file) => available.has(file)) ? input.hiddenLive :
      new Set([...(input.hiddenLive ?? [])].filter((file) => available.has(file)));
    const live = !input.active && input.hiddenLive ? hidden : retainLiveDesignFrameFiles({
      previous: prior?.live ?? new Set(), next, active: input.active,
      available: [...available.keys()], maxLive: DESIGN_MAX_LIVE_FRAMES,
    });
    for (const file of live) mounted.add(file);
    for (const file of input.protectedFiles ?? []) if (available.has(file)) mounted.add(file);
    const frames = input.frames.filter((frame) => mounted.has(frame.file));
    const sameFrames = prior && frames.length === prior.frames.length && frames.every((frame, index) => frame === prior.frames[index]);
    const result = sameFrames && live === prior.live && sources === prior.sources && visible === prior.visible ? prior : { frames: sameFrames ? prior.frames : frames, live, sources, visible };
    previous = { owner: input.owner, result };
    return result;
  };
}
