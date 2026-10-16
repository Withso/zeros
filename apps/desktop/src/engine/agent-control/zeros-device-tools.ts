import type { BrowserJsonValue } from "@zeros/protocol/browser-tools";
import {
  DEVICE_TOOL_DEFINITIONS,
  parseDeviceToolCall,
  type DeviceToolName,
  type DeviceToolResult,
  type DeviceToolRoute,
} from "@zeros/protocol/device-tools";

import {
  HostedControlTools,
  type HostedControlToolPolicy,
} from "./hosted-control-tools";

export type ZerosDeviceToolPolicy = HostedControlToolPolicy;

/** Engine-side owner of one chat's simulator use. Every port is bound to the
 * admitted workspace, conversation and agent; tool arguments never choose
 * them. */
export interface ZerosDeviceToolPorts {
  /** Settings decide per call, so turning simulators off for agents applies
   * to a running agent. */
  policy(): ZerosDeviceToolPolicy;
  assertOwner?(): void;
  invoke(request: {
    turnId: string;
    tool: DeviceToolName;
    arguments: BrowserJsonValue;
    signal: AbortSignal;
  }): Promise<DeviceToolResult>;
  /** Let go of the simulators this chat is using. */
  release(reason: "turn-end" | "stop"): Promise<boolean>;
}

export const DEVICE_TOOLS_OFF =
  "Agents can't use simulators. The user can turn on Let agents use simulators in Settings > Simulators.";

export function zerosDeviceToolPolicy(route: DeviceToolRoute): ZerosDeviceToolPolicy {
  return route === "zeros" ? { ok: true } : { ok: false, reason: DEVICE_TOOLS_OFF };
}

/** The `zeros_device` MCP handler for one agent execution. Main runs every
 * call against DeviceHub; this side tracks the provider's turns so the chat
 * lets go of its simulators when a turn ends, the user stops it, or the
 * session retires. */
export class ZerosDeviceTools extends HostedControlTools<DeviceToolName> {
  constructor(ports: ZerosDeviceToolPorts) {
    super(ports, {
      definitions: DEVICE_TOOL_DEFINITIONS,
      parse: parseDeviceToolCall,
      text: {
        authority: "Invalid simulator tool authority.",
        stopped: "Simulator use was stopped.",
        cancelled: "The simulator action was cancelled.",
        retired: "Simulator tools were retired for this agent session.",
        failed: "The simulator action failed.",
        unreadable:
          "Simulator settings could not be read. Check Settings > Simulators.",
      },
    });
  }
}
