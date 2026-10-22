import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { CLOUD_V2_MAX_FRAME_BYTES, CloudV2WorkerActivitySchema, CloudV2WorkerHelloSchema, CloudV2WorkerHistorySchema, type CloudV2ControlFrame } from "./contract.js";
import type { CloudV2Store, CloudV2WorkerSession, CloudV2Workspace } from "./store.js";
import { isCloudV2Token } from "./tokens.js";

export const CLOUD_V2_WORKER_API = "/v2/cloud/worker";
type ConfigFrame = Extract<CloudV2ControlFrame, { t: "config" }>;
export type CloudV2WorkerRouteDeps = {
  store: Pick<CloudV2Store, "acceptWorkerHello" | "workerSession" | "accessEpoch" | "loginRevision" | "markActive" | "writeWorkerHistory">;
  runtimeSha256: string;
  config(workspace: CloudV2Workspace): Promise<ConfigFrame>;
  githubToken(workspace: CloudV2Workspace): Promise<{ token: string; expiresAt: number }>;
};
const unauthorized = () => new HttpError(401, "worker_unauthorized", "Worker authorization is no longer current");
function bearer(c: Context): string {
  const header = c.req.header("authorization") ?? "";
  if (!header.startsWith("Bearer ")) throw unauthorized();
  const token = header.slice(7);
  if (!isCloudV2Token(token, "worker")) throw unauthorized();
  return token;
}
async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new HttpError(400, "invalid_request", "Invalid worker request"); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid worker request");
  return parsed.data;
}
async function session(c: Context, deps: CloudV2WorkerRouteDeps): Promise<{ token: string; bootId: string; workspace: CloudV2WorkerSession }> {
  const token = bearer(c), bootId = c.req.header("x-zeros-worker-boot");
  if (!bootId || !z.string().uuid().safeParse(bootId).success) throw unauthorized();
  const workspace = await deps.store.workerSession(token, bootId);
  if (!workspace) throw unauthorized();
  return { token, bootId, workspace };
}
async function configuration(deps: CloudV2WorkerRouteDeps, workspace: CloudV2WorkerSession, token: string, bootId: string): Promise<ConfigFrame> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const revision = await deps.store.loginRevision(workspace.id);
    if (revision === null || !await deps.store.workerSession(token, bootId)) throw unauthorized();
    const config = await deps.config(workspace);
    if (!await deps.store.workerSession(token, bootId)) throw unauthorized();
    if (revision === await deps.store.loginRevision(workspace.id)) return { ...config, loginRevision: revision };
  }
  throw new HttpError(503, "configuration_changing", "Worker configuration is changing");
}

/** Mounted before user authentication. Every request is scoped by the worker
 * credential and current boot, never by an id supplied in the body. */
export function createCloudV2WorkerRoutes(deps: CloudV2WorkerRouteDeps): Hono {
  const app = new Hono();
  app.use(`${CLOUD_V2_WORKER_API}/*`, bodyLimit({ maxSize: CLOUD_V2_MAX_FRAME_BYTES, onError: c => c.json({ error: { code: "payload_too_large" } }, 413) }));
  app.use(`${CLOUD_V2_WORKER_API}/*`, async (c, next) => { bearer(c); c.header("Cache-Control", "no-store"); await next(); });
  app.post(`${CLOUD_V2_WORKER_API}/hello`, async c => {
    const input = await body(c, CloudV2WorkerHelloSchema);
    if (input.runtimeSha256 !== deps.runtimeSha256) throw new HttpError(409, "worker_runtime_mismatch", "Worker runtime requires an update");
    const workspace = await deps.store.acceptWorkerHello(bearer(c), input.bootId);
    if (!workspace) throw unauthorized();
    return c.json({ config: await configuration(deps, workspace, bearer(c), input.bootId) });
  });
  app.post(`${CLOUD_V2_WORKER_API}/history`, async c => {
    const auth = await session(c, deps), input = await body(c, CloudV2WorkerHistorySchema);
    if (input.bootId !== auth.bootId) throw unauthorized();
    const { t: _t, bootId, sequence, ...history } = input;
    await deps.store.writeWorkerHistory(auth.token, bootId, sequence, history);
    return c.json({ sequence });
  });
  app.post(`${CLOUD_V2_WORKER_API}/activity`, async c => {
    const auth = await session(c, deps), { idle } = await body(c, CloudV2WorkerActivitySchema);
    if (!idle) await deps.store.markActive(auth.workspace.id);
    return c.json({ loginRevision: auth.workspace.loginRevision, state: auth.workspace.state });
  });
  app.get(`${CLOUD_V2_WORKER_API}/config`, async c => {
    const auth = await session(c, deps);
    return c.json({ config: await configuration(deps, auth.workspace, auth.token, auth.bootId) });
  });
  app.post(`${CLOUD_V2_WORKER_API}/github-token`, async c => {
    const auth = await session(c, deps);
    await body(c, z.object({}).strict());
    let granted: { token: string; expiresAt: number };
    try { granted = await deps.githubToken(auth.workspace); }
    catch { throw new HttpError(409, "github_token_unavailable", "GitHub token unavailable"); }
    if (!await deps.store.workerSession(auth.token, auth.bootId)) throw unauthorized();
    return c.json(granted);
  });
  return app;
}
