// ──────────────────────────────────────────────────────────
// Workbench Tab Strip — inline tab strip for Workbench's header band
// ──────────────────────────────────────────────────────────
//
// The tab strip is rendered INSIDE
// Workbench's own 40px header band. No outer wrapper /
// border-bottom: the header band's own border is the visual
// divider.
//
// Layout: [Open file] [Changes] [Review] [...File/Browser tabs] [+]
// - Changes + Review are pinned homes, and the leading File tab is the FIXED
//   Files home: permanent like them, but its ✕ closes the open FILE (the tab
//   reverts to the blank "Open file" tree) and hides entirely while blank.
//   Extra File and Browser tabs are all closable, including blanks. The Changes
//   pill carries the live All Changes count (committed + uncommitted net diff).
// - The ✕ on an extra File or Browser tab removes the whole tab.
// - Tab pill: icon + truncated title + absolute-positioned close button
//   (no width-on-hover layout shift) + fade gradient mask. Blank tabs keep the
//   explicit Open file / Browser labels.
// - Sticky strip (use-sticky-tab-strip.tsx): when the tabs overflow, only the
//   lane scrolls — the "+" stays fixed after it — and the ACTIVE pill pins to
//   whichever lane edge it reaches, so the selection can never scroll out of
//   view. Hover fills follow `data-hovered` (the hook's re-hit-testing), not
//   native :hover.

import React from "react";
import { CircleStop, MousePointer2, X } from "lucide-react";
import { Tooltip } from "../../shared/ui/primitives";
import { FileTypeIcon } from "../../features/agent/composer-editor/file-type-icon";
import { useWorkspaceDispatch } from "../../state/store";
import {
  TAB_TYPE_META,
  workbenchTabIconPath,
  type WorkbenchTab,
} from "./tab-model";
import {
  WORKBENCH_TAB_PILL_ACTIVE_CLS,
  WORKBENCH_TAB_PILL_BASE_CLS,
  WORKBENCH_TAB_PILL_INACTIVE_CLS,
} from "./tab-chrome";
import {
  STICKY_TAB_NAV_CLS,
  STICKY_TAB_ROW_CLS,
  STICKY_TAB_VIEWPORT_CLS,
  StickyTabStripFades,
  useStickyTabStrip,
} from "../use-sticky-tab-strip";
import { useWorkspaceChangeCount } from "./tabs/changes-tab";
import { useGitRefreshKey } from "../use-git-refresh-key";
import { WorkbenchNewTabMenu } from "./new-tab-menu";
import {
  browserSessionIsAgentActive,
  dismissBrowserSession,
  useConversationBrowserActivity,
} from "../../features/browser/browser-session-activity-store";
import { useAgentSessions } from "../../features/agent/sessions-hooks";
import { nativeInvoke } from "../../platform/runtime";
import {
  forgetBrowserTabFavicon,
  useBrowserTabFavicon,
} from "../../features/browser/browser-tab-favicon-store";

interface WorkbenchTabStripProps {
  /** The persisted workbench home + open-File tab list — see Workbench. */
  tabs: WorkbenchTab[];
  /** The validated active tab id from the same composition. */
  activeId: string | null;
  /** The workspace the tabs belong to — a switch restarts the strip's scroll
   *  at the leading edge instead of leaking the previous workspace's offset. */
  folderKey: string;
  /** Git target identity: opaque row id for a worktree, local repo root for the
   * rowless primary checkout. Only opaque ids arrive from cross-device events. */
  workspaceId: string | null;
}

