// ──────────────────────────────────────────────────────────
// Browser Tab — embedded browser chrome
// ──────────────────────────────────────────────────────────
//
// Two browser panes share the workbench tab model:
//   - ordinary preview/design tabs render their existing iframe tree;
//   - conversation-owned agent tabs attach the exact isolated main-process
//     WebContentsView used by the canonical browser tools.
//
// Per-tab state:
//   - `tab.url`   — last navigated URL (persisted)
//   - `tab.title` — page title (persisted; cross-origin pages
//     fall back to URL slug since contentDocument is unreadable)
//
// Supported interactions:
//   - Type a URL, hit Enter → loads
//   - Back / forward / reload buttons work
//   - URL bar tracks internal navigation
//   - ⋯ menu: Hard Reload, DevTools / separate preview window, device
//     toolbar, page Appearance (per tab), Clear Cache + Clear Cookies via IPC
//   - Float preview: the live viewport moves over the chat without reloading

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { BrowserAppearance } from "@zeros/protocol/browser-tools";
import { workspacePreviewAvailable } from "../../../platform/cloud-workspace-access";
import { isCloudWorkspace, parseCloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { useCloudWorkspaceAccountAccess } from "../../../features/team/cloud-workspace-account-access";
import {
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  MousePointer2,
  Palette,
  PictureInPicture2,
  RotateCw,
  Globe,
  GitFork,
  X,
} from "lucide-react";
import {
  BrowserDeviceToolbar,
  browserDeviceLayout,
  browserDevicePreset,
  browserDevicePresetForSize,
  browserDeviceResizeSize,
  clampBrowserDeviceSize,
  normalizeBrowserDevicePreset,
  type BrowserDevicePresetId,
  type BrowserDeviceZoom,
} from "../../../features/browser/browser-device-toolbar";
import { beginDesignPointerGesture } from "../../../features/design-workspace/design-pointer-gesture";
import {
  browserFloatKey,
  dockBrowserTab,
  floatBrowserTab,
  moveNodePreservingState,
  onBrowserFloatSlotRemoved,
  useBrowserFloatEntries,
  useBrowserFloatSlot,
  useBrowserTabFloating,
} from "../../../features/browser/browser-float-store";
import {
  browserDevToolsUnavailableReason,
  browserWindowUnavailableReason,
  inspectBrowserFrame,
  openBrowserWindow,
} from "../../../features/browser/browser-window-actions";
import { stageSelectedElementsInComposer } from "../../../features/browser/element-composer-staging";
import { isPickerPageUrl } from "../../../features/browser/picker-message-guard";
import {
  useIframeWebview,
  type SelectedElement,
} from "../../../features/browser/use-iframe-webview";
import { BrowserVariantFrame } from "../../../features/browser/browser-variant-frame";
import {
  CanvasKnobHandles,
  type CanvasKnobAxis,
} from "../../../features/browser/canvas-knob-handles";
import {
  BROWSER_VARIANT_GAP_PX,
  BROWSER_VARIANT_MIN_HEIGHT,
  BROWSER_VARIANT_MIN_WIDTH,
  browserCanvasStripWidth,
  type BrowserTabVariant,
  variantNeedsLiveLayer,
} from "../../../features/browser/variant-types";
import { applyForkManifestFields } from "../../../features/browser/variant-artifact";
import { BrowserAppearanceMenu } from "../../../features/browser/browser-appearance-menu";
import {
  useWorkspaceStore,
  useWorkspaceDispatch,
  type PendingComposerAppend,
} from "../../../state/store";
import { nativeInvoke, useNativeRuntime } from "../../../platform/runtime";
import { useAgentSessions } from "../../../features/agent/sessions-hooks";
import {
  BROWSER_DEFAULT_HEIGHT,
  BROWSER_DEFAULT_WIDTH,
  BROWSER_MIN_HEIGHT,
  BROWSER_MIN_WIDTH,
  BROWSER_VIEWPORT_PRESETS,
  type WorkbenchTab,
} from "../tab-model";
import { Button } from "../../../shared/ui";
import {
  isLoopbackUrl,
  normalizeBrowserUrl,
  resolveBrowserAddressInput,
} from "./localhost-url";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from "../../../shared/ui/primitives";
import { toast } from "../../../shared/ui/primitives/elements";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { BrowserStartPage } from "./browser-start-page";
import { requestWorkbenchCollapse } from "../workbench-visibility-controller";
import {
  clearPreviewRuntimeForTab,
  consumePreviewNavigation,
  isPreviewRuntimeUrlForTab,
  previewNavigationForTab,
  previewNavigationDescriptor,
  previewRuntimeStateForTab,
  reconcilePreviewRuntimeUrlForTab,
  redactPreviewRuntimeTextForTab,
  stagePreviewNavigation,
} from "../../../features/browser/preview-navigation";
import { useBrowserSessionAgentPresence } from "@/renderer/features/browser/browser-session-activity-store";
import {
  hasOpenNativeBrowserBlockingOverlay,
  nativeBrowserOverlayShouldParkSurface,
  NativeBrowserSurfaceCommandQueue,
  requestImmediateNativeBrowserSurfacePark,
} from "@/renderer/features/browser/native-browser-overlay";
import { listenForNativeSurfaceOverlayIntent } from "@/renderer/shared/ui/native-surface-overlay";
import { PanelHeader } from "@/renderer/shared/ui/primitives/panel-header";
import {
  WorkbenchEmptyState,
  WorkbenchTabToolbar,
  useWorkbenchStatusSource,
} from "../tab-status";

// URL normalization lives in ./localhost-url. Browser navigation accepts
// ordinary http(s) sites; Design/Canvas are gated separately to loopback URLs.

const EMPTY_BROWSER_VARIANTS: BrowserTabVariant[] = [];
const PREVIEW_RENEW_AHEAD_MS = 5 * 60_000;
const PREVIEW_RENEW_RETRY_MS = 15_000;

// ── Component ─────────────────────────────────────────────

interface BrowserTabProps {
  tab: WorkbenchTab;
  active: boolean;
  /** Persisted workbench scope; required when this iframe is retained while a
   * different workspace is active. */
  scope?: string;
}

export function BrowserTab(props: BrowserTabProps) {
  const previewFolder = useWorkspaceStore((state) =>
    props.tab.previewSource
      ? state.chats.find((chat) => chat.id === props.tab.previewSource?.chatId)
          ?.folder
      : undefined,
  );
  const folder = props.scope ?? previewFolder ?? "";
  const cloudPreviews = useCloudWorkspaceAccountAccess(parseCloudWorkspaceKey(folder)?.organizationId);
  if (!props.tab.browserConversationId && (props.tab.previewSource || isLoopbackUrl(normalizeBrowserUrl(props.tab.url ?? "") ?? "")) && isCloudWorkspace(folder) && !cloudPreviews) return null;
  if (
    !props.tab.browserConversationId &&
    (props.tab.previewSource ||
      isLoopbackUrl(normalizeBrowserUrl(props.tab.url ?? "") ?? "")) &&
    !workspacePreviewAvailable(props.scope ?? previewFolder ?? "")
  ) {
    return <UnavailableBrowser />;
  }
  return props.tab.browserConversationId ? (
    <NativeAgentBrowserTab {...props} />
  ) : (
    <IframeBrowserTab {...props} scope={folder} />
  );
}

function UnavailableBrowser() {
  const message = "Cloud preview URLs are not configured for this build.";
  const managed = useWorkbenchStatusSource({
    error: message,
    pending: false,
    primary: true,
  });
  return managed ? (
    <WorkbenchEmptyState type="browser" />
  ) : (
    <p className="text-fg2 p-4 text-sm">{message}</p>
  );
}

/** The workbench and agent share one Electron WebContentsView. Attaching moves
 * that view from its hidden parking window into this exact rectangle; it does
 * not reload, copy cookies, or create a second page. */
function NativeAgentBrowserTab({ tab, active, scope }: BrowserTabProps) {
  const dispatch = useWorkspaceDispatch();
  const conversationId = tab.browserConversationId;
  const presence = useBrowserSessionAgentPresence(conversationId, active);
  const activity = presence.activity;
  const browserSessionId =
    activity && activity.status !== "closed"
      ? activity.browserSessionId
      : undefined;
  const surfaceIdRef = useRef(`workbench:${tab.id}`);
  const hostRef = useRef<HTMLDivElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const attachedSessionRef = useRef<string | null>(null);
  const navigationSequenceRef = useRef(0);
  const submittedAddressRef = useRef<string | null>(null);
  const [address, setAddress] = useState(tab.url ?? "");
  const [editingAddress, setEditingAddress] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const retryAttach = useRef<(() => Promise<void>) | null>(null);
  const managed = useWorkbenchStatusSource(
    {
      error: surfaceError,
      pending: restoring,
      primary: true,
      hasContent:
        attachedSessionRef.current === browserSessionId && !!browserSessionId,
      retry: () => (active ? retryAttach.current?.() : undefined),
    },
    browserSessionId,
  );
  const [blockingOverlayOpen, setBlockingOverlayOpen] = useState(false);
  const [overlayCapture, setOverlayCapture] = useState<string | null>(null);
  const lastOverlayCaptureRef = useRef<string | null>(null);
  const lastOverlayCaptureSessionRef = useRef<string | null>(null);
  const lastOverlayCaptureUrlRef = useRef<string | null>(null);
  const [surfaceCommands] = useState(
    () => new NativeBrowserSurfaceCommandQueue(),
  );
  if (
    submittedAddressRef.current &&
    activity?.url === submittedAddressRef.current
  ) {
    submittedAddressRef.current = null;
  }
  useEffect(() => {
    if (editingAddress) return;
    const confirmedAddress = activity?.url || tab.url || "";
    if (
      submittedAddressRef.current &&
      confirmedAddress !== submittedAddressRef.current
    ) {
      return;
    }
    submittedAddressRef.current = null;
    setAddress(confirmedAddress);
  }, [activity?.url, editingAddress, tab.url]);

  useEffect(() => {
    if (!active || !browserSessionId) {
      setBlockingOverlayOpen(false);
      return;
    }
    const refresh = () => {
      const next = hasOpenNativeBrowserBlockingOverlay(document);
      setBlockingOverlayOpen((current) => (current === next ? current : next));
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state", "role"],
    });
    const unlistenIntent = listenForNativeSurfaceOverlayIntent((open) => {
      requestImmediateNativeBrowserSurfacePark(
        {
          overlayOpening: open,
          browserSessionId,
          surfaceId: surfaceIdRef.current,
        },
        (request) => {
          // Main handles this non-async command synchronously, before the
          // portal's first renderer paint. The layout effect cleanup repeats
          // the ordinary detach as an acknowledged, serialized fallback.
          void nativeInvoke<boolean>("browser_session_park", request).catch(
            () => false,
          );
          return true;
        },
      );
      setBlockingOverlayOpen(
        open || hasOpenNativeBrowserBlockingOverlay(document),
      );
    });
    return () => {
      observer.disconnect();
      unlistenIntent();
    };
  }, [active, browserSessionId]);

  useEffect(() => {
    if (!browserSessionId) {
      setOverlayCapture(null);
      lastOverlayCaptureRef.current = null;
      lastOverlayCaptureSessionRef.current = null;
      lastOverlayCaptureUrlRef.current = null;
      return;
    }
    const captureUrl = activity?.url ?? tab.url ?? "";
    if (lastOverlayCaptureSessionRef.current !== browserSessionId) {
      lastOverlayCaptureSessionRef.current = browserSessionId;
      lastOverlayCaptureUrlRef.current = null;
      lastOverlayCaptureRef.current = null;
      setOverlayCapture(null);
    }
    // Keep one same-session snapshot warm while the native guest is live. A
    // portal can then park it before its first paint; the refresh below updates
    // that retained image after each overlay intent without exposing a blank.
    if (
      !blockingOverlayOpen &&
      lastOverlayCaptureRef.current &&
      lastOverlayCaptureUrlRef.current === captureUrl
    ) {
      return;
    }
    let disposed = false;
    void nativeInvoke<{ dataUrl?: string | null }>("browser_session_capture", {
      browserSessionId,
    })
      .then((result) => {
        if (disposed) return;
        const captured = result?.dataUrl ?? null;
        if (captured) {
          lastOverlayCaptureRef.current = captured;
          lastOverlayCaptureUrlRef.current = captureUrl;
        }
        setOverlayCapture(captured ?? lastOverlayCaptureRef.current);
      })
      .catch(() => {
        if (!disposed) setOverlayCapture(lastOverlayCaptureRef.current);
      })
      .finally(() => undefined);
    return () => {
      disposed = true;
    };
  }, [activity?.url, blockingOverlayOpen, browserSessionId, tab.url]);

  const parkForOverlay = nativeBrowserOverlayShouldParkSurface({
    overlayOpen: blockingOverlayOpen,
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    const detach = (id: string | null) => {
      if (!id) return;
      void surfaceCommands
        .enqueue(() =>
          nativeInvoke("browser_session_detach", {
            browserSessionId: id,
            surfaceId: surfaceIdRef.current,
          }),
        )
        .catch(() => undefined);
      if (attachedSessionRef.current === id) attachedSessionRef.current = null;
    };
    if (!active || parkForOverlay || !host || !browserSessionId) {
      detach(attachedSessionRef.current);
      setRestoring(false);
      return;
    }

    if (
      attachedSessionRef.current &&
      attachedSessionRef.current !== browserSessionId
    ) {
      detach(attachedSessionRef.current);
    }
    let disposed = false;
    let frame = 0;
    let request: Promise<unknown> | null = null;
    let rerun = false;
    const retryWaiters = new Set<() => void>();
    const attach = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || !host.isConnected) return;
        const rect = host.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        if (request) {
          rerun = true;
          return;
        }
        setRestoring(true);
        request = surfaceCommands
          .enqueue(() =>
            nativeInvoke("browser_session_attach", {
              browserSessionId,
              surfaceId: surfaceIdRef.current,
              bounds: {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            }),
          )
          .then((state) => {
            if (disposed) return;
            attachedSessionRef.current = state ? browserSessionId : null;
            setRestoring(false);
            setSurfaceError(
              state ? null : "The live browser session is no longer available.",
            );
          })
          .catch((error) => {
            if (disposed) return;
            attachedSessionRef.current = null;
            setRestoring(false);
            setSurfaceError(
              error instanceof Error
                ? error.message
                : "The live browser could not be attached.",
            );
          })
          .finally(() => {
            request = null;
            if (!disposed && rerun) {
              rerun = false;
              attach();
            }
            for (const resolve of retryWaiters) resolve();
            retryWaiters.clear();
          });
      });
    };
    const retry = () =>
      new Promise<void>((resolve) => {
        retryWaiters.add(resolve);
        attach();
      });
    retryAttach.current = retry;
    const observer = new ResizeObserver(attach);
    observer.observe(host);
    window.addEventListener("resize", attach);
    window.addEventListener("scroll", attach, true);
    attach();
    return () => {
      disposed = true;
      if (retryAttach.current === retry) retryAttach.current = null;
      for (const resolve of retryWaiters) resolve();
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", attach);
      window.removeEventListener("scroll", attach, true);
      detach(browserSessionId);
    };
  }, [active, browserSessionId, parkForOverlay, surfaceCommands]);

  const control = useCallback(
    async (
      tool: "open" | "back" | "forward" | "reload",
      argumentsValue: Record<string, unknown> = {},
    ) => {
      if (!browserSessionId) {
        toast.error("The live browser session is unavailable.");
        return false;
      }
      try {
        const result = (await nativeInvoke("browser_session_control", {
          browserSessionId,
          tool,
          arguments: argumentsValue,
        })) as {
          success?: boolean;
          content?: Array<{ type?: string; text?: string }>;
        };
        if (result?.success === false) {
          throw new Error(
            result.content?.find((item) => item.type === "text")?.text ||
              "Browser action failed.",
          );
        }
        setSurfaceError(null);
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Browser action failed.",
        );
        return false;
      }
    },
    [browserSessionId],
  );

  const navigate = useCallback(() => {
    const url = resolveBrowserAddressInput(address);
    if (!url) {
      toast.error("Enter a search or valid http(s) URL");
      return;
    }
    const sequence = ++navigationSequenceRef.current;
    submittedAddressRef.current = url;
    setAddress(url);
    addressInputRef.current?.blur();
    const confirmedAddress = activity?.url || tab.url || "";
    void control("open", { url }).then((succeeded) => {
      if (!succeeded && navigationSequenceRef.current === sequence) {
        submittedAddressRef.current = null;
        setAddress(confirmedAddress);
      }
    });
  }, [activity?.url, address, control, tab.url]);

  const changeAppearance = useCallback(
    (appearance: BrowserAppearance | undefined) => {
      dispatch({
        type: "UPDATE_WORKBENCH_TAB",
        id: tab.id,
        scope,
        updates: { appearance },
      });
      if (!browserSessionId) return;
      // The browser session controller resends on the session's next state.
      void nativeInvoke("browser_session_appearance", {
        browserSessionId,
        appearance: appearance ?? "system",
      }).catch(() => undefined);
    },
    [browserSessionId, dispatch, scope, tab.id],
  );

  const awaitingConfirmation = activity?.status === "awaiting-confirmation";
  const closed = activity?.status === "closed";
  const browserLocked = presence.active || awaitingConfirmation;
  const placeholder = blockingOverlayOpen
    ? null
    : surfaceError
      ? managed
        ? "Retry to load the preview."
        : surfaceError
      : closed
        ? "This browser session has closed. The agent can open it again."
        : !browserSessionId
          ? "The agent’s browser will appear here when it opens a page."
          : restoring
            ? "Connecting to the live browser…"
            : null;

  return (
    <div className="bg-bg1 flex min-h-0 flex-1 flex-col overflow-hidden">
      <WorkbenchTabToolbar>
        <PanelHeader size="window" className="h-9">
          <Tooltip label="Back">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-fg2 hover:text-fg1 size-6 disabled:opacity-40"
              disabled={
                !browserSessionId ||
                browserLocked ||
                activity?.canGoBack === false
              }
              onClick={() => void control("back")}
              aria-label="Back"
            >
              <ChevronLeft size={14} />
            </Button>
          </Tooltip>
          <Tooltip label="Forward">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-fg2 hover:text-fg1 size-6 disabled:opacity-40"
              disabled={
                !browserSessionId ||
                browserLocked ||
                activity?.canGoForward === false
              }
              onClick={() => void control("forward")}
              aria-label="Forward"
            >
              <ChevronRight size={14} />
            </Button>
          </Tooltip>
          <Tooltip label={activity?.loading ? "Loading…" : "Reload"}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-fg2 hover:text-fg1 size-6 disabled:opacity-40"
              disabled={!browserSessionId || browserLocked}
              onClick={() => void control("reload")}
              aria-label="Reload"
            >
              {activity?.loading ? (
                <ZerosSpinner size={16} />
              ) : (
                <RotateCw size={14} />
              )}
            </Button>
          </Tooltip>
          <form
            className="min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              navigate();
            }}
          >
            <div className="bg-bg2 focus-within:border-highlighted-bright flex h-6 items-center rounded-sm border border-transparent px-2">
              {activity?.faviconDataUrl ? (
                <img
                  src={activity.faviconDataUrl}
                  alt=""
                  className="mr-1.5 size-3.5 shrink-0 rounded-[2px]"
                />
              ) : (
                <Globe
                  className="text-fg3 mr-1.5 size-3.5 shrink-0"
                  aria-hidden="true"
                />
              )}
              <input
                ref={addressInputRef}
                aria-label="Browser URL"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                onFocus={(event) => {
                  setEditingAddress(true);
                  event.currentTarget.select();
                }}
                onBlur={() => setEditingAddress(false)}
                disabled={!browserSessionId || browserLocked}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                placeholder="Search or enter URL"
                className="text-fg1 placeholder:text-fg3 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm outline-none disabled:cursor-not-allowed"
              />
            </div>
          </form>
          {/* Appearance is a tab preference, so the menu stays available while
              the agent drives or before it opens a page. */}
          <DropdownMenu>
            <Tooltip label="More">
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-fg2 hover:text-fg1 data-[state=open]:bg-bg2-hover data-[state=open]:text-fg1 size-6"
                  aria-label="More browser actions"
                >
                  <MoreHorizontal size={14} />
                </Button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuItem
                onClick={() => void control("reload")}
                disabled={!browserSessionId || browserLocked}
              >
                Reload
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <BrowserAppearanceMenu
                appearance={tab.appearance}
                onAppearanceChange={changeAppearance}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </PanelHeader>
      </WorkbenchTabToolbar>
      <div
        ref={hostRef}
        className="bg-bg1 relative min-h-0 flex-1"
        aria-label="Shared agent browser content"
        onPointerDown={() => {
          if (blockingOverlayOpen) dismissNativeBrowserOverlay();
        }}
        onWheel={() => {
          if (blockingOverlayOpen) dismissNativeBrowserOverlay();
        }}
      >
        {parkForOverlay && overlayCapture ? (
          <img
            src={overlayCapture}
            alt="Current browser page"
            className="absolute inset-0 size-full object-fill"
            draggable={false}
          />
        ) : null}
        {placeholder ? (
          <div className="text-fg2 absolute inset-0 flex items-center justify-center p-8 text-center text-sm">
            {placeholder}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function dismissNativeBrowserOverlay() {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

function IframeBrowserTab({ tab, active, scope }: BrowserTabProps) {
  const dispatch = useWorkspaceDispatch();
  const sessions = useAgentSessions();
  const previewAvailable = workspacePreviewAvailable(scope ?? "");
  const updateTab = useCallback(
    (updates: Partial<Omit<WorkbenchTab, "id" | "type">>) => {
      dispatch({ type: "UPDATE_WORKBENCH_TAB", id: tab.id, scope, updates });
    },
    [dispatch, scope, tab.id],
  );
  // The reactive hook lets a late-arriving
  // preload bridge (build race / HMR refresh / stale dist-electron)
  // unblocks the URL bar without a manual reload.
  const electron = useNativeRuntime().ready;
  // Body is a plain <iframe>. The retained Browser deck handles inactive-tab
  // visibility without unmounting or reordering the node, preserving history,
  // scroll, form input, and JS heap. Design Mode is auto-injected by main on
  // did-frame-finish-load and controlled via postMessage; only the chip's element
  // thumbnail capture takes an IPC hop. See use-iframe-webview.ts.
  // Persisted URLs are still treated as untrusted input: only canonical http(s)
  // pages are restored. External http(s) sites are valid browser content.
  const safeTabUrl = normalizeBrowserUrl(tab.url ?? "") ?? "";
  const cloudBrowser = isCloudWorkspace(scope ?? "");
  const nativeCloudPreview = cloudBrowser && Boolean(tab.previewSource || isLoopbackUrl(safeTabUrl));
  const [, setCloudNavigationVersion] = useState(0);
  // Chromium history contains volatile grant origins. Cloud toolbar history
  // instead retains logical URLs and opaque owners, then re-admits each entry.
  const logicalHistory = useRef<{
    owner: string;
    entries: Array<{ url: string; source: WorkbenchTab["previewSource"] }>;
    index: number;
  }>({
    owner: `${scope}/${tab.id}`,
    entries: safeTabUrl ? [{ url: safeTabUrl, source: tab.previewSource }] : [],
    index: safeTabUrl ? 0 : -1,
  });
  if (logicalHistory.current.owner !== `${scope}/${tab.id}`)
    logicalHistory.current = {
      owner: `${scope}/${tab.id}`,
      entries: safeTabUrl ? [{ url: safeTabUrl, source: tab.previewSource }] : [],
      index: safeTabUrl ? 0 : -1,
    };
  const recordLogicalHistory = useCallback((url: string, source: WorkbenchTab["previewSource"]) => {
    const history = logicalHistory.current;
    const current = history.entries[history.index];
    if (url === current?.url &&
      source?.chatId === current.source?.chatId &&
      source?.port === current.source?.port &&
      source?.executionId === current.source?.executionId &&
      source?.portId === current.source?.portId) return;
    history.entries = [
      ...history.entries.slice(0, history.index + 1), { url, source },
    ].slice(-128);
    history.index = history.entries.length - 1;
  }, []);
  const [previewRuntime, setPreviewRuntime] = useState(() => {
    const runtime = previewRuntimeStateForTab(tab.id, safeTabUrl);
    return runtime && runtime.expiresAt > Date.now() ? runtime : null;
  });
  const [previewRenewRetryAt, setPreviewRenewRetryAt] = useState(0);
  const previewRenewingRef = useRef(false);
  const [previewRenewFailure, setPreviewRenewFailure] = useState<{
    key: string;
    error: unknown;
  } | null>(null);
  const [previewRenewPending, setPreviewRenewPending] = useState(false);
  const retryRenew = useRef<(() => Promise<void>) | null>(null);
  // Preview admission capabilities never enter the persisted WorkbenchTab.
  // Peek is render-pure/idempotent for React Strict Mode; consume only after
  // this mount commits. Later remounts use the safe URL + established cookie.
  const [initialFrameUrl] = useState(
    () =>
      previewNavigationForTab(tab.id, safeTabUrl) ??
      (tab.previewSource || nativeCloudPreview ? "about:blank" : safeTabUrl),
  );
  useEffect(() => {
    consumePreviewNavigation(tab.id);
  }, [tab.id]);
  // A floated tab is visible over the chat even while its workbench body is
  // hidden, so page-lifecycle work follows `live`. Shortcuts, focus and
  // Design/Canvas stay tied to the docked, active body.
  const floatKey = browserFloatKey(scope ?? "", tab.id);
  const floatRequested = useBrowserTabFloating(floatKey);
  const floatSlot = useBrowserFloatSlot(floatKey);
  const floating = floatRequested && floatSlot !== null;
  const floatViewport = useBrowserFloatEntries(scope ?? "").find(
    (entry) => entry.key === floatKey,
  )?.viewport;
  const live = active || floating;
  const frameName = `zeros-browser-${tab.id}`;
  const webview = useIframeWebview({
    initialUrl: initialFrameUrl,
    active: live,
    frameName,
    trustedPreviewOrigin: previewRuntime?.origin,
    onNavigation: (url) => {
      if (!cloudBrowser) return;
      const current = logicalHistory.current.entries[logicalHistory.current.index];
      const logicalUrl = reconcilePreviewRuntimeUrlForTab(tab.id, current?.url ?? safeTabUrl, url);
      if (logicalUrl) {
        recordLogicalHistory(logicalUrl, current?.source);
        if (logicalUrl !== safeTabUrl) updateTab({ url: logicalUrl });
        return;
      }
      // The old frame can finish while a toolbar admission is pending. It
      // cannot replace the newer logical intent before its grant arrives.
      if (nativeCloudPreview && !previewRuntimeStateForTab(tab.id, current?.url ?? safeTabUrl)) return;
      recordLogicalHistory(url, undefined);
      clearPreviewRuntimeForTab(tab.id);
      setPreviewRuntime(null);
      void nativeInvoke("browser:revoke-preview-origin", { frameName }).catch(() => undefined);
      if (url !== tab.url || tab.previewSource)
        updateTab({ url, previewSource: undefined });
    },
  });
  useWorkbenchStatusSource(
    {
      error: webview.state.loadError,
      pending: webview.state.isLoading,
      primary: true,
      hasContent:
        !!webview.state.loadedUrl &&
        webview.state.loadedUrl === webview.state.currentUrl,
      retry: webview.reloadAndWait,
    },
    safeTabUrl,
  );
  useWorkbenchStatusSource(
    {
      error:
        previewRenewFailure?.key === safeTabUrl
          ? previewRenewFailure.error
          : null,
      pending: previewRenewPending,
      retry: () => retryRenew.current?.(),
    },
    "preview-renewal",
  );
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const attachWebviewFrame = webview.ref;
  const attachPreviewFrame = useCallback((node: HTMLIFrameElement | null) => {
    previewFrameRef.current = node;
    attachWebviewFrame(node);
  }, [attachWebviewFrame]);
  const replacePreviewUrl = webview.replace;
  const navigateFrame = webview.navigate;
  const navigateLogicalCloud = useCallback(
    (url: string, source: WorkbenchTab["previewSource"], record = true) => {
      if (!previewAvailable && isLoopbackUrl(url)) return;
      if (record) recordLogicalHistory(url, source);
      clearPreviewRuntimeForTab(tab.id);
      setPreviewRuntime(null);
      if (electron)
        void nativeInvoke("browser:revoke-preview-origin", { frameName }).catch(() => undefined);
      updateTab({ url, previewSource: source });
      setCloudNavigationVersion(value => value + 1);
      if (!isLoopbackUrl(url)) navigateFrame(url);
    },
    [previewAvailable, recordLogicalHistory, tab.id, electron, frameName, updateTab, navigateFrame],
  );
  const navigateAddress = (url: string) => {
    if (cloudBrowser) {
      navigateLogicalCloud(url, undefined);
      return;
    }
    clearPreviewRuntimeForTab(tab.id);
    setPreviewRuntime(null);
    if (electron) void nativeInvoke("browser:revoke-preview-origin", { frameName }).catch(() => undefined);
    updateTab({ previewSource: undefined });
    webview.navigate(url);
  };
  const navigateHistory = (offset: number) => {
    const history = logicalHistory.current;
    const index = history.index + offset;
    const entry = history.entries[index];
    if (!entry) return;
    history.index = index;
    navigateLogicalCloud(entry.url, entry.source, false);
  };
  const reloadCloudPreview = () =>
    navigateLogicalCloud(safeTabUrl, tab.previewSource, false);
  const chromeWebview = cloudBrowser ? {
    ...webview,
    state: {
      ...webview.state,
      canGoBack: logicalHistory.current.index > 0,
      canGoForward: logicalHistory.current.index < logicalHistory.current.entries.length - 1,
    },
    back: () => navigateHistory(-1),
    forward: () => navigateHistory(1),
    reload: nativeCloudPreview ? reloadCloudPreview : webview.reload,
    hardReload: nativeCloudPreview ? reloadCloudPreview : webview.hardReload,
  } : webview;

  // Browser credentials are deliberately volatile. Re-exchange the safe
  // chat/display-port identity before the one-hour inner cookie (or provider
  // signed origin) expires. Hidden retained tabs stay inert; becoming active
  // performs an immediate catch-up when their prior grant elapsed.
  useEffect(() => {
    const source = tab.previewSource;
    if (!live || nativeCloudPreview || !source || !safeTabUrl) return;
    const current = previewRuntimeStateForTab(tab.id, safeTabUrl);
    const now = Date.now();
    const dueAt = Math.max(
      previewRenewRetryAt,
      current ? current.expiresAt - PREVIEW_RENEW_AHEAD_MS : now,
    );
    let cancelled = false;
    const renew = async () => {
      if (cancelled || previewRenewingRef.current) return;
      previewRenewingRef.current = true;
      setPreviewRenewPending(true);
      try {
        const owner = sessions.getSession(source.chatId);
        const livePort = owner?.boundaryPorts?.ports.find(
          (port) => port.port === source.port,
        );
        if (!livePort) {
          throw new Error("preview listener is not active");
        }
        const opened = await sessions.openBoundaryPort(
          source.chatId,
          livePort.id,
        );
        const descriptor = previewNavigationDescriptor(opened);
        if (descriptor.volatileOrigin) {
          if (!electron) {
            throw new Error("native preview authorization is unavailable");
          }
          const authorized = await nativeInvoke<{ ok: boolean }>(
            "browser:authorize-preview-origin",
            {
              frameName,
              origin: descriptor.runtimeOrigin,
              expiresAt: descriptor.expiresAt,
            },
          );
          if (!authorized.ok) {
            throw new Error("preview origin was not authorized");
          }
        }
        if (cancelled) return;
        const staged = stagePreviewNavigation(tab.id, opened);
        setPreviewRuntime({
          origin: staged.runtimeOrigin,
          expiresAt: staged.expiresAt,
          volatileOrigin: staged.volatileOrigin,
        });
        consumePreviewNavigation(tab.id);
        replacePreviewUrl(opened.admissionUrl);
        setPreviewRenewFailure(null);
        setPreviewRenewRetryAt(
          staged.expiresAt - Date.now() <= PREVIEW_RENEW_AHEAD_MS
            ? Date.now() + PREVIEW_RENEW_RETRY_MS
            : 0,
        );
      } catch (error) {
        if (cancelled) return;
        if (!current || current.expiresAt <= Date.now()) {
          setPreviewRuntime(null);
        }
        setPreviewRenewFailure({ key: safeTabUrl, error });
        setPreviewRenewRetryAt(Date.now() + PREVIEW_RENEW_RETRY_MS);
      } finally {
        previewRenewingRef.current = false;
        if (!cancelled) setPreviewRenewPending(false);
      }
    };
    retryRenew.current = renew;
    const timer = window.setTimeout(
      () => void renew(),
      Math.max(0, dueAt - now),
    );
    return () => {
      cancelled = true;
      if (retryRenew.current === renew) retryRenew.current = null;
      window.clearTimeout(timer);
    };
  }, [
    live,
    nativeCloudPreview,
    electron,
    frameName,
    previewRenewRetryAt,
    previewRuntime?.expiresAt,
    safeTabUrl,
    sessions,
    tab.id,
    tab.previewSource,
    replacePreviewUrl,
  ]);

  const observedUrl =
    webview.state.currentUrl === "about:blank" && (tab.previewSource || nativeCloudPreview)
      ? safeTabUrl
      : webview.state.currentUrl || initialFrameUrl || safeTabUrl;
  const previewRuntimeActive = isPreviewRuntimeUrlForTab(
    tab.id,
    safeTabUrl,
    observedUrl,
  );
  const effectiveUrl = nativeCloudPreview || previewRuntimeActive
    ? safeTabUrl
    : webview.state.currentUrl || safeTabUrl;
  // Canvas, forks and ⌥+click stay loopback-only (cloud previews keep their
  // logical localhost URL here). Design Mode works on any http(s) page; the
  // picker runs in the page's own world, so its messages are untrusted input
  // (see picker-message-guard.ts).
  const localToolsEnabled = isLoopbackUrl(effectiveUrl);
  const designModeAvailable = isPickerPageUrl(effectiveUrl);
  const designModeEnabled = designModeAvailable && !floating;
  const chipVisible = designModeEnabled && webview.selectedElements.length > 0;
  const designModeActive = webview.designModeActive;
  const setWebviewDesignMode = webview.setDesignMode;

  // Mirror iframe picker selection to workspace store for MCP + @selection.
  useEffect(() => {
    if (!active || !designModeEnabled) return;
    const primary = webview.selectedElements[0];
    if (!primary) {
      dispatch({ type: "SET_BROWSER_PICKER_SELECTION", selection: null });
    } else {
      dispatch({
        type: "SET_BROWSER_PICKER_SELECTION",
        selection: {
          selector: primary.selector,
          tag: primary.tag,
          componentName: primary.componentName,
          styles: primary.styles,
        },
      });
    }
    // Switching to another Browser/File/system tab must not leave a stale
    // element globally available to @selection or MCP consumers.
    return () => {
      dispatch({ type: "SET_BROWSER_PICKER_SELECTION", selection: null });
    };
  }, [active, designModeEnabled, webview.selectedElements, dispatch]);

  // Design Mode exits on a non-web page and while the page floats over the
  // chat (the float is for viewing; picks there would have no chip).
  useEffect(() => {
    if (!designModeEnabled && designModeActive) setWebviewDesignMode(false);
  }, [designModeEnabled, designModeActive, setWebviewDesignMode]);

  // Leaving loopback immediately exits Canvas. Persisting it off prevents an
  // external page from retaining an invisible canvas state that unexpectedly
  // reappears on a later localhost navigation.
  useEffect(() => {
    if (!localToolsEnabled && tab.canvasMode) updateTab({ canvasMode: false });
  }, [localToolsEnabled, tab.canvasMode, updateTab]);

  // ── ⌥+click direct-to-composer ──────────────────────────
  //
  // The preload sets `altKey=true` when the user holds Option while
  // clicking. The hook routes those to a separate one-shot slot
  // (`altClickedElement`) instead of the multi-select array — so
  // ⌥+click never opens the chip. We consume the slot here: format
  // the element context as a short single-line block and append it
  // to the active chat's composer via pendingComposerAppend.
  // AgentChat picks that up (see agent-chat.tsx) and merges into
  // its local input state — the user can keep typing around the
  // inserted block before submitting.
  // No active chat → toast; never silently spawn one.
  useEffect(() => {
    if (!active) return;
    const el = webview.altClickedElement;
    if (!el) return;
    if (!localToolsEnabled) {
      webview.clearAltClickedElement();
      return;
    }
    const activeChatId = useWorkspaceStore.getState().activeChatId;
    if (!activeChatId) {
      toast.error("No active chat to append this element to.", {
        description: "Open or create a chat first.",
      });
      webview.clearAltClickedElement();
      return;
    }
    const append: PendingComposerAppend = {
      id: `elemAppend-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      text: formatElementForComposer(el, effectiveUrl),
      chatId: activeChatId,
      source: "element-picker",
    };
    dispatch({ type: "ENQUEUE_COMPOSER_APPEND", append });
    webview.clearAltClickedElement();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, webview.altClickedElement]);

  // ── Persist URL + title back to the tab ──────────────────
  // The webview drives canonical state (final URL after redirects,
  // page title once <title> resolves). Mirror to the tab so the
  // tab strip label updates and a reload restores the right URL.
  // Cloud URL persistence uses committed native observations above, so an
  // optimistic frame URL cannot overwrite a pending logical admission.
  useEffect(() => {
    if (nativeCloudPreview || (cloudBrowser && electron)) return;
    const url = webview.state.currentUrl;
    if (url === "about:blank" && (tab.previewSource || nativeCloudPreview)) return;
    if (url && isPreviewRuntimeUrlForTab(tab.id, safeTabUrl, url)) return;
    if (!webview.state.isLoading && url && url !== tab.url) {
      clearPreviewRuntimeForTab(tab.id);
      setPreviewRuntime(null);
      if (electron) {
        void nativeInvoke("browser:revoke-preview-origin", { frameName }).catch(
          () => undefined,
        );
      }
      updateTab({ url, previewSource: undefined });
    }
  }, [
    electron,
    frameName,
    webview.state.currentUrl,
    webview.state.isLoading,
    safeTabUrl,
    tab.id,
    tab.previewSource,
    nativeCloudPreview,
    cloudBrowser,
    tab.url,
    updateTab,
  ]);

  useEffect(
    () => () => {
      clearPreviewRuntimeForTab(tab.id);
      void nativeInvoke("browser:revoke-preview-origin", { frameName }).catch(
        () => undefined,
      );
    },
    [frameName, tab.id],
  );

  useEffect(() => {
    const t = webview.state.title;
    const safeTitle = redactPreviewRuntimeTextForTab(tab.id, safeTabUrl, t);
    if (!webview.state.isLoading && safeTitle && safeTitle !== tab.title) {
      updateTab({ title: safeTitle });
    }
  }, [
    safeTabUrl,
    tab.id,
    tab.title,
    updateTab,
    webview.state.isLoading,
    webview.state.title,
  ]);

  // ── ⌘+Shift+D global shortcut ────────────────────────────
  //
  // Two listening paths because the keystroke can land in either
  // context:
  //   (1) DOM-level keydown on `window` — fires when focus is in
  //       the React renderer (chrome row, URL bar, tab strip).
  //       Only active tab listens; inactive ones bail.
  //   (2) Picker-forwarded postMessage — when focus is inside the
  //       iframe, our picker script intercepts ⌘+Shift+D and posts
  //       `zeros:picker:toggle-request` to the parent. The hook
  //       turns that into setDesignModeActive toggle (see
  //       use-iframe-webview.ts). Only the tab whose iframe sent
  //       the message gets the toggle, since each tab's hook has
  //       its own message listener scoped to its iframe.
  useEffect(() => {
    if (!active || !designModeEnabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.shiftKey && (e.metaKey || e.ctrlKey) && e.code === "KeyD") {
        e.preventDefault();
        webview.setDesignMode(!webview.designModeActive);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, designModeEnabled, webview]);

  // ── Escape exits Design Mode (renderer-side) ─────────────
  //
  // Escape has two layers:
  //   1st Escape → dismiss chip (handled by ElementChip's own
  //      keydown listener; stops propagation so this handler
  //      doesn't fire)
  //   2nd Escape → exit Design Mode (this handler)
  //
  // The picker also handles Escape inside the iframe and posts
  // `zeros:picker:exited` which flips designModeActive in the
  // hook. This handler covers the case where focus is in the
  // React shell (e.g., after the chip dismisses, focus may settle
  // on body before the user clicks back into the page).
  useEffect(() => {
    if (!active || !designModeEnabled || !webview.designModeActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // ElementChip stops propagation on its own Escape, so if
        // this fires the chip is already gone (or was never up).
        e.preventDefault();
        webview.setDesignMode(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, designModeEnabled, webview.designModeActive, webview]);

  const hasUrl = Boolean(webview.state.currentUrl || safeTabUrl);

  // ── Canvas mode ─────────────────────────────────────────
  //
  // Canvas mode (Palette button in chrome / ⌘\) reframes the
  // body so the iframe becomes a centered resizable "frame"
  // inside a scrollable area, with viewport presets on the
  // right column edge and a height-reset indicator below.
  // In fill mode (default) the iframe edges = column edges as
  // before.
  //
  // Important: the iframe element must stay mounted across
  // mode toggles. We achieve that by always rendering the
  // <iframe> in the same JSX position, and only changing
  // wrapper className/style based on mode. The chip is also
  // a sibling of the iframe inside the same wrapper so its
  // click-coord-based positioning stays correct in both modes.
  // Canvas, the device toolbar and the float are mutually exclusive layouts
  // of that one frame; a float takes precedence and both others resume after.
  const canvasMode = localToolsEnabled && !floating && (tab.canvasMode ?? false);
  const deviceMode =
    hasUrl && !floating && !canvasMode && tab.deviceToolbar === true;
  const persistedW = tab.viewportWidth ?? BROWSER_DEFAULT_WIDTH;
  const persistedH = tab.viewportHeight ?? BROWSER_DEFAULT_HEIGHT;
  // Drag state — live dims during a pointer drag for smooth
  // updates without per-move dispatch. On pointerup we persist
  // via UPDATE_WORKBENCH_TAB. While not dragging this is null and
  // we read straight from the tab record.
  const [dragDims, setDragDims] = useState<{
    w: number;
    h: number;
    axis: CanvasKnobAxis;
  } | null>(null);
  const effW = dragDims?.w ?? persistedW;
  const effH = dragDims?.h ?? persistedH;
  const isResizing = dragDims !== null;

  const persistViewport = useCallback(
    (w: number, h: number) => {
      updateTab({ viewportWidth: w, viewportHeight: h });
    },
    [updateTab],
  );

  // ── Device toolbar ──────────────────────────────────────
  //
  // A fixed-size viewport, top-aligned and centered in a scrollable body,
  // scaled by the zoom menu ("Fit" never enlarges). It shares the persisted
  // viewport size with Canvas mode. Measurement runs only while visible.
  const devicePresetId = normalizeBrowserDevicePreset(tab.devicePreset);
  const deviceSize = clampBrowserDeviceSize(effW, effH);
  const [deviceZoom, setDeviceZoom] = useState<BrowserDeviceZoom>("fit");
  const viewportWrapperRef = useRef<HTMLDivElement>(null);
  const [deviceBody, setDeviceBody] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = viewportWrapperRef.current;
    if (!active || !deviceMode || !el) return;
    const update = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      setDeviceBody((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, deviceMode]);
  // The drag renders the same layout it will persist, so "Fit" stays live
  // and releasing a knob never rescales the frame.
  const deviceLayout = browserDeviceLayout({
    bodyWidth: deviceBody.width,
    bodyHeight: deviceBody.height,
    width: deviceSize.width,
    height: deviceSize.height,
    zoom: deviceZoom,
  });

  const setDeviceToolbar = useCallback(
    (next: boolean) => {
      updateTab(
        next ? { deviceToolbar: true, canvasMode: false } : { deviceToolbar: false },
      );
    },
    [updateTab],
  );
  const setDeviceSize = useCallback(
    (width: number, height: number) => {
      const next = clampBrowserDeviceSize(width, height);
      const presetId = browserDevicePresetForSize(
        devicePresetId,
        next.width,
        next.height,
      );
      updateTab({
        viewportWidth: next.width,
        viewportHeight: next.height,
        devicePreset: presetId === "custom" ? undefined : presetId,
      });
    },
    [devicePresetId, updateTab],
  );
  const setDevicePreset = useCallback(
    (presetId: BrowserDevicePresetId) => {
      const preset = browserDevicePreset(presetId);
      updateTab(
        preset
          ? {
              devicePreset: preset.id,
              viewportWidth: preset.width,
              viewportHeight: preset.height,
            }
          : { devicePreset: undefined },
      );
    },
    [updateTab],
  );
  const rotateDevice = useCallback(() => {
    setDeviceSize(deviceSize.height, deviceSize.width);
  }, [deviceSize.height, deviceSize.width, setDeviceSize]);

  // One knob drag at a time. Escape, window blur and lost capture cancel it
  // back to the start size, and leaving device mode mid-drag cancels it so the
  // frame never stays stuck in a resizing state.
  const deviceGestureCancelRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (!active || !deviceMode) deviceGestureCancelRef.current?.();
  }, [active, deviceMode]);
  useLayoutEffect(() => () => deviceGestureCancelRef.current?.(), []);
  // A knob drag also scrolls the body to keep the knob under the pointer.
  // The scroll waits for the commit that resizes the scroll area; set any
  // earlier, the browser would clamp it to the old size.
  const pendingDeviceScrollRef = useRef<{ left: number; top: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const pending = pendingDeviceScrollRef.current;
    const el = viewportWrapperRef.current;
    pendingDeviceScrollRef.current = null;
    if (!pending || !el) return;
    el.scrollLeft = pending.left;
    el.scrollTop = pending.top;
  }, [dragDims]);

  const startDeviceResize = useCallback(
    (e: React.PointerEvent, axis: CanvasKnobAxis, handle: HTMLElement) => {
      if (!e.isPrimary || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      deviceGestureCancelRef.current?.();
      const body = viewportWrapperRef.current;
      const start = {
        axis,
        width: deviceSize.width,
        height: deviceSize.height,
        zoom: deviceZoom,
        bodyWidth: deviceBody.width,
        bodyHeight: deviceBody.height,
        scrollLeft: body?.scrollLeft ?? 0,
        scrollTop: body?.scrollTop ?? 0,
      };
      const startX = e.clientX;
      const startY = e.clientY;
      let last = { width: start.width, height: start.height };
      setDragDims({ w: last.width, h: last.height, axis });
      const settle = (commit: boolean) => {
        deviceGestureCancelRef.current = null;
        // Persist before clearing the live size so no frame shows the old one.
        if (
          commit &&
          (last.width !== start.width || last.height !== start.height)
        ) {
          setDeviceSize(last.width, last.height);
        } else {
          pendingDeviceScrollRef.current = {
            left: start.scrollLeft,
            top: start.scrollTop,
          };
        }
        setDragDims(null);
      };
      deviceGestureCancelRef.current = beginDesignPointerGesture({
        target: handle,
        pointerId: e.pointerId,
        cursor: axis === "bottom" ? "ns-resize" : "ew-resize",
        onMove: (move) => {
          const next = browserDeviceResizeSize(
            start,
            move.clientX - startX,
            move.clientY - startY,
          );
          last = { width: next.width, height: next.height };
          pendingDeviceScrollRef.current = {
            left: next.scrollLeft,
            top: next.scrollTop,
          };
          setDragDims({ w: last.width, h: last.height, axis });
        },
        onFinish: () => settle(true),
        onCancel: () => settle(false),
      });
    },
    [
      deviceSize.width,
      deviceSize.height,
      deviceZoom,
      deviceBody.width,
      deviceBody.height,
      setDeviceSize,
    ],
  );

  // ── Infinite canvas viewport ────────────────────────────
  //
  // Viewport controls on top of an infinite canvas. State:
  //   - `canvasViewport.x/y` translates the frame in screen px
  //   - `canvasViewport.zoom` scales it (0.2–2)
  //
  // Pan: Space + drag (window-level keydown tracking + pointer
  // capture on the canvas body). Zoom: ⌘/Ctrl + wheel, anchored
  // at the cursor so the point under the cursor stays fixed.
  // Frame canvas position is always (0, 0); on every transition
  // into canvas mode the viewport is reset to center the frame
  // at zoom 1. We don't persist pan/zoom — width/height of the
  // frame already persist, which is what the user asked for.
  const [canvasViewport, setCanvasViewport] = useState({
    x: 0,
    y: 0,
    zoom: 1,
  });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const canvasBodyRef = useRef<HTMLDivElement>(null);
  // viewport.zoom snapshot at resize-drag start. Pointer deltas
  // are in screen px; logical (frame) deltas are screen / zoom.
  const dragZoomRef = useRef(1);

  const startResize = useCallback(
    (e: React.PointerEvent, axis: CanvasKnobAxis, handle: HTMLElement) => {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = effW;
      const startH = effH;
      const zoom = canvasViewport.zoom;
      dragZoomRef.current = zoom;
      let lastW = startW;
      let lastH = startH;
      setDragDims({ w: startW, h: startH, axis });

      const onMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / zoom;
        const dy = (ev.clientY - startY) / zoom;
        let newW = startW;
        let newH = startH;
        if (axis === "right") newW = startW + dx;
        if (axis === "left") newW = startW - dx;
        if (axis === "bottom") newH = startH + dy;
        lastW = Math.max(BROWSER_MIN_WIDTH, Math.round(newW));
        lastH = Math.max(BROWSER_MIN_HEIGHT, Math.round(newH));
        setDragDims({ w: lastW, h: lastH, axis });
      };
      const onUp = () => {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        setDragDims(null);
        persistViewport(lastW, lastH);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [effW, effH, persistViewport, canvasViewport.zoom],
  );

  // Center the frame in the visible canvas area and auto-fit the
  // zoom so both the frame AND the preset rail (which sits to the
  // right of the frame, also inside the wrapper so it pans/zooms
  // with the frame) are visible. We never zoom in past 1; only
  // zoom out when the natural-size frame would overflow.
  const centerFrame = useCallback(() => {
    const el = canvasBodyRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const PADDING = 40;
    const variants = tab.variants ?? EMPTY_BROWSER_VARIANTS;
    const totalW = browserCanvasStripWidth(effW, variants);
    const totalH = effH;
    const zoomW = (rect.width - PADDING * 2) / totalW;
    const zoomH = (rect.height - PADDING * 2) / totalH;
    const zoom = Math.max(0.2, Math.min(1, zoomW, zoomH));
    const x = (rect.width - totalW * zoom) / 2;
    const y = (rect.height - effH * zoom) / 2;
    setCanvasViewport({ x, y, zoom });
  }, [effW, effH, tab.variants]);

  // Snap-center on every canvas-mode entry. We watch canvasMode
  // directly; the ref-guard ensures we don't re-center mid-session
  // when the user has pan/zoomed elsewhere (only on the false →
  // true transition).
  const wasCanvasModeRef = useRef(false);
  useEffect(() => {
    // A retained browser can first mount while its workspace is hidden. Wait
    // until it has real layout bounds before calculating the initial framing.
    if (!active) return;
    if (canvasMode && !wasCanvasModeRef.current) {
      // Defer one tick so the canvas body has its layout rect.
      const t = window.setTimeout(centerFrame, 0);
      wasCanvasModeRef.current = true;
      return () => window.clearTimeout(t);
    }
    if (!canvasMode) {
      wasCanvasModeRef.current = false;
    }
  }, [active, canvasMode, centerFrame]);

  // Space-key tracking — only when this tab is active AND canvas
  // mode is on, so we don't fight global app shortcuts.
  useEffect(() => {
    if (!active || !canvasMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't hijack space when the user is typing in the URL bar
      // or any input. matches() lets us check by tag.
      const t = e.target as HTMLElement | null;
      if (t && t.matches("input, textarea, [contenteditable]")) return;
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [active, canvasMode]);

  // Wheel listener for ⌘/Ctrl + wheel zoom. Plain wheel passes
  // through so the iframe content still scrolls normally when
  // the cursor is over it.
  useEffect(() => {
    if (!active || !canvasMode) return;
    const el = canvasBodyRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setCanvasViewport((v) => {
        // Anchor zoom at cursor: keep the logical point under the
        // cursor at the same screen position before and after.
        const delta = -e.deltaY * 0.005;
        const newZoom = Math.max(0.2, Math.min(2, v.zoom * (1 + delta)));
        if (newZoom === v.zoom) return v;
        const k = newZoom / v.zoom;
        return {
          x: cx - (cx - v.x) * k,
          y: cy - (cy - v.y) * k,
          zoom: newZoom,
        };
      });
    };
    // passive:false is required to call preventDefault on wheel
    // in modern browsers.
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [active, canvasMode]);

  // Space + drag = pan. Attached to the canvas body so any
  // pointer-down in the body (over the frame, the background,
  // or empty space) starts a pan when space is held.
  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!spaceHeld) return;
      const hit = e.target as HTMLElement;
      if (
        hit.closest(
          "[data-zeros-browser-variant], [data-zeros-canvas-chrome], [data-zeros-element-chip]",
        )
      ) {
        return;
      }
      e.preventDefault();
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);
      setIsPanning(true);
      const startX = e.clientX;
      const startY = e.clientY;
      const startVX = canvasViewport.x;
      const startVY = canvasViewport.y;
      const onMove = (ev: PointerEvent) => {
        setCanvasViewport((v) => ({
          ...v,
          x: startVX + (ev.clientX - startX),
          y: startVY + (ev.clientY - startY),
        }));
      };
      const onUp = () => {
        target.releasePointerCapture(e.pointerId);
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
        setIsPanning(false);
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
    },
    [spaceHeld, canvasViewport.x, canvasViewport.y],
  );

  const setCanvasMode = useCallback(
    (next: boolean) => {
      updateTab(
        next ? { canvasMode: true, deviceToolbar: false } : { canvasMode: false },
      );
    },
    [updateTab],
  );

  // ── ⌘+\ — toggle canvas mode ────────────────────────────
  useEffect(() => {
    if (!active || !localToolsEnabled || floating) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setCanvasMode(!canvasMode);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, localToolsEnabled, floating, canvasMode, setCanvasMode]);

  const applyPresetWidth = useCallback(
    (width: number) => {
      persistViewport(width, persistedH);
    },
    [persistViewport, persistedH],
  );

  const resetHeight = useCallback(() => {
    persistViewport(persistedW, BROWSER_DEFAULT_HEIGHT);
  }, [persistViewport, persistedW]);

  const tabVariants = tab.variants ?? EMPTY_BROWSER_VARIANTS;

  const deleteVariant = useCallback(
    (variantId: string) => {
      updateTab({
        variants: tabVariants.filter((v) => v.id !== variantId),
      });
    },
    [tabVariants, updateTab],
  );

  const renameVariant = useCallback(
    (variantId: string, name: string) => {
      updateTab({
        variants: tabVariants.map((v) =>
          v.id === variantId ? { ...v, name } : v,
        ),
      });
    },
    [tabVariants, updateTab],
  );

  const resizeVariant = useCallback(
    (variantId: string, width: number, contentHeight: number) => {
      updateTab({
        variants: tabVariants.map((v) =>
          v.id === variantId
            ? {
                ...v,
                sourceViewportWidth: width,
                sourceContentHeight: contentHeight,
              }
            : v,
        ),
      });
    },
    [tabVariants, updateTab],
  );

  const moveVariant = useCallback(
    (variantId: string, offsetX: number, offsetY: number) => {
      updateTab({
        variants: tabVariants.map((v) =>
          v.id === variantId ? { ...v, offsetX, offsetY } : v,
        ),
      });
    },
    [tabVariants, updateTab],
  );

  /** Nudge canvas pan so the full strip (live frame + variants) stays in view. */
  const panToRevealStrip = useCallback(
    (variants: BrowserTabVariant[]) => {
      const el = canvasBodyRef.current;
      if (!el || !canvasMode) return;
      const PADDING = 40;
      const bodyW = el.clientWidth;
      setCanvasViewport((prev) => {
        const stripLogicalW = browserCanvasStripWidth(effW, variants);
        const stripScreenW = stripLogicalW * prev.zoom;
        let x = prev.x;
        if (x + stripScreenW > bodyW - PADDING) {
          x = bodyW - PADDING - stripScreenW;
        }
        if (x > PADDING) x = PADDING;
        return { ...prev, x };
      });
    },
    [canvasMode, effW],
  );

  const handleForkVariant = useCallback(async () => {
    if (!canvasMode || !webview.designModeActive) return;
    const elements = webview.selectedElements;
    if (elements.length === 0) return;

    const anchorIndex = elements.length - 1;
    const anchor = elements[anchorIndex];
    const result = await webview.requestForkSnapshot(
      anchor.selector,
      anchorIndex,
    );
    const snapshot = result.snapshot;
    if (!snapshot) {
      const reason = result.error;
      if (reason === "cancelled" || reason === "superseded") return;
      const description =
        reason === "element-not-found"
          ? "The selected element is no longer in the page. Click it again in design mode."
          : reason === "timeout"
            ? "Fork timed out — the page may be large. Reload the tab and try again."
            : reason === "capture-failed" || reason === "capture-error"
              ? "Capture failed. Reload the browser tab, re-enter design mode, and select the element again."
              : "Reload the browser tab, enter design mode (⌘+Shift+D), and select the element again.";
      toast.error("Could not fork this element.", { description });
      return;
    }

    const forkWidth = Math.max(BROWSER_VARIANT_MIN_WIDTH, Math.round(effW));
    const forkHeight = Math.max(BROWSER_VARIANT_MIN_HEIGHT, Math.round(effH));

    const variantName = anchor.componentName
      ? `${anchor.componentName} Fork ${tabVariants.length + 1}`
      : `Component Fork ${tabVariants.length + 1}`;

    const variant: BrowserTabVariant = {
      id: `bvar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: variantName,
      html: snapshot.html,
      css: snapshot.css,
      sourceSelector: snapshot.sourceSelector,
      sourceUrl: effectiveUrl || anchor.href || "",
      componentName: snapshot.componentName ?? anchor.componentName,
      sourceViewportWidth: forkWidth,
      sourceContentHeight: forkHeight,
      offsetX: 0,
      offsetY: 0,
      createdAt: Date.now(),
      ...applyForkManifestFields({
        name: variantName,
        behaviorManifest: snapshot.behaviorManifest,
      }),
    };

    const nextVariants = [...tabVariants, variant];

    updateTab({ variants: nextVariants });

    if (snapshot.cssTruncated) {
      toast.warning("Variant forked with truncated CSS", {
        description:
          "Stylesheet was large — some rules were omitted. Preview may differ slightly.",
      });
    } else if (variantNeedsLiveLayer(variant)) {
      const count = variant.behaviorManifest?.behaviors.length ?? 0;
      toast.success("Variant forked (static + live catalog)", {
        description: `${count} JS behavior${count === 1 ? "" : "s"} catalogued for future .tsx live layer.`,
      });
    } else if (snapshot.extractionMode === "precision-local") {
      toast.success("Variant forked (precision)", {
        description: "Full localhost stylesheets captured.",
      });
    } else {
      toast.success("Variant forked");
    }

    requestAnimationFrame(() => {
      panToRevealStrip(nextVariants);
    });
  }, [
    canvasMode,
    webview,
    effectiveUrl,
    tabVariants,
    effW,
    effH,
    updateTab,
    panToRevealStrip,
  ]);

  // ── Float preview ───────────────────────────────────────
  //
  // React renders the viewport into a detached host element. The host moves
  // between the docked slot below and this tab's float slot with an atomic
  // DOM move, so floating and docking never reload the page.
  const [viewportHost] = useState<HTMLDivElement | null>(() => {
    if (typeof document === "undefined") return null;
    const host = document.createElement("div");
    host.dataset.zerosBrowserViewport = "";
    Object.assign(host.style, {
      position: "absolute",
      inset: "0",
      overflow: "hidden",
    });
    return host;
  });
  const dockSlotRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!viewportHost) return;
    const target = floating ? floatSlot : dockSlotRef.current;
    if (target && viewportHost.parentElement !== target) {
      moveNodePreservingState(target, viewportHost);
    }
  }, [viewportHost, floating, floatSlot]);
  // A float slot can unmount before this tab re-renders (owner switch, chat
  // column unmount); the rescue runs while that slot is still connected.
  useLayoutEffect(() => {
    if (!viewportHost) return;
    return onBrowserFloatSlotRemoved(floatKey, (slot) => {
      const dock = dockSlotRef.current;
      if (dock && viewportHost.parentElement === slot) {
        moveNodePreservingState(dock, viewportHost);
      }
    });
  }, [floatKey, viewportHost]);
  useLayoutEffect(
    () => () => {
      viewportHost?.remove();
    },
    [viewportHost],
  );
  useEffect(() => () => dockBrowserTab(floatKey), [floatKey]);
  const renderInViewportHost = (node: React.ReactNode) =>
    viewportHost ? createPortal(node, viewportHost) : node;

  const toggleFloat = () => {
    if (floatRequested) {
      dockBrowserTab(floatKey);
      return;
    }
    // The float keeps the page's current layout size and scales it down, so
    // responsive pages do not reflow into a phone layout.
    const body = canvasBodyRef.current;
    floatBrowserTab({
      scope: scope ?? "",
      tabId: tab.id,
      viewport: deviceMode
        ? deviceSize
        : canvasMode
          ? { width: effW, height: effH }
          : body
            ? { width: body.clientWidth, height: body.clientHeight }
            : null,
    });
    // The float sits over the chat; "Open in right panel" brings the column back.
    requestWorkbenchCollapse();
  };

  // ── Separate window / DevTools ──────────────────────────
  const windowInput = {
    frameName,
    url: effectiveUrl,
    scope,
    title: tab.title,
    agentPreview: Boolean(tab.previewSource),
    previewRuntimeActive,
  };
  const windowUnavailable = browserWindowUnavailableReason(windowInput);
  const openWindow = () => {
    void openBrowserWindow(windowInput).then((result) => {
      if (!result.ok) toast.error(result.message);
    });
  };
  const devToolsUnavailable = browserDevToolsUnavailableReason(effectiveUrl);
  const openDevTools = () => {
    void inspectBrowserFrame({ frameName, frame: previewFrameRef.current }).then(
      (result) => {
        if (!result.ok) toast.error(result.message);
      },
    );
  };

  const showStartPage = electron && !hasUrl;
  const viewportLayout = floating
    ? "float"
    : canvasMode
      ? "canvas"
      : deviceMode
        ? "device"
        : "fill";
  const floatFrame = floatViewport ?? {
    width: BROWSER_DEFAULT_WIDTH,
    height: BROWSER_DEFAULT_HEIGHT,
  };

  return (
    <div className="bg-bg1 flex h-full min-h-0 flex-col">
      <WorkbenchTabToolbar>
        <BrowserChrome
          webview={chromeWebview}
          displayUrl={effectiveUrl}
          onNavigate={(url) => {
            if (!previewAvailable && isLoopbackUrl(url)) {
              toast.error(
                "Cloud preview URLs are not configured for this build.",
              );
              return;
            }
            navigateAddress(url);
          }}
          electron={electron}
          designModeAvailable={designModeAvailable}
          localToolsEnabled={localToolsEnabled}
          canvasMode={canvasMode}
          onToggleCanvasMode={() => setCanvasMode(!canvasMode)}
          floating={floatRequested}
          canFloat={electron && hasUrl}
          onToggleFloat={toggleFloat}
          deviceToolbar={tab.deviceToolbar === true && !canvasMode}
          canShowDeviceToolbar={electron && hasUrl && !floatRequested}
          onToggleDeviceToolbar={setDeviceToolbar}
          windowUnavailable={windowUnavailable}
          onOpenWindow={openWindow}
          devToolsUnavailable={devToolsUnavailable}
          onOpenDevTools={openDevTools}
          appearance={tab.appearance}
          onAppearanceChange={(appearance) => updateTab({ appearance })}
        />
        {deviceMode && (
          <BrowserDeviceToolbar
            presetId={browserDevicePresetForSize(
              devicePresetId,
              deviceSize.width,
              deviceSize.height,
            )}
            width={deviceSize.width}
            height={deviceSize.height}
            zoom={deviceZoom}
            effectiveZoom={deviceLayout.zoom}
            onPresetChange={setDevicePreset}
            onSizeChange={setDeviceSize}
            onRotate={rotateDevice}
            onZoomChange={setDeviceZoom}
            onClose={() => setDeviceToolbar(false)}
          />
        )}
      </WorkbenchTabToolbar>
      {/* Browser body — a real <iframe>. CSS positions it; in
          canvas mode the iframe becomes a centered explicit-sized
          frame with edge resize handles and a viewport preset
          rail; otherwise it fills the column. Sandbox attribute
          grants the capabilities local development pages need:
          allow-same-origin keeps cookies/localStorage usable for the user's dev
          server, allow-scripts/forms/popups/modals lets typical
          web apps run normally, allow-popups-to-escape-sandbox
          is required so OAuth and similar window.open flows can
          land in a fresh tab/window without being trapped inside
          the iframe. X-Frame-Options + CSP frame-ancestors are
          stripped for http(s) responses (see
          apps/desktop/electron/iframe-headers.ts) so most arbitrary URLs load. */}
      <div
        ref={canvasBodyRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        onPointerDown={canvasMode ? onCanvasPointerDown : undefined}
        style={
          canvasMode
            ? {
                cursor: spaceHeld
                  ? isPanning
                    ? "grabbing"
                    : "grab"
                  : "default",
              }
            : undefined
        }
      >
        {/* Holds the viewport host while docked; React never renders into it. */}
        <div ref={dockSlotRef} className="absolute inset-0" />
        {showStartPage && (
          <BrowserStartPage
            scope={scope ?? ""}
            active={active}
            onOpen={navigateAddress}
          />
        )}
        {floating && (
          <FloatingPreviewPlaceholder onDock={() => dockBrowserTab(floatKey)} />
        )}
        {renderInViewportHost(
          showStartPage ? null : (
          <>
            {/* Canvas background — dot grid that pans/zooms with
                the viewport. Only painted in canvas mode. */}
            {canvasMode && (
              <div
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundImage:
                    "radial-gradient(circle, var(--border1) 1px, transparent 1px)",
                  backgroundSize: `${24 * canvasViewport.zoom}px ${24 * canvasViewport.zoom}px`,
                  backgroundPosition: `${canvasViewport.x}px ${canvasViewport.y}px`,
                  opacity: 0.6,
                }}
              />
            )}
            {/* Iframe wrapper — same React tree position in every
                layout, only the style differs. Stays mounted across
                mode toggles so page nav + scroll + JS heap survive.
                Fill: inset:0 fills the body. Canvas: absolute-positioned
                with the viewport transform. Device: a scroll area around
                a fixed-size scaled frame. Float: the frame keeps its
                layout size and the float box scales it. */}
            <div
              ref={viewportWrapperRef}
              className={
                VIEWPORT_WRAPPER_CLASSES[
                  viewportLayout === "device" && deviceZoom !== "fit"
                    ? "deviceFixedZoom"
                    : viewportLayout
                ]
              }
              style={
                canvasMode
                  ? {
                      left: canvasViewport.x,
                      top: canvasViewport.y,
                      transform: `scale(${canvasViewport.zoom})`,
                      transformOrigin: "top left",
                      gap: BROWSER_VARIANT_GAP_PX,
                    }
                  : undefined
              }
            >
              <div
                className={VIEWPORT_FRAME_CLASSES[viewportLayout]}
                style={
                  viewportLayout === "canvas"
                    ? { width: effW, height: effH }
                    : viewportLayout === "device"
                      ? {
                          left: deviceLayout.left,
                          top: deviceLayout.top,
                          width: deviceSize.width,
                          height: deviceSize.height,
                          transform: `scale(${deviceLayout.zoom})`,
                          transformOrigin: "top left",
                        }
                      : viewportLayout === "float"
                        ? {
                            width: floatFrame.width,
                            height: floatFrame.height,
                            transform:
                              "scale(var(--zeros-browser-float-scale, 1))",
                            transformOrigin: "top left",
                          }
                        : undefined
                }
                data-zeros-canvas-chrome
              >
                <iframe
                  key={webview.frameNavigationKey}
                  ref={attachPreviewFrame}
                  name={frameName}
                  src={
                    hasUrl
                      ? nativeCloudPreview && (!webview.frameSrc || isLoopbackUrl(webview.frameSrc))
                        ? "about:blank"
                        : webview.frameSrc || safeTabUrl || ""
                      : "about:blank"
                  }
                  // `title` is the iframe's accessible name for screen readers.
                  // (A hover Tooltip over the full page body would pop a chip on
                  // every hover and can stick open, since the iframe swallows
                  // pointerleave — so the frame name stays a plain attribute.)
                  title={tab.title}
                  // Pinned to its pre-gesture size during seam drags even
                  // while VISIBLE (resize-gesture-freeze.ts): resizing an
                  // iframe re-lays-out the guest document every frame, the
                  // most expensive thing a drag can trigger. It clips/shows
                  // surface bg mid-drag and snaps once on release — the
                  // standard webview treatment during sash drags. Inline px
                  // from the freeze beat size-full; in canvas mode the size
                  // is already fixed, so the pin is a no-op there — but only
                  // because the freeze normalizes its measurement by the
                  // wrapper's scale(zoom): pinning the raw (visual) rect
                  // would resize the iframe to zoom×layout for the drag.
                  data-zeros-resize-freeze=""
                  className="bg-bg1 absolute inset-0 block size-full border-0"
                  // Block pointer events on the iframe while a
                  // resize drag is happening so the drag pointer
                  // doesn't get captured by the iframe content.
                  // Also block while the element chip is open — in
                  // Electron, sibling overlays don't always win hit
                  // testing over iframes; the input still works via
                  // autoFocus but fork/close clicks were falling
                  // through to the page underneath.
                  // During Space+pan, block iframe so canvas pan wins.
                  // Chromium gives the page this frame's color scheme as its
                  // prefers-color-scheme, live and across origins. Unset, the
                  // frame inherits the Zeros theme.
                  style={{
                    pointerEvents:
                      isResizing || chipVisible || spaceHeld ? "none" : "auto",
                    colorScheme: tab.appearance,
                  }}
                  sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-pointer-lock allow-presentation allow-storage-access-by-user-activation allow-downloads"
                  // Do not advertise clipboard-read, geolocation, camera, or
                  // microphone to visited sites; the main-process permission
                  // handler denies them anyway. Keep only low-risk features.
                  allow="clipboard-write; fullscreen"
                />
                {chipVisible && (
                  <ElementChip
                    elements={webview.selectedElements}
                    onDismiss={webview.clearSelectedElements}
                    onRemoveAt={webview.removeSelectedElementAt}
                    forkEnabled={
                      canvasMode &&
                      webview.designModeActive &&
                      webview.selectedElements.length > 0
                    }
                    forkPending={webview.forkPending}
                    onFork={() => void handleForkVariant()}
                    onSubmit={(text) => {
                      const staged = stageSelectedElementsInComposer({
                        elements: webview.selectedElements,
                        prompt: text,
                        tabUrl: effectiveUrl || "",
                        activeChatId: useWorkspaceStore.getState().activeChatId,
                      });
                      if (staged.ok) webview.clearSelectedElements();
                    }}
                  />
                )}
                {(canvasMode || deviceMode) && (
                  <CanvasKnobHandles
                    axes={["left", "right", "bottom"]}
                    activeAxis={dragDims?.axis ?? null}
                    scale={deviceMode ? deviceLayout.zoom : undefined}
                    onStart={canvasMode ? startResize : startDeviceResize}
                  />
                )}
                {canvasMode && (
                  <CanvasHeightIndicator
                    height={effH}
                    isResizing={isResizing}
                    onReset={resetHeight}
                  />
                )}
                {canvasMode && (
                  <CanvasPresetRail
                    width={effW}
                    onApplyWidth={applyPresetWidth}
                  />
                )}
              </div>
              {deviceMode && (
                // Sizes the scroll area: the scaled frame plus its padding.
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0 left-0"
                  style={{
                    width: deviceLayout.contentWidth,
                    height: deviceLayout.contentHeight,
                  }}
                />
              )}
              {canvasMode &&
                tabVariants.map((variant) => (
                  <BrowserVariantFrame
                    key={variant.id}
                    variant={variant}
                    appearance={tab.appearance}
                    canvasZoom={canvasViewport.zoom}
                    onDelete={deleteVariant}
                    onRename={renameVariant}
                    onResize={resizeVariant}
                    onMove={moveVariant}
                  />
                ))}
            </div>
          </>
          ),
        )}
      </div>
    </div>
  );
}

