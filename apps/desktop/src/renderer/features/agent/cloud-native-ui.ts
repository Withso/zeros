import type {AvailableCommand} from "@zeros/protocol/agent-events";
import type {CloudNativeCapabilities} from "@zeros/protocol/cloud-agent-execution";
import {isCloudWorkspace} from "../../platform/bridge/cloud-workspace-key";

/** The shared built-in floor must not advertise an unqualified cloud RPC. */
export function filterCloudNativeCommands(commands:AvailableCommand[],cwd:string|null|undefined,capabilities?:CloudNativeCapabilities):AvailableCommand[] {
  if(!isCloudWorkspace(cwd))return commands;
  return commands.filter(command=>(command.name!=="goal"||capabilities?.goals===true) &&
    (command.name!=="review"||capabilities?.nativeReview===true));
}
