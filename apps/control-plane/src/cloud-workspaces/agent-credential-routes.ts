import {Hono} from "hono";
import {bodyLimit} from "hono/body-limit";
import {z} from "zod";
import {HttpError} from "../authz.js";
import {rateLimit} from "../ratelimit.js";
import type {DatabaseCloudAgentCredentialService} from "./agent-credentials.js";
import type {DatabaseCloudAgentExecutionService} from "./agent-executions.js";
import {CloudComputerToolExecutionRequestSchema} from "./computer-tools-contract.js";
import {ComputerToolConflictError} from "./computer-tools.js";
import {CloudWorkspaceEngineAuthorityError} from "./engine-authority.js";
import { CloudCustomizationOperationSchema } from "./customization-workspace.js";
import {CloudBackgroundOperationSchema} from "./agent-background-tasks.js";

export function createCloudAgentCredentialRoutes(service:DatabaseCloudAgentCredentialService,options:{workspaceEnabled?:boolean}={}):Hono{
  const app=new Hono(),base="/v1/cloud-agent-credentials";
  for(const path of [base,`${base}/*`]){
    app.use(path,bodyLimit({maxSize:96*1024}));
    app.use(path,rateLimit("cloud-agent-credentials",30,60_000));
    app.use(path,async(c,next)=>{c.header("Cache-Control","no-store");await next();});
  }
  app.delete(`${base}/:credential/dev-reference`,async c=>{
    const input=z.object({organizationId:z.string().uuid(),scope:z.enum(["local","organization","global"])}).strict().safeParse(await c.req.json().catch(()=>null));
    if(!input.success)throw new HttpError(422,"invalid_agent_credential_request","Invalid Dev disconnect scope");
    return c.json(await service.removeDevConnection(c.get("user").id,input.data.organizationId,c.req.param("credential"),input.data.scope));
  });
  app.post(`${base}/:credential/dev-reference/reattach`,async c=>{
    const input=z.object({organizationId:z.string().uuid()}).strict().safeParse(await c.req.json().catch(()=>null));
    if(!input.success)throw new HttpError(422,"invalid_agent_credential_request","Invalid Dev reattach request");
    return c.json(await service.reattachDevConnection(c.get("user").id,input.data.organizationId,c.req.param("credential")));
  });
  app.get(base,async c=>c.json(await service.list(c.get("user").id)));
  app.put(`${base}/:credential/native-codex`,async c=>{
    const parsed=z.object({operationId:z.string().uuid(),expectedRevision:z.number().int().nonnegative().safe(),displayName:z.string().min(1).max(80),organizationId:z.string().uuid().optional(),nativeCache:z.unknown()}).strict()
      .safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)throw new HttpError(422,"invalid_agent_credential_request","Invalid agent credential request");
    return c.json(await service.importCodex({...parsed.data,nativeCache:parsed.data.nativeCache,ownerUserId:c.get("user").id,credentialId:c.req.param("credential")}));
  });
  app.put(`${base}/:credential`,bodyLimit({maxSize:48*1024}),async c=>{
    const parsed=z.object({operationId:z.string().uuid(),expectedRevision:z.number().int().nonnegative().safe(),displayName:z.string().min(1).max(80),organizationId:z.string().uuid().optional(),material:z.unknown()}).strict()
      .safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)throw new HttpError(422,"invalid_agent_credential_request","Invalid agent credential request");
    return c.json(await service.put({...parsed.data,material:parsed.data.material,ownerUserId:c.get("user").id,credentialId:c.req.param("credential")}));
  });
  app.delete(`${base}/:credential`,async c=>c.json(await service.revoke(c.get("user").id,c.req.param("credential"))));
  if(options.workspaceEnabled!==false){
    app.get(`${base}/:credential/delegations`,async c=>c.json(await service.listDelegations(c.get("user").id,c.req.param("credential"))));
    app.post(`${base}/delegations`,async c=>c.json(await service.delegate(c.get("user").id,await c.req.json().catch(()=>null))));
    app.delete(`${base}/delegations/:delegation`,async c=>c.json(await service.revokeDelegation(c.get("user").id,c.req.param("delegation"))));
    app.get("/v1/cloud-workspaces/:workspace/agent-credentials",async c=>{
      c.header("Cache-Control","no-store");return c.json(await service.forWorkspace(c.get("user").id,c.req.param("workspace")));
    });
  }
  const organizationBase="/v1/organizations/:organization/agent-connections";
  for(const path of [organizationBase,`${organizationBase}/*`,"/v1/cloud-workspaces/:workspace/agent-credentials/prepare"]){
    app.use(path,bodyLimit({maxSize:16*1024}));
    app.use(path,rateLimit("cloud-agent-connections",60,60_000));
    app.use(path,async(c,next)=>{c.header("Cache-Control","no-store");await next();});
  }
  app.get(organizationBase,async c=>c.json(await service.organizationConnections(c.get("user").id,c.req.param("organization"))));
  app.put(`${organizationBase}/:provider`,async c=>c.json(await service.setOrganizationConnection(
    c.get("user").id,c.req.param("organization"),c.req.param("provider"),await c.req.json().catch(()=>null))));
  app.delete(`${organizationBase}/accounts/:credential`,async c=>c.json(await service.removeOrganizationCredential(
    c.get("user").id,c.req.param("organization"),c.req.param("credential"))));
  if(options.workspaceEnabled!==false)app.post("/v1/cloud-workspaces/:workspace/agent-credentials/prepare",async c=>{
      if(!z.object({}).strict().safeParse(await c.req.json().catch(()=>null)).success)
        throw new HttpError(422,"invalid_agent_credential_request","Invalid agent credential request");
      return c.json(await service.authorizeOrganizationForWorkspace(c.get("user").id,c.req.param("workspace")));
    });
  return app;
}

