import { useActiveWorkspace } from "../../state/use-active-workspace";
import { DesignDirectoryMenu } from "./design-directory-menu";
import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Workspace } from "../../platform/git";

import { designDirectoryTargetKeyForWorkspace, useDesignDirectoryTarget } from "../../state/design-directory-target";
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

import { popoverBoundaryProps } from "@/renderer/shared/ui/popover-boundary";
const SIDEBAR_BASE_CLS =
  "bg-bg1 relative flex min-h-0 w-[var(--zeros-design-layers-width,240px)] flex-col overflow-hidden [flex:0_1_var(--zeros-design-layers-width,240px)] min-w-[min(180px,34%)] max-w-[min(720px,34%)]";

export function DesignWorkspaceSidebar({
  surfaceActive,
  workspace = null,
  folder = null,
}: {
  surfaceActive: boolean;
  workspace?: Workspace | null;
  folder?: string | null;
}) {
  const currentWorkspace = useActiveWorkspace().workspace;
  const directoryWorkspace = workspace ?? currentWorkspace;
  const sectionRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(readPersistedDesignWorkspaceLayersWidth);
  const ownerSuffix = workspace?.id ?? null;
  const directory = useDesignDirectoryTarget(
    directoryWorkspace ? designDirectoryTargetKeyForWorkspace(directoryWorkspace.id) : null,
    { enabled: surfaceActive },
  );
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
      {...popoverBoundaryProps}
      aria-label="Design workspace sidebar"
      className={SIDEBAR_BASE_CLS}
    >
      <div data-design-directory-header="" className="border-border1 flex h-10 shrink-0 items-center border-b px-3">
        {workspace ? <DesignDirectoryMenu workspace={workspace} active={surfaceActive} name={directory.data?.directory ?? "Design"} /> : <span data-design-directory-name="" className="text-fg1 truncate text-xs font-medium">{directory.data?.directory ?? "Design"}</span>}
      </div>
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
