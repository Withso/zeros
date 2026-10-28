import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DESIGN_SURFACE_LAYOUT, DESIGN_SURFACE_LAYOUT_REQUEST, DESIGN_SURFACE_READY, type DesignSurfaceCost } from "@zeros/protocol/design-surface";
import { designProtocolFrameUrl } from "../../platform/bridge/design-protocol-url";
import { designSourceSurfaceBudget } from "./design-source-surfaces";
import { acquireDesignSourceVectorImage, designSourceLoadSlots, designSourceVectorCache, designSourceVectorKey, type DesignSourceLoadTicket, type DesignCachedSourceVector, type DesignSourceVectorRequest, type DesignSourceVectorTarget } from "./design-source-vector";
import { retainDesignResource } from "./state/design-resource-counters";
import { useDesignDocumentReplacement } from "./state/use-design-document-replacement";
import type { DesignDocumentReplacement } from "./state/design-document-replacements";
import { attachDesignSourceTiles } from "./design-source-scene";

interface SurfaceDocument {
  key: string;
  target: DesignSourceVectorTarget;
  url: string;
  sourceVersion: string;
  theme: string | null;
  cost: DesignSurfaceCost;
}

function SourceHtmlDocument({ entry, title, incoming, visible, holdSlot, onReady, onFailure, onRetired }: {
  entry: SurfaceDocument; title: string; incoming: boolean; visible: boolean; holdSlot: boolean;
  onReady(svg: unknown): void; onFailure(): void; onRetired(): void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const ticket = useRef<DesignSourceLoadTicket | null>(null);
  const [started, setStarted] = useState(false);
  const [ready, setReady] = useState(false);
  const callbacks = useRef({ onReady, onFailure, onRetired });
  callbacks.current = { onReady, onFailure, onRetired };
  useLayoutEffect(() => {
    const requested = designSourceLoadSlots.request(() => setStarted(true));
    ticket.current = requested;
    return () => { requested.release(); ticket.current = null; callbacks.current.onRetired(); };
  }, []);
  useLayoutEffect(() => started ? retainDesignResource("sourceDocumentBuffers") : undefined, [started]);
  useLayoutEffect(() => { if (ready && !holdSlot) ticket.current?.release(); }, [ready, holdSlot]);
  useLayoutEffect(() => {
    if (!started) return;
    let waiting = true;
    const node = iframe.current;
    let layoutFrame = 0;
    const deliverLayout = () => {
      if (!waiting || !node || node !== iframe.current) return;
      node.getBoundingClientRect();
      node.contentWindow?.postMessage({ kind: DESIGN_SURFACE_LAYOUT, sourceVersion: entry.sourceVersion, theme: entry.theme }, "*");
    };
    const paintLayout = () => {
      deliverLayout();
      window.cancelAnimationFrame(layoutFrame);
      layoutFrame = window.requestAnimationFrame(() => {
        layoutFrame = window.requestAnimationFrame(() => { layoutFrame = 0; deliverLayout(); });
      });
    };
    const failed = () => { if (waiting) { waiting = false; ticket.current?.release(); callbacks.current.onFailure(); } };
    // Queue waiting creates no browsing context. Once admitted, navigation
    // includes engine preparation; a loaded document owns the shorter deadline.
    let timer = window.setTimeout(failed, 30_000);
    const loaded = () => {
      if (!waiting) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(failed, 5_000);
      // Initial remote-frame geometry can arrive without a child resize event.
      // One parent paint delivers it even when the child's rAF is suspended.
      paintLayout();
    };
    let layoutRequested = false;
    const message = (event: MessageEvent) => {
      if (!waiting || event.source !== iframe.current?.contentWindow || !event.data ||
          event.data.sourceVersion !== entry.sourceVersion || event.data.theme !== entry.theme) return;
      if (event.data.kind === DESIGN_SURFACE_LAYOUT_REQUEST) {
        if (!layoutRequested) { layoutRequested = true; paintLayout(); }
        return;
      }
      if (event.data.kind !== DESIGN_SURFACE_READY) return;
      waiting = false; window.clearTimeout(timer); setReady(true);
      window.cancelAnimationFrame(layoutFrame);
      callbacks.current.onReady(event.data.svg);
    };
    node?.addEventListener("load", loaded);
    window.addEventListener("message", message);
    return () => {
      waiting = false; window.clearTimeout(timer);
      window.cancelAnimationFrame(layoutFrame);
      node?.removeEventListener("load", loaded); window.removeEventListener("message", message);
    };
  }, [started, entry]);
  return started ? <iframe ref={iframe} src={entry.url} sandbox="allow-scripts" tabIndex={-1} {...{ inert: "" }}
    aria-label={`${title} design surface`} aria-hidden={incoming || !visible || !ready || undefined}
    data-design-source-surface="" data-design-source-version={entry.sourceVersion}
    data-design-source-ready={ready ? "" : undefined}
    data-design-source-buffer={incoming ? "incoming" : "displayed"}
    data-design-source-offscreen={!visible ? "" : undefined}
    className="zd-design-document pointer-events-none absolute inset-0 block border-0"
    // A visibility:hidden native child can remain at a 0x0 viewport. Keep its
    // initial layout visible to Chromium but transparent until readiness; the
    // frame chrome stays hidden and the document remains inert throughout.
    style={{ visibility: !ready ? "visible" : !incoming && visible ? "inherit" : "hidden", opacity: ready ? undefined : 0 }} /> : null;
}

/** Reattach the loaded element, just as the PNG display cache does. Assigning
 * its URL to a new React img would still miss the first return paint. */
function SourceVectorImage({ vector, entry, incoming, visible, ready, covered, passive, onReady, onFailure }: {
  vector: DesignCachedSourceVector; entry: SurfaceDocument; incoming: boolean; visible: boolean; ready: boolean; covered: boolean; passive: boolean;
  onReady(): void; onFailure(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const tileRelease = useRef<(() => void) | null>(null);
  const callbacks = useRef({ onReady, onFailure }); callbacks.current = { onReady, onFailure };
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    const cached = vector.image;
    const claim = acquireDesignSourceVectorImage(vector);
    const node = claim.image;
    image.current = node;
    node.alt = ""; node.setAttribute("aria-hidden", "true"); node.decoding = "sync"; node.draggable = false;
    node.className = "zd-design-document pointer-events-none absolute inset-0 block border-0";
    node.dataset.designSourceSurface = ""; node.dataset.designSourceVector = "";
    node.dataset.designSourceVersion = entry.sourceVersion;
    const loaded = () => { if (node.complete && node.naturalWidth > 0) { vector.confirm(node); callbacks.current.onReady(); } };
    const failed = () => { vector.invalidate(); callbacks.current.onFailure(); };
    node.addEventListener("load", loaded); node.addEventListener("error", failed);
    if (node !== cached) node.src = vector.url;
    container.appendChild(node); loaded();
    return () => {
      tileRelease.current?.(); tileRelease.current = null;
      node.removeEventListener("load", loaded); node.removeEventListener("error", failed);
      node.remove(); image.current = null; claim.release();
      if (vector.image !== node) node.removeAttribute("src");
    };
  }, [entry.sourceVersion, vector]);
  useLayoutEffect(() => {
    const node = image.current;
    if (!node) return;
    node.dataset.designSourceBuffer = incoming ? "incoming" : "displayed";
    node.toggleAttribute("data-design-source-ready", ready);
    node.toggleAttribute("data-design-source-offscreen", !visible);
    node.style.visibility = incoming || !visible || !ready || covered ? "hidden" : "inherit";
  }, [vector, incoming, visible, ready, covered]);
  useLayoutEffect(() => {
    const node = image.current;
    if (!node || incoming || !visible || !ready || covered || !passive) return;
    const release = attachDesignSourceTiles(node, vector.key);
    tileRelease.current = release;
    return () => { release(); if (tileRelease.current === release) tileRelease.current = null; };
  }, [vector, incoming, visible, ready, covered, passive]);
  return <div ref={host} data-design-source-vector-host="" className="contents" />;
}

function SourceDocument({ entry, title, incoming, visible, retainHtml, allowLoad, replacement, onReady, onFailure }: {
  entry: SurfaceDocument; title: string; incoming: boolean; visible: boolean; retainHtml: boolean;
  allowLoad: boolean;
  replacement: DesignDocumentReplacement | null;
  onReady(entry: SurfaceDocument): void; onFailure(): void;
}) {
  const [admitted, setAdmitted] = useState(!incoming);
  const [vector, setVector] = useState<DesignCachedSourceVector | null>(null);
  const [cacheChecked, setCacheChecked] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [vectorReady, setVectorReady] = useState(false);
  const [vectorUnavailable, setVectorUnavailable] = useState(false);
  const [htmlReady, setHtmlReady] = useState(false);
  const callbacks = useRef({ onReady, onFailure });
  callbacks.current = { onReady, onFailure };
  const vectorRef = useRef<DesignCachedSourceVector | null>(null);
  const requestRef = useRef<DesignSourceVectorRequest | null>(null);
  // An owner can retire in the readiness callback before React commits the
  // pending image/effect. That allocation still belongs to this document.
  useLayoutEffect(() => {
    const request = designSourceVectorCache.open(entry.target);
    requestRef.current = request;
    vectorRef.current = request.cached;
    // The actual display claim confirms readiness synchronously when it can
    // reuse a loaded image. Another view's complete image is not this view's
    // readiness when a simultaneous consumer needs its own element.
    setVector(request.cached); setFromCache(!!request.cached); setVectorReady(false); setCacheChecked(true);
    return () => {
      request.close(); requestRef.current = null;
      vectorRef.current?.release(); vectorRef.current = null;
    };
  }, [entry]);
  useLayoutEffect(() => {
    if (!incoming) { setAdmitted(true); return; }
    const release = designSourceSurfaceBudget.acquireOverlap(entry.cost);
    setAdmitted(!!release);
    if (!release) callbacks.current.onFailure();
    return release ?? undefined;
  }, [entry, incoming]);
  useLayoutEffect(() => admitted && incoming ? replacement?.attach() : undefined, [admitted, incoming, replacement]);
  useLayoutEffect(() => {
    if (!vector) return;
    const release = retainDesignResource("sourceVectorBuffers");
    return () => { release(); vector.release(); };
  }, [vector]);
  const ready = useCallback((svg: unknown) => {
    setHtmlReady(true);
    if (!vectorRef.current) {
      let next: DesignCachedSourceVector | null = null;
      try { next = requestRef.current?.publish(svg) ?? null; } catch { /* Fall back through the existing bounded preview path. */ }
      if (next) {
        vectorRef.current = next; setVector(next);
        // Keep the confirmed outgoing buffer until this vector actually loads.
        // HTML readiness alone cannot commit an image that may fail to decode.
        if (incoming) return;
      }
      else {
        setVectorUnavailable(true);
        // An older engine omits SVG. An explicit unsupported/oversized result
        // from a current engine uses bounded previews, not hundreds of retained
        // browsing contexts outside the vector budget.
        if (svg !== undefined) { callbacks.current.onFailure(); return; }
      }
    }
    callbacks.current.onReady(entry);
  }, [entry, incoming]);
  const retired = useCallback(() => setHtmlReady(false), []);
  const failed = useCallback(() => { if (!vectorRef.current) callbacks.current.onFailure(); }, []);
  if (!admitted || !cacheChecked) return null;
  return <>
    {vector ? <SourceVectorImage vector={vector} entry={entry} incoming={incoming} visible={visible} ready={vectorReady}
      covered={retainHtml && htmlReady} passive={!retainHtml} onReady={() => { setVectorReady(true); callbacks.current.onReady(entry); }}
      onFailure={() => {
        setVectorUnavailable(true); setVectorReady(false); setVector(null); vectorRef.current = null;
        callbacks.current.onFailure();
      }} /> : null}
    {allowLoad && (retainHtml || (!vectorReady && !fromCache)) ? <SourceHtmlDocument entry={entry} title={title} incoming={incoming}
      visible={visible} holdSlot={!retainHtml && !vectorUnavailable} onReady={ready} onFailure={failed} onRetired={retired} /> : null}
  </>;
}

/** Ready HTML hands off to a browser vector image, then retires its browsing
 * context. Editing candidates keep their responsive HTML under the editor. */
export const DesignFrameSourceSurface = React.memo(function DesignFrameSourceSurface({ workspaceId, folder, directoryId, capability, file, title,
  sourceVersion, theme, width, height, cost, visible, retainHtml, allowLoad = true, onReady, onUnavailable, onRetired }: {
  workspaceId: string; capability: string; file: string; title: string;
  folder: string; directoryId: string; width: number; height: number;
  sourceVersion: string; theme: string | null; cost: DesignSurfaceCost;
  visible: boolean; retainHtml: boolean; allowLoad?: boolean;
  onReady(file: string, version: string): void;
  onUnavailable(file: string, version: string): void;
  onRetired(file: string, version: string): void;
}) {
  const url = designProtocolFrameUrl({ workspaceId, capability, frame: file, sourceVersion, surface: true, theme });
  const { nodes: requestedNodes, sourceBytes: requestedBytes, imageBytes: requestedImages } = cost;
  const requested = useMemo<SurfaceDocument | null>(() => {
    if (!url) return null;
    const target = { workspaceId, folder, directoryId, capability, file, sourceVersion, theme, width, height, imageBytes: requestedImages };
    return { url, sourceVersion, theme, target, key: designSourceVectorKey(target),
      cost: { nodes: requestedNodes, sourceBytes: requestedBytes, imageBytes: requestedImages } };
  }, [url, workspaceId, folder, directoryId, capability, file, sourceVersion, theme, width, height, requestedNodes, requestedBytes, requestedImages]);
  const [displayed, setDisplayed] = useState(requested);
  const [admitted, setAdmitted] = useState(false);
  const callbacks = useRef({ onReady, onUnavailable, onRetired, sourceVersion, displayed });
  callbacks.current = { onReady, onUnavailable, onRetired, sourceVersion, displayed };
  useLayoutEffect(() => () => {
    callbacks.current.onRetired(file, callbacks.current.displayed?.sourceVersion ?? callbacks.current.sourceVersion);
  }, [file]);
  const { nodes, sourceBytes, imageBytes } = displayed?.cost ?? cost;
  useLayoutEffect(() => {
    setAdmitted(false);
    return designSourceSurfaceBudget.request({ nodes, sourceBytes, imageBytes },
      () => setAdmitted(true), () => callbacks.current.onUnavailable(file, callbacks.current.sourceVersion));
  }, [nodes, sourceBytes, imageBytes, file]);
  const replacement = useDesignDocumentReplacement(allowLoad && requested && requested.key !== displayed?.key ? requested.key : null, false);
  const ready = useCallback((entry: SurfaceDocument) => {
    if (entry.key !== requested?.key) return;
    setDisplayed(entry);
    callbacks.current.onReady(file, entry.sourceVersion);
  }, [file, requested]);
  const failed = useCallback(() => callbacks.current.onUnavailable(file, callbacks.current.sourceVersion), [file]);
  useEffect(() => { if (!requested) failed(); }, [failed, requested]);
  if (!admitted || !requested || !displayed) return null;
  const buffers = [displayed, ...(replacement && requested.key !== displayed.key ? [requested] : [])];
  return <>{buffers.map(entry => <SourceDocument key={entry.key} entry={entry} title={title}
    incoming={entry.key !== displayed.key} visible={visible} retainHtml={retainHtml} allowLoad={allowLoad}
    replacement={replacement} onReady={ready} onFailure={failed} />)}</>;
});