export const CLOUD_AGENT_EXECUTION_PATH="/internal/v2/cloud-workspaces/engine/agent-execution";
const privateRequest=z.object({workspaceId:z.string().uuid(),organizationId:z.string().uuid(),generation:z.number().int().positive().safe(),engineInstanceId:z.string().uuid(),
  request:z.discriminatedUnion("kind",[
    z.object({kind:z.literal("admit"),admission:z.unknown(),includeGitAuthor:z.boolean().optional(),nativeCapabilitiesVersion:z.literal(1).optional(),backgroundTasksVersion:z.literal(1).optional(),computerToolsVersion:z.literal(1).optional(),environmentVersion:z.literal(1).optional()}).strict(),
    CloudComputerToolExecutionRequestSchema,
    z.object({kind:z.literal("terminal-environment"),actorSessionId:z.string().uuid()}).strict(),
    z.object({kind:z.literal("background"),leaseId:z.string().uuid(),operation:CloudBackgroundOperationSchema}).strict(),
    z.object({kind:z.literal("validate"),leaseId:z.string().uuid(),renew:z.boolean().optional(),credentialVersion:z.number().int().positive().safe().optional(),nativeCapabilitiesVersion:z.literal(1).optional()}).strict(),
    z.object({kind:z.literal("refresh-codex"),leaseId:z.string().uuid(),credentialVersion:z.number().int().positive().safe(),nativeCapabilitiesVersion:z.literal(1).optional()}).strict(),
    z.object({kind:z.literal("release"),leaseId:z.string().uuid()}).strict(),
    z.object({kind:z.literal("authorize-action"),executionId:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),actorSessionId:z.string().uuid()}).strict(),
    z.object({kind:z.literal("customization"),actorSessionId:z.string().uuid(),operation:CloudCustomizationOperationSchema,params:z.record(z.unknown())}).strict(),
  ])}).strict();
export function createCloudAgentExecutionRoutes(service:DatabaseCloudAgentExecutionService):Hono{
  const app=new Hono();app.use(CLOUD_AGENT_EXECUTION_PATH,bodyLimit({maxSize:256*1024}));
  app.post(CLOUD_AGENT_EXECUTION_PATH,async c=>{
    c.header("Cache-Control","no-store");
    if(c.req.header("content-type")?.split(";",1)[0]?.trim().toLowerCase()!=="application/json")return c.json({error:"invalid_agent_execution"},415);
    const heartbeatToken=/^Bearer (zwh_[A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization")??"")?.[1];
    if(!heartbeatToken)return c.json({error:"engine_authority_rejected"},401);
    const parsed=privateRequest.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:"invalid_agent_execution"},422);
    const {request,...scope}=parsed.data,binding={...scope,heartbeatToken};
    const customized=request.kind==="computer-tool"||request.kind==="background"||request.kind==="customization"||(request.kind==="admit"&&request.admission!==null&&typeof request.admission==="object"&&"customization" in request.admission);
    if(!customized&&Buffer.byteLength(JSON.stringify(parsed.data))>4096)return c.json({error:"invalid_agent_execution"},413);
    try{
      const result=request.kind==="terminal-environment"?await service.terminalEnvironment(binding,request.actorSessionId):request.kind==="admit"?await service.admit(binding,request.admission,request.includeGitAuthor,request.nativeCapabilitiesVersion,request.backgroundTasksVersion,request.computerToolsVersion,request.environmentVersion):request.kind==="computer-tool"?
        await service.computerTool(binding,request):request.kind==="background"?
        await service.background(binding,request.leaseId,request.operation):request.kind==="validate"?
        await service.validate(binding,request.leaseId,request.renew??false,request.credentialVersion,false,request.nativeCapabilitiesVersion):request.kind==="refresh-codex"?
        await service.validate(binding,request.leaseId,true,request.credentialVersion,true,request.nativeCapabilitiesVersion):request.kind==="authorize-action"?
        await service.authorizeAction(binding,request.executionId,request.actorSessionId):request.kind==="customization"?
        await service.customization(binding,request.actorSessionId,request.operation,request.params):await service.release(binding,request.leaseId);
      return c.json({result});
    }catch(error){
      if(error instanceof CloudWorkspaceEngineAuthorityError)return c.json({error:"engine_authority_rejected"},401);
      if(request.kind==="computer-tool"&&error instanceof ComputerToolConflictError)return c.json({result:error.result},409);
      if(request.kind==="admit"&&error instanceof HttpError&&error.code==="cloud_computer_tools_update_required")
        return c.json({error:"cloud_computer_tools_update_required"},409);
      if(error instanceof HttpError&&["computer_environment_revoked","computer_environment_runtime_required"].includes(error.code))return c.json({error:error.code},409);
      if(error instanceof HttpError)return c.json({error:"cloud_agent_authority_rejected"},error.status===503?503:error.status===429?429:403);
      return c.json({error:"cloud_agent_execution_unavailable"},503);
    }
  });return app;
}