/** Wrapper and frame classes per viewport layout. The frame element is the
 * same node in every layout so the iframe never remounts. The app's
 * scrollbars take layout space, so a device-body scrollbar appearing mid-drag
 * would narrow the body and shift the centered frame. */
const VIEWPORT_WRAPPER_CLASSES = {
  fill: "absolute inset-0",
  canvas: "absolute flex items-start",
  // Fit frames do not overflow, so no bar takes width from the centering.
  device:
    "bg-bg0 absolute inset-0 overflow-auto [&::-webkit-scrollbar-corner]:bg-transparent",
  // A fixed zoom always reserves the vertical bar, so a frame that starts or
  // stops overflowing mid-drag cannot shift the centering. Not
  // `scrollbar-gutter`: Chromium drops the gutter width from the horizontal
  // scroll range, which clips the frame's right padding.
  deviceFixedZoom:
    "bg-bg0 absolute inset-0 overflow-x-auto overflow-y-scroll [&::-webkit-scrollbar-corner]:bg-transparent",
  float: "absolute inset-0",
} as const;

const VIEWPORT_FRAME_CLASSES = {
  fill: "absolute inset-0",
  canvas: "relative shrink-0",
  device: "ring-border2 absolute ring-1",
  float: "absolute top-0 left-0",
} as const;

