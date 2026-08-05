// ──────────────────────────────────────────────────────────
// Workbench tab bodies
// ──────────────────────────────────────────────────────────

import React from "react";
import { BrowserTab } from "./tabs/browser-tab";
import { ChangesWorkbenchSurface } from "./tabs/changes-surface";
import { ContextSurface } from "./tabs/context-surface";
import { FilesTab } from "./tabs/files-tab";
import { ReviewSurface } from "./tabs/review-surface";
import type { WorkbenchTab, WorkbenchTabType } from "./tab-model";

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
  changes: ChangesWorkbenchSurface,
  review: ReviewSurface,
  context: ContextSurface,
  browser: BrowserTab,
  files: FilesTab,
};

export function WorkbenchTabContent({ tab, active, scope }: TabBodyProps) {
  const Body = TAB_BODY_MAP[tab.type];
  return <Body tab={tab} active={active} scope={scope} />;
}
