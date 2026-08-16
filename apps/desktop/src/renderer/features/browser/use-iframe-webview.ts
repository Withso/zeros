// ──────────────────────────────────────────────────────────
// useIframeWebview — React hook for an iframe-based browser tab
// ──────────────────────────────────────────────────────────
//
// Replaces the WebContentsView-based
// `useWebview` hook. Same surface area (ref, navigate, back,
// forward, reload, state) so the BrowserTab callsite doesn't need
// to restructure — but the implementation is an order of magnitude
// simpler:
//
//   - No main-process IPC for create / destroy / set-bounds /
//     set-visible. The iframe IS a DOM element; mounting and
//     unmounting the React component creates and destroys it.
//   - No setBounds. CSS positions the iframe; pan / zoom in a
//     parent React Flow canvas works naturally because
//     iframes inherit transforms.
//   - No setVisible. The bounded Browser deck keeps inactive tabs mounted in
//     stable DOM positions and makes their wrapper inert + invisible, which
//     preserves history, JS heap, scroll position, and form input.
//   - No screenshot backdrop. DOM popovers (dropdowns, chips,
//     tooltips) z-index above the iframe naturally; the iframe
//     is a sibling, not an OS overlay.
//
// What we DO need main for: clear cache, clear cookies (session-
// scoped operations the iframe can't perform itself). See
// apps/desktop/electron/ipc/iframe-session.ts.
//
// Cross-origin caveat: renderer DOM cannot read an external iframe's
// URL/title/favicon. Electron therefore observes frame navigation and resolves
// favicon artwork in main, then emits trusted iframe-name-scoped events here.
// Picker postMessages remain loopback-only.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isElectron,
  nativeInvoke,
  nativeListen,
  useNativeRuntime,
} from "../../platform/runtime";
import { isLoopbackUrl } from "../../shell/workbench/tabs/localhost-url";
import type { ForkSnapshotPayload } from "./variant-types";
import {
  reconcileObservedIframeHistory,
  snapshotIframeHistory,
  type IframeHistorySnapshot,
} from "./iframe-history";
import {
  beginBrowserTabFaviconNavigation,
  publishBrowserTabFavicon,
  useBrowserTabFavicon,
} from "./browser-tab-favicon-store";

export interface IframeWebviewState {
  currentUrl: string;
  title: string;
  faviconDataUrl: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}

/** Payload pushed by the in-iframe element picker. Field-for-field
 *  the same shape as the old WebContentsView SelectedElement so
 *  the chip / chat-submission code doesn't need to know which
 *  picker captured it. Events arrive through postMessage. */
export interface SelectedElement {
  selector: string;
  tag: string;
  componentName?: string | null;
  rect: { x: number; y: number; width: number; height: number };
  click: { x: number; y: number };
  styles?: Record<string, string>;
  altKey: boolean;
  hasShadowRoot: boolean;
  href: string;
  screenshot?: string;
  /** Picker-supplied DPR — useful for downstream renderers that
   *  need to scale screenshots back to CSS px. */
  devicePixelRatio?: number;
}

// ── Picker postMessage protocol ──────────────────────────────
// Parent ↔ iframe-main-world communication. All messages have
// type "zeros:picker:<op>".

const MSG_PREFIX = "zeros:picker:";

type PickerInbound =
  | { type: "zeros:picker:ready" }
  | { type: "zeros:picker:exited" }
  | { type: "zeros:picker:toggle-request" }
  | {
      type: "zeros:picker:single-selected";
      payload: Omit<SelectedElement, "screenshot">;
    }
  | {
      type: "zeros:picker:batch-selected";
      elements: Omit<SelectedElement, "screenshot">[];
      click: { x: number; y: number };
    }
  | {
      type: "zeros:picker:fork-result";
      requestId?: string;
      ok: boolean;
      error?: string;
      snapshot?: ForkSnapshotPayload;
    };

function isPickerMessage(data: unknown): data is PickerInbound {
  if (!data || typeof data !== "object") return false;
  const t = (data as { type?: unknown }).type;
  return typeof t === "string" && t.startsWith(MSG_PREFIX);
}

interface UseIframeWebviewOptions {
  /** Initial URL to load. Empty string = blank iframe. */
  initialUrl?: string;
  /** Stable iframe `name`, used to route trusted main-process navigation events
   *  to the correct Browser tab when several iframes are mounted. */
  frameName?: string;
}

export interface ForkSnapshotRequestResult {
  snapshot: ForkSnapshotPayload | null;
  error: string | null;
}

export interface UseIframeWebviewResult {
  /** Callback ref to attach to the <iframe> element — wires the
   *  load/error listeners the instant the node mounts. */
  ref: React.RefCallback<HTMLIFrameElement>;
  /** Last renderer-requested iframe src. Observed internal navigation updates
   *  `state.currentUrl`, not this value, so React never reloads SPA/link moves. */
  frameSrc: string;
  /** Incremented only for the browser-only fallback navigation path. Electron
   *  controls the existing named frame, so its node and history stay intact. */
  frameNavigationKey: number;
  /** Latest known state. Updated on iframe load events. */
  state: IframeWebviewState;
  navigate: (url: string) => void;
  back: () => void;
  forward: () => void;
  reload: () => void;
  /** Clear the shared iframe HTTP cache, then reload the current page. */
  hardReload: () => void;
  /** Clear HTTP cache for the iframe session (main-process call). */
  clearCache: () => Promise<void>;
  /** Clear cookies (only) for the iframe session. */
  clearCookies: () => Promise<void>;

