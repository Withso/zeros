// ──────────────────────────────────────────────────────────
// Workbench tab bodies
// ──────────────────────────────────────────────────────────

import React from "react";
import { BrowserTab } from "./tabs/browser-tab";
import { ChangesWorkbenchSurface } from "./tabs/changes-surface";
import { FilesTab } from "./tabs/files-tab";
import { ReviewSurface } from "./tabs/review-surface";
import type { WorkbenchTab, WorkbenchTabType } from "./tab-model";
import { useWorkspaceStore, selectActiveFolder } from "../../state/store";
import { WorkbenchTabFrame } from "./tab-status";
import { WORKBENCH_STATUS_ADAPTERS } from "./tab-status-model";
import { useSourceTarget } from "./tabs/changes-tab";
import { useChangesFilter } from "./tabs/changes-filter-store";
import { scopeIdentity } from "./tabs/changes-scope";

interface TabBodyProps {
  tab: WorkbenchTab;
  active: boolean;
  /** Persisted workspace scope for a retained Browser tab. */
  scope?: string;
}

const TAB_BODY_MAP: Record<
  WorkbenchTabType,
  React.ComponentType<TabBodyProps>
> = {
  // The shared terminal deck owns these bodies in both placements, preserving
  // xterm identity when a tab moves between the workbench and bottom panel.
  terminal: () => null,
  // The bounded Design deck preserves canvas iframes across workspace hops.
  design: () => null,
  changes: ChangesWorkbenchSurface,
  review: ReviewSurface,
  browser: BrowserTab,
  files: FilesTab,
};

export function WorkbenchTabContent({ tab, active, scope }: TabBodyProps) {
  const Body = TAB_BODY_MAP[tab.type];
  const folder = useWorkspaceStore(selectActiveFolder);
  const { workspace, changesTarget } = useSourceTarget();
  const filter = useChangesFilter(changesTarget ?? "");
  // Changes owns its comparison in the shared filter store, rather than the
  // tab document. PR identity likewise belongs to workspace metadata.
  const statusTarget =
    tab.type === "changes" && changesTarget
      ? JSON.stringify([
          changesTarget,
          scopeIdentity(filter.scope),
          filter.turn,
        ])
      : tab.type === "review" && workspace
        ? JSON.stringify([workspace.id, workspace.prNumber, tab.reviewSubtab])
        : undefined;
  // The exhaustive status adapter and unconditional frame make the contract
  // structural for future bodies. Retained decks use the same frame below.
  const adapter = WORKBENCH_STATUS_ADAPTERS[tab.type];
  return (
    <WorkbenchTabFrame
      tab={tab}
      folder={scope ?? folder ?? ""}
      active={active}
      key={adapter.noun}
      statusTarget={statusTarget}
    >
      <Body tab={tab} active={active} scope={scope} />
    </WorkbenchTabFrame>
  );
}
