import { isRunSessionId } from "@zeros/protocol/run-actions";

import { SETUP_SUBTAB } from "./use-setup-control";

/** Stable id for the discoverability tab shown when no run actions exist. */
export const RUN_ADD_SUBTAB = "run:add";

export type TerminalTabAuthority = "human-user" | "repo-code-task";

/** Plain shells are the explicit, uncontained human terminal. Setup and Run
 * execute repository-controlled bytes through the repo-code-task boundary.
 * Keep this classification separate from visual tab names so persisted ids
 * cannot accidentally make a protected task look like a user shell. */
export function terminalTabAuthority(
  activeId: string,
  plainSessionIds: readonly string[],
): TerminalTabAuthority {
  return activeId !== SETUP_SUBTAB &&
    activeId !== RUN_ADD_SUBTAB &&
    !isRunSessionId(activeId) &&
    !activeId.startsWith("pty-setup-") &&
    plainSessionIds.includes(activeId)
    ? "human-user"
    : "repo-code-task";
}

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
