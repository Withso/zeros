import { gateSimulatorSettings } from "@zeros/protocol/agent-control-rollout";
import {
  resolveDeviceToolRoute,
  type DeviceToolRoute,
} from "@zeros/protocol/device-tools";
import { simulatorSettings } from "@zeros/protocol/simulators";

import { opSettingsResolve } from "../settings/ops";
import { agentControlAvailability } from "./availability";

/** Whether `agentFamily` gets the simulator tools from the trusted settings.
 * The `[simulators]` table is user-scoped (managed policy may override it),
 * so every Local workspace resolves the same route. */
export function deviceToolRouteForWorkspace(
  agentFamily: string,
  workspaceRoot: string,
  mainRepoRoot?: string,
): DeviceToolRoute {
  return resolveDeviceToolRoute(
    agentFamily,
    gateSimulatorSettings(
      simulatorSettings(
        opSettingsResolve(workspaceRoot, mainRepoRoot).effective.simulators,
      ),
      agentControlAvailability(),
    ),
  );
}
