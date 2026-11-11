import { Hono, type Context, type Handler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../../authz.js";
import { rateLimit } from "../../ratelimit.js";
import { readCloudV2History } from "../history.js";
import { CloudV2PromptCounterSchema, CloudV2PromptIdSchema, CloudV2SessionNameSchema } from "../prompt-contract.js";
import { ApiRenameSchema } from "../api/contract.js";
import type { CloudTeamSharing } from "./store.js";
import { TEAM_SHARING_HEADER, TeamListSchema, TeamPageSchema, teamNotFound, teamReadOnly, teamManagementDenied, teamUnavailable } from "./contract.js";

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

export function createCloudTeamRoutes(sharing: CloudTeamSharing, document: (value: Awaited<ReturnType<CloudTeamSharing["get"]>>) => unknown): Hono {
  const app = new Hono(), path = "/v1/cloud-v2/workspaces/:id";
  const share = (handler: Handler): Handler => async (c,next) => {
    if (c.req.header(TEAM_SHARING_HEADER) !== "1") return next();
    c.header("Cache-Control","no-store");
    try { return await handler(c,next); }
    catch (error) {
      const failure = error instanceof HttpError ? error : teamUnavailable();
      if (failure.status === 503) c.header("Retry-After","5");
      if (failure.status === 429 && !c.res.headers.has("Retry-After")) c.header("Retry-After","60");
      return c.json({ error: { code: failure.code,message: failure.message } },failure.status);
    }
  };
  const limited = bodyLimit({ maxSize: 16*1024,onError: c => c.json({ error: { code: "payload_too_large" } },413) });
  app.use("/v1/cloud-v2/workspaces*",async (c,next) => {
    if (c.req.header(TEAM_SHARING_HEADER) === "1" && !["/prompts","/github"].some(suffix => c.req.path.endsWith(suffix))) return limited(c,next);
    return next();
  });
  app.get("/v1/cloud-v2/workspaces",share(async c => {
    const parsed = TeamListSchema.safeParse(c.req.query());
    if (!parsed.success) throw new HttpError(400,"invalid_request","Invalid workspace filters");
    const result = await sharing.list(c.get("user"),parsed.data);
    return c.json({ ...result,workspaces: result.workspaces.map(document) });
  }));
  app.get("/v1/cloud-v2/workspaces/by-number/:organization/:number",share(async c => {
    const slug = c.req.param("organization")!, number = c.req.param("number")!;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug) || !/^[1-9][0-9]{0,9}$/.test(number) || Number(number)>2_147_483_647) throw teamNotFound();
    return c.json({ workspace: document(await sharing.byNumber(slug,Number(number),c.get("user"))),teamSharing: 1 });
  }));
  app.get(path,share(async c => c.json({ workspace: document(await sharing.get(uuid(c.req.param("id")!),c.get("user"))),teamSharing: 1 })));
  app.get(`${path}/events`,share(c => sharing.events.open(c,uuid(c.req.param("id")!))));
  const activityLimit = rateLimit("cloud-workspace-activity",12,60_000);
  app.post(`${path}/activity`,share(async c => activityLimit(c,async () => {
    c.res = c.json(await sharing.activity(uuid(c.req.param("id")!),c.get("user")));
  })));
  app.post(`${path}/history`,share(async c => {
    const id = uuid(c.req.param("id")!), request = await c.req.json().catch(() => null);
    return c.json({ result: await sharing.read(id,c.get("user"),() => readCloudV2History(sharing.workspaces,id,request)) });
  }));
  app.get(`${path}/prompts`,share(async c => {
    const query = z.object({ chatId: CloudV2PromptIdSchema,after: CloudV2PromptCounterSchema.default("0"),
      limit: z.coerce.number().int().min(1).max(100).default(100),includePayload: z.enum(["true","false"]).default("true") }).strict().safeParse(c.req.query());
    if (!query.success) throw new HttpError(400,"invalid_request","Invalid message status request");
    const id = uuid(c.req.param("id")!), { chatId,after,limit,includePayload } = query.data;
    return c.json(await sharing.read(id,c.get("user"),proof => sharing.workspaces.prompts.listForViewer(id,chatId,after,limit,includePayload === "true",
      async tx => { await sharing.authority.assert(proof,tx); })));
  }));
  const creator = share(async (c,next) => {
    const id = uuid(c.req.param("id")!), user = c.get("user");
    if (await sharing.authority.isCreator(id,user.id)) return next();
    const proof = await sharing.authority.admit(id,user);
    if (proof.view.role !== "creator") throw teamReadOnly();
    return next();
  });
  for (const action of ["connect","start","restart","prompts","prompts/stop","github"]) app.post(`${path}/${action}`,creator);
  for (const action of ["stop","archive"] as const) app.post(`${path}/${action}`,share(async c => {
    await body(c,empty,true);
    const id = uuid(c.req.param("id")!), user = c.get("user");
    const result = await sharing.manage(id,user,action);
    return c.json({ workspace: document(await sharing.get(id,user)),teamSharing: 1 },result.moved ? 202 : 200);
  }));
  app.post(`${path}/rename`,share(async c => {
    const input = await body(c,ApiRenameSchema), id = uuid(c.req.param("id")!), user = c.get("user");
    await sharing.manage(id,user,"rename",input.name);
    return c.json({ workspace: document(await sharing.get(id,user)),teamSharing: 1 });
  }));
  app.delete(path,share(async c => {
    await body(c,empty,true);
    const id = uuid(c.req.param("id")!), user = c.get("user");
    await sharing.manage(id,user,"delete");
    return c.json({ workspace: document(await sharing.get(id,user)),teamSharing: 1 },202);
  }));
  app.post(`${path}/chats/:chatId/edit`,share(async c => {
    const parsed = CloudV2PromptIdSchema.safeParse(c.req.param("chatId"));
    if (!parsed.success) throw teamNotFound();
    const patch = await body(c,z.object({ title: CloudV2SessionNameSchema.transform(value => value.trim()).optional(),archived: z.boolean().optional() })
      .strict().refine(value => value.title !== undefined || value.archived !== undefined));
    const id = uuid(c.req.param("id")!), user = c.get("user"), proof = await sharing.authority.admit(id,user);
    if (proof.view.role === "member") throw teamManagementDenied();
    const chat = await sharing.workspaces.chatEdits.applyForManager({ organizationId: proof.view.workspace.organizationId,userId: user.id },id,parsed.data,
      { ...(patch.title === undefined ? {} : { title: patch.title }),...(patch.archived === undefined ? {} : { archived: patch.archived }) },tx => sharing.manager(proof,tx));
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
