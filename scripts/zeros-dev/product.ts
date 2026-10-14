import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { CloudComputerV2BuildRequestSchema, CloudComputerV2BuildRuntimeSchema, type CloudComputerV2BuildRuntime, type CloudComputerV2BuildSummary } from "@zeros/protocol/cloud-computer-v2";
import { CloudWorkspaceDocumentSchema, OptionsSchema, AgentGrantsSchema, CloudAgentBootAvailabilitySchema, type CloudWorkspaceDocument } from "../../apps/desktop/src/renderer/platform/cloud-workspace-contract";
import { cloudComputerV2StateSchema, cloudComputerV2BuildSchema, buildResult, logSchema } from "../../apps/desktop/src/renderer/features/settings/cloud-computer-v2-contract";
import type { ZerosDevSession } from "./session";
import type { Fixture } from "./config";
import { CreateBodySchema, type Run, type RunHandle } from "./receipts";
import { AlphaTransport, type JsonRequest } from "./transport";
import { ZerosDevError } from "./errors";
import { readSetupProgress, type SetupObservation } from "./setup-observation";

const document=z.object({workspace:CloudWorkspaceDocumentSchema});
const observedDocument=document.extend({setupProgress:z.unknown().optional()});
const pendingDeletion=z.object({truncated:z.boolean(),pendingDeletion:z.array(z.object({workspaceId:z.string().uuid(),generation:z.number().int().positive()})).max(500)});
export type Agent="claude"|"codex"|"cursor";
type SessionPort=Pick<ZerosDevSession,"fixture"|"whoami"|"accessToken">;
const runtimeTarget = CloudComputerV2BuildRuntimeSchema.shape.selected.unwrap().pick({ runtimeId: true, baseImageId: true });
export type ComputerRuntimeTarget = z.infer<typeof runtimeTarget>;

