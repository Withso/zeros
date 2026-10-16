import type { BrowserJsonValue } from "@zeros/protocol/browser-tools";
import {
  COMPUTER_TOOL_DEFINITIONS,
  parseComputerToolCall,
  type ComputerToolName,
  type ComputerToolResult,
  type ComputerUseRoute,
} from "@zeros/protocol/computer-use-tools";

import {
  HostedControlTools,
  type HostedControlToolPolicy,
} from "./hosted-control-tools";

export type ZerosComputerToolPolicy = HostedControlToolPolicy;

/** Engine-side owner of one chat's computer use. Every port is bound to the
 * admitted workspace, conversation and agent; tool arguments never choose
 * them. */
export interface ZerosComputerToolPorts {
  /** Settings decide per call, so turning computer use off applies to a
   * running agent. */
  policy(): ZerosComputerToolPolicy;
  /** Throws once the owning workspace is no longer the admitted one. */
  assertOwner?(): void;
  invoke(request: {
    turnId: string;
    tool: ComputerToolName;
    arguments: BrowserJsonValue;
    signal: AbortSignal;
  }): Promise<ComputerToolResult>;
  /** End this chat's control of the Mac. */
  release(reason: "turn-end" | "stop"): Promise<boolean>;
}

/** Whether an agent family may call `zeros_computer` on its Settings route. */
export function zerosComputerToolPolicy(
  agentFamily: string,
  route: ComputerUseRoute,
): ZerosComputerToolPolicy {
  if (route === "zeros") return { ok: true };
  if (route === "codex-native") {
    return {
      ok: false,
      reason:
        "Codex is set to use its built-in computer use in Settings > Computer use.",
    };
  }
  return {
    ok: false,
    reason:
      agentFamily === "codex"
        ? "Computer use is turned off for Codex in Settings > Computer use."
        : "Computer use is turned off in Settings > Computer use.",
  };
}

/** The `zeros_computer` MCP handler for one agent execution. Main runs every
 * call; this side tracks the provider's turns so the chat gives the Mac back
 * when a turn ends, the user stops it, or the session retires. */
export class ZerosComputerTools extends HostedControlTools<ComputerToolName> {
  constructor(ports: ZerosComputerToolPorts) {
    super(ports, {
      definitions: COMPUTER_TOOL_DEFINITIONS,
      parse: parseComputerToolCall,
      text: {
        authority: "Invalid computer tool authority.",
        stopped: "Computer use was stopped.",
        cancelled: "The computer action was cancelled.",
        retired: "Computer tools were retired for this agent session.",
        failed: "The computer action failed.",
        unreadable:
          "Computer use settings could not be read. Check Settings > Computer use.",
      },
    });
  }
}
