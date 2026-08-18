import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { CircleStop, Globe2, Maximize2, Minus } from "lucide-react";

import { nativeInvoke } from "../../platform/runtime";
import { useAgentSessions } from "../agent/sessions-hooks";
import { useWorkspaceStore } from "../../state/store";
import { workbenchScopeForFolder } from "../../state/workspace-store";
import { defaultScopeFor } from "../../shell/workbench/tab-model";
import {
  browserSessionIsAgentActive,
  useConversationBrowserActivity,
} from "./browser-session-activity-store";
import {
  hasOpenNativeBrowserBlockingOverlay,
  nativeBrowserOverlayShouldParkSurface,
  NativeBrowserSurfaceCommandQueue,
  requestImmediateNativeBrowserSurfacePark,
} from "./native-browser-overlay";
import { listenForNativeSurfaceOverlayIntent } from "../../shared/ui/native-surface-overlay";

interface BrowserAgentPictureInPictureProps {
  visible: boolean;
  onRestore: () => void;
}

const PIP_EDGE_GUTTER = 16;
const PIP_VIEWPORT_FRACTION = 0.52;
const PIP_MAX_WIDTH = 380;
const PIP_MAX_HEIGHT = 300;
const PIP_MIN_WIDTH = 280;
const PIP_MIN_HEIGHT = 176;

/** Fit the last full Browser viewport into the available workspace. This keeps
 * a desktop page legible and lets page/column geometry produce the naturally
 * varying preview sizes used by the native Browser surface. */
export function browserPictureInPictureSize(input: {
  availableWidth: number;
  availableHeight: number;
  sourceViewport?: { width: number; height: number };
}): { width: number; height: number } {
  const widthBudget = Math.max(1, input.availableWidth - 2 * PIP_EDGE_GUTTER);
  const heightBudget = Math.max(1, input.availableHeight - 2 * PIP_EDGE_GUTTER);
  const maximumWidth = Math.max(
    1,
    Math.min(
      PIP_MAX_WIDTH,
      widthBudget < PIP_MIN_WIDTH
        ? widthBudget
        : Math.max(
            PIP_MIN_WIDTH,
            Math.floor(widthBudget * PIP_VIEWPORT_FRACTION),
          ),
    ),
  );
  const maximumHeight = Math.max(
    1,
    Math.min(
      PIP_MAX_HEIGHT,
      heightBudget < PIP_MIN_HEIGHT
        ? heightBudget
        : Math.max(
            PIP_MIN_HEIGHT,
            Math.floor(heightBudget * PIP_VIEWPORT_FRACTION),
          ),
    ),
  );
  const source = input.sourceViewport;
  const ratio =
    source && source.width > 0 && source.height > 0
      ? source.width / source.height
      : 1_440 / 1_000;
  let width = maximumWidth;
  let height = Math.round(width / ratio);
  if (height > maximumHeight) {
    height = maximumHeight;
    width = Math.round(height * ratio);
  }
  return {
    width: Math.max(Math.min(PIP_MIN_WIDTH, maximumWidth), width),
    height: Math.max(Math.min(PIP_MIN_HEIGHT, maximumHeight), height),
  };
}

export function browserPictureInPictureTitle(
  title: string | undefined,
  url: string | undefined,
): string {
  return (
    browserHostname(url)?.replace(/^www\./, "") || title?.trim() || "Browser"
  );
}

export function nextBrowserPictureInPictureChrome(
  current: boolean,
  input: {
    nativeHovered: boolean;
    rendererEvent: "enter" | "leave" | null;
  },
): boolean {
  if (input.rendererEvent === "leave") return false;
  if (input.rendererEvent === "enter" || input.nativeHovered) return true;
  return current;
}

export function browserPictureInPictureShouldResetHidden(input: {
  previousAgentActive: boolean;
  currentAgentActive: boolean;
  previousSessionId: string | undefined;
  currentSessionId: string | undefined;
}): boolean {
  return (
    input.currentAgentActive &&
    (!input.previousAgentActive ||
      (Boolean(input.currentSessionId) &&
        input.previousSessionId !== input.currentSessionId))
  );
}

/** Rehost the exact shared WebContentsView when the user collapses Workbench
 * during an agent-owned browser turn. The surface disappears at handoff; it is
 * never a second browser, screenshot replay, or provider-owned window. */
