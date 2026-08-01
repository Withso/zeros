// ============================================
// COMPONENT: DesignFrameRuntimeIframe
// PURPOSE: Host one opaque HTML/CSS frame and connect its app-owned runtime
// USED IN: DesignCanvas
// ============================================

// --- IMPORTS ---

import React, { useCallback, useEffect, useRef } from "react";

import type { DesignRuntimeSnapshot } from "@zeros/core/design-runtime";

import type { DesignFrameDocumentWire } from "../../native/git";
import { isElectron } from "../../native/runtime";
import {
  connectDesignFrameRuntime,
  type DesignFrameRuntimeConnection,
} from "../bridge/design-frame-runtime";
import { designProtocolFrameUrl } from "../bridge/design-protocol-url";
import {
  captureDesignRuntimeScreenshot,
  reconcileDesignRuntimeSnapshot,
} from "../store/design-selection";

// --- TYPES ---

interface DesignFrameRuntimeIframeProps {
  /** Exact workspace owner for runtime requests and screenshot publication. */
  workspaceId: string;
  /** Per-launch authority for this exact workspace's custom-protocol route. */
  protocolCapability: string | null;
  /** Exact folder owner used by the composer selection lookup. */
  folder: string;
  /** Authored frame document and composed runtime-enabled srcDoc. */
  frame: DesignFrameDocumentWire;
  /** Hidden retained canvases must not capture or revalidate active readback. */
  active: boolean;
  /** Selected frames receive priority screenshot refreshes. */
  selected: boolean;
  /** A bounded first window receives speculative thumbnail captures. */
  autoCapture: boolean;
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

export function DesignFrameRuntimeIframe({
  workspaceId,
  protocolCapability,
  folder,
  frame,
  active,
  selected,
  autoCapture,
}: DesignFrameRuntimeIframeProps) {
  // Owns the exact WindowProxy request connection for this iframe instance.
  const connectionRef = useRef<DesignFrameRuntimeConnection | null>(null);
  // Prevents duplicate raster work for the same source/runtime revision.
  const captureKeyRef = useRef<string | null>(null);
  // Cancels a queued idle capture when the frame becomes inactive or reloads.
  const cancelCaptureRef = useRef<(() => void) | null>(null);
  // The WindowProxy connection stays stable while selection/source props move.
  const latestRef = useRef({
    workspaceId,
    folder,
    frame,
    active,
    selected,
    autoCapture,
  });
  latestRef.current = {
    workspaceId,
    folder,
    frame,
    active,
    selected,
    autoCapture,
  };

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
        // Geometry, layers, and selection remain live if rasterization is
        // unsupported for one document. Activation or a later runtime event
        // may retry this exact revision without disturbing a newer capture.
        if (captureKeyRef.current === captureKey) {
          captureKeyRef.current = null;
        }
      });
    });
  }, []);

  /** Callback refs attach before load, so the runtime's ready event cannot race us. */
  const setIframe = useCallback(
    (node: HTMLIFrameElement | null) => {
      connectionRef.current?.destroy();
      connectionRef.current = null;
      if (!node) return;
      connectionRef.current = connectDesignFrameRuntime(
        workspaceId,
        frame.file,
        node,
        { onSnapshot: handleSnapshot },
      );
      const connection = connectionRef.current;
      queueMicrotask(() => {
        if (connectionRef.current !== connection || !latestRef.current.active) {
          return;
        }
        void connection
          .getSnapshot()
          .then(handleSnapshot)
          .catch(() => {
            // Initial documents may not have installed their listener yet;
            // their primary ready event follows once the runtime boots.
          });
      });
    },
    [frame.file, handleSnapshot, workspaceId],
  );

  // Navigation/collapse tears down pending requests and idle raster work.
  useEffect(
    () => () => {
      cancelCaptureRef.current?.();
      cancelCaptureRef.current = null;
      connectionRef.current?.destroy();
      connectionRef.current = null;
    },
    [],
  );

  // A retained hidden frame deliberately ignores runtime work. Becoming
  // active—or entering the selected/thumbnail capture set—revalidates its
  // exact current document without requiring an iframe reload.
  useEffect(() => {
    if (!active || (!selected && !autoCapture)) return;
    const connection = connectionRef.current;
    if (!connection) return;
    void connection
      .getSnapshot()
      .then(handleSnapshot)
      .catch(() => {
        // A source reload racing activation publishes its own ready event.
      });
  }, [active, autoCapture, handleSnapshot, selected]);

  const protocolSource = isElectron()
    ? designProtocolFrameUrl({
        workspaceId,
        capability: protocolCapability,
        frame: frame.file,
        sourceVersion: frame.sourceVersion,
      })
    : null;

  return (
    <iframe
      ref={setIframe}
      {...(protocolSource ? { src: protocolSource } : { srcDoc: frame.srcDoc })}
      sandbox="allow-scripts"
      tabIndex={-1}
      className="bg-bg1 pointer-events-none block size-full border-0"
      aria-label={`${frame.title} design frame`}
      onLoad={() => {
        if (!latestRef.current.active) return;
        void connectionRef.current
          ?.getSnapshot()
          .then(handleSnapshot)
          .catch(() => {
            // The injected ready event is primary; onLoad revalidation is a
            // missed-event fallback and can harmlessly fail during reload.
          });
      }}
    />
  );
}
