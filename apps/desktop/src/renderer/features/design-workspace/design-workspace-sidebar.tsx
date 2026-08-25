import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Workspace } from "../../platform/git";

import { WorkspaceModeHeader } from "../../shared/ui/workspace-mode-header";
import { DesignPanelResizeHandle } from "./design-panel-resize-handle";
import { DesignWorkspaceSidebarPanels } from "./design-workspace-sidebar-panels";
import {
  DESIGN_WORKSPACE_LAYERS_WIDTH_DEFAULT,
  DESIGN_WORKSPACE_LAYERS_WIDTH_MAX,
  DESIGN_WORKSPACE_LAYERS_WIDTH_MIN,
  DESIGN_WORKSPACE_LAYERS_WIDTH_VAR,
  clampDesignWorkspaceLayersWidth,
  persistDesignWorkspaceLayersWidth,
  readPersistedDesignWorkspaceLayersWidth,
} from "./design-workspace-width";

const SIDEBAR_BASE_CLS =
  "bg-bg1 relative flex min-h-0 w-[var(--zeros-design-layers-width,240px)] flex-col overflow-hidden [flex:0_1_var(--zeros-design-layers-width,240px)] min-w-[min(180px,34%)] max-w-[min(720px,50%)]";

export function DesignWorkspaceSidebar({
  surfaceActive,
  workspace = null,
  folder = null,
}: {
  surfaceActive: boolean;
  workspace?: Workspace | null;
  folder?: string | null;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(readPersistedDesignWorkspaceLayersWidth);
  const ownerSuffix = workspace?.id ?? null;
  const sidebarId = ownerSuffix
    ? `design-workspace-sidebar-${ownerSuffix}`
    : "design-workspace-sidebar";
  const panelId = ownerSuffix
    ? `design-layers-panel-${ownerSuffix}`
    : "design-layers-panel";

  useLayoutEffect(() => {
    sectionRef.current?.parentElement?.style.setProperty(
      DESIGN_WORKSPACE_LAYERS_WIDTH_VAR,
      `${width}px`,
    );
  }, [width]);

  const persist = useCallback((next: number) => {
    const committed = persistDesignWorkspaceLayersWidth(next);
    setWidth(committed);
    sectionRef.current?.parentElement?.style.setProperty(
      DESIGN_WORKSPACE_LAYERS_WIDTH_VAR,
      `${committed}px`,
    );
    document.documentElement.style.setProperty(
      DESIGN_WORKSPACE_LAYERS_WIDTH_VAR,
      `${committed}px`,
    );
  }, []);

  return (
    <section
      ref={sectionRef}
      id={sidebarId}
      data-design-workspace-surface=""
      aria-label="Design workspace sidebar"
      className={SIDEBAR_BASE_CLS}
    >
      <WorkspaceModeHeader workspace={workspace} separator />
      <DesignWorkspaceSidebarPanels
        surfaceActive={surfaceActive}
        workspace={workspace}
        folder={folder}
        panelId={panelId}
      />
      <DesignPanelResizeHandle
        panelRef={sectionRef}
        edge="right"
        value={width}
        defaultValue={DESIGN_WORKSPACE_LAYERS_WIDTH_DEFAULT}
        minimum={DESIGN_WORKSPACE_LAYERS_WIDTH_MIN}
        maximum={DESIGN_WORKSPACE_LAYERS_WIDTH_MAX}
        clampValue={clampDesignWorkspaceLayersWidth}
        onCommit={persist}
        ariaLabel="Resize Layers panel"
        controlsId={sidebarId}
      />
    </section>
  );
}