/** Docked body while the page floats over the chat column. */
function FloatingPreviewPlaceholder({ onDock }: { onDock: () => void }) {
  return (
    <div className="bg-bg1 absolute inset-0 flex flex-col items-center justify-center gap-3 px-10 text-center">
      <PictureInPicture2
        className="text-fg3 size-6"
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <p className="text-fg2 m-0 text-xs">This page is floating over the chat.</p>
      <Button variant="secondary" onClick={onDock}>
        Show here
      </Button>
    </div>
  );
}

// ── Chrome row (back/forward/reload + URL + design mode + ⋯) ──

interface BrowserChromeProps {
  webview: ReturnType<typeof useIframeWebview>;
  displayUrl: string;
  onNavigate: (url: string) => void;
  electron: boolean;
  /** Any http(s) page can host Design Mode. */
  designModeAvailable: boolean;
  /** Loopback pages also get Canvas. */
  localToolsEnabled: boolean;
  canvasMode: boolean;
  onToggleCanvasMode: () => void;
  floating: boolean;
  canFloat: boolean;
  onToggleFloat: () => void;
  deviceToolbar: boolean;
  canShowDeviceToolbar: boolean;
  onToggleDeviceToolbar: (next: boolean) => void;
  /** Why the page cannot open in its own window, or null when it can. */
  windowUnavailable: string | null;
  onOpenWindow: () => void;
  /** Why DevTools has nothing to inspect, or null when it does. */
  devToolsUnavailable: string | null;
  /** Inspects the tab's own iframe; never opens a preview window. */
  onOpenDevTools: () => void;
  /** The page's color scheme; undefined follows Zeros. */
  appearance: BrowserAppearance | undefined;
  onAppearanceChange: (appearance: BrowserAppearance | undefined) => void;
}

