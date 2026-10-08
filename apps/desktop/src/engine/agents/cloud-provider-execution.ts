import type {CloudAgentExecutionAdmission,CloudAgentExecutionRequest} from "@zeros/protocol/cloud-agent-execution";
import { isCloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";
import { cloudCommandFailureCode, decodeCloudCommandFailure, CloudCommandFailureError, type CloudCommandFailureCause } from "@zeros/protocol/cloud-commands";
import type {CloudAgentToolBridge} from "@zeros/protocol/cloud-agent-tools";
import {CLOUD_NATIVE_EXECUTION_PROFILE,cloudNativeProviderRestrictions,cloudBrowserUnavailable} from "@zeros/protocol/containment";
import {CloudAgentLease,type CloudAgentLeaseSupervisor} from "./cloud-agent-lease";
import {CloudWorkloadTools} from "./cloud-workload-tools";
import {CloudNativeBoundary} from "./containment/cloud-native-boundary";
import {resolveCloudRuntime} from "./containment/cloud-runtime-root.mjs";
import type {PreparedBoundary} from "./containment/types";
import type {McpServerRegistration} from "./types";
import {materializeMcpServerRegistrations} from "./mcp-registration";
import { readCloudRepositoryMcp, cloudCodexMcpServer, freezeCloudSnapshot, type CloudRepositoryMcpNotice } from "./cloud-mcp";
import { CloudCustomizationRedactor } from "./cloud-customization-redaction";
import {CloudBackgroundExecution} from "./cloud-background-execution";
import {CloudComputerMcpServer} from "./cloud-computer-tools";
import {CLOUD_COMPUTER_TOOLS_SERVER} from "@zeros/protocol/cloud-computer-tools";
import {CLOUD_COMPUTER_ADMIN_WORKSPACE_NOTICE} from "@zeros/protocol/system-instructions";
import path from "node:path";

export type CloudAgentSelection=Omit<CloudAgentExecutionAdmission,"executionId"|"provider"|"customization">;
export type CloudProviderExecution={
  /** Trusted server-selected checkout root, never a renderer request cwd. */
  readonly cwd:string;
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
/** Only CP-admitted computer tools identify the marked admin execution. */
export function adminWorkspaceSystemInstruction(boundary:PreparedBoundary|undefined,instruction?:string):string|undefined{
  return cloudProviderExecution(boundary)?.lease.computerToolsVersion===1
    ? [instruction,CLOUD_COMPUTER_ADMIN_WORKSPACE_NOTICE].filter(Boolean).join("\n\n") : instruction;
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
  onRepositoryMcpNotice?(context:{executionId:string;conversationId:string;provider:CloudAgentExecutionAdmission["provider"];notice:CloudRepositoryMcpNotice}):void;
}):CloudAgentExecutionFactory{
  return {async prepare({admission,conversationId,workload,cwd,signal,productTools,providerSettings,customization}){
    let lease:CloudAgentLease|undefined;
    let redactor:CloudCustomizationRedactor|undefined;
    let stage: CloudCommandFailureCause["stage"] = "validation";
    try{
      signal.throwIfAborted();
      if(resolveCloudRuntime().profile!=="v4")throw new Error("Cloud agents require a qualified v4 worker");
      const requested=customization?{...admission,customization:{version:3 as const,repositoryServers:await readCloudRepositoryMcp(cwd,admission.provider,notice=>
        options.onRepositoryMcpNotice?.({executionId:admission.executionId,conversationId,provider:admission.provider,notice}))}}:admission;
      stage = "admission";
      lease=await CloudAgentLease.admit(requested,options.request,signal,options.supervisor);
      redactor=new CloudCustomizationRedactor([...Object.values(lease.environment?.values??{}),...(lease.customization?.servers??[]).flatMap(({server})=>
        Object.values(server.transport==="stdio"?server.env??{}:server.headers??{}))]);
      stage = "containment";
      lease.attach(workload);
      const tools=new CloudWorkloadTools(lease,workload,cwd);
      const coordinator=await CloudNativeBoundary.prepare(lease,workload,conversationId,providerSettings);
      signal.throwIfAborted();
      lease.assertLive();
      const productServers=materializeMcpServerRegistrations(productTools?.servers??[],productTools?.env??{});
      if(productServers.some(server=>server.transport==="stdio"))throw new Error("Cloud product tools require a scoped remote transport");
      if(productServers.some(server=>server.name===CLOUD_COMPUTER_TOOLS_SERVER))throw new Error("Cloud Computer tools require private execution admission");
      if(lease.computerToolsVersion===1){
        const ownedLease=lease;
        const computer=await lease.launch(()=>CloudComputerMcpServer.start(ownedLease));
        productServers.push(computer.registration);
      }
      const userServers=lease.customization?.servers.map(({server,scope})=>{
        // Repository cwd is a compatible wire-relative projection. Translate
        // only after exact CP echo/digest verification, and only for repository
        // entries. Org/member absolute paths retain their original meaning.
        const materialized=scope==="repository"&&server.transport==="stdio"&&server.cwd?
          {...server,cwd:path.resolve(cwd,path.posix.relative("/srv/zeros/workspace",server.cwd))}:server;
        return admission.provider==="codex"?cloudCodexMcpServer(materialized):materialized;
      })??[];
      if(userServers.some(server=>productServers.some(product=>product.name===server.name)))throw new Error("Cloud MCP server name conflicts with a product tool");
      const owned=lease;
      const runtimeProfile="zeros-cloud-worker-v4" as const;
      // Gateway retirement closes both domains through the lease. This facade
      // is deliberately not attached back to the lease (which would deadlock).
      const boundary:PreparedBoundary={
        generation:workload.generation,status:{...coordinator.status,
          browser:{...cloudBrowserUnavailable(admission.provider,lease.credentialKind),runtimeProfile},
          parity:{level:"restricted",restrictions:[...new Set([...coordinator.status.parity.restrictions.filter(value=>!lease!.customization||value!=="user-mcp-disabled"),
            ...cloudNativeProviderRestrictions(admission.provider,lease.nativeCapabilities),...(!lease.customization?["user-mcp-disabled" as const]:[])])].sort()},cloudExecution:{version:1,
          profile:CLOUD_NATIVE_EXECUTION_PROFILE,runtimeProfile,provider:admission.provider,
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
      redactor.addSecrets(productServers.flatMap(server=>server.transport==="stdio"?[]:Object.values(server.headers??{})));
      const background=new CloudBackgroundExecution(lease,conversationId,()=>coordinator.hasBackgroundServers());
      admitted.set(boundary,Object.freeze({cwd,lease,tools,coordinator,background,productServers:freezeCloudSnapshot(structuredClone(productServers)),userServers:freezeCloudSnapshot(structuredClone(userServers)),redactor}));
      return {boundary,env:coordinator.environment(),authorityId:lease.authorityId};
    }catch(error){
      const redacted=redactor?.error(error)??error;
      const innerCode = redacted && typeof redacted === "object" && "code" in redacted ? redacted.code : undefined;
      const code = isCloudAgentAdmissionCode(innerCode)?innerCode:cloudCommandFailureCode(redacted, stage);
      try { if(lease)await lease.close();else await workload.stopAndProve(); }
      catch(retirementError){
        const retirementCode=cloudCommandFailureCode(retirementError,"containment");
        if(!lease)options.supervisor.onRetirementFailure(new CloudCommandFailureError(decodeCloudCommandFailure(retirementCode)!));
        // Retirement remains failed and retry/quarantine ownership stays live.
        // The original preparation cause is still the receipt's diagnosis.
        throw Object.assign(new AggregateError([redacted,new CloudCommandFailureError(decodeCloudCommandFailure(retirementCode)!)],
          redacted instanceof Error?redacted.message:"Cloud agent preparation failed"),{code});
      }
      if (isCloudAgentAdmissionCode(innerCode)) throw redacted;
      if (redacted instanceof Error) throw Object.assign(redacted, { code });
      throw new CloudCommandFailureError(decodeCloudCommandFailure(code)!);
    }
  }};
}
