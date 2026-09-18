// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Live HTML/CSS canvas and structured design inspector
// USED IN: MainShellBody in place of the code workspace's Workbench
// ============================================

// --- IMPORTS ---

import { FileCode2 } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

import { designFrameRuntime } from "../../platform/bridge/design-frame-runtime";
import { type DesignCanvasFrameWire } from "../../platform/git";
import { type DesignHighResolutionViewportTile } from "./design-canvas-math";
import { DesignFrameRuntimeIframe } from "./design-frame-runtime-iframe";
import { designBackgroundWork } from "./state/design-background-work";
import { useDesignRuntimeStore } from "./state/design-runtime-store";



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
  image.src = dataUrl;
  await image.decode();
  if (signal.aborted) throw new Error("Resolution capture was superseded.");
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
  selected,
  selectedNodeIds,
  live,
  theme,
  highResolutionTile,
  highResolutionDisabled,
}: {
  workspaceId: string;
  protocolCapability: string | null;
  folder: string;
  frame: DesignCanvasFrameWire;
  active: boolean;
  selected: boolean;
  selectedNodeIds: readonly string[];
  live: boolean;
  theme: string | null;
  highResolutionTile: DesignHighResolutionViewportTile | null;
  highResolutionDisabled: boolean;
}) {
  const screenshot = useDesignRuntimeStore(
    (state) =>
      state.byWorkspace[workspaceId]?.frames[frame.file]?.screenshotsByNode[""],
  );
  const runtimePaintVersion = useDesignRuntimeStore(
    (state) =>
      state.byWorkspace[workspaceId]?.frames[frame.file]?.updatedAt ?? -1,
  );
  const [highResolutionCapture, setHighResolutionCapture] = useState<{
    sourceVersion: string;
    tileKey: string;
    dataUrl: string;
    crop: DesignHighResolutionViewportTile["crop"];
    width: number;
    height: number;
    scale: number;
  } | null>(null);
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
          await decodeDesignHighResolutionCapture(
            captured.dataUrl,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          setHighResolutionCapture({
            sourceVersion: captured.sourceVersion,
            tileKey,
            dataUrl: captured.dataUrl,
            crop: highResolutionTile.crop,
            width: captured.width,
            height: captured.height,
            scale: captured.scale,
          });
        })
        .catch(() => {
          // The live iframe remains authoritative while a newer camera or
          // document generation cancels this optional resolution tile.
        })
        .finally(() => {
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
    workspaceId,
  ]);

  let surface: React.ReactNode;
  if (live) {
    surface = (
      <DesignFrameRuntimeIframe
        workspaceId={workspaceId}
        protocolCapability={protocolCapability}
        folder={folder}
        frame={frame}
        active={active}
        selected={selected}
        selectedNodeIds={selectedNodeIds}
        autoCapture
        theme={theme}
        transitionCover={screenshot ?? null}
      />
    );
  } else if (screenshot?.sourceVersion === frame.sourceVersion) {
    surface = (
      <img
        src={screenshot.dataUrl}
        alt=""
        draggable={false}
        className="pointer-events-none block size-full object-fill"
      />
    );
  } else {
    surface = (
      <div className="bg-bg2 text-muted-fg pointer-events-none flex size-full items-center justify-center gap-2 text-xs">
        <FileCode2 />
        <span className="max-w-48 truncate">{frame.title}</span>
      </div>
    );
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
    <div className="relative isolate size-full overflow-hidden">
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
