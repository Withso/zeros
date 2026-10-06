import type {AvailableCommand} from "@zeros/protocol/agent-events";
import type {CloudNativeCapabilities} from "@zeros/protocol/cloud-agent-execution";
import type {ExecutionBoundaryStatus} from "@zeros/protocol/containment";
import {isCloudWorkspace} from "../../platform/bridge/cloud-workspace-key";

export function cloudAgentLimitations(boundary?: Pick<ExecutionBoundaryStatus,"cloudExecution"|"parity"> | null): string[] {
  if (!boundary?.cloudExecution) return [];
  const capabilities = boundary.cloudExecution.capabilities;
  const codex = boundary.cloudExecution.provider === "codex";
  return [
    ...(boundary.parity.restrictions.includes("user-mcp-disabled") ? ["custom MCP servers and organization skills"] : []),
    ...(codex && !capabilities?.goals ? ["goals"] : []),
    ...(codex && !capabilities?.nativeReview ? ["native review"] : []),
    ...(capabilities?.nativeFork || capabilities?.transcriptFork ? [] : ["forking"]),
    ...(codex && !capabilities?.connectedApps ? ["connected apps"] : []),
    ...(codex && !capabilities?.multiAgent ? ["subagents"] : []),
  ];
}

/** The shared built-in floor must not advertise an unqualified cloud RPC. */
export function filterCloudNativeCommands(commands:AvailableCommand[],cwd:string|null|undefined,capabilities?:CloudNativeCapabilities):AvailableCommand[] {
  if(!isCloudWorkspace(cwd))return commands;
  return commands.filter(command=>(command.name!=="goal"||capabilities?.goals===true) &&
    (command.name!=="review"||capabilities?.nativeReview===true));
}
