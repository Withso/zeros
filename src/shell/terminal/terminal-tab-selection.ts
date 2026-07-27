import { isRunSessionId } from "@zeros/core/run-actions";

import { SETUP_SUBTAB } from "./use-setup-control";

/** Stable id for the discoverability tab shown when no run actions exist. */
export const RUN_ADD_SUBTAB = "run:add";

/** Resolve persisted terminal focus without allowing stale state or the
 *  auto-seeded plain shell to override Setup's fresh-workspace default. */
export function resolveTerminalPanelTab({
  activeId,
  configuredRunIds,
  sessionIds,
  showRunAdd,
}: {
  activeId: string | null;
  configuredRunIds: readonly string[];
  sessionIds: readonly string[];
  showRunAdd: boolean;
}): string {
  if (activeId === SETUP_SUBTAB || activeId?.startsWith("pty-setup-"))
    return SETUP_SUBTAB;
  if (activeId === RUN_ADD_SUBTAB && showRunAdd) return RUN_ADD_SUBTAB;
  if (activeId && configuredRunIds.includes(activeId)) return activeId;
  if (activeId && isRunSessionId(activeId))
    return showRunAdd ? RUN_ADD_SUBTAB : (configuredRunIds[0] ?? SETUP_SUBTAB);
  if (activeId && sessionIds.includes(activeId)) return activeId;
  return SETUP_SUBTAB;
}
