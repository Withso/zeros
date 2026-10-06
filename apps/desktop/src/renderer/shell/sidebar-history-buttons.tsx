// ============================================
// COMPONENT: SidebarHistoryButtons
// PURPOSE: Go back / Go forward through the sidebar destinations visited this
//          session (sidebar-navigation-history.ts).
// USED IN: AppSidebar's title band, after the resource monitor
// ============================================

import { memo, useMemo } from "react";
import { ArrowLeft, ArrowRight, type LucideIcon } from "lucide-react";

import { prefetchSettingsForRepo } from "../features/settings/use-settings";
import { Button } from "../shared/ui/primitives/button";
import { Tooltip } from "../shared/ui/primitives/tooltip";
import { useWorkspaceDispatch } from "../state/store";
import { useOpenWorkspace } from "../state/use-open-workspace";
import type { WorkspaceNavigationTarget } from "./prefetch-workspace-surface";
import {
  getSidebarNavigationHistory,
  sidebarHistoryTarget,
  stepSidebarHistory,
  useSidebarNavigationHistory,
  type SidebarHistoryScope,
} from "./sidebar-navigation-history";

// The resource monitor's 28px title-band button. A step with nowhere to go is
// aria-disabled, not disabled: a disabled button drops pointer events, so a
// quick second click at the end of the history would reach the title band and
// zoom the window (use-custom-window-drag.ts).
const HISTORY_BUTTON_CLS =
  "h-7 w-7 shrink-0 rounded-md text-fg2 hover:bg-sidebar-bg-hover hover:text-fg1 aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-fg2";

interface SidebarHistoryButtonsProps {
  scope: SidebarHistoryScope;
  /** Warm the workspace a step would open, as its row does on hover. */
  onPrefetchWorkspace: (workspace: WorkspaceNavigationTarget) => void;
}

export const SidebarHistoryButtons = memo(function SidebarHistoryButtons({
  scope,
  onPrefetchWorkspace,
}: SidebarHistoryButtonsProps) {
  const history = useSidebarNavigationHistory();
  const dispatch = useWorkspaceDispatch();
  const openWorkspace = useOpenWorkspace();
  const canGoBack = useMemo(
    () => sidebarHistoryTarget(history, -1, scope) !== null,
    [history, scope],
  );
  const canGoForward = useMemo(
    () => sidebarHistoryTarget(history, 1, scope) !== null,
    [history, scope],
  );

  const step = (direction: -1 | 1) =>
    stepSidebarHistory(direction, scope, { dispatch, openWorkspace });
  const warm = (direction: -1 | 1) => {
    const route = sidebarHistoryTarget(
      getSidebarNavigationHistory(),
      direction,
      scope,
    )?.route;
    // An in-flight create's path does not exist yet; there is nothing to warm.
    if (route?.kind === "workspace" && !route.workspace.validationPending)
      onPrefetchWorkspace(route.workspace);
    else if (route?.kind === "repo") prefetchSettingsForRepo(route.repoRoot);
  };

  return (
    <>
      <HistoryButton
        label="Go back"
        icon={ArrowLeft}
        available={canGoBack}
        onStep={() => step(-1)}
        onWarm={() => warm(-1)}
      />
      <HistoryButton
        label="Go forward"
        icon={ArrowRight}
        available={canGoForward}
        onStep={() => step(1)}
        onWarm={() => warm(1)}
      />
    </>
  );
});

function HistoryButton({
  label,
  icon: Icon,
  available,
  onStep,
  onWarm,
}: {
  label: string;
  icon: LucideIcon;
  available: boolean;
  onStep: () => void;
  onWarm: () => void;
}) {
  return (
    <Tooltip label={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={HISTORY_BUTTON_CLS}
        aria-label={label}
        aria-disabled={!available || undefined}
        onPointerEnter={onWarm}
        onFocus={onWarm}
        onClick={onStep}
      >
        <Icon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
      </Button>
    </Tooltip>
  );
}
