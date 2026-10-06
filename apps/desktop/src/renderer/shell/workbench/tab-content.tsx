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

function TabContentFrame({
  tab,
  active,
  scope,
  statusTarget,
}: TabBodyProps & { statusTarget?: string }) {
  const Body = TAB_BODY_MAP[tab.type];
  const folder = useWorkspaceStore(selectActiveFolder);
  return (
    <WorkbenchTabFrame
      tab={tab}
      folder={scope ?? folder ?? ""}
      active={active}
      statusTarget={statusTarget}
    >
      <Body tab={tab} active={active} scope={scope} />
    </WorkbenchTabFrame>
  );
}

function ChangesTabContent(props: TabBodyProps) {
  const { changesTarget } = useSourceTarget();
  const filter = useChangesFilter(changesTarget ?? "");
  const statusTarget = changesTarget
    ? JSON.stringify([changesTarget, scopeIdentity(filter.scope), filter.turn])
    : undefined;
  return <TabContentFrame {...props} statusTarget={statusTarget} />;
}

function ReviewTabContent(props: TabBodyProps) {
  const { workspace } = useSourceTarget();
  const statusTarget = workspace
    ? JSON.stringify([workspace.id, workspace.prNumber, props.tab.reviewSubtab])
    : undefined;
  return <TabContentFrame {...props} statusTarget={statusTarget} />;
}

// Only comparison/review bodies subscribe to their additional target stores.
// Every entry still goes through the structural frame and exhaustive adapter.
const TAB_CONTENT_MAP: Record<
  WorkbenchTabType,
  React.ComponentType<TabBodyProps>
> = {
  files: TabContentFrame,
  changes: ChangesTabContent,
  review: ReviewTabContent,
  design: TabContentFrame,
  browser: TabContentFrame,
  terminal: TabContentFrame,
};

export function WorkbenchTabContent(props: TabBodyProps) {
  const Content = TAB_CONTENT_MAP[props.tab.type];
  return <Content {...props} />;
}