export function WorkbenchTabStrip({
  tabs,
  activeId,
  folderKey,
  workspaceId,
}: WorkbenchTabStripProps) {
  const dispatch = useWorkspaceDispatch();
  // The Changes pill's live All Changes net count — the same exact comparison
  // (and refresh bus) the default Changes list reads, so the two always agree.
  const refreshKey = useGitRefreshKey(folderKey, workspaceId);
  const changeCount = useWorkspaceChangeCount(refreshKey);

  const strip = useStickyTabStrip({
    activeKey: activeId,
    resetKey: folderKey,
    tabCount: tabs.length,
    tabAttr: "data-workbench-tab",
  });

  const handleClose = (
    e: React.MouseEvent,
    tab: WorkbenchTab,
    browserSessionId?: string,
  ) => {
    e.stopPropagation();
    if (
      tab.type === "changes" ||
      tab.type === "review" ||
      tab.type === "context"
    )
      return;
    if (tab.type === "browser") {
      forgetBrowserTabFavicon(`zeros-browser-${tab.id}`);
      if (browserSessionId) {
        dismissBrowserSession(browserSessionId);
        void nativeInvoke("browser_session_close", {
          browserSessionId,
        }).catch(() => undefined);
      }
    }
    dispatch({ type: "REMOVE_WORKBENCH_TAB", id: tab.id });
  };

  const handleActivate = (id: string) => {
    if (id !== activeId) dispatch({ type: "ACTIVATE_WORKBENCH_TAB", id });
  };

  return (
    <div className="flex h-full min-w-0 items-center pl-1">
      <div className={STICKY_TAB_VIEWPORT_CLS}>
        <div
          ref={strip.navRef}
          className={STICKY_TAB_NAV_CLS}
          role="tablist"
          aria-label="Workspace panels"
          {...strip.navProps}
        >
          <div className={STICKY_TAB_ROW_CLS}>
            {tabs.map((tab) => (
              <TabPill
                key={tab.id}
                tab={tab}
                active={tab.id === activeId}
                canClose={
                  tab.type === "browser" ||
                  // The fixed Files home only offers ✕ while a file is open
                  // (✕ = close the file); blank, there is nothing to close.
                  (tab.type === "files" && (!tab.fixed || !!tab.filePath))
                }
                badge={tab.type === "changes" ? changeCount : 0}
                onActivate={() => handleActivate(tab.id)}
                onClose={(e, browserSessionId) =>
                  handleClose(e, tab, browserSessionId)
                }
                registerRef={(node) => strip.registerTab(tab.id, node)}
              />
            ))}
          </div>
        </div>
        <StickyTabStripFades fades={strip.fadeRefs} />
      </div>
      {/* The "+" sits OUTSIDE the scroll lane: it hugs the last tab while
          they fit, then stays put while only the tabs scroll. */}
      <div className="flex h-full shrink-0 items-center">
        <WorkbenchNewTabMenu />
      </div>
      <div className="min-w-0 flex-1" aria-hidden="true" />
    </div>
  );
}

// ── Tab pill ───────────────────────────────────────────────

interface TabPillProps {
  tab: WorkbenchTab;
  active: boolean;
  canClose: boolean;
  /** Count rendered after the label (the Changes pill's live change count). */
  badge: number;
  onActivate: () => void;
  onClose: (e: React.MouseEvent, browserSessionId?: string) => void;
  /** Registers the pill with the sticky strip (pin math + reveal). */
  registerRef: (node: HTMLDivElement | null) => void;
}

/** Every current tab has an explicit label, including the blank "Open file"
 *  and "Browser" states. */
function tabShowsLabel(tab: WorkbenchTab): boolean {
  return Boolean(tab.title);
}

