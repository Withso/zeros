// ============================================
// COMPONENT: DesignFrameRuntimeIframe
// PURPOSE: Host one opaque HTML/CSS frame and connect its app-owned runtime
// USED IN: DesignCanvas
// ============================================

// --- IMPORTS ---

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  DESIGN_SELECTION_NODE_LIMIT,
  type DesignRuntimeSnapshot,
} from "@zeros/protocol/design-runtime";

import type { DesignCanvasFrameWire } from "../../platform/git";
import { useNativeRuntime } from "../../platform/runtime";
import {
  connectDesignFrameRuntime,
  designFrameRuntime,
  type DesignFrameRuntimeConnection,
} from "../../platform/bridge/design-frame-runtime";
import { designProtocolFrameUrl } from "../../platform/bridge/design-protocol-url";
import {
  captureDesignRuntimeScreenshot,
  reconcileDesignRuntimeSnapshot,
} from "./state/design-selection";
import { reconcileDesignWorkspaceRuntimeAudit } from "./state/design-workspace-cache";
import { useDesignRuntimeStore } from "./state/design-runtime-store";
import { useDesignFrameDocument } from "./state/use-design-frame-document";

// --- TYPES ---

interface DesignFrameRuntimeIframeProps {
  /** Exact workspace owner for runtime requests and screenshot publication. */
  workspaceId: string;
  /** Per-launch authority for this exact workspace's custom-protocol route. */
  protocolCapability: string | null;
  /** Exact folder owner used by the composer selection lookup. */
  folder: string;
  /** Lightweight frame metadata plus its exact composed generation. */
  frame: DesignCanvasFrameWire;
  /** Hidden retained canvases must not capture or revalidate active readback. */
  active: boolean;
  /** Selected frames receive priority screenshot refreshes. */
  selected: boolean;
  /** Semantic selection retained while a new document generation readies. */
  selectedNodeIds: readonly string[];
  /** A bounded first window receives speculative thumbnail captures. */
  autoCapture: boolean;
  /** Workspace-owned token mode applied inside the opaque frame runtime. */
  theme: string | null;
  /** Last confirmed pixels cover unavoidable structural document navigation. */
  transitionCover: { sourceVersion: string; dataUrl: string } | null;
}

// --- WORKFLOWS ---