export class ProductApi {
  private readonly now:()=>number;
  private readonly sleep:(ms:number,signal?:AbortSignal)=>Promise<void>;
  constructor(readonly session:SessionPort,readonly transport:AlphaTransport,options:{now?:()=>number;sleep?:(ms:number,signal?:AbortSignal)=>Promise<void>}={}){
    this.now=options.now??(()=>performance.now());this.sleep=options.sleep??(async(ms,signal)=>{await delay(ms,undefined,{signal});});
  }
  async request<T>(pathname:string,schema:z.ZodType<T>,options:JsonRequest={}):Promise<T>{
    const value=await this.transport.json(pathname,{...options,token:await this.session.accessToken()});
    const parsed=schema.safeParse(value);if(!parsed.success)throw new ZerosDevError("bad_response");return parsed.data;
  }
  private root(fixture:Fixture):string{return `/v1/organizations/${fixture.organizationId}/cloud-workspaces`;}
  private computerRoot(fixture:Fixture):string{return `/v1/organizations/${fixture.organizationId}/cloud-computer/v2`;}
  async assertFixtureEmpty(signal?:AbortSignal):Promise<void>{
    await this.session.whoami();const fixture=await this.session.fixture();
    const rows=await this.request(`${this.root(fixture)}?limit=100`,z.object({workspaces:z.array(CloudWorkspaceDocumentSchema).max(100),nextCursor:z.string().nullable()}),{signal});
    const pending=await this.request(`/v1/organizations/${fixture.organizationId}/cloud-workspace-management/pending-deletion`,pendingDeletion,{signal});
    // Never treat an incomplete list, an unknown workspace or a provider's
    // accepted deletion as a free fixture. Cleanup requires its signed receipt.
    if(rows.nextCursor!==null||rows.workspaces.length||pending.truncated||pending.pendingDeletion.length)throw new ZerosDevError("cleanup_pending");
  }
  private repositoryNameMatches(fixture:Fixture,repository:{owner:string;name:string}):boolean{
    // GitHub names are case-insensitive; Computer configs and workspace rows
    // use lowercase while GitHub discovery preserves display casing. Compare
    // without rewriting fixture pins or any recorded request body.
    const pinned=fixture.repository;
    return repository.owner.toLowerCase()===pinned.owner.toLowerCase()&&repository.name.toLowerCase()===pinned.name.toLowerCase();
  }
  private repositoryMatches(fixture:Fixture,repository:{id:string;owner:string;name:string;installationId:string}):boolean{
    const pinned=fixture.repository;
    return repository.id===pinned.id&&this.repositoryNameMatches(fixture,repository)&&repository.installationId===pinned.installationId;
  }
  async computerState(signal?:AbortSignal){const fixture=await this.session.fixture();return this.request(`${this.computerRoot(fixture)}?activeRepositories=true`,cloudComputerV2StateSchema,{signal});}
  async ensureRepository(signal?:AbortSignal):Promise<{revision:string}>{
    await this.session.whoami();const fixture=await this.session.fixture(),repo=fixture.repository;
    const result=await this.request(`${this.root(fixture)}/create-options?owner=${encodeURIComponent(repo.owner)}&repository=${encodeURIComponent(repo.name)}&cloudComputerV2=true`,OptionsSchema,{signal});
    if(!result.configured||!result.repository||!this.repositoryNameMatches(fixture,result.repository)||
      !result.installations.some(row=>row.id===repo.installationId))throw new ZerosDevError("repository_required");
    return {revision:result.repository.defaultBranch};
  }
  async buildComputer(handle:RunHandle,signal?:AbortSignal):Promise<CloudComputerV2BuildSummary>{
    await this.session.whoami();const fixture=await this.session.fixture();
    if(handle.run.computer?.result)return this.readBuild(handle.run,signal);
    if(!handle.run.computer){
      const state=await this.computerState(signal);
      if(!state.canManage)throw new ZerosDevError("forbidden");
      if(state.draft.repositories.length!==1||!this.repositoryMatches(fixture,state.draft.repositories[0]!))throw new ZerosDevError("repository_required");
      handle.run.computer={operationId:randomUUID(),expectedRevision:state.revision};await handle.save();
    }
    const intent=handle.run.computer;
    const body=CloudComputerV2BuildRequestSchema.parse({expectedRevision:intent.expectedRevision,operationId:intent.operationId});
    const result=await this.request(`${this.computerRoot(fixture)}/builds`,buildResult,{method:"POST",body,idempotencyKey:intent.operationId,signal});
    handle.run.computer.result={id:result.build.id,version:result.build.version};await handle.save();return result.build;
  }
  async readBuild(run:Run,signal?:AbortSignal):Promise<CloudComputerV2BuildSummary>{
    const result=run.computer?.result;if(!result)throw new ZerosDevError("computer_required");
    const fixture=await this.session.fixture();
    const build=await this.request(`${this.computerRoot(fixture)}/builds/${result.id}`,cloudComputerV2BuildSchema,{signal});
    if(build.id!==result.id||build.version!==result.version)throw new ZerosDevError("identity_changed");return build;
  }
  async readComputerRuntime(build:Pick<CloudComputerV2BuildSummary,"id"|"version">,signal?:AbortSignal):Promise<CloudComputerV2BuildRuntime>{
    const fixture=await this.session.fixture();
    const proof=await this.request(`${this.computerRoot(fixture)}/builds/${build.id}/runtime`,CloudComputerV2BuildRuntimeSchema,{signal});
    if(proof.buildId!==build.id||proof.version!==build.version)throw new ZerosDevError("identity_changed");
    return proof;
  }
  async verifyComputerRuntime(build:Pick<CloudComputerV2BuildSummary,"id"|"version">,signal?:AbortSignal,expectedRuntime?:string|ComputerRuntimeTarget):Promise<"confirmed">{
    if(expectedRuntime!==undefined&&(typeof expectedRuntime==="string"?!/^r1-[a-f0-9]{64}$/.test(expectedRuntime):!runtimeTarget.safeParse(expectedRuntime).success))
      throw new ZerosDevError("invalid_request");
    const proof=await this.readComputerRuntime(build,signal);
    // The hourly run captures a qualified tuple once. A later release or
    // revocation is a selection race, not permission to chase another build.
    if(typeof expectedRuntime==="object"){
      if(!proof.selected)throw new ZerosDevError("runtime_selection_unavailable");
      if(proof.selected.runtimeId!==expectedRuntime.runtimeId||proof.selected.baseImageId!==expectedRuntime.baseImageId)
        throw new ZerosDevError("runtime_selection_changed");
    }
    if(!proof.runtimeId||!proof.baseImageId||!proof.selected||proof.runtimeId!==proof.selected.runtimeId||
      proof.baseImageId!==proof.selected.baseImageId||typeof expectedRuntime==="string"&&proof.runtimeId!==expectedRuntime)
      throw new ZerosDevError("runtime_pin_unconfirmed");
    return "confirmed";
  }
  async waitComputer(run:Run,signal?:AbortSignal,expectedRuntime?:string|ComputerRuntimeTarget){
    return this.observe(async bound=>{
      const build=await this.readBuild(run,bound);
      if(["failed","cancelled"].includes(build.state))throw new ZerosDevError("computer_failed");
      if(build.state!=="succeeded"||build.templateState!=="ready")return null;
      return {...build,runtimePin:await this.verifyComputerRuntime(build,bound,expectedRuntime)};
    },signal,900_000);
  }
  async computerLog(run:Run,after=0,signal?:AbortSignal){
    const result=run.computer?.result;if(!result)throw new ZerosDevError("computer_required");
    if(!Number.isSafeInteger(after)||after<0)throw new ZerosDevError("invalid_request");
    const fixture=await this.session.fixture();
    return this.request(`${this.computerRoot(fixture)}/builds/${result.id}/log?after=${after}&limit=100`,logSchema,{signal});
  }
  private assertWorkspace(row:CloudWorkspaceDocument,fixture:Fixture,run:Run,allowNextGeneration=false):void{
    const receipt=run.create?.result;
    if(row.placement!=="cloud"||row.organizationId!==fixture.organizationId||row.createdBy!==fixture.accountId||
      row.ownerUserId!==fixture.accountId||row.repository.forge!=="github.com"||!this.repositoryNameMatches(fixture,row.repository)||
      receipt&&(row.id!==receipt.id||row.createdBy!==receipt.createdBy||row.createdAt!==receipt.createdAt))throw new ZerosDevError("identity_changed");
    if(receipt&&(row.generation.number<receipt.generation||!allowNextGeneration&&row.generation.number!==receipt.generation))throw new ZerosDevError("runtime_changed");
  }
  async createWorkspace(handle:RunHandle,signal?:AbortSignal):Promise<CloudWorkspaceDocument>{
    await this.session.whoami();const fixture=await this.session.fixture();
    if(handle.run.deletionConfirmed)throw new ZerosDevError("operation_conflict");
    if(handle.run.create?.result)return this.workspace(handle.run,signal);
    if(!handle.run.create){
      const [state,repository]=await Promise.all([this.computerState(signal),this.ensureRepository(signal)]);
      if(!state.active||state.active.state!=="succeeded"||state.active.templateState!=="ready")throw new ZerosDevError("computer_required");
      if(state.activeRepositories.length!==1||!this.repositoryMatches(fixture,state.activeRepositories[0]!))throw new ZerosDevError("repository_required");
      // Ordinary creates use the CP's active Computer grant. cloudComputerBuild
      // is the retired workspace-as-builder request, not a template selector.
      handle.run.create={key:randomUUID(),body:CreateBodySchema.parse({name:`zd-${handle.run.runId}`,
        repository:{forge:"github.com",owner:fixture.repository.owner,name:fixture.repository.name,revision:repository.revision,githubInstallationId:fixture.repository.installationId}})};
      await handle.save();
    }
    const intent=handle.run.create;
    // Never rebuild a recorded body from current defaults or the active build.
    const {workspace}=await this.request(this.root(fixture),document,{method:"POST",body:intent.body,idempotencyKey:intent.key,signal});
    this.assertWorkspace(workspace,fixture,handle.run);
    intent.result={id:workspace.id,createdBy:workspace.createdBy,createdAt:workspace.createdAt,generation:workspace.generation.number};
    await handle.save();return workspace;
  }
  async workspace(run:Run,signal?:AbortSignal,allowNextGeneration=false):Promise<CloudWorkspaceDocument>{
    const result=run.create?.result;if(!result)throw new ZerosDevError("receipt_missing");
    const fixture=await this.session.fixture();
    const {workspace}=await this.request(`/v1/cloud-workspaces/${result.id}`,document,{signal});
    this.assertWorkspace(workspace,fixture,run,allowNextGeneration);return workspace;
  }
  private assertCleanupName(workspace:CloudWorkspaceDocument,run:Run):void{
    if(workspace.name!==run.create?.body.name||!/^zd-[a-z0-9-]{1,100}$/.test(workspace.name))throw new ZerosDevError("identity_changed");
  }
  async lifecycle(handle:RunHandle,operation:"wake"|"stop"|"delete",signal?:AbortSignal):Promise<CloudWorkspaceDocument>{
    await this.session.whoami();const fixture=await this.session.fixture();
    const previous=handle.run.lifecycle.at(-1);
    if(previous&&!previous.confirmed&&!previous.settled&&previous.operation!==operation)throw new ZerosDevError("operation_conflict");
    const workspace=await this.workspace(handle.run,signal);
    if(operation==="delete")this.assertCleanupName(workspace,handle.run);
    if(workspace.status==="deleted"&&operation!=="delete")throw new ZerosDevError("workspace_failed");
    let intent=previous&&!previous.confirmed&&!previous.settled?previous:undefined;
    if(!intent){
      intent={operation,key:randomUUID(),generation:workspace.generation.number,confirmed:false};
      handle.run.lifecycle.push(intent);await handle.save();
    }
    const {workspace:next}=await this.request(`${this.root(fixture)}/${workspace.id}${operation==="delete"?"":`/${operation}`}`,document,
      {method:operation==="delete"?"DELETE":"POST",body:{},idempotencyKey:intent.key,signal});
    this.assertWorkspace(next,fixture,handle.run,operation==="wake");
    if(handle.run.create?.result)handle.run.create.result.generation=next.generation.number;
    // Accepted is not completed. Keep the key until observation confirms it.
    await handle.save();return next;
  }
  async waitWorkspace(handle:RunHandle,target:"running"|"stopped"|"deleted",signal?:AbortSignal):Promise<CloudWorkspaceDocument>{
    let setup:SetupObservation|undefined;
    try{return await this.observe(async bound=>{
      const pending=handle.run.lifecycle.at(-1);
      const result=handle.run.create?.result;if(!result)throw new ZerosDevError("receipt_missing");
      const fixture=await this.session.fixture();
      const observation=await this.request(`/v1/cloud-workspaces/${result.id}?setupProgress=true`,observedDocument,{signal:bound});
      const row=observation.workspace;
      this.assertWorkspace(row,fixture,handle.run,pending?.operation==="wake"&&!pending.confirmed);
      setup=readSetupProgress(observation.setupProgress,row.generation.number);
      if(row.status==="failed"&&target!=="deleted")throw new ZerosDevError("workspace_failed");
      if(target==="running"?!["ready","busy"].includes(row.status):row.status!==target)return null;
      if(target==="deleted"){
        if(!row.deletedAt||row.generation.observedState!=="deleted")return null;
        const fixture=await this.session.fixture();
        const progress=await this.request(`/v1/organizations/${fixture.organizationId}/cloud-workspace-management/pending-deletion`,pendingDeletion,{signal:bound});
        if(progress.truncated||progress.pendingDeletion.some(item=>item.workspaceId===row.id))return null;
        handle.run.deletionConfirmed=true;
      }
      if(handle.run.create?.result)handle.run.create.result.generation=row.generation.number;
      const expected=target==="running"?"wake":target==="stopped"?"stop":"delete";
      if(pending?.operation===expected)pending.confirmed=true;
      await handle.save();return row;
    },signal,180_000);}catch(error){
      if(error instanceof ZerosDevError&&["deadline","workspace_failed"].includes(error.code))
        throw new ZerosDevError(error.code,error.status,error.retryAfterMs,setup);
      throw error;
    }
  }
  async cleanup(handle:RunHandle,apply=false,signal?:AbortSignal):Promise<{planned:number;confirmed:number}>{
    if(handle.run.deletionConfirmed)return {planned:0,confirmed:1};
    if(!handle.run.create)return {planned:0,confirmed:0};
    if(!handle.run.create.result)throw new ZerosDevError("command_uncertain"); // reconcile the exact create first
    await this.session.whoami();const workspace=await this.workspace(handle.run,signal);
    this.assertCleanupName(workspace,handle.run);
    if(!apply)return {planned:1,confirmed:0};
    const prior=handle.run.lifecycle.at(-1);
    if(prior&&prior.operation!=="delete"&&!prior.confirmed&&!prior.settled){
      // Wake acceptance does not promise readiness: setup can fail and the CP
      // can system-stop the workspace. Preserve that observed outcome without
      // inventing successful completion, then let the explicit delete proceed.
      const settled=z.enum(["stopped","ready","busy","failed"]).safeParse(workspace.status);
      if(!settled.success)throw new ZerosDevError("cleanup_pending");
      prior.settled={status:settled.data,generation:workspace.generation.number};
      await handle.save();
    }
    await this.lifecycle(handle,"delete",signal);
    try {
      await this.waitWorkspace(handle, "deleted", signal);
    } catch (error) {
      if (error instanceof ZerosDevError && ["deadline", "not_found"].includes(error.code))
        throw new ZerosDevError("cleanup_pending");
      throw error;
    }
    return {planned:1,confirmed:1};
  }
  async grant(run:Run,agent:Agent,model:string,signal?:AbortSignal):Promise<string>{
    const row=await this.workspace(run,signal),fixture=await this.session.fixture();
    const result=await this.request(`/v1/cloud-workspaces/${row.id}/agent-credentials/prepare`,AgentGrantsSchema,{method:"POST",body:{},idempotencyKey:randomUUID(),signal});
    const eligible=result.delegations.filter(grant=>grant.ownerUserId===fixture.accountId&&grant.kind.startsWith(`${agent}-`)&&grant.models.includes(model)&&Date.parse(grant.expiresAt)>Date.now());
    const selected=eligible.find(grant=>grant.runtimeQualified===true)??eligible.find(grant=>grant.runtimeQualified!==false);
    if(!selected)throw new ZerosDevError("agent_credential_required");return selected.id;
  }
  async agentAvailability(run:Run,signal?:AbortSignal){
    const row=await this.workspace(run,signal);
    return this.request(`/v1/cloud-workspaces/${row.id}/agent-availability`,CloudAgentBootAvailabilitySchema,{signal});
  }
  private async observe<T>(read:(signal:AbortSignal)=>Promise<T|null>,external:AbortSignal|undefined,timeoutMs:number):Promise<T>{
    const deadline=AbortSignal.timeout(timeoutMs),signal=external?AbortSignal.any([external,deadline]):deadline,start=this.now();
    for(let poll=0;poll<180&&this.now()-start<timeoutMs;poll++){
      if(signal.aborted)throw new ZerosDevError("deadline");
      let wait=Math.min(5000,500*2**Math.min(poll,4));
      try{const result=await read(signal);if(result!==null)return result;}
      catch(error){if(!(error instanceof ZerosDevError)||error.code!=="rate_limited")throw error;wait=error.retryAfterMs??5000;}
      const remaining=timeoutMs-(this.now()-start);
      if(remaining<=0)throw new ZerosDevError("deadline");
      try{await this.sleep(Math.min(wait,remaining),signal);}catch{throw new ZerosDevError("deadline");}
    }
    throw new ZerosDevError("deadline");
  }
}
