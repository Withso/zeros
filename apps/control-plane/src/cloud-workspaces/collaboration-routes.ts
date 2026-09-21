import {Hono,type Context} from "hono";
import type pg from "pg";
import {z} from "zod";
import {HttpError} from "../authz.js";
import {withSystemTx} from "../db.js";
import {rateLimit} from "../ratelimit.js";
import {DatabaseCloudWorkspaceCollaborationService,type WorkspaceInvitationDeliveryConfig} from "./actors.js";

export function createCloudWorkspaceCollaborationRoutes(pool:pg.Pool,delivery:WorkspaceInvitationDeliveryConfig|null):Hono {
  const app=new Hono(),service=new DatabaseCloudWorkspaceCollaborationService(pool,delivery??undefined);
  const base="/v1/cloud-workspaces/:workspace";
  app.use(`${base}/*`,async(c,next)=>{c.header("Cache-Control","no-store");c.header("Pragma","no-cache");await next();});
  app.use(`${base}/*`,rateLimit("cloud-workspace-collaboration",60,60_000));
  app.use("/v1/cloud-workspace-invitations/accept",rateLimit("cloud-workspace-invitation-accept",30,600_000));
  const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{
    const parsed=schema.safeParse(value);if(!parsed.success)throw new HttpError(422,"invalid_input","Invalid collaboration request");return parsed.data;
  };
  const scope=async(c:Context)=>{
    const workspaceId=parse(z.string().uuid(),c.req.param("workspace"));
    const org=await withSystemTx(pool,async tx=>(await tx.query<{org_id:string}>("SELECT org_id FROM cloud_workspaces WHERE id=$1 AND deleted_at IS NULL",[workspaceId])).rows[0]);
    if(!org)throw new HttpError(404,"cloud_workspace_not_found","Cloud workspace access is unavailable");
    return {workspaceId,organizationId:org.org_id,actorUserId:c.get("user").id};
  };
  app.get(`${base}/collaborators`,async c=>c.json(await service.list(await scope(c))));
  app.patch(`${base}/sharing`,async c=>{
    const input=parse(z.object({sharingMode:z.enum(["private","organization"]),expectedRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict(),await c.req.json().catch(()=>null));
    return c.json(await service.setSharing({...await scope(c),...input}));
  });
  app.post(`${base}/invitations`,async c=>{
    if(!delivery)throw new HttpError(503,"cloud_workspace_invitation_delivery_unavailable","Workspace invitation delivery is not configured");
    const input=parse(z.object({email:z.string().trim().email().max(254),role:z.enum(["viewer","prompter","developer"])}).strict(),await c.req.json().catch(()=>null));
    const idempotencyKey=parse(z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),c.req.header("idempotency-key"));
    const invitation=await service.invite({...await scope(c),...input,idempotencyKey});
    return c.json({invitation:{id:invitation.id,expiresAt:invitation.expiresAt},replayed:invitation.replayed},invitation.replayed?200:201);
  });
  app.delete(`${base}/invitations/:invitation`,async c=>c.json(await service.revokeInvitation({...await scope(c),invitationId:parse(z.string().uuid(),c.req.param("invitation"))})));
  app.delete(`${base}/collaborators/:user`,async c=>c.json(await service.revokeGuest({...await scope(c),guestUserId:parse(z.string().uuid(),c.req.param("user"))})));
  app.post("/v1/cloud-workspace-invitations/accept",async c=>{
    c.header("Cache-Control","no-store");c.header("Pragma","no-cache");
    const {token,workspaceId}=parse(z.object({token:z.string().regex(/^zwi_[A-Za-z0-9_-]{43}$/),workspaceId:z.string().uuid()}).strict(),await c.req.json().catch(()=>null));
    const user=c.get("user"),result=await service.accept({actorUserId:user.id,identity:user.identity,token,expectedWorkspaceId:workspaceId.toLowerCase()});
    return c.json({...result,path:`/workspace/${result.workspaceId}`});
  });
  return app;
}
