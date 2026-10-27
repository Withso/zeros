// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Live HTML/CSS canvas and structured design inspector
// USED IN: MainShellBody in place of the code workspace's Workbench
// ============================================

// --- IMPORTS ---

import { FileCode2 } from "lucide-react";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { designFrameRuntime } from "../../platform/bridge/design-frame-runtime";
import { type DesignCanvasFrameWire } from "../../platform/git";
import { type DesignHighResolutionViewportTile } from "./design-canvas-math";
import { DesignFrameRuntimeIframe } from "./design-frame-runtime-iframe";
import { DesignFrameSourceSurface } from "./design-frame-source-surface";
import { designBackgroundWork } from "./state/design-background-work";
import {
  designFrameAutoCapture,
  type DesignPreviewLevel,
  type DesignPreviewOwner,
} from "./state/design-frame-previews";
import { useDesignRuntimeStore } from "./state/design-runtime-store";
import { useDesignFramePreview } from "./state/use-design-frame-previews";
import { designImageResidency, type DesignImageLease } from "./state/design-image-residency";
import { retainDesignResource } from "./state/design-resource-counters";
import { useDesignImageDisplay, useDesignImageState } from "./state/use-design-image-display";



function designHighResolutionTileKey(
  tile: DesignHighResolutionViewportTile,
): string {
  const coordinate = (value: number) => Math.round(value * 1_000_000);
  return [
    coordinate(tile.crop.x),
    coordinate(tile.crop.y),
    coordinate(tile.crop.width),
    coordinate(tile.crop.height),
    tile.outputWidth,
    tile.outputHeight,
  ].join(":");
}

async function decodeDesignHighResolutionCapture(
  dataUrl: string,
  signal: AbortSignal,
): Promise<void> {
  const image = new Image();
  const cancel = () => { image.src = ""; };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new Error("Resolution capture was superseded.");
    image.src = dataUrl;
    await image.decode();
    if (signal.aborted) throw new Error("Resolution capture was superseded.");
  } finally {
    signal.removeEventListener("abort", cancel);
    image.src = "";
  }
}

/** The cache already owns a loaded image. Moving that element into its view
 * keeps warm remounts and detail upgrades synchronous with the camera. A
 * second simultaneous view gets its own element; it cannot steal the first. */
function DesignFramePicture({ image, url, current, screenshot }: {
  image: HTMLImageElement | null; url: string; current?: boolean; screenshot?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    const node = image && !image.isConnected ? image : new Image();
    node.alt = "";
    node.decoding = "sync";
    node.draggable = false;
    if (current !== undefined) node.dataset.designFramePicture = current ? "current" : "previous";
    if (screenshot) node.dataset.designFrameScreenshot = "";
    node.className = "pointer-events-none block size-full object-fill";
    const ready = () => {
      if (node.complete && node.naturalWidth > 0) container.dataset.designFramePixelsReady = "";
    };
    node.addEventListener("load", ready);
    if (node !== image) node.src = url;
    container.appendChild(node);
    ready();
    return () => {
      node.removeEventListener("load", ready);
      delete container.dataset.designFramePixelsReady;
      delete node.dataset.designFramePicture;
      delete node.dataset.designFrameScreenshot;
      node.remove();
      if (node !== image) node.src = "";
    };
  }, [current, image, screenshot, url]);
  return <div ref={host} data-design-frame-pixel-cover="" className="pointer-events-none absolute inset-0" />;
}

// ============================================
// COMPONENT: DesignFrameRenderSurface
// PURPOSE: Swap far frame runtimes for exact-generation raster snapshots
// USED IN: DesignCanvas
// ============================================