function BrowserChrome({
  webview,
  displayUrl,
  onNavigate,
  electron,
  designModeAvailable,
  localToolsEnabled,
  canvasMode,
  onToggleCanvasMode,
  floating,
  canFloat,
  onToggleFloat,
  deviceToolbar,
  canShowDeviceToolbar,
  onToggleDeviceToolbar,
  windowUnavailable,
  onOpenWindow,
  devToolsUnavailable,
  onOpenDevTools,
  appearance,
  onAppearanceChange,
}: BrowserChromeProps) {
  const {
    state,
    back,
    forward,
    reload,
    hardReload,
    clearCache,
    clearCookies,
    designModeActive,
    setDesignMode,
  } = webview;
  const inputRef = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState(() => displayUrl);
  const [focused, setFocused] = useState(false);

  // Sync the address to the webview's canonical URL when the user isn't editing.
  // Without this guard, an internal navigation would yank the cursor
  // out mid-typing.
  useEffect(() => {
    if (!focused) setAddress(displayUrl);
  }, [displayUrl, focused]);

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const url = resolveBrowserAddressInput(address);
      if (!url) {
        toast.error("Enter a search or valid http(s) URL");
        return;
      }
      setAddress(url);
      if (url === displayUrl && state.currentUrl !== displayUrl) reload();
      else onNavigate(url);
      inputRef.current?.blur();
    },
    [address, displayUrl, onNavigate, reload, state.currentUrl],
  );

  return (
    // 36px (h-9) chrome — 24px (size-6) icon buttons + the 24px search bar sit
    // centered with breathing room.
    <PanelHeader size="window" className="h-9">
      {/* Navigation buttons */}
      <Tooltip label="Back">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-fg2 hover:text-fg1 size-6 disabled:opacity-40"
          disabled={!state.canGoBack}
          onClick={back}
          aria-label="Back"
        >
          <ChevronLeft size={14} />
        </Button>
      </Tooltip>
      <Tooltip label="Forward">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-fg2 hover:text-fg1 size-6 disabled:opacity-40"
          disabled={!state.canGoForward}
          onClick={forward}
          aria-label="Forward"
        >
          <ChevronRight size={14} />
        </Button>
      </Tooltip>
      <Tooltip label={state.isLoading ? "Loading…" : "Reload"}>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-fg2 hover:text-fg1 size-6"
          onClick={reload}
          aria-label="Reload"
        >
          {state.isLoading ? (
            <ZerosSpinner size={16} />
          ) : (
            <RotateCw size={14} />
          )}
        </Button>
      </Tooltip>

      {/* URL omnibox — accepts canonical or scheme-less http(s) addresses. */}
      <form onSubmit={handleSubmit} className="min-w-0 flex-1">
        <div
          className={[
            "bg-bg2 flex h-6 w-full items-center rounded-sm border border-transparent px-2 transition-colors",
            electron ? "focus-within:border-highlighted-bright" : "opacity-60",
          ].join(" ")}
          onMouseDown={(e) => {
            // Clicking anywhere in the bar routes focus to the address.
            if (e.target !== inputRef.current) {
              e.preventDefault();
              inputRef.current?.focus();
            }
          }}
        >
          {state.faviconDataUrl ? (
            <img
              src={state.faviconDataUrl}
              alt=""
              className="mr-1.5 size-3.5 shrink-0 rounded-[2px]"
            />
          ) : (
            <Globe
              className="text-fg3 mr-1.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
          )}
          <input
            ref={inputRef}
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => {
              setFocused(true);
              // Select all on focus so the user can replace the address
              // immediately.
              e.currentTarget.select();
            }}
            onBlur={() => {
              setFocused(false);
            }}
            placeholder={electron ? "Search or enter URL" : "Mac app only"}
            disabled={!electron}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            aria-label="Browser URL"
            className="text-fg1 placeholder:text-fg3 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm outline-none disabled:cursor-not-allowed"
          />
        </div>
      </form>

      {/* Design Mode toggle — element picker. When on, the
          in-iframe picker (auto-injected on every http(s) iframe
          load by main's did-frame-finish-load hook) starts handling
          hover and click events. Clicking pops the ElementChip in the
          BrowserTab body. Both toggles stay in place (disabled) while
          the page floats so the float button does not shift. */}
      {designModeAvailable && (
        <Tooltip label="Design Mode" shortcut="⌘⇧D">
          <Button
            variant="ghost"
            size="icon-sm"
            className={[
              "size-6",
              designModeActive
                ? "bg-bg2-hover text-fg1"
                : "text-fg2 hover:text-fg1",
              // Design/Canvas are plain toggles over the live iframe. Avoid a
              // focus-visible carry-over when focus bounces through the page.
              "focus-visible:border-transparent focus-visible:ring-0",
            ].join(" ")}
            onClick={() => setDesignMode(!designModeActive)}
            disabled={!electron || floating}
            aria-pressed={designModeActive}
            aria-label="Toggle Design Mode"
          >
            <MousePointer2 size={14} />
          </Button>
        </Tooltip>
      )}
      {localToolsEnabled && (
        <Tooltip label="Canvas Mode" shortcut={"⌘\\"}>
          <Button
            variant="ghost"
            size="icon-sm"
            className={[
              "size-6",
              canvasMode
                ? "bg-bg2-hover text-fg1"
                : "text-fg2 hover:text-fg1",
              "focus-visible:border-transparent focus-visible:ring-0",
            ].join(" ")}
            onClick={onToggleCanvasMode}
            disabled={floating}
            aria-pressed={canvasMode}
            aria-label="Toggle Canvas Mode"
          >
            <Palette size={14} />
          </Button>
        </Tooltip>
      )}
      <Tooltip label={floating ? "Stop floating" : "Float preview over chat"}>
        <Button
          variant="ghost"
          size="icon-sm"
          className={[
            "size-6",
            floating ? "bg-bg2-hover text-fg1" : "text-fg2 hover:text-fg1",
          ].join(" ")}
          onClick={onToggleFloat}
          disabled={!canFloat}
          aria-pressed={floating}
          aria-label="Float preview over chat"
        >
          <PictureInPicture2 size={14} />
        </Button>
      </Tooltip>

      {/* Iframe migration — Radix DropdownMenu z-indexes naturally
          over the iframe body. No more native menu, no overlay-lock,
          no screenshot backdrop. */}
      <DropdownMenu>
        <Tooltip label="More">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={[
                "text-fg2 hover:text-fg1 size-6",
                "data-[state=open]:bg-bg2-hover data-[state=open]:text-fg1",
              ].join(" ")}
              disabled={!electron}
              aria-label="More browser actions"
            >
              <MoreHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-[220px]">
          <DropdownMenuItem onClick={hardReload} disabled={!electron}>
            Hard reload
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onOpenDevTools}
            disabled={!electron || devToolsUnavailable !== null}
          >
            Open DevTools
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={onOpenWindow}
            disabled={!electron || windowUnavailable !== null}
          >
            Open separate preview window
          </DropdownMenuItem>
          {electron && windowUnavailable !== null && (
            <DropdownMenuLabel className="text-muted-fg text-2xxs pt-0 font-normal">
              {windowUnavailable}
            </DropdownMenuLabel>
          )}
          <DropdownMenuCheckboxItem
            indicatorSide="end"
            checked={deviceToolbar}
            disabled={!canShowDeviceToolbar}
            onCheckedChange={(checked) => onToggleDeviceToolbar(checked === true)}
          >
            Show device toolbar
          </DropdownMenuCheckboxItem>
          <BrowserAppearanceMenu
            appearance={appearance}
            onAppearanceChange={onAppearanceChange}
          />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => void clearCookies()}
            disabled={!electron}
          >
            Clear cookies
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => void clearCache()}
            disabled={!electron}
          >
            Clear cache
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </PanelHeader>
  );
}

