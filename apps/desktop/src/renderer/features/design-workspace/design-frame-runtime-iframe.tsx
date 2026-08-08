// ============================================
// COMPONENT: DesignFrameRuntimeIframe
// PURPOSE: Host one opaque HTML/CSS frame and connect its app-owned runtime
// USED IN: DesignCanvas
// ============================================

// --- IMPORTS ---

import React, { useCallback, useEffect, useRef } from "react";

import type { DesignRuntimeSnapshot } from "@zeros/protocol/design-runtime";

import type { DesignCanvasFrameWire } from "../../platform/git";
import { useNativeRuntime } from "../../platform/runtime";
import {
  connectDesignFrameRuntime,
  type DesignFrameRuntimeConnection,
} from "../../platform/bridge/design-frame-runtime";
import { designProtocolFrameUrl } from "../../platform/bridge/design-protocol-url";
import {
  captureDesignRuntimeScreenshot,
  reconcileDesignRuntimeSnapshot,
} from "./state/design-selection";
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
  /** A bounded first window receives speculative thumbnail captures. */
  autoCapture: boolean;
  /** Workspace-owned token mode applied inside the opaque frame runtime. */
  theme: string | null;
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
  theme,
}: DesignFrameRuntimeIframeProps) {
  const nativeRuntime = useNativeRuntime();
  // Owns the exact WindowProxy request connection for this iframe instance.
  const connectionRef = useRef<DesignFrameRuntimeConnection | null>(null);
  // The loaded node creates a fresh private MessagePort on every navigation.
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Tracks the exact load whose onLoad established a usable runtime. React
  // StrictMode can replay passive-effect cleanup without replaying the DOM ref.
  const loadedKeyRef = useRef<string | null>(null);
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
    theme,
  });
  latestRef.current = {
    workspaceId,
    folder,
    frame,
    active,
    selected,
    autoCapture,
    theme,
  };
  const loadKey = `${workspaceId}\u0000${frame.file}\u0000${frame.sourceVersion}`;

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

  /** The runtime withholds ready until onLoad transfers its private channel. */
  const setIframe = useCallback((node: HTMLIFrameElement | null) => {
    connectionRef.current?.destroy();
    connectionRef.current = null;
    iframeRef.current = node;
    if (!node) loadedKeyRef.current = null;
  }, []);

  const connectCurrentIframe = useCallback(() => {
    const node = iframeRef.current;
    if (!node) return;
    connectionRef.current?.destroy();
    const connection = connectDesignFrameRuntime(
      workspaceId,
      frame.file,
      frame.sourceVersion,
      node,
      { onSnapshot: handleSnapshot },
    );
    connectionRef.current = connection;
    if (!latestRef.current.active) return;
    void connection
      .setTheme(latestRef.current.theme)
      .then(handleSnapshot)
      .catch(() => {
        // A source navigation can replace this exact connection while its
        // first snapshot is queued; the next load owns the new channel.
      });
  }, [frame.file, frame.sourceVersion, handleSnapshot, workspaceId]);

  // Navigation/collapse tears down pending requests and idle raster work.
  // If StrictMode already delivered onLoad, its second effect setup restores
  // the connection that the simulated cleanup intentionally destroyed.
  useEffect(() => {
    if (loadedKeyRef.current === loadKey && connectionRef.current === null) {
      connectCurrentIframe();
    }
    return () => {
      cancelCaptureRef.current?.();
      cancelCaptureRef.current = null;
      connectionRef.current?.destroy();
      connectionRef.current = null;
    };
  }, [connectCurrentIframe, loadKey]);

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

  useEffect(() => {
    if (!active) return;
    const connection = connectionRef.current;
    if (!connection) return;
    void connection
      .setTheme(theme)
      .then(handleSnapshot)
      .catch(() => {
        // A source navigation racing a theme change is repaired by onLoad.
      });
  }, [active, handleSnapshot, theme]);

  const protocolSource = nativeRuntime.ready
    ? designProtocolFrameUrl({
        workspaceId,
        capability: protocolCapability,
        frame: frame.file,
        sourceVersion: frame.sourceVersion,
      })
    : null;
  const fallback = useDesignFrameDocument(
    workspaceId,
    frame.file,
    frame.sourceVersion,
    active && protocolSource === null,
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
      tabIndex={-1}
      className="bg-bg1 pointer-events-none block size-full border-0"
      aria-label={`${frame.title} design frame`}
      onLoad={() => {
        loadedKeyRef.current = loadKey;
        connectCurrentIframe();
      }}
    />
  );
}
