import { Hono, type Context, type Handler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../../authz.js";
import { rateLimit } from "../../ratelimit.js";
import { readCloudV2SharingHistory } from "../history.js";
import { CloudV2PromptIdSchema, CloudV2SessionNameSchema } from "../prompt-contract.js";
import { promptStatusQuery } from "../prompt-status-query.js";
import { ApiRenameSchema } from "../api/contract.js";
import type { CloudTeamSharing } from "./store.js";
import { TEAM_SHARING_HEADER, TEAM_OWNERSHIP_HEADER, TeamListSchema, TeamPageSchema, TeamCandidatesQuerySchema, TeamReassignSchema,
  teamNotFound, teamReadOnly, teamManagementDenied, teamOwnershipRequired, teamUnavailable } from "./contract.js";

const uuid = (input: string) => { const parsed = z.string().uuid().safeParse(input); if (!parsed.success) throw teamNotFound(); return parsed.data; };
async function body<T>(c: Context, schema: z.ZodType<T>, optional = false): Promise<T> {
  const text = await c.req.text();
  let input: unknown;
  try { input = text ? JSON.parse(text) : optional ? {} : null; } catch { input = null; }
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400,"invalid_request","Invalid request");
  return result.data;
}
const empty = z.object({}).strict();

export function createCloudTeamRoutes(sharing: CloudTeamSharing, document: (value: Awaited<ReturnType<CloudTeamSharing["get"]>>) => unknown,
  connectActive?: (c: Context, workspaceId: string) => Promise<boolean>): Hono {
  const app = new Hono(), path = "/v1/cloud-v2/workspaces/:id";
  const owns = (c: Context) => c.req.header(TEAM_SHARING_HEADER) === "1" && c.req.header(TEAM_OWNERSHIP_HEADER) === "1";
  const marker = (c: Context) => owns(c) ? { teamOwnership: 1 as const } : {};
  const share = (handler: Handler): Handler => async (c,next) => {
    if (c.req.header(TEAM_SHARING_HEADER) !== "1") return next();
    c.header("Cache-Control","no-store");
    try { return await handler(c,next); }
    catch (error) {
      const failure = error instanceof HttpError ? error : teamUnavailable();
      if (failure.status === 503) c.header("Retry-After","5");
      if (failure.status === 429 && !c.res.headers.has("Retry-After")) c.header("Retry-After","60");
      return c.json({ error: { code: failure.code,message: failure.message,
        ...("agent" in failure ? { agent: failure.agent } : {}) } },failure.status);
    }
  };
  const limited = bodyLimit({ maxSize: 16*1024,onError: c => c.json({ error: { code: "payload_too_large" } },413) });
  const ownership = (handler: Handler): Handler => async (c,next) => {
    c.header("Cache-Control","no-store");
    if (!owns(c)) { const error = teamOwnershipRequired(); return c.json({ error: { code: error.code,message: error.message } },error.status); }
    return share(handler)(c,next);
  };
  // 200 IDs of 256 characters, including JSON escaping, fit the lookup bound.
  const historyLimit = bodyLimit({ maxSize: 320*1024,onError: c => c.json({ error: { code: "payload_too_large" } },413) });
  app.use("/v1/cloud-v2/workspaces*",async (c,next) => {
    if (c.req.header(TEAM_SHARING_HEADER) === "1" && c.req.path.endsWith("/history")) return historyLimit(c,next);
    if (c.req.header(TEAM_SHARING_HEADER) === "1" && !["/prompts","/github"].some(suffix => c.req.path.endsWith(suffix))) return limited(c,next);
    return next();
  });
  app.get("/v1/cloud-v2/workspaces",share(async c => {
    const parsed = TeamListSchema.safeParse(c.req.query());
    if (!parsed.success) throw new HttpError(400,"invalid_request","Invalid workspace filters");
    const result = await sharing.list(c.get("user"),parsed.data,owns(c));
    return c.json({ ...result,workspaces: result.workspaces.map(document) });
  }));
  app.get("/v1/cloud-v2/workspaces/by-number/:organization/:number",share(async c => {
    const slug = c.req.param("organization")!, number = c.req.param("number")!;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug) || !/^[1-9][0-9]{0,9}$/.test(number) || Number(number)>2_147_483_647) throw teamNotFound();
    return c.json({ workspace: document(await sharing.byNumber(slug,Number(number),c.get("user"),owns(c))),teamSharing: 1,...marker(c) });
  }));
  app.get(path,share(async c => c.json({ workspace: document(await sharing.get(uuid(c.req.param("id")!),c.get("user"),owns(c))),teamSharing: 1,...marker(c) })));
  app.get(`${path}/reassign-candidates`,ownership(async c => {
    const page = TeamCandidatesQuerySchema.safeParse(c.req.query());
    if (!page.success) throw new HttpError(400,"invalid_request","Invalid candidates page");
    const id = uuid(c.req.param("id")!), user = c.get("user");
    return rateLimit("cloud-team-candidates",12,60_000,() => `${user.id}:${id}`)(c,async () => {
      c.res = c.json(await sharing.ownership.candidates(id,user,page.data));
    });
  }));
  app.post(`${path}/reassign`,limited,ownership(async c => {
    const input = await body(c,TeamReassignSchema), id = uuid(c.req.param("id")!), user = c.get("user");
    const proof = await sharing.authority.admit(id,user);
    return rateLimit("cloud-team-reassign",10,60_000,() => `${user.id}:${proof.view.workspace.organizationId}`)(c,async () => {
      const result = await sharing.ownership.reassign(id,user,input);
      c.res = c.json({ ...result,workspace: document(result.workspace) });
    });
  }));
  app.get(`${path}/events`,share(c => sharing.events.open(c,uuid(c.req.param("id")!))));
  const activityLimit = rateLimit("cloud-workspace-activity",12,60_000);
  app.post(`${path}/activity`,share(async c => activityLimit(c,async () => {
    c.res = c.json(await sharing.activity(uuid(c.req.param("id")!),c.get("user")));
  })));
  app.post(`${path}/history`,share(async c => {
    const id = uuid(c.req.param("id")!), request = await c.req.json().catch(() => null);
    return c.json({ result: await sharing.read(id,c.get("user"),() => readCloudV2SharingHistory(sharing.workspaces,id,request)) });
  }));
  app.get(`${path}/prompts`,share(async c => {
    const cache = c.req.header("X-Zeros-Chat-Cache") === "1", query = promptStatusQuery(c.req.query(), cache);
    const id = uuid(c.req.param("id")!), { chatId,after,limit,includePayload,queueRevision } = query;
    return c.json(await sharing.read(id,c.get("user"),proof => sharing.workspaces.prompts.listForViewer(id,chatId,after,limit,includePayload === "true",
      async tx => { await sharing.authority.assert(proof,tx); },cache ? { userId: c.get("user").id,queueRevision } : undefined)));
  }));
  const creator = share(async (c,next) => {
    const id = uuid(c.req.param("id")!), user = c.get("user");
    if (c.req.path.endsWith("/connect") && connectActive
      ? await connectActive(c,id) : await sharing.workspaces.prompts.execution?.active(id)) return next();
    if (await sharing.authority.isCreator(id,user.id)) return next();
    const proof = await sharing.authority.admit(id,user);
    if (proof.view.role !== "creator") throw teamReadOnly();
    return next();
  });
  for (const action of ["connect","start","restart","prompts","prompts/stop","github"]) app.post(`${path}/${action}`,creator);
  for (const action of ["stop","archive"] as const) app.post(`${path}/${action}`,share(async (c,next) => {
    await body(c,empty,true);
    const id = uuid(c.req.param("id")!), user = c.get("user");
    if (action === "stop" && await sharing.workspaces.prompts.execution?.active(id)) return next();
    const result = await sharing.manage(id,user,action);
    return c.json({ workspace: document(await sharing.get(id,user,owns(c))),teamSharing: 1,...marker(c) },result.moved ? 202 : 200);
  }));
  app.post(`${path}/rename`,share(async c => {
    const input = await body(c,ApiRenameSchema), id = uuid(c.req.param("id")!), user = c.get("user");
    await sharing.manage(id,user,"rename",input.name);
    return c.json({ workspace: document(await sharing.get(id,user,owns(c))),teamSharing: 1,...marker(c) });
  }));
  app.delete(path,share(async c => {
    await body(c,empty,true);
    const id = uuid(c.req.param("id")!), user = c.get("user");
    await sharing.manage(id,user,"delete");
    return c.json({ workspace: document(await sharing.get(id,user,owns(c))),teamSharing: 1,...marker(c) },202);
  }));
  app.post(`${path}/chats/:chatId/edit`,share(async c => {
    const parsed = CloudV2PromptIdSchema.safeParse(c.req.param("chatId"));
    if (!parsed.success) throw teamNotFound();
    const patch = await body(c,z.object({ title: CloudV2SessionNameSchema.transform(value => value.trim()).optional(),archived: z.boolean().optional() })
      .strict().refine(value => value.title !== undefined || value.archived !== undefined));
    const id = uuid(c.req.param("id")!), user = c.get("user"), proof = await sharing.authority.admit(id,user);
    const active = await sharing.workspaces.prompts.execution?.active(id);
    if (!active && proof.view.role === "member") throw teamManagementDenied();
    const chat = await sharing.workspaces.chatEdits.applyForManager({ organizationId: proof.view.workspace.organizationId,userId: user.id },id,parsed.data,
      { ...(patch.title === undefined ? {} : { title: patch.title }),...(patch.archived === undefined ? {} : { archived: patch.archived }) },async tx => { if (active) await sharing.authority.assert(proof,tx); else await sharing.manager(proof,tx); });
    return c.json({ chat });
  }));
  for (const verb of ["follow","unfollow","pin","unpin"] as const) app.post(`${path}/${verb}`,share(async c => {
    await body(c,empty,true);
    const id = uuid(c.req.param("id")!), user = c.get("user");
    const proof = await sharing.authority.admit(id,user);
    const limit = rateLimit("cloud-team-marks",60,60_000,() => `${user.id}:${proof.view.workspace.organizationId}`);
    return limit(c,async () => {
      c.res = c.json(await sharing.mark(id,user,verb.endsWith("follow") ? "follow" : "pin",!verb.startsWith("un")));
    });
  }));
  app.get(`${path}/followers`,share(async c => {
    const page = TeamPageSchema.safeParse(c.req.query());
    if (!page.success) throw new HttpError(400,"invalid_request","Invalid followers page");
    return c.json(await sharing.followers(uuid(c.req.param("id")!),c.get("user"),page.data));
  }));
  return app;
}
