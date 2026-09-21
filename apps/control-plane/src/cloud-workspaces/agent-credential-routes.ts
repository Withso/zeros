import {Hono} from "hono";
import {bodyLimit} from "hono/body-limit";
import {z} from "zod";
import {HttpError} from "../authz.js";
import {rateLimit} from "../ratelimit.js";
import type {DatabaseCloudAgentCredentialService} from "./agent-credentials.js";
import type {DatabaseCloudAgentExecutionService} from "./agent-executions.js";
import {CloudWorkspaceEngineAuthorityError} from "./engine-authority.js";

export function createCloudAgentCredentialRoutes(service:DatabaseCloudAgentCredentialService):Hono{
  const app=new Hono(),base="/v1/cloud-agent-credentials";
  for(const path of [base,`${base}/*`]){
    app.use(path,bodyLimit({maxSize:96*1024}));
    app.use(path,rateLimit("cloud-agent-credentials",30,60_000));
    app.use(path,async(c,next)=>{c.header("Cache-Control","no-store");await next();});
  }
  app.get(base,async c=>c.json(await service.list(c.get("user").id)));
  app.put(`${base}/:credential/native-codex`,async c=>{
    const parsed=z.object({operationId:z.string().uuid(),expectedRevision:z.number().int().nonnegative().safe(),displayName:z.string().min(1).max(80),nativeCache:z.unknown()}).strict()
      .safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)throw new HttpError(422,"invalid_agent_credential_request","Invalid agent credential request");
    return c.json(await service.importCodex({...parsed.data,nativeCache:parsed.data.nativeCache,ownerUserId:c.get("user").id,credentialId:c.req.param("credential")}));
  });
  app.put(`${base}/:credential`,bodyLimit({maxSize:48*1024}),async c=>{
    const parsed=z.object({operationId:z.string().uuid(),expectedRevision:z.number().int().nonnegative().safe(),displayName:z.string().min(1).max(80),material:z.unknown()}).strict()
      .safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)throw new HttpError(422,"invalid_agent_credential_request","Invalid agent credential request");
    return c.json(await service.put({...parsed.data,material:parsed.data.material,ownerUserId:c.get("user").id,credentialId:c.req.param("credential")}));
  });
  app.delete(`${base}/:credential`,async c=>c.json(await service.revoke(c.get("user").id,c.req.param("credential"))));
  app.get(`${base}/:credential/delegations`,async c=>c.json(await service.listDelegations(c.get("user").id,c.req.param("credential"))));
  app.post(`${base}/delegations`,async c=>c.json(await service.delegate(c.get("user").id,await c.req.json().catch(()=>null))));
  app.delete(`${base}/delegations/:delegation`,async c=>c.json(await service.revokeDelegation(c.get("user").id,c.req.param("delegation"))));
  app.get("/v1/cloud-workspaces/:workspace/agent-credentials",async c=>{
    c.header("Cache-Control","no-store");return c.json(await service.forWorkspace(c.get("user").id,c.req.param("workspace")));
  });
  return app;
}

export const CLOUD_AGENT_EXECUTION_PATH="/internal/v2/cloud-workspaces/engine/agent-execution";
const privateRequest=z.object({workspaceId:z.string().uuid(),organizationId:z.string().uuid(),generation:z.number().int().positive().safe(),engineInstanceId:z.string().uuid(),
  request:z.discriminatedUnion("kind",[
    z.object({kind:z.literal("admit"),admission:z.unknown()}).strict(),
    z.object({kind:z.literal("validate"),leaseId:z.string().uuid(),renew:z.boolean().optional(),credentialVersion:z.number().int().positive().safe().optional()}).strict(),
    z.object({kind:z.literal("refresh-codex"),leaseId:z.string().uuid(),credentialVersion:z.number().int().positive().safe()}).strict(),
    z.object({kind:z.literal("release"),leaseId:z.string().uuid()}).strict(),
    z.object({kind:z.literal("authorize-action"),executionId:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),actorSessionId:z.string().uuid()}).strict(),
  ])}).strict();
export function createCloudAgentExecutionRoutes(service:DatabaseCloudAgentExecutionService):Hono{
  const app=new Hono();app.use(CLOUD_AGENT_EXECUTION_PATH,bodyLimit({maxSize:4096}));
  app.post(CLOUD_AGENT_EXECUTION_PATH,async c=>{
    c.header("Cache-Control","no-store");
    if(c.req.header("content-type")?.split(";",1)[0]?.trim().toLowerCase()!=="application/json")return c.json({error:"invalid_agent_execution"},415);
    const heartbeatToken=/^Bearer (zwh_[A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization")??"")?.[1];
    if(!heartbeatToken)return c.json({error:"engine_authority_rejected"},401);
    const parsed=privateRequest.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:"invalid_agent_execution"},422);
    const {request,...scope}=parsed.data,binding={...scope,heartbeatToken};
    try{
      const result=request.kind==="admit"?await service.admit(binding,request.admission):request.kind==="validate"?
        await service.validate(binding,request.leaseId,request.renew??false,request.credentialVersion):request.kind==="refresh-codex"?
        await service.validate(binding,request.leaseId,true,request.credentialVersion,true):request.kind==="authorize-action"?
        await service.authorizeAction(binding,request.executionId,request.actorSessionId):await service.release(binding,request.leaseId);
      return c.json({result});
    }catch(error){
      if(error instanceof CloudWorkspaceEngineAuthorityError)return c.json({error:"engine_authority_rejected"},401);
      if(error instanceof HttpError)return c.json({error:"cloud_agent_authority_rejected"},error.status===503?503:error.status===429?429:403);
      return c.json({error:"cloud_agent_execution_unavailable"},503);
    }
  });return app;
}