export const DesignFrameRenderSurface = React.memo(function DesignFrameRenderSurface({
  workspaceId,
  protocolCapability,
  folder,
  frame,
  active,
  playbackSessionId,
  onPlaybackStopped,
  selected,
  selectedNodeIds,
  live,
  theme,
  highResolutionTile,
  highResolutionDisabled,
  designDirectory,
  previewOwner,
  previewLevel,
  sourceSurface = false,
  sourceReadOnly = false,
  sourceVisible = true,
  onSourceReady,
  onSourceUnavailable,
  onSourceRetired,
}: {
  workspaceId: string;
  protocolCapability: string | null;
  folder: string;
  frame: DesignCanvasFrameWire;
  active: boolean;
  playbackSessionId?: string | null;
  onPlaybackStopped?: (sessionId: string, error?: Error) => void;
  selected: boolean;
  selectedNodeIds: readonly string[];
  live: boolean;
  theme: string | null;
  highResolutionTile: DesignHighResolutionViewportTile | null;
  highResolutionDisabled: boolean;
  /** The Design directory the canvas shows (agent stylesheet drafts). */
  designDirectory?: string;
  /** Who this frame's saved pictures belong to; null paints none. */
  previewOwner?: DesignPreviewOwner | null;
  /** The picture level that stays sharp at the frame's painted size. */
  previewLevel?: DesignPreviewLevel;
  sourceSurface?: boolean;
  /** Last-confirmed pixels can paint while source authority revalidates. */
  sourceReadOnly?: boolean;
  sourceVisible?: boolean;
  onSourceReady?(file: string, version: string): void;
  onSourceUnavailable?(file: string, version: string): void;
  onSourceRetired?(file: string, version: string): void;
}) {
  useLayoutEffect(() => retainDesignResource("frameSurfaces"), []);
  const sourceOwner = `${workspaceId}\0${folder}\0${previewOwner?.directoryId ?? designDirectory ?? ""}\0${protocolCapability}\0${theme}`;
  const sourceRequest = `${frame.sourceVersion}\0${frame.width}\0${frame.height}`;
  const [sourceReady, setSourceReady] = useState<{ owner: string; version: string; key: string } | null>(null);
  const [sourceFailure, setSourceFailure] = useState<{ owner: string; key: string } | null>(null);
  const sourceEnabled = active && sourceSurface && !!frame.surfaceCost && !!protocolCapability;
  // The passive surface keeps its confirmed outgoing document until the next
  // generation is ready. It already reflows at the frame's current size; an
  // older PNG must not cover it during that source replacement.
  const hasSourcePixels = active && sourceReady?.owner === sourceOwner;
  const sourceFailed = sourceFailure?.owner === sourceOwner && sourceFailure.key === sourceRequest;
  const readySource = useCallback((file: string, version: string) => {
    setSourceReady({ owner: sourceOwner, version, key: sourceRequest });
    setSourceFailure(null);
    onSourceReady?.(file, version);
  }, [onSourceReady, sourceOwner, sourceRequest]);
  const failedSource = useCallback((file: string, version: string) => {
    setSourceFailure({ owner: sourceOwner, key: sourceRequest });
    setSourceReady(current => current?.owner === sourceOwner && current.key !== sourceRequest ? current : null);
    onSourceUnavailable?.(file, version);
  }, [onSourceUnavailable, sourceOwner, sourceRequest]);
  const retiredSource = useCallback((file: string, version: string) => {
    setSourceReady(current => current?.owner === sourceOwner && current.version === version ? null : current);
    onSourceRetired?.(file, version);
  }, [onSourceRetired, sourceOwner]);
  // Saved previews preserve authored alpha, including transparent text frames.
  const picture = useDesignFramePreview(
    active && previewOwner && (!hasSourcePixels || sourceFailed || !sourceEnabled)
      ? { owner: previewOwner, file: frame.file, sourceVersion: frame.sourceVersion, theme,
          level: previewLevel ?? "overview" }
      : null,
  );
  // A rejected generation still requests its normal bounded preview. Keep only
  // the last confirmed source painted until that exact-generation decode can
  // replace it; no failed HTML or pending layout work survives the handoff.
  const sourcePainted = hasSourcePixels && (sourceEnabled || (sourceFailed && !picture?.current));
  const storedScreenshot = useDesignRuntimeStore(
    (state) =>
      state.byWorkspace[workspaceId]?.frames[frame.file]?.screenshotsByNode[""],
  );
  // A confirmed exact-generation preview already supplies the cover. Do not
  // also reserve a full runtime screenshot that this surface will not paint;
  // those duplicate rasters can evict an entire overview's warm thumbnails.
  const screenshot = useDesignImageDisplay(storedScreenshot, active && !sourcePainted && !picture?.current);
  const runtimePaintVersion = useDesignRuntimeStore(
    (state) =>
      state.byWorkspace[workspaceId]?.frames[frame.file]?.updatedAt ?? -1,
  );
  const [highResolutionCapture, setHighResolutionCapture] = useDesignImageState<{
    sourceVersion: string;
    tileKey: string;
    dataUrl: string;
    crop: DesignHighResolutionViewportTile["crop"];
    width: number;
    height: number;
    scale: number;
    lease: DesignImageLease;
  }>();
  const highResolutionCaptureRef = useRef(highResolutionCapture);
  useLayoutEffect(() => { highResolutionCaptureRef.current = highResolutionCapture; }, [highResolutionCapture]);
  useEffect(() => {
    if (!active || !live || highResolutionDisabled || !highResolutionTile ||
      highResolutionCapture?.sourceVersion !== frame.sourceVersion)
      setHighResolutionCapture(null);
  }, [active, live, highResolutionDisabled, highResolutionTile, highResolutionCapture?.sourceVersion, frame.sourceVersion, setHighResolutionCapture]);
  const requestedTileKey = highResolutionTile
    ? designHighResolutionTileKey(highResolutionTile)
    : null;
  // At most one viewport rasterization travels to the frame runtime at a
  // time. Each capture clones and re-renders the whole document inside the
  // frame, so a stepped zoom would otherwise stack redundant clones; the
  // newest requested tile replaces the queued one instead.
  const captureFlightRef = useRef<{
    inFlight: boolean;
    queued: (() => void) | null;
  }>({ inFlight: false, queued: null });

  useEffect(() => {
    if (!active || !live || highResolutionDisabled || !highResolutionTile) {
      return;
    }
    const controller = new AbortController();
    const flight = captureFlightRef.current;
    let retryTimer: number | null = null;
    let stopWaitingForImage: (() => void) | undefined;
    let attempts = 0;
    const tileKey = designHighResolutionTileKey(highResolutionTile);
    const capture = () => {
      if (controller.signal.aborted) return;
      const runtime = designFrameRuntime(workspaceId, frame.file);
      if (!runtime || runtime.sourceVersion !== frame.sourceVersion) {
        if (attempts < 4) {
          attempts += 1;
          retryTimer = window.setTimeout(capture, 50);
        }
        return;
      }
      if (flight.inFlight) {
        flight.queued = capture;
        return;
      }
      flight.inFlight = true;
      const releaseRequest = retainDesignResource("tileRequests");
      void designBackgroundWork
        .schedule(`tile:${workspaceId}\0${frame.file}`, () => {
          if (
            controller.signal.aborted ||
            designFrameRuntime(workspaceId, frame.file) !== runtime ||
            runtime.sourceVersion !== frame.sourceVersion
          )
            return Promise.resolve(null);
          return runtime.captureViewportScreenshot(
            highResolutionTile.crop,
            {
              width: highResolutionTile.outputWidth,
              height: highResolutionTile.outputHeight,
            },
            controller.signal,
          );
        })
        .then(async (captured) => {
          if (
            !captured ||
            controller.signal.aborted ||
            captured.sourceVersion !== frame.sourceVersion
          ) {
            return;
          }
          const lease = designImageResidency.acquire(captured.dataUrl, captured.width, captured.height,
            captured.dataUrl.length * 2, highResolutionCaptureRef.current?.lease);
          if (!lease) {
            // Another display can own the single replacement allowance. Drop
            // this unadmitted payload and retry only when capacity is released.
            stopWaitingForImage ??= designImageResidency.subscribeAvailable(() => {
              stopWaitingForImage?.();
              stopWaitingForImage = undefined;
              capture();
            });
            return;
          }
          let transferred = false;
          try {
            await decodeDesignHighResolutionCapture(captured.dataUrl, controller.signal);
            if (controller.signal.aborted) return;
            transferred = true;
            setHighResolutionCapture({
              sourceVersion: captured.sourceVersion, tileKey, dataUrl: captured.dataUrl,
              crop: highResolutionTile.crop, width: captured.width, height: captured.height,
              scale: captured.scale, lease,
            });
          } finally {
            if (!transferred) lease.release();
          }
        })
        .catch(() => {
          // The live iframe remains authoritative while a newer camera or
          // document generation cancels this optional resolution tile.
        })
        .finally(() => {
          releaseRequest();
          flight.inFlight = false;
          const queued = flight.queued;
          flight.queued = null;
          queued?.();
        });
    };
    capture();
    return () => {
      if (flight.queued === capture) flight.queued = null;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      stopWaitingForImage?.();
      controller.abort();
    };
  }, [
    active,
    frame.file,
    frame.sourceVersion,
    highResolutionDisabled,
    highResolutionTile,
    live,
    runtimePaintVersion,
    setHighResolutionCapture,
    workspaceId,
  ]);

  // A current picture renders the saved source exactly; an in-frame capture
  // of the current generation is next; an older picture holds the frame's
  // last pixels while its current picture renders, instead of a blank card.
  const currentScreenshot =
    screenshot?.sourceVersion === frame.sourceVersion ? screenshot : null;
  const pictureCover = useMemo(
    () => (picture ? { sourceVersion: picture.sourceVersion, dataUrl: picture.url } : null),
    [picture],
  );
  const still = picture?.current
    ? picture.url
    : currentScreenshot?.dataUrl ?? picture?.url ?? null;
  let surface: React.ReactNode;
  if (live) {
    surface = (
      <DesignFrameRuntimeIframe
        workspaceId={workspaceId}
        protocolCapability={protocolCapability}
        folder={folder}
        frame={frame}
        active={active}
        playbackSessionId={playbackSessionId}
        onPlaybackStopped={onPlaybackStopped}
        selected={selected}
        selectedNodeIds={selectedNodeIds}
        autoCapture={!playbackSessionId && designFrameAutoCapture(selected, picture)}
        underlayReady={sourcePainted || !!still}
        theme={theme}
        transitionCover={
          currentScreenshot ??
          (picture?.current ? pictureCover : null) ??
          screenshot ??
          pictureCover
        }
        designDirectory={designDirectory}
      />
    );
  } else if (!sourcePainted && !still && !sourceEnabled) {
    surface = (
      <div className="bg-bg2 text-muted-fg pointer-events-none flex size-full items-center justify-center gap-2 text-xs">
        <FileCode2 />
        <span className="max-w-48 truncate">{frame.title}</span>
      </div>
    );
  } else {
    surface = null;
  }

  const mountedHighResolutionCapture =
    active &&
    live &&
    !highResolutionDisabled &&
    highResolutionTile &&
    highResolutionCapture?.sourceVersion === frame.sourceVersion
      ? highResolutionCapture
      : null;
  // A settled camera move invalidates the mounted tile's key while its
  // replacement is still rasterizing. The stale capture stays painted — its
  // crop is authored in frame-local coordinates, so the camera transform
  // keeps it glued to the world exactly like the previous level of a map
  // tile — and the decoded replacement swaps pixels in one paint. Hiding it
  // here would flash the compositor-magnified iframe on every zoom step.
  const currentHighResolutionCapture =
    mountedHighResolutionCapture?.tileKey === requestedTileKey
      ? mountedHighResolutionCapture
      : null;
  return (
    <div data-design-frame-render-surface="" className="relative isolate size-full overflow-hidden">
      {sourceEnabled || sourcePainted ? <DesignFrameSourceSurface key={sourceOwner} workspaceId={workspaceId}
        folder={folder} directoryId={previewOwner?.directoryId ?? designDirectory ?? ""} width={frame.width} height={frame.height}
        capability={protocolCapability!} file={frame.file} title={frame.title}
        sourceVersion={frame.sourceVersion} theme={theme} cost={frame.surfaceCost!}
        visible={sourceVisible} retainHtml={live} allowLoad={sourceEnabled && !sourceReadOnly} onReady={readySource} onUnavailable={failedSource} onRetired={retiredSource} /> : null}
      {/* Keep the same decoded image element through editor activation. Moving
          its URL into the editor's subtree creates a new image whose resource
          load can miss the next paint, even with a retained decoder. */}
      {!sourcePainted && still ? <DesignFramePicture
        image={picture && still === picture.url ? picture.image : null}
        url={still}
        current={picture && still === picture.url ? picture.current : undefined}
        screenshot={still === currentScreenshot?.dataUrl}
      /> : null}
      {surface}
      {mountedHighResolutionCapture ? (
        <img
          data-design-high-resolution-tile=""
          data-design-tile-current={
            currentHighResolutionCapture ? "" : undefined
          }
          data-design-tile-key={mountedHighResolutionCapture.tileKey}
          data-design-tile-source-version={
            mountedHighResolutionCapture.sourceVersion
          }
          data-design-tile-scale={mountedHighResolutionCapture.scale}
          data-design-tile-width={mountedHighResolutionCapture.width}
          data-design-tile-height={mountedHighResolutionCapture.height}
          src={mountedHighResolutionCapture.dataUrl}
          alt=""
          draggable={false}
          className="pointer-events-none absolute z-[2] block max-w-none object-fill"
          style={{
            left: mountedHighResolutionCapture.crop.x,
            top: mountedHighResolutionCapture.crop.y,
            width: mountedHighResolutionCapture.crop.width,
            height: mountedHighResolutionCapture.crop.height,
          }}
        />
      ) : null}
    </div>
  );
});
