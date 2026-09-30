// ============================================
// COMPONENT: DesignDirectoryPill
// PURPOSE: Floating top-left canvas pill: Design directory switcher and the
//          Layers + Inspector panel toggle
// USED IN: DesignWorkspaceColumn
// ============================================

import React from "react";
import { PanelRight } from "lucide-react";

import type { Workspace } from "../../platform/git";
import {
  designDirectoryTargetKeyForWorkspace,
  useDesignDirectoryTarget,
} from "../../state/design-directory-target";

import { DesignDirectoryMenu } from "./design-directory-menu";
import { DesignToolbarButton } from "./design-inspector-kit";

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
    <div
      role="group"
      aria-label="Design directory"
      data-design-directory-header=""
      data-design-controls=""
      className="zd-design-floating-toolbar zd-design-directory-pill absolute flex items-center"
    >
      <DesignDirectoryMenu
        workspace={workspace}
        active={active}
        name={directory.data?.directory ?? "Design"}
      />
      <span className="zd-canvas-toolbar-divider" aria-hidden="true" />
      <DesignToolbarButton
        label="Toggle Layers and Inspector"
        tooltip={
          panelVisible
            ? "Hide Layers and Inspector"
            : "Show Layers and Inspector"
        }
        shortcut={"⌘\\"}
        tooltipSide="bottom"
        pressed={panelVisible}
        disabled={!active}
        aria-keyshortcuts={"Meta+\\ Control+\\"}
        onClick={onTogglePanel}
      >
        <PanelRight />
      </DesignToolbarButton>
    </div>
  );
}