// ── Design Mode element chip ─────────────────────────────

interface ElementChipProps {
  elements: SelectedElement[];
  onSubmit: (text: string) => void;
  onDismiss: () => void;
  onRemoveAt: (index: number) => void;
  forkEnabled?: boolean;
  forkPending?: boolean;
  onFork?: () => void;
}

/** Approximate chip dimensions — used for viewport-bounds clamping
 *  so the chip doesn't disappear off-screen when the user clicks
 *  something near a window edge. The canvas inspector uses the
 *  same pattern (`feedback-pill.ts:100-137`). */
// ── Canvas-mode sub-components ───────────────────────────

interface CanvasPresetRailProps {
  width: number;
  onApplyWidth: (width: number) => void;
}

/** Viewport preset rail anchored to the RIGHT EDGE OF THE FRAME
 *  (not the column). The rail is a child of the frame wrapper, so
 *  it inherits the wrapper's CSS transform — pans/zooms with the
 *  frame, exactly like the height indicator below. Shows the
 *  current width as a pill plus one button per preset (Desktop /
 *  Laptop / Tablet / Mobile). Active preset (width within ±20px
 *  of preset value) gets the accent background. */
function CanvasPresetRail({ width, onApplyWidth }: CanvasPresetRailProps) {
  return (
    <div
      className="pointer-events-none absolute top-1/2 z-20 ml-6 flex -translate-y-1/2 flex-col items-end gap-1"
      style={{ left: "100%" }}
    >
      <div className="border-border1 bg-bg2 text-fg2 pointer-events-auto rounded-sm border px-2.5 py-0.5 text-xs font-medium tabular-nums shadow-sm">
        {width}px
      </div>
      {BROWSER_VIEWPORT_PRESETS.map((p) => {
        const active = Math.abs(width - p.width) < 20;
        return (
          <Tooltip key={p.label} label={`${p.label} (${p.width}px)`}>
            <button
              type="button"
              onClick={() => onApplyWidth(p.width)}
              className={[
                "pointer-events-auto rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                active
                  ? "bg-bg2-hover text-fg1"
                  : "text-fg2 hover:bg-bg1-hover hover:text-fg1",
              ].join(" ")}
            >
              {p.label}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

interface CanvasHeightIndicatorProps {
  height: number;
  isResizing: boolean;
  onReset: () => void;
}

/** Below-iframe pill showing the current height and a Reset
 *  button when it's not the default. Fades in during a drag so
 *  the user has live feedback even while at the default. */
function CanvasHeightIndicator({
  height,
  isResizing,
  onReset,
}: CanvasHeightIndicatorProps) {
  const isDefault = height === BROWSER_DEFAULT_HEIGHT;
  const visible = isResizing || !isDefault;
  return (
    <div
      className="absolute top-full left-1/2 z-10 mt-3 flex -translate-x-1/2 items-center gap-2 transition-opacity duration-150"
      style={{
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      {!isDefault && (
        <Tooltip label="Reset to default height">
          <button
            type="button"
            onClick={onReset}
            className="bg-fg1 text-primary-button-fg hover:bg-fg1/90 rounded-sm px-2.5 py-1 text-xs font-medium shadow-sm"
          >
            Reset ({BROWSER_DEFAULT_HEIGHT}px)
          </button>
        </Tooltip>
      )}
      <div className="border-border1 bg-bg2 text-fg2 rounded-sm border px-2.5 py-0.5 text-xs font-medium tabular-nums shadow-sm">
        {height}px
      </div>
    </div>
  );
}

const CHIP_WIDTH = 340;
const CHIP_HEIGHT_BASE = 76; // base row (tags) + (input row when expanded)
const CHIP_GAP = 12;

/** Floating popover anchored to the most-recently-clicked element.
 *  Rendered as a sibling of the iframe; click coords come from the
 *  picker (iframe-local CSS px) and are already in this container's
 *  coord space because the iframe sits at inset:0 of the container.
 *  Edge-flips when overflowing right or bottom of the container.
 *
 *  Shows ALL selected elements as removable tags, plus
 *  an "+ Add" button to pick another element. Submitting stages every
 *  element in the active chat's composer (one screenshot pill each plus
 *  a details .txt pill); it never sends. */
function ElementChip({
  elements,
  onSubmit,
  onDismiss,
  onRemoveAt,
  forkEnabled = false,
  forkPending = false,
  onFork,
}: ElementChipProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Anchor to the LAST element clicked (most recent intent).
  const anchor = elements[elements.length - 1];

  // requestAnimationFrame ensures the input is mounted, the parent
  // overlay-lock has triggered the visibility flip, and the DOM is
  // painted before we claim focus. Plain `autoFocus` and synchronous
  // .focus() in useEffect both race the layout and intermittently
  // miss — the canvas inspector uses this exact pattern
  // (`feedback-pill.ts:442`).
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [anchor?.selector, anchor?.click.x, anchor?.click.y]);

  // Outside-click dismiss. Capture phase on document so we beat
  // the canvas pan handler. Use composedPath so slotted/shadow
  // targets still count as inside the chip.
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      const chip = containerRef.current;
      if (!chip) return;
      const path = e.composedPath();
      if (path.includes(chip)) return;
      onDismiss();
    };
    const t = window.setTimeout(() => {
      document.addEventListener("pointerdown", onDocPointerDown, true);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("pointerdown", onDocPointerDown, true);
    };
  }, [onDismiss]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
      return;
    }
    // ⌘+L or Ctrl+L stages the selection in the active chat's composer.
    // Also Enter (without Shift) submits. Shift/Option variants are
    // rejected so this plain chord can't double-fire alongside other
    // L-key chords (⇧⌘L is the internal copy-logs shortcut).
    const isCmdL =
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      !e.altKey &&
      (e.key === "l" || e.key === "L");
    const isEnter =
      e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing;
    if (isCmdL || isEnter) {
      e.preventDefault();
      onSubmit(text);
    }
  };

  // Position the chip near the LAST clicked element. Edge-flip if
  // it would overflow right or bottom of the placeholder.
  const placeholder = containerRef.current?.parentElement;
  const placeW = placeholder?.clientWidth ?? 800;
  const placeH = placeholder?.clientHeight ?? 600;
  let left = (anchor?.click.x ?? 8) + CHIP_GAP;
  let top = (anchor?.click.y ?? 8) + CHIP_GAP;
  if (left + CHIP_WIDTH > placeW - 8) {
    left = Math.max(8, (anchor?.click.x ?? 8) - CHIP_WIDTH - CHIP_GAP);
  }
  if (top + CHIP_HEIGHT_BASE > placeH - 8) {
    top = Math.max(8, (anchor?.click.y ?? 8) - CHIP_HEIGHT_BASE - CHIP_GAP);
  }

  if (!anchor) return null;

  const anyShadow = elements.some((e) => e.hasShadowRoot);

  return (
    <div
      ref={containerRef}
      data-zeros-element-chip
      className="pointer-events-auto absolute z-dropdown"
      style={{ left, top, width: CHIP_WIDTH }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="border-border1 bg-bg3 flex flex-col gap-1.5 rounded-lg border p-2 shadow-lg">
        {/* Tag row: one removable pill per selected element + the
            "+" add-another button. flex-wrap so the row grows
            vertically when many elements are selected. */}
        <div className="flex flex-wrap items-center gap-1">
          {elements.map((el, i) => (
            <Tooltip key={`${el.selector}-${i}`} label={`${el.selector}`}>
              <span className="bg-bg3-hover text-fg1 inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs">
                {/* Prefer human-readable component name (React fiber,
                    Vue, data-component, CSS module, aria-label, semantic
                    tag) — falls back to <tag> when no better name is
                    detectable. Mono only on the tag fallback so component
                    names read as natural text. */}
                {el.componentName ? (
                  <span className="font-medium">{el.componentName}</span>
                ) : (
                  <span>{`<${el.tag}>`}</span>
                )}
                <button
                  type="button"
                  onClick={() => onRemoveAt(i)}
                  className="text-fg2 hover:bg-bg4 hover:text-fg1 -mr-0.5 inline-flex size-3 items-center justify-center rounded-sm"
                  aria-label={`Remove ${el.componentName || el.tag}`}
                >
                  <X size={9} />
                </button>
              </span>
            </Tooltip>
          ))}
        </div>
        {/* Input + fork + dismiss row */}
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              elements.length === 1
                ? "Describe the change or ⌘L to add to chat"
                : `Describe (${elements.length} elements) or ⌘L`
            }
            spellCheck={false}
            autoFocus
            className="text-fg1 placeholder:text-fg3 min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          {onFork && (
            <Tooltip label={forkEnabled ? "Fork variant" : "Canvas mode only"}>
              <button
                type="button"
                aria-disabled={!forkEnabled || forkPending}
                onClick={() => {
                  if (!forkEnabled || forkPending) return;
                  onFork();
                }}
                className={`text-fg2 hover:bg-bg2-hover hover:text-fg1 inline-flex size-7 items-center justify-center rounded-sm ${
                  !forkEnabled || forkPending
                    ? "cursor-not-allowed opacity-40"
                    : ""
                }`}
                aria-label="Fork variant"
              >
                {forkPending ? (
                  <ZerosSpinner size={12} />
                ) : (
                  <GitFork size={12} />
                )}
              </button>
            </Tooltip>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="text-fg2 hover:bg-bg2-hover hover:text-fg1 inline-flex size-7 items-center justify-center rounded-sm"
            aria-label="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      </div>
      {anyShadow && (
        <p className="text-fg2 mt-1 ml-1 text-xs">
          {elements.length === 1
            ? "Inside shadow-DOM — selector may be brittle."
            : "One or more elements are inside shadow-DOM — selectors may be brittle."}
        </p>
      )}
    </div>
  );
}

/** Format an element capture for inline insertion into a composer
 *  draft (⌥+click flow). The chip's staged details file uses a richer
 *  multi-line block; this one targets a single compact paragraph
 *  the user can comfortably edit around. */
function formatElementForComposer(el: SelectedElement, tabUrl: string): string {
  const url = tabUrl || el.href;
  const styleSummary = el.styles
    ? Object.entries(el.styles)
        .filter(
          ([, v]) =>
            v && v !== "auto" && v !== "normal" && v !== "none" && v !== "0px",
        )
        .slice(0, 5)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    : "";
  // Lead with component name when known; fall back to bare tag.
  const ident = el.componentName
    ? `${el.componentName} <${el.tag}>`
    : `<${el.tag}>`;
  const head = `[${ident} ${el.selector}${url ? ` @ ${url}` : ""}]`;
  return styleSummary ? `${head} { ${styleSummary} }` : head;
}
