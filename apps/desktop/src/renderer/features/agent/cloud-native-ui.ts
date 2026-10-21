import type {AvailableCommand} from "@zeros/protocol/agent-events";
import {isCloudWorkspace} from "../../platform/bridge/cloud-workspace-key";

/** Cloud agents expose no native goals or review, so the built-in floor
 * does not advertise them in a cloud workspace. */
export function filterCloudNativeCommands(commands:AvailableCommand[],cwd:string|null|undefined):AvailableCommand[] {
  if(!isCloudWorkspace(cwd))return commands;
  return commands.filter(command=>command.name!=="goal"&&command.name!=="review");
}
