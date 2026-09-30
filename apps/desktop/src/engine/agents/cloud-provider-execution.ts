import type {CloudAgentExecutionAdmission,CloudAgentExecutionRequest} from "@zeros/protocol/cloud-agent-execution";
import type {CloudAgentToolBridge} from "@zeros/protocol/cloud-agent-tools";
import {CLOUD_NATIVE_EXECUTION_PROFILE,cloudNativeProviderRestrictions,cloudBrowserUnavailable} from "@zeros/protocol/containment";
import {CloudAgentLease,type CloudAgentLeaseSupervisor} from "./cloud-agent-lease";
import {CloudWorkloadTools} from "./cloud-workload-tools";
import {CloudNativeBoundary} from "./containment/cloud-native-boundary";
import type {PreparedBoundary} from "./containment/types";
import type {McpServerRegistration} from "./types";
import {materializeMcpServerRegistrations} from "./mcp-registration";
import { readCloudRepositoryMcp, cloudCodexMcpServer, freezeCloudSnapshot } from "./cloud-mcp";
import { CloudCustomizationRedactor } from "./cloud-customization-redaction";
import {CloudBackgroundExecution} from "./cloud-background-execution";

export type CloudAgentSelection=Omit<CloudAgentExecutionAdmission,"executionId"|"provider"|"customization">;
export type CloudProviderExecution={
  readonly lease:CloudAgentLease;
  readonly tools:CloudAgentToolBridge;
  readonly coordinator:CloudNativeBoundary;
  readonly background?:CloudBackgroundExecution;
  /** Only engine-minted product tools enter this snapshot, never user MCP. */
  readonly productServers:readonly McpServerRegistration[];
  readonly userServers?:readonly McpServerRegistration[];
  readonly redactor?:CloudCustomizationRedactor;
};
const admitted=new WeakMap<PreparedBoundary,CloudProviderExecution>();
/** This identity is minted in trusted engine memory, never inferred from env,
 * an SDK message, a client flag, or a caller-supplied method implementation. */
export function cloudProviderExecution(boundary?:PreparedBoundary):CloudProviderExecution|null{
  return boundary?admitted.get(boundary)??null:null;
}
/** An execution uses its admitted snapshot, never the mutable Local registry. */
export function executionMcpServers(execution:CloudProviderExecution|null,registrations:readonly McpServerRegistration[]|undefined):McpServerRegistration[]|undefined{
  // A deep copy keeps the lease-scoped admitted snapshot immutable to callers.
  return execution?structuredClone([...(execution.productServers??[]),...(execution.userServers??[])]):registrations?[...registrations]:undefined;
}
export interface CloudAgentExecutionFactory {
  prepare(input:{admission:CloudAgentExecutionAdmission;conversationId:string;workload:PreparedBoundary;cwd:string;signal:AbortSignal;
    customization?:true;providerSettings?:Record<string,string>;productTools?:{servers:McpServerRegistration[];env:Record<string,string>}}):Promise<{
    boundary:PreparedBoundary;env:Record<string,string>;authorityId:string;
  }>;
}
export function createCloudAgentExecutionFactory(options:{
  request(request:CloudAgentExecutionRequest,signal:AbortSignal):Promise<unknown>;
  supervisor:CloudAgentLeaseSupervisor;
}):CloudAgentExecutionFactory{
  return {async prepare({admission,conversationId,workload,cwd,signal,productTools,providerSettings,customization}){
    let lease:CloudAgentLease|undefined;
    let redactor:CloudCustomizationRedactor|undefined;
    try{
      signal.throwIfAborted();
      const requested=customization?{...admission,customization:{version:2 as const,repositoryServers:await readCloudRepositoryMcp(cwd)}}:admission;
      lease=await CloudAgentLease.admit(requested,options.request,signal,options.supervisor);
      redactor=new CloudCustomizationRedactor((lease.customization?.servers??[]).flatMap(({server})=>
        Object.values(server.transport==="stdio"?server.env??{}:server.headers??{})));
      lease.attach(workload);
      const tools=new CloudWorkloadTools(lease,workload,cwd);
      const coordinator=await CloudNativeBoundary.prepare(lease,workload,conversationId,providerSettings);
      signal.throwIfAborted();
      lease.assertLive();
      const productServers=materializeMcpServerRegistrations(productTools?.servers??[],productTools?.env??{});
      if(productServers.some(server=>server.transport==="stdio"))throw new Error("Cloud product tools require a scoped remote transport");
      const userServers=lease.customization?.servers.map(({server})=>admission.provider==="codex"?cloudCodexMcpServer(server):server)??[];
      if(userServers.some(server=>productServers.some(product=>product.name===server.name)))throw new Error("Cloud MCP server name conflicts with a product tool");
      const owned=lease;
      // Gateway retirement closes both domains through the lease. This facade
      // is deliberately not attached back to the lease (which would deadlock).
      const boundary:PreparedBoundary={
        generation:workload.generation,status:{...coordinator.status,
          browser:cloudBrowserUnavailable(admission.provider,lease.credentialKind),
          parity:{level:"restricted",restrictions:[...new Set([...coordinator.status.parity.restrictions.filter(value=>!lease!.customization||value!=="user-mcp-disabled"),
            ...cloudNativeProviderRestrictions(admission.provider,lease.nativeCapabilities),...(!lease.customization?["user-mcp-disabled" as const]:[])])].sort()},cloudExecution:{version:1,
          profile:CLOUD_NATIVE_EXECUTION_PROFILE,runtimeProfile:"zeros-cloud-worker-v3",provider:admission.provider,
          ...(lease.nativeCapabilities?{capabilities:{...lease.nativeCapabilities,connectedApps:lease.nativeCapabilities.connectedApps&&!!lease.codexAuth()}}:{}),
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
      redactor=coordinator.redactor??redactor;
      const background=new CloudBackgroundExecution(lease,conversationId,()=>coordinator.hasBackgroundServers());
      admitted.set(boundary,{lease,tools,coordinator,background,productServers:freezeCloudSnapshot(structuredClone(productServers)),userServers:freezeCloudSnapshot(structuredClone(userServers)),redactor});
      return {boundary,env:coordinator.environment(),authorityId:lease.authorityId};
    }catch(error){
      const redacted=redactor?.error(error)??error;
      if(lease)await lease.close();else await workload.stopAndProve();
      throw redacted;
    }
  }};
}
