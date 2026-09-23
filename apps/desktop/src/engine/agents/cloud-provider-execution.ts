import type {CloudAgentExecutionAdmission,CloudAgentExecutionRequest} from "@zeros/protocol/cloud-agent-execution";
import type {CloudAgentToolBridge} from "@zeros/protocol/cloud-agent-tools";
import {CLOUD_CORE_EXECUTION_PROFILE} from "@zeros/protocol/containment";
import {CloudAgentLease,type CloudAgentLeaseSupervisor} from "./cloud-agent-lease";
import {CloudWorkloadTools} from "./cloud-workload-tools";
import {CloudCoordinatorBoundary} from "./containment/cloud-coordinator-boundary";
import type {PreparedBoundary} from "./containment/types";
import type {McpServerRegistration} from "./types";
import {materializeMcpServerRegistrations} from "./mcp-registration";

export type CloudAgentSelection=Omit<CloudAgentExecutionAdmission,"executionId"|"provider">;
export type CloudProviderExecution={
  readonly lease:CloudAgentLease;
  readonly tools:CloudAgentToolBridge;
  readonly coordinator:CloudCoordinatorBoundary;
  /** Only engine-minted product tools enter this snapshot, never user MCP. */
  readonly productServers:readonly McpServerRegistration[];
};
const admitted=new WeakMap<PreparedBoundary,CloudProviderExecution>();
/** This identity is minted in trusted engine memory, never inferred from env,
 * an SDK message, a client flag, or a caller-supplied method implementation. */
export function cloudProviderExecution(boundary?:PreparedBoundary):CloudProviderExecution|null{
  return boundary?admitted.get(boundary)??null:null;
}
/** A cloud execution sees only the engine-minted product servers admitted with
 * its lease, already carrying their scoped credentials. User and repository
 * MCP registrations never enter it; other executions keep their registry. */
export function executionMcpServers(execution:CloudProviderExecution|null,registrations:readonly McpServerRegistration[]|undefined):McpServerRegistration[]|undefined{
  return execution?[...execution.productServers]:registrations?[...registrations]:undefined;
}
export interface CloudAgentExecutionFactory {
  prepare(input:{admission:CloudAgentExecutionAdmission;conversationId:string;workload:PreparedBoundary;cwd:string;signal:AbortSignal;
    providerSettings?:Record<string,string>;productTools?:{servers:McpServerRegistration[];env:Record<string,string>}}):Promise<{
    boundary:PreparedBoundary;env:Record<string,string>;authorityId:string;
  }>;
}
export function createCloudAgentExecutionFactory(options:{
  request(request:CloudAgentExecutionRequest,signal:AbortSignal):Promise<unknown>;
  supervisor:CloudAgentLeaseSupervisor;
}):CloudAgentExecutionFactory{
  return {async prepare({admission,conversationId,workload,cwd,signal,productTools,providerSettings}){
    let lease:CloudAgentLease|undefined;
    try{
      signal.throwIfAborted();
      lease=await CloudAgentLease.admit(admission,options.request,signal,options.supervisor);
      lease.attach(workload);
      const tools=new CloudWorkloadTools(lease,workload,cwd);
      const coordinator=await CloudCoordinatorBoundary.prepare(lease,workload,conversationId,providerSettings);
      signal.throwIfAborted();
      lease.assertLive();
      const productServers=materializeMcpServerRegistrations(productTools?.servers??[],productTools?.env??{});
      if(productServers.some(server=>server.transport==="stdio"))throw new Error("Cloud product tools require a scoped remote transport");
      const owned=lease;
      // Gateway retirement closes both domains through the lease. This facade
      // is deliberately not attached back to the lease (which would deadlock).
      const boundary:PreparedBoundary={
        generation:workload.generation,status:{...coordinator.status,cloudExecution:{version:1,
          profile:CLOUD_CORE_EXECUTION_PROFILE,runtimeProfile:"zeros-cloud-worker-v3",provider:admission.provider,
          designApi:productServers.some(server=>server.name==="design-draft"&&server.transport==="http")?"admitted":"unavailable"}},attestation:coordinator.attestation,
        providerHomePath:coordinator.providerHomePath,
        wrapSpawn:request=>coordinator.wrapSpawn(request),
        cancelUnstartedLaunch:launch=>coordinator.cancelUnstartedLaunch(launch),
        trackProcess:child=>coordinator.trackProcess(child),
        trackProcessGroup:()=>coordinator.trackProcessGroup(),
        spawn:request=>coordinator.spawn(request),
        requestPort:request=>coordinator.requestPort(request),
        activePorts:()=>workload.activePorts(),portDiscoveryStatus:()=>workload.portDiscoveryStatus(),
        onPortsChanged:listener=>workload.onPortsChanged(listener),
        revoke:()=>owned.close(),stopAndProve:()=>owned.close(),
      };
      admitted.set(boundary,{lease,tools,coordinator,productServers:structuredClone(productServers)});
      return {boundary,env:coordinator.environment(),authorityId:lease.authorityId};
    }catch(error){
      if(lease)await lease.close();else await workload.stopAndProve();
      throw error;
    }
  }};
}
