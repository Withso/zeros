import { gateComputerUseSettings } from "@zeros/protocol/agent-control-rollout";
import {
  computerUseSettings,
  resolveComputerUseRoute,
  type ComputerUseRoute,
} from "@zeros/protocol/computer-use-tools";

import { opSettingsResolve } from "../settings/ops";
import { agentControlAvailability } from "./availability";

/** Which computer use `agentFamily` gets from the trusted settings. The
 * `[computer_use]` table is user-scoped (managed policy may override it), so
 * every Local workspace resolves the same route. */
export function computerUseRouteForWorkspace(
  agentFamily: string,
  workspaceRoot: string,
  mainRepoRoot?: string,
): ComputerUseRoute {
  return resolveComputerUseRoute(
    agentFamily,
    gateComputerUseSettings(
      computerUseSettings(
        opSettingsResolve(workspaceRoot, mainRepoRoot).effective.computer_use,
      ),
      agentControlAvailability(),
    ),
  );
}