  // ── Design Mode ────────────────────────────────────────
  // Main injects the picker only into loopback Browser frames; it posts
  // SelectedElement payloads back through the scoped listener below.
  designModeActive: boolean;
  selectedElements: SelectedElement[];
  altClickedElement: SelectedElement | null;
  setDesignMode: (active: boolean) => void;
  clearSelectedElements: () => void;
  removeSelectedElementAt: (index: number) => void;
  clearAltClickedElement: () => void;
  /** Ask the in-iframe picker to capture HTML+CSS for a selected element. */
  lastForkError: string | null;
  requestForkSnapshot: (
    selector: string,
    targetIndex?: number,
  ) => Promise<ForkSnapshotRequestResult>;
  forkPending: boolean;
}

const EMPTY_STATE: IframeWebviewState = {
  currentUrl: "",
  title: "",
  faviconDataUrl: null,
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
};

/** Bound and validate main-world fork output before it reaches tab persistence.
 *  Local dev pages share that world and can forge postMessages, so TypeScript's
 *  compile-time payload type is not a runtime trust boundary. */
function sanitizeForkSnapshot(value: unknown): ForkSnapshotPayload | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ForkSnapshotPayload>;
  const bounded = (input: unknown, max: number): input is string =>
    typeof input === "string" && input.length <= max;
  if (
    !bounded(raw.html, 4 * 1024 * 1024) ||
    !bounded(raw.css, 2_200_000) ||
    !bounded(raw.sourceSelector, 8192) ||
    typeof raw.contentHeight !== "number" ||
    !Number.isFinite(raw.contentHeight) ||
    typeof raw.contentWidth !== "number" ||
    !Number.isFinite(raw.contentWidth)
  )
    return null;

  const mock = raw.mockData;
  const images = Array.isArray(mock?.images)
    ? mock.images
        .filter((item): item is string => bounded(item, 8192))
        .slice(0, 200)
    : [];
  const texts = Array.isArray(mock?.texts)
    ? mock.texts
        .filter((item): item is string => bounded(item, 8192))
        .slice(0, 500)
    : [];

  let behaviorManifest = raw.behaviorManifest;
  if (behaviorManifest) {
    try {
      const validShape =
        Array.isArray(behaviorManifest.behaviors) &&
        Array.isArray(behaviorManifest.scriptRefs) &&
        Array.isArray(behaviorManifest.platformHints) &&
        typeof behaviorManifest.runtimeMode === "string" &&
        typeof behaviorManifest.sourceUrl === "string";
      if (
        !validShape ||
        behaviorManifest.behaviors.length > 2_000 ||
        behaviorManifest.scriptRefs.length > 500 ||
        behaviorManifest.platformHints.length > 100 ||
        JSON.stringify(behaviorManifest).length > 512 * 1024
      )
        behaviorManifest = undefined;
    } catch {
      behaviorManifest = undefined;
    }
  }

  return {
    html: raw.html,
    css: raw.css,
    sourceSelector: raw.sourceSelector,
    sourceOuterHTML:
      typeof raw.sourceOuterHTML === "string"
        ? raw.sourceOuterHTML.slice(0, 1_000_000)
        : "",
    contentHeight: Math.max(0, Math.min(raw.contentHeight, 10_000_000)),
    contentWidth: Math.max(0, Math.min(raw.contentWidth, 10_000_000)),
    mockData: { images, texts },
    componentName:
      typeof raw.componentName === "string"
        ? raw.componentName.slice(0, 512)
        : null,
    cssTruncated: raw.cssTruncated === true,
    extractionMode:
      raw.extractionMode === "precision-local" ||
      raw.extractionMode === "matched"
        ? raw.extractionMode
        : undefined,
    behaviorManifest,
  };
}

