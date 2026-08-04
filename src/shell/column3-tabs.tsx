// ──────────────────────────────────────────────────────────
// Column 3 Tab Bodies
// ──────────────────────────────────────────────────────────

import React from "react";
import { BrowserTab } from "./column3-tabs/browser-tab";
import { ChangesRow1Tab } from "./column3-tabs/changes-row1-tab";
import { ContextRow1Tab } from "./column3-tabs/context-row1-tab";
import { FilesTab } from "./column3-tabs/files-tab";
import { ReviewRow1Tab } from "./column3-tabs/review-row1-tab";
import type { Column3Tab, Column3TabType } from "./column3-tab-manager";

interface TabBodyProps {
  tab: Column3Tab;
  active: boolean;
  /** Persisted workspace scope for a retained Browser tab. */
  scope?: string;
}

const TAB_BODY_MAP: Record<
  Column3TabType,
  React.ComponentType<TabBodyProps>
> = {
  changes: ChangesRow1Tab,
  review: ReviewRow1Tab,
  context: ContextRow1Tab,
  browser: BrowserTab,
  files: FilesTab,
};

export function Column3TabBody({ tab, active, scope }: TabBodyProps) {
  const Body = TAB_BODY_MAP[tab.type];
  return <Body tab={tab} active={active} scope={scope} />;
}
