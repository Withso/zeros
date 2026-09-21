import type { CloudAgentAccessMaterial } from "@zeros/protocol/cloud-agent-execution";
export const CLOUD_COORDINATOR_UID: 10004;
export const CLOUD_COORDINATOR_HOME: "/home/zeros-agent";
export const CLOUD_COORDINATOR_CWD: "/srv/zeros/workspace";
export function cloudCoordinatorArguments(directory:string,command:string,args?:readonly string[],history?:{provider:"claude"|"cursor"|"codex";directory:string}):string[];
export function cloudCoordinatorEnvironment(material:CloudAgentAccessMaterial,model:string,settings?:Record<string,string>):Record<string,string>;
