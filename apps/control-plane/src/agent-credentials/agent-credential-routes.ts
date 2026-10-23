import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { rateLimit } from "../ratelimit.js";
import type { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";
import { CloudAgentCredentialRemovalPrepareSchema, CloudAgentCredentialRemovalDecisionSchema,
  CloudAgentCredentialRemovalOutcomeSchema } from "./agent-credential-mutations.js";

export function createCloudAgentCredentialRoutes(service:DatabaseCloudAgentCredentialService):Hono{
  const app=new Hono(),base="/v1/cloud-agent-credentials";
  for(const path of [base,`${base}/*`]){
    app.use(path,bodyLimit({maxSize:96*1024}));
    app.use(path,rateLimit("cloud-agent-credentials",30,60_000));
    app.use(path,async(c,next)=>{c.header("Cache-Control","no-store");await next();});
  }
  const removalBase=`${base}/removals`;
  const removalError=(error:unknown)=>{
    if((error instanceof HttpError)&&error.code==="agent_credential_conflict")return {body:{error:error.code},status:409 as const};
    if((error instanceof HttpError)&&error.status<500)return {body:{error:"cloud_validation_access_denied"},status:403 as const};
    return {body:{error:"cloud_agent_credential_busy"},status:503 as const};
  };
  app.post(`${removalBase}/prepare`,async c=>{
    const parsed=CloudAgentCredentialRemovalPrepareSchema.safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)return c.json({error:"invalid_agent_credential_request"},422);
    try{
      const result=CloudAgentCredentialRemovalOutcomeSchema.safeParse(await service.prepareRemoval(c.get("user").id,parsed.data));
      if(!result.success||result.data.operationId!==parsed.data.operationId)return c.json({error:"cloud_agent_credential_busy"},503);
      return c.json(result.data);
    }catch(error){const refusal=removalError(error);return c.json(refusal.body,refusal.status);}
  });
  app.get(`${removalBase}/:operationId`,async c=>{
    try{
      const result=CloudAgentCredentialRemovalOutcomeSchema.safeParse(await service.readRemoval(c.get("user").id,c.req.param("operationId")));
      if(!result.success||result.data.operationId!==c.req.param("operationId"))return c.json({error:"cloud_agent_credential_busy"},503);
      return c.json(result.data);
    }catch(error){const refusal=removalError(error);return c.json(refusal.body,refusal.status);}
  });
  for(const action of ["confirm","cancel"] as const)app.post(`${removalBase}/:operationId/${action}`,async c=>{
    const parsed=CloudAgentCredentialRemovalDecisionSchema.safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)return c.json({error:"invalid_agent_credential_request"},422);
    try{
      const result=CloudAgentCredentialRemovalOutcomeSchema.safeParse(await service.decideRemoval(c.get("user").id,c.req.param("operationId"),action,parsed.data));
      if(!result.success||result.data.operationId!==c.req.param("operationId"))return c.json({error:"cloud_agent_credential_busy"},503);
      return c.json(result.data);
    }catch(error){const refusal=removalError(error);return c.json(refusal.body,refusal.status);}
  });
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
  const organizationBase="/v1/organizations/:organization/agent-connections";
  for(const path of [organizationBase,`${organizationBase}/*`]){
    app.use(path,bodyLimit({maxSize:16*1024}));
    app.use(path,rateLimit("cloud-agent-connections",60,60_000));
    app.use(path,async(c,next)=>{c.header("Cache-Control","no-store");await next();});
  }
  app.get(organizationBase,async c=>c.json(await service.organizationConnections(c.get("user").id,c.req.param("organization"))));
  app.put(`${organizationBase}/:provider`,async c=>c.json(await service.setOrganizationConnection(
    c.get("user").id,c.req.param("organization"),c.req.param("provider"),await c.req.json().catch(()=>null))));
  app.delete(`${organizationBase}/accounts/:credential`,async c=>c.json(await service.removeOrganizationCredential(
    c.get("user").id,c.req.param("organization"),c.req.param("credential"))));
  return app;
}

