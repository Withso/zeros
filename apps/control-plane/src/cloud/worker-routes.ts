import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { CLOUD_V2_MAX_FRAME_BYTES, CloudV2WorkerActivitySchema, CloudV2WorkerHelloSchema, CloudV2WorkerHistorySchema, CloudV2WorkerTimingSchema, type CloudV2ControlFrame } from "./contract.js";
import { emitCloudV2Timing, type CloudV2TimingRecord } from "./lifecycle.js";
import type { CloudV2Store, CloudV2WorkerSession, CloudV2Workspace } from "./store.js";
import { isCloudV2Token } from "./tokens.js";
import { CloudV2PromptAckSchema, CloudV2PromptBeginSchema, CloudV2PromptOutcomeSchema, CloudV2PromptPullSchema, CloudV2PromptStopReplySchema, CloudV2PromptStopSchema } from "./prompt-contract.js";
import { CloudGithubCheckoutSchema, type CloudGithubCheckout } from "./github-pr-contract.js";

export const CLOUD_V2_WORKER_API = "/v2/cloud/worker";
type ConfigFrame = Extract<CloudV2ControlFrame, { t: "config" }>;
export type CloudV2WorkerRouteDeps = {
  store: Pick<CloudV2Store, "acceptWorkerHello" | "workerSession" | "accessEpoch" | "loginRevision" | "markActive" | "writeWorkerHistory"> & Partial<Pick<CloudV2Store, "prompts">>;
  runtimeSha256: string;
  promptOutbox?: boolean;
  timing?: (record: CloudV2TimingRecord) => void;
  waitForPrompts?(workspaceId: string, waitMs: number, signal: AbortSignal): { wait: Promise<void>; dispose(): void };
  config(workspace: CloudV2Workspace): Promise<ConfigFrame>;
  authorizeSource?(workspace: CloudV2Workspace): Promise<void>;
  githubToken(workspace: CloudV2Workspace, purpose?: "git" | "gh"): Promise<{ token: string; expiresAt: number }>;
  githubCheckout?(token: string, bootId: string, value: CloudGithubCheckout): Promise<void>;
  mcpAuthorization?(workspace: CloudV2Workspace, id: string, force: boolean): Promise<{ headers: Record<string, string>; expiresAt?: number }>;
};
const unauthorized = () => new HttpError(401, "worker_unauthorized", "Worker authorization is no longer current");
const workerFeatures = (c: Context) => new Set((c.req.header("x-zeros-worker-features") ?? "").split(",").map(value => value.trim()));
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
  // Retain Stop's final history/ack path even when source authority is lost.
  if (workspace.state !== "stopping") await deps.authorizeSource?.(workspace);
  return { token, bootId, workspace };
}
async function configuration(deps: CloudV2WorkerRouteDeps, workspace: CloudV2WorkerSession, token: string, bootId: string, features: ReadonlySet<string>): Promise<ConfigFrame> {
  await deps.authorizeSource?.(workspace);
  for (let attempt = 0; attempt < 8; attempt++) {
    const revision = await deps.store.loginRevision(workspace.id);
    if (revision === null || !await deps.store.workerSession(token, bootId)) throw unauthorized();
    const config = await deps.config(workspace);
    if (!await deps.store.workerSession(token, bootId)) throw unauthorized();
    if (revision === await deps.store.loginRevision(workspace.id)) {
      const { mcpServers, githubPullRequests, ...legacy } = config;
      const { setup, baseCommit, github, ...workspaceConfig } = config.workspace;
      return { ...legacy, workspace: { ...workspaceConfig,
        ...(features.has("github-pr-v1") && github ? { github } : {}),
        ...(features.has("workspace-setup-v1") && setup !== undefined ? { setup } : {}),
        ...(features.has("checkout-v2") && baseCommit !== undefined ? { baseCommit } : {}) },
        loginRevision: revision, ...(features.has("github-pr-v1") && githubPullRequests === 1 ? { githubPullRequests } : {}), ...(features.has("mcp-v1") && mcpServers ? { mcpServers } : {}),
        ...(deps.promptOutbox ? { promptOutbox: 1 } : {}) };
    }
  }
  throw new HttpError(503, "configuration_changing", "Worker configuration is changing");
}

/** Mounted before user authentication. Every request is scoped by the worker
 * credential and current boot, never by an id supplied in the body. */