function scheduleIdle(work: () => void): () => void {
  const idleWindow = window as Window & {
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout: number },
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof idleWindow.requestIdleCallback === "function") {
    const handle = idleWindow.requestIdleCallback(work, { timeout: 1_000 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(work, 0);
  return () => window.clearTimeout(handle);
}

// --- RENDER ---

type DesignDocumentBuffer = "displayed" | "incoming";

interface DesignFrameDocumentBufferProps {
  workspaceId: string;
  protocolCapability: string | null;
  folder: string;
  frame: DesignCanvasFrameWire;
  documentSourceVersion: string;
  buffer: DesignDocumentBuffer;
  ready: boolean;
  runtimeActive: boolean;
  selected: boolean;
  selectedNodeIds: readonly string[];
  autoCapture: boolean;
  theme: string | null;
  onSnapshot: (snapshot: DesignRuntimeSnapshot) => void;
  onConnection: (
    documentSourceVersion: string,
    connection: DesignFrameRuntimeConnection | null,
  ) => void;
  onReady: (
    documentSourceVersion: string,
    connection: DesignFrameRuntimeConnection,
  ) => void;
}

/**
 * One immutable document generation. Structural updates mount a second buffer
 * beneath the currently painted iframe, so the browser can finish layout,
 * fonts, and raster work before one React commit swaps which buffer is shown.
 */
function DesignFrameDocumentBuffer({
  workspaceId,
  protocolCapability,
  folder,
  frame,
  documentSourceVersion,
  buffer,
  ready,
  runtimeActive,
  selected,
  selectedNodeIds,
  autoCapture,
  theme,
  onSnapshot,
  onConnection,
  onReady,
}: DesignFrameDocumentBufferProps) {
  const nativeRuntime = useNativeRuntime();
  const connectionRef = useRef<DesignFrameRuntimeConnection | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const loadedKeyRef = useRef<string | null>(null);
  const latestRef = useRef({
    folder,
    frame,
    runtimeActive,
    selected,
    selectedNodeIds,
    autoCapture,
    theme,
  });
  latestRef.current = {
    folder,
    frame,
    runtimeActive,
    selected,
    selectedNodeIds,
    autoCapture,
    theme,
  };
  const loadKey = `${workspaceId}\u0000${frame.file}\u0000${documentSourceVersion}`;

  const setIframe = useCallback(
    (node: HTMLIFrameElement | null) => {
      if (node === iframeRef.current) return;
      connectionRef.current?.destroy();
      connectionRef.current = null;
      onConnection(documentSourceVersion, null);
      iframeRef.current = node;
      if (!node) loadedKeyRef.current = null;
    },
    [documentSourceVersion, onConnection],
  );

  const connectCurrentIframe = useCallback(() => {
    const node = iframeRef.current;
    if (!node) return;
    connectionRef.current?.destroy();
    onConnection(documentSourceVersion, null);
    const connection = connectDesignFrameRuntime(
      workspaceId,
      frame.file,
      documentSourceVersion,
      node,
      {
        onSnapshot: (snapshot, event) => {
          if (event !== "ready") {
            onSnapshot(snapshot);
            return;
          }
          const finishReady = () => {
            if (
              connectionRef.current === connection &&
              connection.sourceVersion ===
                latestRef.current.frame.sourceVersion
            ) {
              onReady(documentSourceVersion, connection);
            }
          };
          if (!latestRef.current.runtimeActive) {
            onSnapshot(snapshot);
            finishReady();
            return;
          }
          const reconcileSelectedNodes = async () => {
            const latest = latestRef.current;
            if (!latest.selected || latest.selectedNodeIds.length === 0) return;
            const details = (
              await Promise.all(
                latest.selectedNodeIds
                  .slice(0, DESIGN_SELECTION_NODE_LIMIT)
                  .map((nodeId) =>
                    connection.getNodeDetails(nodeId).catch(() => null),
                  ),
              )
            ).filter((candidate) => candidate !== null);
            if (
              connectionRef.current !== connection ||
              connection.sourceVersion !== latestRef.current.frame.sourceVersion
            ) {
              return;
            }
            const current = latestRef.current;
            for (const candidate of details) {
              useDesignRuntimeStore
                .getState()
                .publishNodeDetails(
                  workspaceId,
                  current.folder,
                  current.frame.file,
                  candidate,
                  current.frame.sourceVersion,
                );
            }
          };
          void connection
            .setTheme(latestRef.current.theme)
            .then(async (themedSnapshot) => {
              onSnapshot(themedSnapshot);
              await reconcileSelectedNodes();
              finishReady();
            })
            .catch(() => {
              // A newer buffered generation now owns readiness.
            });
        },
      },
    );
    connectionRef.current = connection;
    onConnection(documentSourceVersion, connection);
  }, [
    documentSourceVersion,
    frame.file,
    onConnection,
    onReady,
    onSnapshot,
    workspaceId,
  ]);

  // StrictMode can replay passive cleanup without replaying the DOM ref. The
  // second setup reconnects the already-loaded immutable buffer in that case.
  useEffect(() => {
    if (loadedKeyRef.current === loadKey && connectionRef.current === null) {
      connectCurrentIframe();
    }
    return () => {
      connectionRef.current?.destroy();
      connectionRef.current = null;
      onConnection(documentSourceVersion, null);
    };
  }, [connectCurrentIframe, documentSourceVersion, loadKey, onConnection]);

  useEffect(() => {
    if (!runtimeActive || (!selected && !autoCapture)) return;
    const connection = connectionRef.current;
    if (!connection) return;
    void connection.getSnapshot().then(onSnapshot).catch(() => {
      // A replacement buffer publishes its own exact ready snapshot.
    });
  }, [autoCapture, onSnapshot, runtimeActive, selected]);

  useEffect(() => {
    if (!runtimeActive) return;
    const connection = connectionRef.current;
    if (!connection) return;
    void connection.setTheme(theme).then(onSnapshot).catch(() => {
      // A replacement buffer applies the latest theme before it is revealed.
    });
  }, [onSnapshot, runtimeActive, theme]);

  const protocolSource = nativeRuntime.ready
    ? designProtocolFrameUrl({
        workspaceId,
        capability: protocolCapability,
        frame: frame.file,
        sourceVersion: documentSourceVersion,
      })
    : null;
  const fallback = useDesignFrameDocument(
    workspaceId,
    frame.file,
    documentSourceVersion,
    runtimeActive && protocolSource === null,
  );
  const fallbackSrcDoc =
    fallback.data?.srcDoc ??
    '<!doctype html><html><body style="margin:0"></body></html>';

  return (
    <iframe
      ref={setIframe}
      {...(protocolSource
        ? { src: protocolSource }
        : { srcDoc: fallbackSrcDoc })}
      sandbox="allow-scripts"
      data-design-document-source-version={documentSourceVersion}
      data-design-source-version={frame.sourceVersion}
      data-design-document-buffer={buffer}
      data-design-document-ready={ready ? "" : undefined}
      tabIndex={-1}
      className={
        buffer === "displayed"
          ? "bg-bg1 pointer-events-none relative z-[1] block size-full border-0"
          : "bg-bg1 pointer-events-none absolute inset-0 z-0 block size-full border-0"
      }
      aria-label={`${frame.title} design frame`}
      aria-hidden={buffer === "incoming" ? true : undefined}
      onLoad={() => {
        loadedKeyRef.current = loadKey;
        connectCurrentIframe();
      }}
    />
  );
}

export function DesignFrameRuntimeIframe({
  workspaceId,
  protocolCapability,
  folder,
  frame,
  active,
  selected,
  selectedNodeIds,
  autoCapture,
  theme,
  transitionCover,
}: DesignFrameRuntimeIframeProps) {
  // A style-only generation advances the displayed connection in place. A
  // structural generation instead preloads an immutable incoming iframe while
  // the outgoing iframe continues to supply exact live text pixels.
  const [displayedSourceVersion, setDisplayedSourceVersion] = useState(
    frame.sourceVersion,
  );
  const [incomingSourceVersion, setIncomingSourceVersion] = useState<
    string | null
  >(null);
  const [readySourceVersions, setReadySourceVersions] = useState<string[]>([]);
  const connectionsByDocumentRef = useRef(
    new Map<string, DesignFrameRuntimeConnection>(),
  );
  const captureKeyRef = useRef<string | null>(null);
  const cancelCaptureRef = useRef<(() => void) | null>(null);
  const swapFrameRef = useRef<number | null>(null);
  const latestRef = useRef({
    workspaceId,
    folder,
    frame,
    active,
    selected,
    selectedNodeIds,
    autoCapture,
    theme,
    displayedSourceVersion,
    incomingSourceVersion,
  });
  latestRef.current = {
    workspaceId,
    folder,
    frame,
    active,
    selected,
    selectedNodeIds,
    autoCapture,
    theme,
    displayedSourceVersion,
    incomingSourceVersion,
  };

  const cancelSwap = useCallback(() => {
    if (swapFrameRef.current === null) return;
    window.cancelAnimationFrame(swapFrameRef.current);
    swapFrameRef.current = null;
  }, []);

  /** Publish authoritative runtime state and schedule bounded real-pixel capture. */
  const handleSnapshot = useCallback((snapshot: DesignRuntimeSnapshot) => {
    const latest = latestRef.current;
    const {
      workspaceId: ownerId,
      folder: ownerFolder,
      frame: currentFrame,
    } = latest;
    if (!latest.active) return;
    if (snapshot.sourceVersion !== currentFrame.sourceVersion) return;
    reconcileDesignRuntimeSnapshot({
      workspaceId: ownerId,
      folder: ownerFolder,
      frame: currentFrame,
      snapshot,
    });
    void reconcileDesignWorkspaceRuntimeAudit({
      workspaceId: ownerId,
      frame: currentFrame.file,
      sourceVersion: currentFrame.sourceVersion,
      warnings: snapshot.warnings,
    }).catch(() => {
      // The exact carried audit remains visible until a later ready/mutation
      // snapshot can complete the authoritative engine round trip.
    });
    if (!latest.selected && !latest.autoCapture) return;
    const captureKey = `${currentFrame.sourceVersion}:${snapshot.revision}`;
    if (captureKeyRef.current === captureKey) return;
    captureKeyRef.current = captureKey;
    cancelCaptureRef.current?.();
    cancelCaptureRef.current = scheduleIdle(() => {
      cancelCaptureRef.current = null;
      void captureDesignRuntimeScreenshot(
        ownerId,
        ownerFolder,
        currentFrame.file,
        currentFrame.sourceVersion,
        null,
        latest.selected ? 0.75 : 0.25,
      ).catch(() => {
        if (captureKeyRef.current === captureKey) {
          captureKeyRef.current = null;
        }
      });
    });
  }, []);

  const handleConnection = useCallback(
    (
      sourceVersion: string,
      connection: DesignFrameRuntimeConnection | null,
    ) => {
      if (connection) {
        connectionsByDocumentRef.current.set(sourceVersion, connection);
      } else {
        connectionsByDocumentRef.current.delete(sourceVersion);
      }
    },
    [],
  );

  const handleDocumentReady = useCallback(
    (sourceVersion: string, connection: DesignFrameRuntimeConnection) => {
      if (
        connectionsByDocumentRef.current.get(sourceVersion) !== connection
      ) {
        return;
      }
      setReadySourceVersions((current) =>
        current.includes(sourceVersion)
          ? current
          : [...current, sourceVersion].slice(-2),
      );
      const latest = latestRef.current;
      if (
        latest.incomingSourceVersion !== sourceVersion ||
        latest.frame.sourceVersion !== sourceVersion
      ) {
        return;
      }
      cancelSwap();
      // Two presentation frames let Chromium raster the already-laid-out child
      // compositor surface before the outgoing live text buffer is removed.
      swapFrameRef.current = window.requestAnimationFrame(() => {
        swapFrameRef.current = window.requestAnimationFrame(() => {
          swapFrameRef.current = null;
          const current = latestRef.current;
          if (
            current.incomingSourceVersion !== sourceVersion ||
            current.frame.sourceVersion !== sourceVersion ||
            connectionsByDocumentRef.current.get(sourceVersion) !==
              connection ||
            designFrameRuntime(current.workspaceId, current.frame.file) !==
              connection
          ) {
            return;
          }
          setDisplayedSourceVersion(sourceVersion);
          setIncomingSourceVersion(null);
          setReadySourceVersions([sourceVersion]);
        });
      });
    },
    [cancelSwap],
  );

  useLayoutEffect(() => {
    if (displayedSourceVersion === frame.sourceVersion) {
      if (incomingSourceVersion !== null) {
        cancelSwap();
        setIncomingSourceVersion(null);
      }
      return;
    }
    const displayedConnection = connectionsByDocumentRef.current.get(
      displayedSourceVersion,
    );
    if (
      displayedConnection &&
      designFrameRuntime(workspaceId, frame.file) === displayedConnection &&
      displayedConnection.sourceVersion === frame.sourceVersion
    ) {
      if (incomingSourceVersion !== null) {
        cancelSwap();
        setIncomingSourceVersion(null);
      }
      return;
    }
    if (incomingSourceVersion === frame.sourceVersion) return;
    cancelSwap();
    setReadySourceVersions((current) =>
      current.filter((sourceVersion) => sourceVersion !== frame.sourceVersion),
    );
    setIncomingSourceVersion(frame.sourceVersion);
  }, [
    cancelSwap,
    displayedSourceVersion,
    frame.file,
    frame.sourceVersion,
    incomingSourceVersion,
    workspaceId,
  ]);

  useEffect(
    () => () => {
      cancelSwap();
      cancelCaptureRef.current?.();
      cancelCaptureRef.current = null;
    },
    [cancelSwap],
  );

  const documentReady = readySourceVersions.includes(displayedSourceVersion);
  const transitionCoverUrl =
    transitionCover?.sourceVersion === displayedSourceVersion ||
    transitionCover?.sourceVersion === frame.sourceVersion
      ? transitionCover.dataUrl
      : null;
  const buffers: Array<{
    sourceVersion: string;
    buffer: DesignDocumentBuffer;
  }> = [
    { sourceVersion: displayedSourceVersion, buffer: "displayed" },
    ...(active &&
    incomingSourceVersion &&
    incomingSourceVersion !== displayedSourceVersion
      ? ([
          { sourceVersion: incomingSourceVersion, buffer: "incoming" },
        ] as const)
      : []),
  ];

  return (
    <div className="relative size-full overflow-hidden">
      {buffers.map((entry) => (
        <DesignFrameDocumentBuffer
          key={entry.sourceVersion}
          workspaceId={workspaceId}
          protocolCapability={protocolCapability}
          folder={folder}
          frame={frame}
          documentSourceVersion={entry.sourceVersion}
          buffer={entry.buffer}
          ready={readySourceVersions.includes(entry.sourceVersion)}
          runtimeActive={
            active &&
            (entry.buffer === "incoming" || incomingSourceVersion === null)
          }
          selected={selected}
          selectedNodeIds={selectedNodeIds}
          autoCapture={autoCapture}
          theme={theme}
          onSnapshot={handleSnapshot}
          onConnection={handleConnection}
          onReady={handleDocumentReady}
        />
      ))}
      {!documentReady ? (
        transitionCoverUrl ? (
          <img
            data-design-frame-transition-cover=""
            src={transitionCoverUrl}
            alt=""
            draggable={false}
            className="bg-bg1 pointer-events-none absolute inset-0 z-[2] block size-full object-fill"
          />
        ) : (
          <div
            data-design-frame-transition-cover=""
            className="bg-bg1 pointer-events-none absolute inset-0 z-[2]"
          />
        )
      ) : null}
    </div>
  );
}