export function useIframeWebview(
  opts: UseIframeWebviewOptions = {},
): UseIframeWebviewResult {
  const { initialUrl = "", frameName } = opts;
  const nativeReady = useNativeRuntime().ready;

  // Typed nullable so the callback ref (setIframeNode) can assign
  // `ref.current` — an object ref initialized with null is otherwise
  // inferred as a read-only RefObject.
  const ref = useRef<HTMLIFrameElement | null>(null);
  // Local history stack — we maintain our own because we can't
  // read `iframe.contentWindow.history` across origins. Each
  // entry is a URL; `index` points at the current entry.
  // back/forward index into this; navigate() truncates the forward arm and
  // appends. Electron's trusted frame events push internal links and redirects,
  // including cross-origin navigations renderer DOM cannot inspect.
  const historyRef = useRef<string[]>(initialUrl ? [initialUrl] : []);
  const indexRef = useRef<number>(initialUrl ? 0 : -1);
  // A renderer-requested address load already owns a history entry; live-frame
  // Back/Forward identify their expected destination through the same slot. If
  // either redirects, replace that entry with the committed destination instead
  // of appending both URLs (which traps Back in a redirect loop).
  const pendingFrameNavigationRef = useRef<{
    requestedUrl: string;
    previousHistory: IframeHistorySnapshot;
    replaceFrameOnCancel: boolean;
  } | null>(
    initialUrl
      ? {
          requestedUrl: initialUrl,
          previousHistory: { entries: [], index: -1 },
          replaceFrameOnCancel: false,
        }
      : null,
  );
  // Invalidates async screenshot/fork work whenever its source document changes.
  const documentGenerationRef = useRef(0);
  // Declarative iframe request, deliberately separate from observed currentUrl.
  const [frameRequest, setFrameRequest] = useState({
    src: initialUrl,
    key: 0,
  });
  // Browser chrome state, including trusted cross-origin observations.
  const [state, setState] = useState<IframeWebviewState>(() => ({
    ...EMPTY_STATE,
    currentUrl: initialUrl,
    isLoading: Boolean(initialUrl),
  }));
  const faviconDataUrl = useBrowserTabFavicon(frameName);

  // ── State sync helper ───────────────────────────────────
  const updateState = useCallback((patch: Partial<IframeWebviewState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const recomputeNav = useCallback(() => {
    updateState({
      canGoBack: indexRef.current > 0,
      canGoForward: indexRef.current < historyRef.current.length - 1,
    });
  }, [updateState]);

  useEffect(() => {
    updateState({ faviconDataUrl });
  }, [faviconDataUrl, updateState]);

  // Electron can observe top-level child-frame navigation without violating
  // cross-origin DOM rules. The iframe `name` makes those trusted events
  // unambiguous across multiple mounted Browser tabs.
  useEffect(() => {
    if (!frameName || !nativeReady) return;
    let disposed = false;
    const unsubscribers: Array<() => void> = [];
    const onNavigation = (payload: {
      frameName?: unknown;
      url?: unknown;
      title?: unknown;
      loading?: unknown;
      cancelled?: unknown;
      cancelledUrl?: unknown;
      inPage?: unknown;
    }) => {
      if (payload?.frameName !== frameName || typeof payload.url !== "string")
        return;

      if (payload.cancelled === true) {
        const pending = pendingFrameNavigationRef.current;
        if (pending) {
          let requestedUrl = pending.requestedUrl;
          try {
            const parsedRequestedUrl = new URL(requestedUrl);
            parsedRequestedUrl.username = "";
            parsedRequestedUrl.password = "";
            requestedUrl = parsedRequestedUrl.href;
          } catch {
            // Keep the renderer-normalized string for the comparison below.
          }
          // A detached iframe can report its abort just before the replacement
          // starts. Do not let that older request cancel the renderer's newer
          // explicit address/back/forward navigation.
          if (payload.cancelledUrl !== requestedUrl) return;
        }
        if (pending) {
          historyRef.current = pending.previousHistory.entries;
          indexRef.current = pending.previousHistory.index;
        }
        pendingFrameNavigationRef.current = null;

        const restoredUrl = pending
          ? (historyRef.current[indexRef.current] ?? payload.url.trim())
          : payload.url.trim();
        beginBrowserTabFaviconNavigation(frameName, restoredUrl);
        let restoredTitle = "";
        if (restoredUrl) {
          try {
            restoredTitle = new URL(restoredUrl).hostname || "Browser";
          } catch {
            restoredTitle = "Browser";
          }
        }
        updateState({
          currentUrl: restoredUrl,
          title: restoredTitle,
          isLoading: false,
        });
        recomputeNav();

        // Browser-only fallback address/back/forward navigation remounts the
        // iframe. If that new frame cancelled before commit, reload the restored
        // entry into a fresh frame; Electron controls its existing named frame.
        if (pending?.replaceFrameOnCancel) {
          setFrameRequest((prev) => ({
            src: restoredUrl,
            key: prev.key + 1,
          }));
        }
        return;
      }

      let parsed: URL;
      try {
        parsed = new URL(payload.url);
      } catch {
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      parsed.username = "";
      parsed.password = "";

      const url = parsed.href;
      const loading = payload.loading === true;
      beginBrowserTabFaviconNavigation(frameName, url);
      if (loading) documentGenerationRef.current += 1;
      // `will-frame-navigate` is provisional: a redirect chain can report
      // several URLs. Commit only the finished/failure URL to Back history.
      if (!loading) {
        const reconciled = reconcileObservedIframeHistory(
          historyRef.current,
          indexRef.current,
          url,
          pendingFrameNavigationRef.current?.requestedUrl ?? null,
          payload.inPage === true,
        );
        historyRef.current = reconciled.entries;
        indexRef.current = reconciled.index;
        pendingFrameNavigationRef.current = null;
      }
      const rawTitle =
        typeof payload.title === "string" ? payload.title.trim() : "";
      updateState({
        currentUrl: url,
        title: rawTitle.slice(0, 512) || parsed.hostname || "Browser",
        isLoading: loading,
      });
      recomputeNav();
    };
    const onFavicon = (payload: {
      frameName?: unknown;
      pageUrl?: unknown;
      faviconDataUrl?: unknown;
    }) => {
      if (
        disposed ||
        payload?.frameName !== frameName ||
        typeof payload.pageUrl !== "string" ||
        typeof payload.faviconDataUrl !== "string"
      ) {
        return;
      }
      publishBrowserTabFavicon(
        frameName,
        payload.pageUrl,
        payload.faviconDataUrl,
      );
    };
    // Install both subscriptions before asking main for a catch-up snapshot;
    // otherwise a cached iframe can publish its favicon between two effects.
    void Promise.all([
      nativeListen("browser-frame-navigated", onNavigation),
      nativeListen("browser-frame-favicon", onFavicon),
    ]).then((off) => {
      if (disposed) {
        for (const unsubscribe of off) unsubscribe();
        return;
      }
      unsubscribers.push(...off);
      void nativeInvoke<{ ok: boolean }>("browser:reinject-picker", {
        frameName,
      }).catch(() => {});
    });
    return () => {
      disposed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [frameName, nativeReady, updateState, recomputeNav]);

  // ── Iframe load/error → state update ────────────────────
  //
  // The load + error listeners are attached via a CALLBACK REF
  // (`setIframeNode`, defined below) rather than a useEffect. The old
  // effect bailed whenever `ref.current` was null — which is exactly a
  // fresh tab: the iframe only mounts once the user leaves the empty
  // state, and the effect (keyed on the stable `updateState`) never
  // re-ran to attach the listener. So the `load` that clears
  // `isLoading` was missed and the reload spinner span forever. A
  // callback ref runs synchronously the moment the node mounts —
  // before it can fire its first async load — so the listener is
  // always in place.

  // ── Navigation primitives ───────────────────────────────
  //
  // Explicit navigation updates frameRequest + browser chrome. Trusted
  // observations update browser chrome only: binding iframe src directly to an
  // observed SPA URL would turn every pushState/link into an unwanted reload.
  // reload/hardReload remain imperative because their URL does not change.

  /** Browser-only/detached-frame fallback without coupling iframe src to the
   *  observed URL main reports for internal links and redirects. */
  const requestFrameNavigation = useCallback(
    (url: string, previousHistory: IframeHistorySnapshot) => {
      pendingFrameNavigationRef.current = {
        requestedUrl: url,
        previousHistory,
        replaceFrameOnCancel: true,
      };
      setFrameRequest((prev) => ({ src: url, key: prev.key + 1 }));
    },
    [],
  );

  const controlNativeFrame = useCallback(
    (
      action: "navigate" | "back" | "forward" | "reload",
      url?: string,
      fallback?: () => void,
    ): boolean => {
      if (!frameName || !isElectron()) return false;
      const generation = documentGenerationRef.current;
      const handleFailure = () => {
        if (documentGenerationRef.current !== generation) return;
        if (fallback) fallback();
        else updateState({ isLoading: false });
      };
      void nativeInvoke<{ ok: boolean }>("browser:control-iframe", {
        frameName,
        action,
        ...(url ? { url } : {}),
      })
        .then((result) => {
          if (!result.ok) handleFailure();
        })
        .catch(handleFailure);
      return true;
    },
    [frameName, updateState],
  );

  const navigate = useCallback(
    (url: string) => {
      if (!url) return;
      const previousHistory = snapshotIframeHistory(
        historyRef.current,
        indexRef.current,
      );
      const cur = historyRef.current[indexRef.current];
      if (url !== cur) {
        historyRef.current = historyRef.current.slice(0, indexRef.current + 1);
        historyRef.current.push(url);
        indexRef.current = historyRef.current.length - 1;
      }
      documentGenerationRef.current += 1;
      if (frameName) beginBrowserTabFaviconNavigation(frameName, url);
      pendingFrameNavigationRef.current = {
        requestedUrl: url,
        previousHistory,
        replaceFrameOnCancel: false,
      };
      if (
        !controlNativeFrame("navigate", url, () =>
          requestFrameNavigation(
            url,
            pendingFrameNavigationRef.current?.previousHistory ??
              previousHistory,
          ),
        )
      ) {
        requestFrameNavigation(url, previousHistory);
      }
      updateState({ currentUrl: url, isLoading: true, title: "" });
      recomputeNav();
    },
    [
      controlNativeFrame,
      frameName,
      requestFrameNavigation,
      updateState,
      recomputeNav,
    ],
  );

  const back = useCallback(() => {
    if (indexRef.current <= 0) return;
    const previousHistory = snapshotIframeHistory(
      historyRef.current,
      indexRef.current,
    );
    indexRef.current -= 1;
    const url = historyRef.current[indexRef.current];
    documentGenerationRef.current += 1;
    if (frameName) beginBrowserTabFaviconNavigation(frameName, url);
    pendingFrameNavigationRef.current = {
      requestedUrl: url,
      previousHistory,
      replaceFrameOnCancel: false,
    };
    if (
      !controlNativeFrame("back", undefined, () =>
        requestFrameNavigation(
          url,
          pendingFrameNavigationRef.current?.previousHistory ?? previousHistory,
        ),
      )
    ) {
      requestFrameNavigation(url, previousHistory);
    }
    updateState({ currentUrl: url, isLoading: true, title: "" });
    recomputeNav();
  }, [
    controlNativeFrame,
    frameName,
    requestFrameNavigation,
    updateState,
    recomputeNav,
  ]);

  const forward = useCallback(() => {
    if (indexRef.current >= historyRef.current.length - 1) return;
    const previousHistory = snapshotIframeHistory(
      historyRef.current,
      indexRef.current,
    );
    indexRef.current += 1;
    const url = historyRef.current[indexRef.current];
    documentGenerationRef.current += 1;
    if (frameName) beginBrowserTabFaviconNavigation(frameName, url);
    pendingFrameNavigationRef.current = {
      requestedUrl: url,
      previousHistory,
      replaceFrameOnCancel: false,
    };
    if (
      !controlNativeFrame("forward", undefined, () =>
        requestFrameNavigation(
          url,
          pendingFrameNavigationRef.current?.previousHistory ?? previousHistory,
        ),
      )
    ) {
      requestFrameNavigation(url, previousHistory);
    }
    updateState({ currentUrl: url, isLoading: true, title: "" });
    recomputeNav();
  }, [
    controlNativeFrame,
    frameName,
    requestFrameNavigation,
    updateState,
    recomputeNav,
  ]);

  const reload = useCallback(() => {
    const iframe = ref.current;
    if (!iframe) return;
    documentGenerationRef.current += 1;
    updateState({ isLoading: true });
    if (controlNativeFrame("reload")) return;
    // Same-origin: reload() preserves form state; cross-origin
    // falls back to re-setting src (forces a fresh load).
    try {
      iframe.contentWindow?.location.reload();
    } catch {
      // Re-poke src — set to a transient blank then back, otherwise
      // assigning the same string is a no-op.
      const cur = historyRef.current[indexRef.current];
      if (cur) {
        iframe.src = "about:blank";
        // Two-tick deferral so the about:blank load actually
        // happens before we re-set.
        setTimeout(() => {
          if (ref.current) ref.current.src = cur;
        }, 0);
      }
    }
  }, [controlNativeFrame, updateState]);

  const hardReload = useCallback(() => {
    const iframe = ref.current;
    if (!iframe) return;
    const cur = historyRef.current[indexRef.current];
    if (!cur) return;
    documentGenerationRef.current += 1;
    updateState({ isLoading: true });
    // A cache-buster query leaks into the visible URL/history and can alter app
    // routing. Electron can perform a real cache clear; reload only if the user
    // has not navigated elsewhere while that async operation was in flight.
    const reloadCurrent = () => {
      if (historyRef.current[indexRef.current] === cur) reload();
    };
    if (!isElectron()) {
      reloadCurrent();
      return;
    }
    void nativeInvoke("iframe:clear-cache").then(reloadCurrent, reloadCurrent);
  }, [reload, updateState]);

  const clearCache = useCallback(async () => {
    if (!isElectron()) return;
    await nativeInvoke("iframe:clear-cache");
  }, []);

  const clearCookies = useCallback(async () => {
    if (!isElectron()) return;
    await nativeInvoke("iframe:clear-cookies");
  }, []);

  // ── Design mode ──────────────────────────────────────────
  //
  // Picker auto-injects on every iframe load (main process hooks
  // did-frame-finish-load). The picker stays dormant until we
  // postMessage activate. All control + event flow uses
  // postMessage; only screenshot capture takes an IPC hop (main
  // process is the only thing that can call capturePage).

  const [designModeActive, setDesignModeActive] = useState(false);
  // Synchronous mode mirror used to reject late async screenshot completions.
  const designModeActiveRef = useRef(false);
  const [selectedElements, setSelectedElements] = useState<SelectedElement[]>(
    [],
  );
  const [altClickedElement, setAltClickedElement] =
    useState<SelectedElement | null>(null);
  const [forkPending, setForkPending] = useState(false);
  const [lastForkError, setLastForkError] = useState<string | null>(null);
  const forkResolverRef = useRef<
    ((result: ForkSnapshotRequestResult) => void) | null
  >(null);
  const activeForkRequestIdRef = useRef<string | null>(null);
  // Document generation the active fork request belongs to.
  const activeForkGenerationRef = useRef<number | null>(null);
  const forkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingFork = useCallback((error = "cancelled") => {
    if (forkTimeoutRef.current) {
      clearTimeout(forkTimeoutRef.current);
      forkTimeoutRef.current = null;
    }
    const resolve = forkResolverRef.current;
    forkResolverRef.current = null;
    activeForkRequestIdRef.current = null;
    activeForkGenerationRef.current = null;
    if (resolve) resolve({ snapshot: null, error });
    setForkPending(false);
    setLastForkError(error);
  }, []);

  // A selection belongs to one document. Clear it as soon as navigation starts
  // (not only after load) so stale chips/fork results cannot cross pages.
  useEffect(() => {
    if (!state.isLoading) return;
    setSelectedElements([]);
    setAltClickedElement(null);
    if (forkResolverRef.current) cancelPendingFork();
  }, [state.isLoading, cancelPendingFork]);

  // Closing a Browser tab while capture is in flight must settle the caller and
  // clear its timer without scheduling state updates on the unmounted hook.
  useEffect(
    () => () => {
      if (forkTimeoutRef.current) clearTimeout(forkTimeoutRef.current);
      forkTimeoutRef.current = null;
      activeForkRequestIdRef.current = null;
      activeForkGenerationRef.current = null;
      const resolve = forkResolverRef.current;
      forkResolverRef.current = null;
      if (resolve) resolve({ snapshot: null, error: "cancelled" });
    },
    [],
  );

  /** Change picker mode as one transaction: every exit path (button, shortcut,
   *  iframe Escape, external navigation) clears selections and settles a fork. */
  const setDesignMode = useCallback(
    (active: boolean) => {
      designModeActiveRef.current = active;
      setDesignModeActive(active);
      if (!active) {
        documentGenerationRef.current += 1;
        setSelectedElements([]);
        setAltClickedElement(null);
        if (forkResolverRef.current) cancelPendingFork();
      }
    },
    [cancelPendingFork],
  );

  /** Post a control message to the picker running inside the
   *  iframe. Fire-and-forget — if the picker isn't loaded yet,
   *  the message is dropped silently. The 'ready' event + this
   *  hook's load-event handler re-sync state once it is. */
  const postToPicker = useCallback(
    (type: string, extra: Record<string, unknown> = {}) => {
      const currentUrl = historyRef.current[indexRef.current] ?? "";
      if (!isLoopbackUrl(currentUrl)) return;
      const iframe = ref.current;
      const cw = iframe?.contentWindow;
      if (!cw) return;
      try {
        cw.postMessage({ type: MSG_PREFIX + type, ...extra }, "*");
      } catch {
        /* iframe might be cross-origin and contentWindow access
           throws on some browsers — postMessage itself is safe
           but reading the proxy can be touchy. Swallow. */
      }
    },
    [],
  );

  // ── Iframe node listeners (callback ref) ─────────────────
  //
  // `handleLoadRef` / `handleErrorRef` hold the LIVE handlers,
  // reassigned every render so the stable listeners below always see
  // the current designModeActive without needing to re-attach.
  const handleLoadRef = useRef<() => void>(() => {});
  const handleErrorRef = useRef<() => void>(() => {});

  handleLoadRef.current = () => {
    const iframe = ref.current;
    const next: Partial<IframeWebviewState> = { isLoading: false };
    if (iframe) {
      try {
        // Same-origin happy path — read canonical URL + title. Cross-
        // origin throws; we keep whatever navigate() set.
        const url = iframe.contentWindow?.location.href;
        const title = iframe.contentDocument?.title;
        if (url) next.currentUrl = url;
        if (title) next.title = title;
      } catch {
        /* cross-origin — keep the URL we navigated to */
      }
    }
    updateState(next);
    // Fresh document: drop stale picker selection + overlays and re-arm
    // design mode (the picker re-injects dormant on every load).
    setSelectedElements([]);
    setAltClickedElement(null);
    if (designModeActive) postToPicker("activate");
  };

  handleErrorRef.current = () => {
    // A failed load (dev server down / connection refused with no error
    // document) fires `error`, not `load` — clear the spinner so it
    // doesn't hang. Most failures still render a Chromium error page
    // and fire `load`; this just covers the rest.
    updateState({ isLoading: false });
  };

  // Stable listeners delegating to the live handlers above.
  const onFrameLoad = useCallback(() => handleLoadRef.current(), []);
  const onFrameError = useCallback(() => handleErrorRef.current(), []);

  // Callback ref: attach load/error the instant the iframe mounts —
  // synchronously during commit, so no async load can slip past before
  // the listener exists. Detaches on unmount / node swap.
  const setIframeNode = useCallback(
    (node: HTMLIFrameElement | null) => {
      const prev = ref.current;
      if (prev === node) return;
      if (prev) {
        prev.removeEventListener("load", onFrameLoad);
        prev.removeEventListener("error", onFrameError);
      }
      ref.current = node;
      if (node) {
        node.addEventListener("load", onFrameLoad);
        node.addEventListener("error", onFrameError);
      }
    },
    [onFrameLoad, onFrameError],
  );

  // Failsafe: never spin forever. If neither `load` nor `error` fires
  // within the window (a hung sub-resource, an unforeseen missed
  // event), force isLoading off. Re-armed whenever loading starts;
  // cleared the moment it ends.
  useEffect(() => {
    if (!state.isLoading) return;
    const id = setTimeout(() => updateState({ isLoading: false }), 30_000);
    return () => clearTimeout(id);
  }, [state.isLoading, updateState]);

  /** Capture a screenshot of the picked element via main process.
   *  Element rect comes from the picker in iframe-viewport CSS
   *  coords; we translate to main-window CSS coords by adding the
   *  iframe's bounding rect, then clamp to the visible iframe area
   *  so spillover (element scrolled partly off-screen) doesn't
   *  blow up capturePage. */
  const captureElementScreenshot = useCallback(
    async (rect: SelectedElement["rect"]): Promise<string | undefined> => {
      if (!isElectron()) return undefined;
      const iframe = ref.current;
      if (!iframe) return undefined;
      const ifr = iframe.getBoundingClientRect();
      // Canvas Mode transforms the iframe wrapper. Picker rects remain in the
      // iframe's unscaled CSS coordinates, while capturePage expects main-window
      // coordinates, so apply the live transform scale on both axes.
      const scaleX =
        iframe.offsetWidth > 0 ? ifr.width / iframe.offsetWidth : 1;
      const scaleY =
        iframe.offsetHeight > 0 ? ifr.height / iframe.offsetHeight : 1;
      // Intersection of element rect (translated to window coords)
      // with the iframe's visible region.
      const elLeft = ifr.left + rect.x * scaleX;
      const elTop = ifr.top + rect.y * scaleY;
      const elRight = elLeft + rect.width * scaleX;
      const elBottom = elTop + rect.height * scaleY;
      // Canvas frames can be panned beyond an overflow-hidden ancestor. Clamp
      // to every clipping ancestor as well as the iframe itself so capturePage
      // never screenshots browser chrome or a neighboring variant where the
      // selected element is not actually visible.
      let clipLeft = Math.max(0, ifr.left);
      let clipTop = Math.max(0, ifr.top);
      let clipRight = Math.min(window.innerWidth, ifr.right);
      let clipBottom = Math.min(window.innerHeight, ifr.bottom);
      for (let ancestor = iframe.parentElement; ancestor; ) {
        const style = window.getComputedStyle(ancestor);
        const rect = ancestor.getBoundingClientRect();
        if (/(auto|hidden|scroll|clip)/.test(style.overflowX)) {
          clipLeft = Math.max(clipLeft, rect.left);
          clipRight = Math.min(clipRight, rect.right);
        }
        if (/(auto|hidden|scroll|clip)/.test(style.overflowY)) {
          clipTop = Math.max(clipTop, rect.top);
          clipBottom = Math.min(clipBottom, rect.bottom);
        }
        ancestor = ancestor.parentElement;
      }
      const x = Math.max(clipLeft, elLeft);
      const y = Math.max(clipTop, elTop);
      const right = Math.min(clipRight, elRight);
      const bottom = Math.min(clipBottom, elBottom);
      const w = Math.max(0, right - x);
      const h = Math.max(0, bottom - y);
      if (w <= 0 || h <= 0) return undefined;
      try {
        const res = await nativeInvoke<{ ok: boolean; dataUrl?: string }>(
          "iframe-picker:capture-region",
          { x, y, width: w, height: h },
        );
        return res.ok ? res.dataUrl : undefined;
      } catch {
        return undefined;
      }
    },
    [],
  );

  /** Activate / deactivate picker + reinject latest script on enter. */
  useEffect(() => {
    if (designModeActive) {
      // During navigation the old document may already be gone while the new
      // picker is not injected yet. Re-arm after the committed load; the
      // picker's ready handshake is the complementary race-safe path.
      if (state.isLoading) return;
      if (isElectron()) {
        void nativeInvoke<{ ok: boolean }>("browser:reinject-picker", {
          frameName,
        }).catch(() => {});
      }
      postToPicker("activate");
      return;
    }
    postToPicker("deactivate");
  }, [designModeActive, frameName, state.isLoading, postToPicker]);

  // (The "re-arm design mode + clear stale chip on every load" logic
  // that used to live here is now part of the callback-ref load
  // handler above — handleLoadRef — so it can't miss a late-mounting
  // iframe either.)

  /** Forward Shift-release to the picker. Bug from the first
   *  Stage-2 ship: keyboard events go to whichever window has
   *  focus. If the user shift+clicks elements inside the iframe
   *  (focus transfers there), then moves the cursor to the React
   *  chrome before releasing Shift, the keyup lands HERE, not in
   *  the iframe. The iframe never sees the release and the batch
   *  never flushes.
   *
   *  Fix: at the renderer level, listen for any keyup of Shift
   *  while design mode is active and forward via postMessage.
   *  The picker's flush-batch handler is idempotent — if it
   *  already flushed (iframe heard the keyup itself), the parent
   *  forward is a no-op (pendingShiftPicks is empty). */
  useEffect(() => {
    if (!designModeActive) return;
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") postToPicker("flush-batch");
    };
    window.addEventListener("keyup", onKeyUp);
    return () => window.removeEventListener("keyup", onKeyUp);
  }, [designModeActive, postToPicker]);

  /** Listen for messages FROM the picker. Filter by source so we
   *  don't pick up postMessage spam from other windows / extensions.
   *  The picker shares contentWindow with the untrusted visited page, so
   *  the source check can't tell them apart. Strictly validate every field shape
   *  before any selection reaches the chat composer / agent loop — a forged
   *  message with a NaN/Infinity rect, a non-string selector, or a giant string
   *  is dropped rather than injected. (A per-load nonce would further authenticate
   *  the source, but needs main→renderer per-frame delivery + isolated-world
   *  injection — tracked as a follow-up; see the remediation notes.) */
  useEffect(() => {
    const STR_CAP = 8192;
    const isStr = (v: unknown): v is string =>
      typeof v === "string" && v.length <= STR_CAP;
    const isFiniteNum = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 10_000_000;
    const isRect = (r: unknown): boolean => {
      const o = r as Record<string, unknown> | null;
      return (
        !!o &&
        isFiniteNum(o.x) &&
        isFiniteNum(o.y) &&
        isFiniteNum(o.width) &&
        isFiniteNum(o.height) &&
        (o.width as number) >= 0 &&
        (o.height as number) >= 0
      );
    };
    const isValidSelected = (p: unknown): p is SelectedElement => {
      const o = p as Record<string, unknown> | null;
      if (!o || typeof o !== "object") return false;
      if (!isStr(o.selector) || !isStr(o.tag)) return false;
      if (!isRect(o.rect)) return false;
      const click = o.click as Record<string, unknown> | undefined;
      if (!click || !isFiniteNum(click.x) || !isFiniteNum(click.y))
        return false;
      if (o.componentName != null && !isStr(o.componentName)) return false;
      if (typeof o.altKey !== "boolean") return false;
      if (typeof o.hasShadowRoot !== "boolean") return false;
      if (!isStr(o.href)) return false;
      if (
        o.devicePixelRatio != null &&
        (!isFiniteNum(o.devicePixelRatio) || o.devicePixelRatio <= 0)
      )
        return false;
      if (o.styles != null) {
        if (typeof o.styles !== "object" || Array.isArray(o.styles))
          return false;
        const entries = Object.entries(o.styles as Record<string, unknown>);
        if (entries.length > 100) return false;
        for (const [k, v] of entries) {
          if (!isStr(k) || !isStr(v)) return false;
        }
      }
      return true;
    };
    const onMessage = async (ev: MessageEvent) => {
      const iframe = ref.current;
      if (!iframe) return;
      if (ev.source !== iframe.contentWindow) return;
      // Picker code is injected only on loopback pages. A public page shares
      // the iframe's contentWindow proxy and could otherwise forge the same
      // protocol to surface selections or append content into a chat.
      if (!isLoopbackUrl(ev.origin)) return;
      if (!isPickerMessage(ev.data)) return;
      const msg = ev.data;
      const op = msg.type.slice(MSG_PREFIX.length);
      if (op === "ready") {
        // Picker booted (initial inject or post-navigation re-inject).
        // If design mode is supposed to be on, tell it to activate.
        if (designModeActive) postToPicker("activate");
        return;
      }
      if (op === "exited") {
        setDesignMode(false);
        return;
      }
      if (op === "toggle-request") {
        setDesignMode(!designModeActive);
        return;
      }
      if (op === "single-selected") {
        const payload = (msg as { payload: unknown }).payload;
        if (!isValidSelected(payload)) return; // Drop a malformed or forged selection.
        const generation = documentGenerationRef.current;
        const screenshot = await captureElementScreenshot(payload.rect);
        if (
          generation !== documentGenerationRef.current ||
          !designModeActiveRef.current
        )
          return;
        const enriched: SelectedElement = { ...payload, screenshot };
        if (enriched.altKey) {
          // ⌥+click: route through altClickedElement so the chat
          // composer can pick it up directly. Don't add to selectedElements — alt-click
          // is a separate flow.
          setAltClickedElement(enriched);
        } else {
          setSelectedElements([enriched]);
        }
        return;
      }
      if (op === "batch-selected") {
        const m = msg as { elements?: unknown };
        // Validate the batch (bounded length + every element well-formed).
        if (!Array.isArray(m.elements) || m.elements.length > 200) return;
        const valid = m.elements.filter(isValidSelected);
        if (valid.length === 0) return;
        const generation = documentGenerationRef.current;
        // Capture screenshots in parallel — these are independent
        // IPC calls and the user just released Shift expecting
        // the chip to appear immediately.
        const enriched = await Promise.all(
          valid.map(async (el) => ({
            ...el,
            screenshot: await captureElementScreenshot(el.rect),
          })),
        );
        if (
          generation !== documentGenerationRef.current ||
          !designModeActiveRef.current
        )
          return;
        setSelectedElements(enriched);
        return;
      }
      if (op === "fork-result") {
        const m = msg as {
          requestId?: string;
          ok: boolean;
          snapshot?: ForkSnapshotPayload;
          error?: string;
        };
        // Rapid re-forks can leave an older capture resolving after a newer one
        // starts. Never let that stale result satisfy the current request.
        if (!m.requestId || m.requestId !== activeForkRequestIdRef.current)
          return;
        if (activeForkGenerationRef.current !== documentGenerationRef.current) {
          cancelPendingFork();
          return;
        }
        const snapshot = m.ok ? sanitizeForkSnapshot(m.snapshot) : null;
        const error = snapshot
          ? null
          : (m.error ?? (m.ok ? "invalid-payload" : "capture-failed"));
        setForkPending(false);
        setLastForkError(error);
        if (forkTimeoutRef.current) {
          clearTimeout(forkTimeoutRef.current);
          forkTimeoutRef.current = null;
        }
        const resolve = forkResolverRef.current;
        forkResolverRef.current = null;
        activeForkRequestIdRef.current = null;
        activeForkGenerationRef.current = null;
        if (resolve) {
          resolve({
            snapshot,
            error,
          });
        }
        return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    designModeActive,
    setDesignMode,
    postToPicker,
    captureElementScreenshot,
    cancelPendingFork,
  ]);

  const clearSelectedElements = useCallback(() => {
    setSelectedElements([]);
    postToPicker("clear-selections");
  }, [postToPicker]);

  const removeSelectedElementAt = useCallback(
    (index: number) => {
      // If this was the last pill, send clear-selections instead so
      // the picker fully unfreezes (vs. just removing one overlay
      // and leaving the picker frozen with no chip and nothing to
      // dismiss). Read length before setState so we don't depend on
      // a closure that hasn't observed our update yet.
      const willBeEmpty = selectedElements.length === 1;
      setSelectedElements((prev) => prev.filter((_, i) => i !== index));
      if (willBeEmpty) {
        postToPicker("clear-selections");
      } else {
        postToPicker("remove-selection-at", { index });
      }
    },
    [selectedElements.length, postToPicker],
  );

  const clearAltClickedElement = useCallback(() => {
    setAltClickedElement(null);
  }, []);

  const requestForkSnapshot = useCallback(
    (
      selector: string,
      targetIndex?: number,
    ): Promise<ForkSnapshotRequestResult> => {
      if (forkResolverRef.current) cancelPendingFork("superseded");
      const requestId = `fork-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      setForkPending(true);
      setLastForkError(null);
      return new Promise((resolve) => {
        activeForkRequestIdRef.current = requestId;
        activeForkGenerationRef.current = documentGenerationRef.current;
        forkResolverRef.current = resolve;
        forkTimeoutRef.current = setTimeout(() => {
          if (activeForkRequestIdRef.current !== requestId) return;
          forkTimeoutRef.current = null;
          forkResolverRef.current = null;
          activeForkRequestIdRef.current = null;
          activeForkGenerationRef.current = null;
          setForkPending(false);
          setLastForkError("timeout");
          resolve({ snapshot: null, error: "timeout" });
        }, 20000);
        postToPicker("fork-request", {
          selector,
          index: targetIndex,
          requestId,
        });
      });
    },
    [cancelPendingFork, postToPicker],
  );

  return {
    ref: setIframeNode,
    frameSrc: frameRequest.src,
    frameNavigationKey: frameRequest.key,
    state,
    navigate,
    back,
    forward,
    reload,
    hardReload,
    clearCache,
    clearCookies,
    designModeActive,
    selectedElements,
    altClickedElement,
    setDesignMode,
    clearSelectedElements,
    removeSelectedElementAt,
    clearAltClickedElement,
    requestForkSnapshot,
    forkPending,
    lastForkError,
  };
}