function TabPill({
  tab,
  active,
  canClose,
  badge,
  onActivate,
  onClose,
  registerRef,
}: TabPillProps) {
  const meta = TAB_TYPE_META[tab.type];
  const Icon = meta.icon;
  const showLabel = tabShowsLabel(tab);
  // A File tab wears its file's own colored type glyph (same sprite as the tree
  // and the viewer breadcrumb); everything else keeps its type's lucide glyph.
  const iconPath = workbenchTabIconPath(tab);
  const browserActivity = useConversationBrowserActivity(
    tab.type === "browser" ? tab.browserConversationId : undefined,
  );
  const ordinaryBrowserFavicon = useBrowserTabFavicon(
    tab.type === "browser" && !tab.browserConversationId
      ? `zeros-browser-${tab.id}`
      : undefined,
  );
  const favicon =
    tab.type === "browser"
      ? (browserActivity?.faviconDataUrl ?? ordinaryBrowserFavicon ?? undefined)
      : undefined;
  const browserWorking =
    tab.type === "browser" && browserSessionIsAgentActive(browserActivity);
  const sessions = useAgentSessions();
  const [stoppingBrowser, setStoppingBrowser] = React.useState(false);
  const stopAgentBrowser = React.useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      const browserSessionId = browserActivity?.browserSessionId;
      const conversationId =
        tab.type === "browser" ? tab.browserConversationId : undefined;
      if (!browserSessionId || !conversationId || stoppingBrowser) return;
      setStoppingBrowser(true);
      void sessions
        .stopBrowserUse(conversationId, browserSessionId)
        .catch(() => undefined)
        .finally(() => setStoppingBrowser(false));
    },
    [browserActivity?.browserSessionId, sessions, stoppingBrowser, tab],
  );
  return (
    <div
      ref={registerRef}
      role="tab"
      aria-selected={active}
      aria-label={tab.title}
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      data-active={active}
      data-workbench-tab="true"
      className={[
        // Chrome-style tabs: rounded pills with a small gap between them and no
        // dividers. Only the active tab carries a background; inactive tabs are
        // transparent until hover. `overflow-hidden` keeps the close-button fade
        // inside the rounded corners. group/tab drives the close + fade on hover.
        "group/tab",
        WORKBENCH_TAB_PILL_BASE_CLS,
        // Labelled tabs fit their content up to a 180px cap (then
        // truncate); icon-only (empty) pills get a tighter square footprint.
        showLabel ? "max-w-[180px] gap-1.5 px-2.5" : "px-2",
        browserWorking ? "pr-7" : "",
        active
          ? WORKBENCH_TAB_PILL_ACTIVE_CLS
          : WORKBENCH_TAB_PILL_INACTIVE_CLS,
      ].join(" ")}
    >
      {browserWorking ? (
        <MousePointer2
          className="text-blue-fg size-3.5 shrink-0 fill-current drop-shadow-[0_0_5px_rgba(47,190,235,.45)]"
          aria-hidden="true"
        />
      ) : favicon ? (
        <img src={favicon} alt="" className="size-3.5 shrink-0 rounded-[2px]" />
      ) : iconPath ? (
        // size 14 === the size-3.5 the lucide glyphs use, so swapping the glyph
        // never shifts the pill's label.
        <FileTypeIcon name={iconPath} size={14} className="shrink-0" />
      ) : (
        <Icon className="size-3.5 shrink-0" />
      )}
      {showLabel && (
        <span
          className={[
            "truncate",
            browserWorking ? "zeros-browser-tab-working" : "",
          ].join(" ")}
        >
          {tab.title}
        </span>
      )}
      {badge > 0 && (
        // Bare count — no chip bg (saves space); the pill's gap spaces it.
        // Bare-count treatment (no chip) keeps the pill compact.
        <span className="text-fg2 text-2xxs tabular-nums">{badge}</span>
      )}
      {browserWorking ? (
        <div className="from-bg2 pointer-events-none absolute inset-y-0 right-0 flex w-9 items-center justify-end bg-gradient-to-l from-55% to-transparent pr-1.5 pl-3">
          <Tooltip label="Stop agent browser work">
            <button
              type="button"
              onClick={stopAgentBrowser}
              disabled={stoppingBrowser}
              aria-label="Stop agent browser work"
              className="text-fg2 hover:bg-bg2-hover hover:text-fg1 pointer-events-auto inline-flex size-5 shrink-0 items-center justify-center rounded-sm transition-[background-color,color] duration-120 ease-out disabled:opacity-50"
            >
              <CircleStop className="size-3.5" aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      ) : canClose ? (
        // Reveal-on-hover close overlay — the same treatment as the chat tabs
        // (conversation/chat-tabs TAB_HOVER_OVERLAY_CLS): the wrapper carries a
        // gradient fade matching the pill's bg-bg2 hover/active fill so a long
        // title bleeds behind the ✕ instead of being clipped by a hard edge.
        // `pointer-events-none` on the wrapper keeps the gradient from
        // stealing hover from the underlying tab; the button opts back in.
        // Pure overlay (absolute) → no flex-width change on hover, no layout
        // shift. focus-within keeps it visible for keyboard users. Reveal keys
        // off the strip-driven data-hovered, not :hover (sticky-strip rule).
        <div className="from-bg2 pointer-events-none absolute inset-y-0 right-0 flex w-10 items-center justify-end bg-gradient-to-l from-50% to-transparent pr-1.5 pl-4 opacity-0 transition-none group-data-[hovered=true]/tab:opacity-100 focus-within:opacity-100">
          <Tooltip
            label={
              tab.type === "files" && tab.fixed ? "Close file" : "Close tab"
            }
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(e, browserActivity?.browserSessionId);
              }}
              aria-label={`Close ${tab.title}`}
              className="text-fg2 hover:bg-bg2-hover hover:text-fg1 pointer-events-auto inline-flex size-5 shrink-0 items-center justify-center rounded-sm transition-[background-color,color] duration-120 ease-out"
            >
              <X className="size-3.5" />
            </button>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
