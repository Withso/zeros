import {
  createTerminalWorkbenchTab,
  type WorkbenchScopeState,
  type WorkbenchTab,
} from "./tab-model";
import { isRunSessionId } from "@zeros/protocol/run-actions";

export interface OpenTerminalIntent {
  terminalId: string;
  title: string;
  /** Omitted when navigating: keep an existing terminal's chosen placement. */
  placement?: "tab" | "panel";
}

export function visibleWorkbenchTabs(tabs: WorkbenchTab[]): WorkbenchTab[] {
  return tabs.filter(
    (t) => t.type !== "terminal" || t.terminalPlacement !== "panel",
  );
}

/** A close/dock chooses a surviving neighbor in the same strip. */
export function terminalTabNeighbor(
  tabs: WorkbenchTab[],
  previous: WorkbenchTab[],
  id: string | null,
): string | null {
  if (tabs.some((t) => t.id === id)) return id;
  const available = new Set(tabs.map((t) => t.id));
  const index = previous.findIndex((t) => t.id === id);
  return (
    previous.slice(index + 1).find((t) => available.has(t.id))?.id ??
    previous
      .slice(0, Math.max(0, index))
      .reverse()
      .find((t) => available.has(t.id))?.id ??
    tabs[0]?.id ??
    null
  );
}

/** Session identity is immutable. Navigation never replaces another terminal. */
export function openTerminalTab(
  cur: WorkbenchScopeState,
  intent: OpenTerminalIntent,
): WorkbenchScopeState {
  const existing = cur.tabs.find(
    (t) => t.type === "terminal" && t.terminalId === intent.terminalId,
  );
  const placement = intent.placement ?? existing?.terminalPlacement ?? "tab";
  const tab: WorkbenchTab = existing ?? {
    ...createTerminalWorkbenchTab(intent.terminalId, intent.title),
    terminalPlacement: placement,
  };
  const changed =
    existing &&
    (existing.title !== intent.title ||
      existing.terminalPlacement !== placement);
  const tabs = !existing
    ? [...cur.tabs, tab]
    : changed
      ? cur.tabs.map((t) =>
          t === existing
            ? { ...t, title: intent.title, terminalPlacement: placement }
            : t,
        )
      : cur.tabs;
  const activeId =
    placement === "tab"
      ? tab.id
      : terminalTabNeighbor(visibleWorkbenchTabs(tabs), cur.tabs, cur.activeId);
  const activeTerminalPanelId =
    placement === "panel"
      ? tab.id
      : terminalTabNeighbor(
          tabs.filter((t) => t.terminalPlacement === "panel"),
          cur.tabs,
          cur.activeTerminalPanelId ?? null,
        );
  if (
    tabs === cur.tabs &&
    activeId === cur.activeId &&
    activeTerminalPanelId === (cur.activeTerminalPanelId ?? null)
  )
    return cur;
  return { ...cur, tabs, activeId, activeTerminalPanelId };
}

/** Readiness is per destination kind. Cold/failed reads never prune a tab. */
export function reconcileTerminalTabs(
  cur: WorkbenchScopeState,
  titles: ReadonlyMap<string, string>,
  authoritative: (id: string) => boolean,
): WorkbenchScopeState {
  let changed = false;
  const tabs: WorkbenchTab[] = [];
  for (const tab of cur.tabs) {
    if (tab.type !== "terminal" || !tab.terminalId) {
      tabs.push(tab);
      continue;
    }
    const title = titles.get(tab.terminalId);
    if (title === undefined && authoritative(tab.terminalId)) {
      changed = true;
      continue;
    }
    if (title !== undefined && title !== tab.title) {
      changed = true;
      tabs.push({ ...tab, title });
    } else tabs.push(tab);
  }
  if (!changed) return cur;
  let next: WorkbenchScopeState = {
    ...cur,
    tabs,
    activeId: terminalTabNeighbor(
      visibleWorkbenchTabs(tabs),
      cur.tabs,
      cur.activeId,
    ),
    activeTerminalPanelId: terminalTabNeighbor(
      tabs.filter((t) => t.terminalPlacement === "panel"),
      cur.tabs,
      cur.activeTerminalPanelId ?? null,
    ),
  };
  // Removing a selected run action keeps the user in the Run workflow, just
  // as the former panel did: another action, Add run script, or Setup.
  for (const selectedId of [cur.activeId, cur.activeTerminalPanelId]) {
    const removed = cur.tabs.find(
      (tab) =>
        tab.id === selectedId &&
        tab.terminalId &&
        isRunSessionId(tab.terminalId),
    );
    if (!removed || tabs.some((tab) => tab.id === removed.id)) continue;
    const fallback = titles.has("run:add")
      ? "run:add"
      : ([...titles.keys()].find(isRunSessionId) ??
        (titles.has("setup") ? "setup" : null));
    if (fallback)
      next = openTerminalTab(next, {
        terminalId: fallback,
        title: titles.get(fallback)!,
        // Reuse another terminal's explicit placement. Only a newly opened
        // fallback inherits the removed destination's surface.
        placement: next.tabs.some((tab) => tab.terminalId === fallback)
          ? undefined
          : (removed.terminalPlacement ?? "tab"),
      });
  }
  return next;
}
