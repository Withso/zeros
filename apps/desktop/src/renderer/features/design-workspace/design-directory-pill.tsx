// ============================================
// COMPONENT: DesignDirectoryPill
// PURPOSE: Secondary Design toolbar: Layers + Inspector toggle and directory
//          switcher. The component name and DOM hooks remain compatible.
// USED IN: DesignWorkspaceColumn
// ============================================

import React from "react";
import { PanelRight } from "lucide-react";

import type { Workspace } from "../../platform/git";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import {
  designDirectoryTargetKeyForWorkspace,
  useDesignDirectoryTarget,
} from "../../state/design-directory-target";

import { DesignDirectoryMenu } from "./design-directory-menu";
import { IconButton, PanelHeader, Tooltip } from "../../shared/ui/primitives";
import { WorkbenchTabToolbar } from "../../shell/workbench/tab-status";

export function DesignDirectoryPill({
  workspace,
  active,
  panelVisible,
  onTogglePanel,
}: {
  workspace: Workspace;
  /** Hidden retained surfaces keep their directory read and menu inert. */
  active: boolean;
  panelVisible: boolean;
  onTogglePanel: () => void;
}) {
  const directory = useDesignDirectoryTarget(
    designDirectoryTargetKeyForWorkspace(workspace.id),
    { enabled: active },
  );
  return (
    <WorkbenchTabToolbar>
      <PanelHeader
        size="window"
        role="group"
        aria-label="Design directory"
        data-design-directory-header=""
        data-design-directory-workspace={workspace.id}
        data-design-controls=""
        className="zd-design-directory-pill min-w-0"
      >
        <Tooltip
          label={
            panelVisible
              ? "Hide panels · ⌘\\"
              : "Show panels · ⌘\\"
          }
          side="bottom"
        >
          <IconButton
            label="Toggle Layers and Inspector"
            size="standard"
            className="hover:bg-bg1-hover"
            aria-pressed={panelVisible}
            aria-controls={`design-panel-${workspace.id}`}
            disabled={!active}
            aria-keyshortcuts={"Meta+\\ Control+\\"}
            onClick={onTogglePanel}
          >
            <PanelRight />
          </IconButton>
        </Tooltip>
        <DesignDirectoryMenu
          key={isCloudWorkspace(workspace.id) ? workspace.id : undefined}
          workspace={workspace}
          active={active}
          name={directory.data?.directory ?? "Design"}
        />
      </PanelHeader>
    </WorkbenchTabToolbar>
  );
}
