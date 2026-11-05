import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { CLOUD_V2_MAX_FRAME_BYTES, CloudV2WorkerActivitySchema, CloudV2WorkerHelloSchema, CloudV2WorkerHistorySchema, CloudV2WorkerTimingSchema, type CloudV2ControlFrame } from "./contract.js";
import { emitCloudV2Timing, type CloudV2TimingRecord } from "./lifecycle.js";
import type { CloudV2Store, CloudV2WorkerSession, CloudV2Workspace } from "./store.js";
import { isCloudV2Token } from "./tokens.js";
import { CloudV2PromptAckSchema, CloudV2PromptBeginSchema, CloudV2PromptOutcomeSchema, CloudV2PromptPullSchema, CloudV2PromptStopReplySchema, CloudV2PromptStopSchema, type CloudV2PromptPullReply } from "./prompt-contract.js";
import { CloudGithubCheckoutSchema, type CloudGithubCheckout } from "./github-pr-contract.js";
import type { CloudSourceContinuation, CloudSourceProof } from "./source-authority.js";
import { cloudGithubFailure } from "./github-failure.js";
import { CloudEnvironmentReportSchema, type CloudEnvironmentReport } from "./environment-contract.js";

export const CLOUD_V2_WORKER_API = "/v2/cloud/worker";
type ConfigFrame = Extract<CloudV2ControlFrame, { t: "config" }>;
export type CloudV2WorkerRouteDeps = {
  store: Pick<CloudV2Store, "beginWorkerHello" | "acceptWorkerHello" | "workerSession" | "accessEpoch" | "loginRevision" | "markActive" | "writeWorkerHistory" | "failWorkerCheckout"> & Partial<Pick<CloudV2Store, "prompts">>;
  runtimeSha256: string;
  promptOutbox?: boolean;
  timing?: (record: CloudV2TimingRecord) => void;
  logger?: Pick<Console, "warn">;
  waitForPrompts?(workspaceId: string, waitMs: number, signal: AbortSignal): { wait: Promise<void>; dispose(): void };
  config(workspace: CloudV2Workspace, mode?: "admission" | "continuation"): Promise<ConfigFrame>;
  authorizeSource?(workspace: CloudV2Workspace): Promise<void>;
  continueSource?(workspace: CloudV2Workspace, proof?: CloudSourceProof): Promise<CloudSourceContinuation>;
  githubToken(workspace: CloudV2Workspace, purpose?: "git" | "gh", failedTokenSha256?: string): Promise<{ token: string; expiresAt: number }>;
  githubCheckout?(token: string, bootId: string, value: CloudGithubCheckout): Promise<void>;
  environmentReport?(token: string, bootId: string, value: CloudEnvironmentReport): Promise<void>;
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
async function session(c: Context, deps: CloudV2WorkerRouteDeps, source = true): Promise<{ token: string; bootId: string; workspace: CloudV2WorkerSession }> {
  const token = bearer(c), bootId = c.req.header("x-zeros-worker-boot");
  if (!bootId || !z.string().uuid().safeParse(bootId).success) throw unauthorized();
  const workspace = await deps.store.workerSession(token, bootId);
  if (!workspace) throw unauthorized();
  // Retain Stop's final history/ack path even when source authority is lost.
  if (source && workspace.state !== "stopping") {
    if (deps.continueSource) await deps.continueSource(workspace, workspace);
    else await deps.authorizeSource?.(workspace);
  }
  return { token, bootId, workspace };
}
async function configuration(deps: CloudV2WorkerRouteDeps, workspace: CloudV2WorkerSession, token: string, bootId: string, features: ReadonlySet<string>, mode: "admission" | "continuation" = "admission"): Promise<ConfigFrame> {
  if (mode === "continuation" && deps.continueSource) await deps.continueSource(workspace, workspace);
  else await deps.authorizeSource?.(workspace);
  for (let attempt = 0; attempt < 8; attempt++) {
    const revision = await deps.store.loginRevision(workspace.id);
    if (revision === null || !await deps.store.workerSession(token, bootId)) throw unauthorized();
    const config = await deps.config(workspace, mode);
    if (!await deps.store.workerSession(token, bootId)) throw unauthorized();
    if (revision === await deps.store.loginRevision(workspace.id)) {
      const { mcpServers, githubPullRequests, githubUserTokens, gitIdentity, agentInteractions, codeReview, historyReplacement: _historyReplacement, environment, ...legacy } = config;
      if (environment && !features.has("workspace-environment-v1"))
        throw new HttpError(409, "cloud_environment_runtime_required", "Update the cloud runtime before opening this workspace.");
      const { setup, setupScript, baseCommit, github, ...workspaceConfig } = config.workspace;
      if (setupScript !== undefined && !features.has("repository-setup-v1"))
        throw new HttpError(409, "cloud_repository_setup_runtime_required", "Update the cloud runtime before opening this workspace.");
      return { ...legacy, workspace: { ...workspaceConfig,
        ...(setupScript !== undefined ? { setupScript } : {}),
        ...(features.has("github-pr-v1") && github ? { github } : {}),
        ...(features.has("workspace-setup-v1") && setup !== undefined ? { setup } : {}),
        ...(features.has("checkout-v2") && baseCommit !== undefined ? { baseCommit } : {}) },
        ...(features.has("agent-interactions-v1") && agentInteractions === 1 ? { agentInteractions } : {}),
        ...(environment ? { environment } : {}),
        loginRevision: revision, ...(features.has("history-replace-v1") ? { historyReplacement: 1 } : {}), ...(features.has("git-identity-v1") && gitIdentity !== undefined ? { gitIdentity } : {}),
        ...(features.has("code-review-v1") && codeReview ? { codeReview } : {}),
        ...(features.has("github-user-token-v1") && githubUserTokens === 1 ? { githubUserTokens } : {}),
        ...(features.has("github-pr-v1") && githubPullRequests === 1 ? { githubPullRequests } : {}), ...(features.has("mcp-v1") && mcpServers ? { mcpServers } : {}),
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
    const token = bearer(c), workspace = await deps.store.beginWorkerHello(token, input.bootId);
    if (!workspace) throw unauthorized();
    const config = await configuration(deps, workspace, token, input.bootId, workerFeatures(c));
    const ready = await deps.store.acceptWorkerHello(token, input.bootId, {
      accessEpoch: workspace.accessEpoch, loginRevision: config.loginRevision ?? workspace.loginRevision,
    });
    if (!ready) throw unauthorized();
    if (ready.helloTiming) emitCloudV2Timing(deps.timing, { workspaceId: ready.id.slice(0, 8), phase: "worker_hello", ...ready.helloTiming });
    return c.json({ config });
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
  app.post(`${CLOUD_V2_WORKER_API}/checkout-failed`, async c => {
    const auth = await session(c, deps, false);
    await body(c, z.object({}).strict());
    if (!await deps.store.failWorkerCheckout(auth.token, auth.bootId)) throw unauthorized();
    return c.json({ ok: true });
  });
  app.post(`${CLOUD_V2_WORKER_API}/environment`, async c => {
    const auth = await session(c, deps, false), report = await body(c, CloudEnvironmentReportSchema);
    if (!deps.environmentReport) throw new HttpError(404, "not_found", "Environment status is unavailable.");
    await deps.environmentReport(auth.token, auth.bootId, report);
    return c.json({ sequence: report.sequence });
  });
  app.post(`${CLOUD_V2_WORKER_API}/history`, async c => {
    const auth = await session(c, deps), input = await body(c, CloudV2WorkerHistorySchema);
    if (input.bootId !== auth.bootId) throw unauthorized();
    const { t: _t, bootId, sequence, ...history } = input;
    await deps.store.writeWorkerHistory(auth.token, bootId, sequence, history);
    return c.json({ sequence });
  });
  app.post(`${CLOUD_V2_WORKER_API}/activity`, async c => {
    // Activity releases no source or credential. Its current worker/boot proof
    // still applies, but a GitHub outage must never turn a busy VM into idle.
    const auth = await session(c, deps, false), { idle } = await body(c, CloudV2WorkerActivitySchema);
    if (!idle) await deps.store.markActive(auth.workspace.id);
    // Actual active work can refresh its cached permission in the background.
    // Neither a slow check nor its failure can suppress the activity receipt.
    if (!idle && auth.workspace.state === "running") void deps.continueSource?.(auth.workspace, auth.workspace).catch(() => {});
    return c.json({ loginRevision: auth.workspace.loginRevision, state: auth.workspace.state });
  });
  app.get(`${CLOUD_V2_WORKER_API}/config`, async c => {
    const auth = await session(c, deps);
    return c.json({ config: await configuration(deps, auth.workspace, auth.token, auth.bootId, workerFeatures(c), "continuation") });
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
    const auth = await session(c, deps, false);
    const input = await body(c, z.object({ purpose: z.enum(["git", "gh"]).optional(), failedTokenSha256: z.string().length(64).regex(/^[a-f0-9]{64}$/).optional() }).strict());
    let granted: { token: string; expiresAt: number };
    try {
      if (auth.workspace.state !== "stopping") {
        if (deps.continueSource) await deps.continueSource(auth.workspace, auth.workspace);
        else await deps.authorizeSource?.(auth.workspace);
      }
      granted = await deps.githubToken(auth.workspace, input.purpose ?? "git", ...(input.failedTokenSha256 ? [input.failedTokenSha256] : []));
    } catch (error) {
      const failure = cloudGithubFailure(error);
      deps.logger?.warn("[cloud-v2] GitHub credential unavailable", failure);
      return c.json({ error: { code: "github_token_unavailable", reason: failure.reason } }, 409);
    }
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
      const forWorker = async (batch: CloudV2PromptPullReply): Promise<CloudV2PromptPullReply> => {
        if (workerFeatures(c).has("agent-interactions-v1")) return batch;
        const prompts: CloudV2PromptPullReply["prompts"] = [];
        for (const item of batch.prompts) {
          // Older workers reject unknown payload fields. Explicit Plan can
          // never be stripped into a full-access dispatch.
          if (item.payload.permissionMode === "plan") {
            await outbox.outcome(auth.token, auth.bootId, { userMessageId: item.payload.userMessageId, deliveryId: item.deliveryId, state: "failed" });
          } else {
            const { permissionMode: _mode, ...payload } = item.payload;
            prompts.push({ ...item, payload });
          }
        }
        return { ...batch, prompts };
      };
      const waiter = waitMs ? deps.waitForPrompts?.(auth.workspace.id, waitMs, c.req.raw.signal) : undefined;
      try {
        const first = await outbox.pull(auth.token, auth.bootId, held);
        if (!waiter || first.prompts.length || first.stops.length) return c.json(await forWorker(first));
        await waiter.wait;
        if (c.req.raw.signal.aborted) throw new HttpError(503, "request_cancelled", "Delivery poll ended");
        await session(c, deps);
        return c.json(await forWorker(await outbox.pull(auth.token, auth.bootId, held)));
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