export function BrowserAgentPictureInPicture({
  visible,
  onRestore,
}: BrowserAgentPictureInPictureProps) {
  const activeChatId = useWorkspaceStore((state) => state.activeChatId);
  const activePage = useWorkspaceStore((state) => state.activePage);
  const chats = useWorkspaceStore((state) => state.chats);
  const workbenchByScope = useWorkspaceStore((state) => state.workbenchByScope);
  const dispatch = useWorkspaceStore((state) => state.dispatch);
  const activity = useConversationBrowserActivity(activeChatId ?? undefined);
  const sessions = useAgentSessions();
  const [hiddenSessionId, setHiddenSessionId] = useState<string | null>(null);
  const chat = chats.find((candidate) => candidate.id === activeChatId);
  const scope = workbenchScopeForFolder(chat?.folder || null);
  const scoped = workbenchByScope[scope] ?? defaultScopeFor(scope);
  const browserTab = scoped.tabs.find(
    (tab) =>
      tab.type === "browser" && tab.browserConversationId === activeChatId,
  );
  const ownsTab = Boolean(browserTab);
  const browserSessionId =
    activity && activity.status !== "closed"
      ? activity.browserSessionId
      : undefined;
  const agentActive = browserSessionIsAgentActive(activity);
  const hidden = hiddenSessionId === browserSessionId;
  const shown =
    visible &&
    activePage === "workspace" &&
    ownsTab &&
    agentActive &&
    Boolean(browserSessionId) &&
    !hidden;
  const hostRef = useRef<HTMLDivElement>(null);
  const surfaceIdRef = useRef("browser-agent-pip");
  const [commands] = useState(() => new NativeBrowserSurfaceCommandQueue());
  const [blockingOverlayOpen, setBlockingOverlayOpen] = useState(false);
  const [capture, setCapture] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(false);
  const [windowSize, setWindowSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const lastCaptureRef = useRef<string | null>(null);
  const lastCaptureSessionRef = useRef<string | null>(null);
  const lastCaptureUrlRef = useRef<string | null>(null);
  const previousOwnershipRef = useRef<{
    agentActive: boolean;
    browserSessionId: string | undefined;
  }>({ agentActive: false, browserSessionId: undefined });

  useEffect(() => {
    if (!visible) setHiddenSessionId(null);
  }, [visible]);

  useEffect(() => {
    const previous = previousOwnershipRef.current;
    if (
      browserPictureInPictureShouldResetHidden({
        previousAgentActive: previous.agentActive,
        currentAgentActive: agentActive,
        previousSessionId: previous.browserSessionId,
        currentSessionId: browserSessionId,
      })
    ) {
      setHiddenSessionId(null);
    }
    previousOwnershipRef.current = { agentActive, browserSessionId };
  }, [agentActive, browserSessionId]);

  useEffect(() => {
    setChromeVisible((current) =>
      nextBrowserPictureInPictureChrome(current, {
        nativeHovered: activity?.surfaceHovered === true,
        rendererEvent: null,
      }),
    );
  }, [activity?.surfaceHovered]);

  useEffect(() => {
    if (!shown) return;
    const update = () =>
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [shown]);

  const restoreBrowser = useCallback(() => {
    if (browserTab) {
      dispatch({
        type: "ACTIVATE_WORKBENCH_TAB",
        id: browserTab.id,
        scope,
      });
    }
    onRestore();
  }, [browserTab, dispatch, onRestore, scope]);

  useEffect(() => {
    if (!shown) {
      setBlockingOverlayOpen(false);
      return;
    }
    const refresh = () =>
      setBlockingOverlayOpen(hasOpenNativeBrowserBlockingOverlay(document));
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
  }, [browserSessionId, shown]);

  const snapshotOverlayOpen = blockingOverlayOpen || chromeVisible;

  useEffect(() => {
    if (!browserSessionId) {
      setCapture(null);
      lastCaptureRef.current = null;
      lastCaptureSessionRef.current = null;
      lastCaptureUrlRef.current = null;
      return;
    }
    const captureUrl = activity?.url ?? "";
    if (lastCaptureSessionRef.current !== browserSessionId) {
      lastCaptureSessionRef.current = browserSessionId;
      lastCaptureUrlRef.current = null;
      lastCaptureRef.current = null;
      setCapture(null);
    }
    if (
      !snapshotOverlayOpen &&
      lastCaptureRef.current &&
      lastCaptureUrlRef.current === captureUrl
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
          lastCaptureRef.current = captured;
          lastCaptureUrlRef.current = captureUrl;
        }
        setCapture(captured ?? lastCaptureRef.current);
      })
      .catch(() => {
        if (!disposed) setCapture(lastCaptureRef.current);
      })
      .finally(() => undefined);
    return () => {
      disposed = true;
    };
  }, [activity?.url, browserSessionId, snapshotOverlayOpen]);

  const parked = nativeBrowserOverlayShouldParkSurface({
    overlayOpen: snapshotOverlayOpen,
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!shown || parked || !host || !browserSessionId) return;
    const surfaceId = surfaceIdRef.current;
    let disposed = false;
    let frame = 0;
    const attach = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || !host.isConnected) return;
        const rect = host.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        void commands
          .enqueue(() =>
            nativeInvoke("browser_session_attach", {
              browserSessionId,
              surfaceId,
              bounds: {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            }),
          )
          .catch(() => undefined);
      });
    };
    const observer = new ResizeObserver(attach);
    observer.observe(host);
    window.addEventListener("resize", attach);
    attach();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", attach);
      void commands
        .enqueue(() =>
          nativeInvoke("browser_session_detach", {
            browserSessionId,
            surfaceId,
          }),
        )
        .catch(() => undefined);
    };
  }, [browserSessionId, commands, parked, shown]);

  if (!shown) return null;
  const pipTitle = browserPictureInPictureTitle(activity?.title, activity?.url);
  // WebContentsView is composited above renderer DOM. Main publishes native
  // hover; capture+park then lets the toolbar overlay the full-page snapshot
  // without reserving a 28px strip or shrinking the live site's viewport.
  const pipSize = browserPictureInPictureSize({
    availableWidth: windowSize.width,
    availableHeight: windowSize.height,
    sourceViewport: activity?.sourceViewport,
  });
  return (
    <section
      className="border-border2 bg-bg1 fixed right-4 bottom-4 z-40 flex overflow-hidden rounded-lg border shadow-[0_14px_42px_rgba(0,0,0,.38)]"
      style={{
        width: pipSize.width,
        height: pipSize.height,
      }}
      aria-label="Agent browser picture in picture"
      data-testid="browser-agent-picture-in-picture"
      onPointerEnter={() =>
        setChromeVisible((current) =>
          nextBrowserPictureInPictureChrome(current, {
            nativeHovered: false,
            rendererEvent: "enter",
          }),
        )
      }
      onPointerLeave={() =>
        setChromeVisible((current) =>
          nextBrowserPictureInPictureChrome(current, {
            nativeHovered: false,
            rendererEvent: "leave",
          }),
        )
      }
      onFocusCapture={() => setChromeVisible(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setChromeVisible(false);
        }
      }}
    >
      <div
        className={[
          "border-border1 bg-bg1/95 absolute inset-x-0 top-0 z-10 flex h-7 items-center gap-1.5 border-b px-2 text-left backdrop-blur-sm transition-opacity duration-150",
          chromeVisible ? "opacity-100" : "pointer-events-none opacity-0",
        ].join(" ")}
        data-testid="browser-agent-pip-toolbar"
      >
        {activity?.faviconDataUrl ? (
          <img
            src={activity.faviconDataUrl}
            alt=""
            className="size-3 shrink-0 rounded-[2px]"
          />
        ) : (
          <Globe2 className="text-fg2 size-3 shrink-0" aria-hidden="true" />
        )}
        <span
          className="text-fg1 text-2xs min-w-0 flex-1 truncate text-left"
          title={pipTitle}
        >
          {pipTitle}
        </span>
        <button
          type="button"
          className="text-fg2 hover:bg-bg2-hover hover:text-fg1 pointer-events-auto inline-flex size-5 items-center justify-center rounded-sm"
          disabled={stopping}
          onClick={(event) => {
            event.stopPropagation();
            if (!browserSessionId || !activeChatId || stopping) return;
            setStopping(true);
            void sessions
              .stopBrowserUse(activeChatId, browserSessionId)
              .catch(() => undefined)
              .finally(() => setStopping(false));
          }}
          aria-label="Stop agent browser work"
        >
          <CircleStop className="size-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="text-fg2 hover:bg-bg2-hover hover:text-fg1 pointer-events-auto inline-flex size-5 items-center justify-center rounded-sm"
          onClick={() => setHiddenSessionId(browserSessionId ?? null)}
          aria-label="Hide browser picture in picture"
        >
          <Minus className="size-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="text-fg2 hover:bg-bg2-hover hover:text-fg1 pointer-events-auto inline-flex size-5 items-center justify-center rounded-sm"
          onClick={restoreBrowser}
          aria-label="Restore browser column"
        >
          <Maximize2 className="size-3" aria-hidden="true" />
        </button>
      </div>
      <div ref={hostRef} className="bg-bg1 absolute inset-0">
        {parked && capture ? (
          <img
            src={capture}
            alt="Current browser page"
            className="absolute inset-0 size-full object-fill"
            draggable={false}
          />
        ) : null}
      </div>
    </section>
  );
}

function browserHostname(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}