export function createCloudV2WorkerRoutes(deps: CloudV2WorkerRouteDeps): Hono {
  const app = new Hono();
  // The VM can read its bearer token. Do not trust its client-side diagnostic
  // throttle; bound both log volume per boot and retained admission state.
  const timingBoots = new Map<string, Set<string>>();
  app.use(`${CLOUD_V2_WORKER_API}/*`, bodyLimit({ maxSize: CLOUD_V2_MAX_FRAME_BYTES, onError: c => c.json({ error: { code: "payload_too_large" } }, 413) }));
  app.use(`${CLOUD_V2_WORKER_API}/*`, async (c, next) => { bearer(c); c.header("Cache-Control", "no-store"); await next(); });
  app.post(`${CLOUD_V2_WORKER_API}/hello`, async c => {
    const input = await body(c, CloudV2WorkerHelloSchema);
    if (input.runtimeSha256 !== deps.runtimeSha256) throw new HttpError(409, "worker_runtime_mismatch", "Worker runtime requires an update");
    if (deps.promptOutbox && !(c.req.header("x-zeros-worker-features") ?? "").split(",").map(value => value.trim()).includes("prompt-outbox-v1"))
      throw new HttpError(409, "worker_runtime_mismatch", "Worker runtime requires an update");
    const workspace = await deps.store.acceptWorkerHello(bearer(c), input.bootId);
    if (!workspace) throw unauthorized();
    if (workspace.helloTiming) emitCloudV2Timing(deps.timing, { workspaceId: workspace.id.slice(0, 8), phase: "worker_hello", ...workspace.helloTiming });
    return c.json({ config: await configuration(deps, workspace, bearer(c), input.bootId, workerFeatures(c)) });
  });
  app.post(`${CLOUD_V2_WORKER_API}/timing`, async c => {
    const auth = await session(c, deps), record = await body(c, CloudV2WorkerTimingSchema);
    const key = `${auth.workspace.id}:${auth.bootId}`;
    let phases = timingBoots.get(key);
    if (!phases) {
      if (timingBoots.size >= 1024) timingBoots.delete(timingBoots.keys().next().value!);
      phases = new Set(); timingBoots.set(key, phases);
    }
    if (phases.has(record.phase)) return c.json({ ok: true });
    phases.add(record.phase);
    emitCloudV2Timing(deps.timing, { workspaceId: auth.workspace.id.slice(0, 8), ...record });
    return c.json({ ok: true });
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
    return c.json({ config: await configuration(deps, auth.workspace, auth.token, auth.bootId, workerFeatures(c)) });
  });
  app.post(`${CLOUD_V2_WORKER_API}/mcp/:id/authorization`, async c => {
    const auth = await session(c, deps), input = await body(c, z.object({ force: z.boolean().optional() }).strict());
    const id = z.string().uuid().safeParse(c.req.param("id"));
    if (!id.success || !deps.mcpAuthorization) throw new HttpError(404, "not_found", "MCP server not found");
    const result = await deps.mcpAuthorization(auth.workspace, id.data, input.force ?? false);
    if (!await deps.store.workerSession(auth.token, auth.bootId)) throw unauthorized();
    return c.json(result);
  });
  app.post(`${CLOUD_V2_WORKER_API}/github-token`, async c => {
    const auth = await session(c, deps);
    const input = await body(c, z.object({ purpose: z.enum(["git", "gh"]).optional() }).strict());
    let granted: { token: string; expiresAt: number };
    try { granted = await deps.githubToken(auth.workspace, input.purpose ?? "git"); }
    catch { throw new HttpError(409, "github_token_unavailable", "GitHub token unavailable"); }
    if (!await deps.store.workerSession(auth.token, auth.bootId)) throw unauthorized();
    return c.json(granted);
  });
  app.post(`${CLOUD_V2_WORKER_API}/github-checkout`, async c => {
    const auth = await session(c, deps);
    if (!deps.githubCheckout) throw new HttpError(404, "not_found", "Cloud pull requests are not available.");
    const input = await body(c, CloudGithubCheckoutSchema);
    await deps.githubCheckout(auth.token, auth.bootId, input);
    return c.json({ sequence: input.sequence });
  });
  if (deps.promptOutbox) {
    const outbox = deps.store.prompts;
    if (!outbox) throw new Error("Cloud prompt store is required");
    app.post(`${CLOUD_V2_WORKER_API}/prompts/pull`, async c => {
      const auth = await session(c, deps);
      const { waitMs, held } = await body(c, CloudV2PromptPullSchema);
      const waiter = waitMs ? deps.waitForPrompts?.(auth.workspace.id, waitMs, c.req.raw.signal) : undefined;
      try {
        const first = await outbox.pull(auth.token, auth.bootId, held);
        if (!waiter || first.prompts.length || first.stops.length) return c.json(first);
        await waiter.wait;
        if (c.req.raw.signal.aborted) throw new HttpError(503, "request_cancelled", "Delivery poll ended");
        await session(c, deps);
        return c.json(await outbox.pull(auth.token, auth.bootId, held));
      } finally { waiter?.dispose(); }
    });
    app.post(`${CLOUD_V2_WORKER_API}/prompts/ack`, async c => {
      const auth = await session(c, deps);
      return c.json(await outbox.ack(auth.token, auth.bootId, await body(c, CloudV2PromptAckSchema)));
    });
    app.post(`${CLOUD_V2_WORKER_API}/prompts/begin`, async c => {
      const auth = await session(c, deps);
      return c.json(await outbox.begin(auth.token, auth.bootId, await body(c, CloudV2PromptBeginSchema)));
    });
    app.post(`${CLOUD_V2_WORKER_API}/prompts/outcome`, async c => {
      const auth = await session(c, deps);
      return c.json(await outbox.outcome(auth.token, auth.bootId, await body(c, CloudV2PromptOutcomeSchema)));
    });
    app.post(`${CLOUD_V2_WORKER_API}/prompts/stop-ack`, async c => {
      const auth = await session(c, deps);
      await outbox.ackStop(auth.token, auth.bootId, await body(c, CloudV2PromptStopReplySchema));
      return c.json({ ok: true });
    });
    app.post(`${CLOUD_V2_WORKER_API}/prompts/stop`, async c => {
      const auth = await session(c, deps);
      return c.json(await outbox.stopWorker(auth.token, auth.bootId, await body(c, CloudV2PromptStopSchema)));
    });
  }
  return app;
}
