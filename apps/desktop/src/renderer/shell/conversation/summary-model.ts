import { isRunSessionId } from "@zeros/protocol/run-actions";
import type { ContextGraphItemWire } from "../../platform/context-graph";
import type { WorkbenchTab, WorkbenchTabType } from "../workbench/tab-model";
import type { PaneNode } from "../../state/chat-panes";

/** A side-by-side split anywhere in the tree gives Summary back its tab icon. */
export function summaryHasSplitColumns(node: PaneNode): boolean {
  return (
    node.type === "split" &&
    (node.direction === "row" ||
      summaryHasSplitColumns(node.first) ||
      summaryHasSplitColumns(node.second))
  );
}

/** Sort a copy: the Context canvas owns the shared snapshot's ordering. */
export function recentSummaryContext(
  items: readonly ContextGraphItemWire[],
): ContextGraphItemWire[] {
  return [...items]
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.relPath.localeCompare(b.relPath))
    .slice(0, 3);
}

/** Reuse the workspace's destinations without changing their nested selection. */
export function summaryDestinationTab(
  tabs: readonly WorkbenchTab[],
  activeId: string | null,
  type: WorkbenchTabType,
): WorkbenchTab | undefined {
  const candidates = tabs.filter((tab) => {
    if (tab.type !== type) return false;
    if (type !== "terminal") return true;
    return (
      !!tab.terminalId &&
      tab.terminalId !== "setup" &&
      tab.terminalId !== "run:add" &&
      !isRunSessionId(tab.terminalId)
    );
  });
  if (type === "files")
    return candidates.find((tab) => tab.fixed) ?? candidates[0];
  return candidates.find((tab) => tab.id === activeId) ?? candidates[0];
}
