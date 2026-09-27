// ============================================
// COMPONENT: SidebarToggleButton / CollapsedSidebarControls
// PURPOSE: The panel-left control that hides and restores the app sidebar.
// USED IN: AppSidebar's title band (open) and MainShellBody (collapsed)
// ============================================
//
// The native macOS traffic lights own the window's top-left corner
// (trafficLightPosition x=19, y=12 in electron/main.ts), and the toggle sits
// immediately after them in both states:
//
//   open       [● ● ●][▯] … inside the sidebar's 40px title band
//   collapsed  [● ● ●][▯]   a 40px band floating over the content's corner
//
// Both bands seat the button identically — a 74px traffic-light reserve, a 4px
// gap, then the 28px button (x 78–106) — so toggling never moves it. The
// collapsed band is 110px wide (with its 4px end padding). Surfaces that own
// that corner keep it clear: the first chat strip reserves it in its leading
// slot (conversation-pane.tsx) and Home pages start below the band
// (app-shell.tsx).

import { useRef } from "react";
import { PanelLeft } from "lucide-react";

import { Button } from "../shared/ui/primitives/button";
import { Tooltip } from "../shared/ui/primitives/tooltip";
import { toggleSidebarCollapsed } from "./sidebar-collapsed";
import { useCustomWindowDrag } from "./use-custom-window-drag";

/** The sidebar root's id, so both toggles can name what they control. */
export const APP_SIDEBAR_ID = "app-sidebar";

/** Clears the native traffic lights; the toggle follows after a 4px gap. */
export const TRAFFIC_LIGHT_RESERVE_CLS = "h-full w-[74px] shrink-0";

const TOGGLE_CLS =
  "h-7 w-7 shrink-0 rounded-md text-fg2 hover:bg-sidebar-bg-hover hover:text-fg1";

export function SidebarToggleButton({ collapsed }: { collapsed: boolean }) {
  const label = collapsed ? "Show sidebar" : "Hide sidebar";
  return (
    <Tooltip label={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={TOGGLE_CLS}
        aria-label={label}
        aria-expanded={!collapsed}
        aria-controls={APP_SIDEBAR_ID}
        onClick={toggleSidebarCollapsed}
      >
        <PanelLeft className="size-4" strokeWidth={1.5} />
      </Button>
    </Tooltip>
  );
}

/** Shown only while the sidebar is collapsed. It floats on the chrome layer
 * so it stays above the first chat strip, and its empty area around the
 * traffic lights still drags the window. */
export function CollapsedSidebarControls() {
  const bandRef = useRef<HTMLDivElement | null>(null);
  useCustomWindowDrag(bandRef);
  return (
    <div
      ref={bandRef}
      className="absolute top-0 left-0 z-(--z-chrome) flex h-10 items-center gap-1 pr-1"
      data-collapsed-sidebar-controls=""
    >
      <div className={TRAFFIC_LIGHT_RESERVE_CLS} aria-hidden="true" />
      <SidebarToggleButton collapsed />
    </div>
  );
}
