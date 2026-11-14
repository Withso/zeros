import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { CLOUD_V2_MAX_FRAME_BYTES, CloudV2WorkerActivitySchema, CloudV2WorkerHelloSchema, CloudV2WorkerHistorySchema, CloudV2WorkerTimingSchema, CloudV2RenewRequestSchema, CloudV2TurnLeaseRequestSchema, CloudV2TerminalLeaseRequestSchema, CloudV2ClientLeaseRequestSchema, CloudV2BootstrapLeaseRequestSchema, CloudV2RetiredRequestSchema, CloudV2BootCleanRequestSchema, ACTING_USER_FEATURE, HISTORY_DIGEST_FEATURE, type CloudV2ControlFrame } from "./contract.js";
import { emitCloudV2Timing, type CloudV2TimingRecord } from "./lifecycle.js";
import type { CloudV2Store, CloudV2WorkerSession, CloudV2Workspace } from "./store.js";
import { isCloudV2Token } from "./tokens.js";
import type { LiveRecoveryProofBinding } from "./live-recovery-signals.js";
import { CLOUD_V2_PROMPT_POLL_MS, CloudV2PromptAckSchema, CloudV2PromptBeginSchema, CloudV2PromptOutcomeSchema, CloudV2PromptPullSchema, CloudV2PromptStopReplySchema, CloudV2PromptStopSchema, type CloudV2PromptPullReply } from "./prompt-contract.js";
import { CloudGithubCheckoutSchema, type CloudGithubCheckout } from "./github-pr-contract.js";
import type { CloudSourceContinuation, CloudSourceProof } from "./source-authority.js";
import { cloudGithubFailure } from "./github-failure.js";
import { CloudEnvironmentReportSchema, type CloudEnvironmentReport } from "./environment-contract.js";
import type { RuntimeAdoption } from "./runtime-adoption.js";
import type { RuntimeHandoffStore } from "./runtime-handoff-store.js";
import { CloudRuntimeUpdateRequestSchema } from "./runtime-update-contract.js";
import { LOCAL_COMMANDS_FEATURE, LOCAL_COMMANDS_REASON_FEATURE, LocalCommandIdSchema } from "./local-commands/contract.js";
import { LocalCommandSubmissionSchema, localUnavailable, type CloudLocalCommands } from "./local-commands/requests.js";
import { localBody, localUuid, localRouteError } from "./local-commands/routes.js";
import { requestSignal, type CloudLocalCommandSignals } from "./local-commands/signals.js";
import { NOTIFY_USER_FEATURE, NotifyUserWorkerRequestSchema } from "./notify-user/contract.js";
import { NotificationRateLimit, type CloudNotifyUser } from "./notify-user/store.js";
import { CloudV2SetupStatusSchema } from "./setup-status-contract.js";
import { CLOUD_RECOVERY_QUIESCE_FEATURE, CloudRecoveryRequestSchema, CloudRecoveryReplySchema,
  type CloudRecoveryHint, type CloudRecoveryRequest, type CloudRecoveryReply } from "./recovery-quiesce-contract.js";
import type { CloudWorkspaceSync } from "./workspace-sync/store.js";
import { SYNC_FEATURE, SYNC_CONTEXT_FEATURE } from "./workspace-sync/contract.js";

import type { CloudExecutionContexts } from "./execution/store.js";
import { executionWorkerRequired } from "./execution/errors.js";
import { activationBusy } from "./execution/activation-state.js";
import { workerGitIdentity } from "./worker-git-identity.js";

export const CLOUD_V2_WORKER_API = "/v2/cloud/worker";
type ConfigFrame = Extract<CloudV2ControlFrame, { t: "config" }>;
export type CloudV2WorkerRouteDeps = {
  outboundProof?(binding: LiveRecoveryProofBinding): Promise<void>;
  recovery?: {
    pull(token: string, bootId: string, id: string): Promise<{ hold: boolean; hint?: CloudRecoveryHint }>;
    request(token: string, bootId: string, input: CloudRecoveryRequest): Promise<CloudRecoveryReply>;
    hello(token: string, bootId: string, runtime: string, capable: boolean, id: string): Promise<boolean>;
    setup(token: string, bootId: string, id: string, report: z.infer<typeof CloudV2SetupStatusSchema>): Promise<void>;
  };
  store: Pick<CloudV2Store, "beginWorkerHello" | "acceptWorkerHello" | "workerSession" | "accessEpoch" | "loginRevision" | "markActive" | "writeWorkerHistory" | "failWorkerCheckout"> & Partial<Pick<CloudV2Store, "prompts" | "workerHelloIdentity" | "chatEdits" | "reportWorkerSetup" | "workerHistoryDigests">>;
  runtimeSha256: string;
  execution?: CloudExecutionContexts;
  runtimeSha256ForWorkspace?(workspace: CloudV2Workspace): Promise<string>;
  runtimeUpdates?: RuntimeAdoption;
  runtimeHandoffs?: RuntimeHandoffStore;
  promptOutbox?: boolean;
  localCommands?: { requests: CloudLocalCommands; signals: CloudLocalCommandSignals };
  notifications?: CloudNotifyUser;
  workspaceSync?: Pick<CloudWorkspaceSync, "advertise">;
  timing?: (record: CloudV2TimingRecord) => void;
  logger?: Pick<Console, "warn">;
  waitForPrompts?(workspaceId: string, waitMs: number, signal: AbortSignal): { wait: Promise<void>; dispose(): void };
  config(workspace: CloudV2Workspace, mode?: "admission" | "continuation", proof?: CloudSourceProof): Promise<ConfigFrame>;
  apiConfiguration?(workspaceId: string): Promise<ConfigFrame["api"]>;
  authorizeSource?(workspace: CloudV2Workspace): Promise<void>;
  continueSource?(workspace: CloudV2Workspace, proof?: CloudSourceProof): Promise<CloudSourceContinuation>;
  githubToken(workspace: CloudV2Workspace, purpose?: "git" | "gh", failedTokenSha256?: string): Promise<{ token: string; expiresAt: number }>;
  githubCheckout?(token: string, bootId: string, value: CloudGithubCheckout): Promise<void>;
  environmentReport?(token: string, bootId: string, value: CloudEnvironmentReport): Promise<void>;
  mcpAuthorization?(workspace: CloudV2Workspace, id: string, force: boolean): Promise<{ headers: Record<string, string>; expiresAt?: number }>;
};
const unauthorized = () => new HttpError(401, "worker_unauthorized", "Worker authorization is no longer current");
function assertLegacyMaterial(workspace: CloudV2WorkerSession) {
  if (workspace.executionMode !== "active" && workspace.executionTransitionId) throw activationBusy();
}
function sameMaterialAuthority(before: CloudV2WorkerSession, after: CloudV2WorkerSession | null): boolean {
  return after !== null && before.accessEpoch === after.accessEpoch && before.executionMode === after.executionMode &&
    (after.executionMode === "active" || !after.executionTransitionId);
}
const workerFeatures = (c: Context) => new Set((c.req.header("x-zeros-worker-features") ?? "").split(",").map(value => value.trim()));
function leaseReply<T extends { gitIdentity: { name: string } | null; personName?: string | undefined }>(c: Context, lease: T) {
  // Persisted material remains readable by a control plane without this field.
  const { personName: _personName, ...value } = lease;
  const personName = workerFeatures(c).has("creator-commit-identity-v1") ? lease.gitIdentity?.name : undefined;
  return { ...value, ...(personName ? { personName } : {}) };
}
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
async function currentSession(deps: CloudV2WorkerRouteDeps, token: string, bootId: string, handoff?: string): Promise<CloudV2WorkerSession | null> {
  if (handoff) {
    if (!z.string().uuid().safeParse(handoff).success || !deps.runtimeUpdates) return null;
    return deps.runtimeUpdates.session(token, bootId, handoff);
  }
  return deps.store.workerSession(token, bootId);
}
async function session(c: Context, deps: CloudV2WorkerRouteDeps, privateBoot = false): Promise<{ token: string; bootId: string; workspace: CloudV2WorkerSession }> {
  const token = bearer(c), bootId = c.req.header("x-zeros-worker-boot");
  if (!bootId || !z.string().uuid().safeParse(bootId).success) throw unauthorized();
  const workspace = await currentSession(deps, token, bootId, privateBoot ? c.req.header("x-zeros-runtime-handoff") : undefined);
  if (!workspace) throw unauthorized();
  return { token, bootId, workspace };
}
async function configuration(deps: CloudV2WorkerRouteDeps, workspace: CloudV2WorkerSession, token: string, bootId: string, features: ReadonlySet<string>, mode: "admission" | "continuation" = "admission", handoff?: string): Promise<ConfigFrame> {
  assertLegacyMaterial(workspace);
  const active = workspace.executionMode === "active";
  if (active && !features.has(ACTING_USER_FEATURE)) throw executionWorkerRequired();
  let fence: Promise<CloudV2WorkerSession | null> | undefined = currentSession(deps, token, bootId, handoff);
  fence.catch(() => {});
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = await (fence ?? currentSession(deps, token, bootId, handoff));
    fence = undefined;
    if (!before) throw unauthorized();
    assertLegacyMaterial(before);
    let config: ConfigFrame;
    let localCommandsEnabled = false;
    try {
      config = await deps.config(before, mode, before);
      if (!active && features.has("workspace-api-v1") && deps.apiConfiguration) {
        const api = await deps.apiConfiguration(before.id);
        if (api) config = { ...config, api };
      }
      localCommandsEnabled = Boolean(features.has(LOCAL_COMMANDS_FEATURE) && deps.promptOutbox && await deps.localCommands?.requests.enabled(before.id));
    }
    catch (error) {
      if (!(error instanceof HttpError) || error.code !== "github_authorization_changed") throw error;
      const current = await currentSession(deps, token, bootId, handoff);
      if (!current || current.accessEpoch !== before.accessEpoch) throw unauthorized();
      if (current.loginRevision === before.loginRevision) throw error;
      continue;
    }
    const after = await currentSession(deps, token, bootId, handoff);
    if (!after || !sameMaterialAuthority(before, after)) throw unauthorized();
    const revision = before.loginRevision;
    if (revision === after.loginRevision) {
      const { api, agentLogins, agentModels, localCommands: _localCommands, localCommandReason: _localCommandReason, notifyUser: _notifyUser, mcpServers, githubPullRequests, githubUserTokens, gitIdentity: _gitIdentity, gitIdentitySource: _gitIdentitySource, agentInteractions, codeReview, historyReplacement: _historyReplacement, historyDigest: _historyDigest, environment, runtimeUpdate: _runtimeUpdate, pushSignals, ...legacy } = config;
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
        ...(active && features.has("creator-agent-logins-v1") && agentLogins ? { agentLogins } : {}),
        ...(active && features.has("creator-agent-models-v1") && agentModels ? { agentModels } : {}),
        ...(features.has("workspace-api-v1") && api ? { api } : {}),
        ...(localCommandsEnabled ? { localCommands: 1 } : {}),
        ...(localCommandsEnabled && features.has(LOCAL_COMMANDS_REASON_FEATURE) ? { localCommandReason: 1 } : {}),
        ...(features.has(NOTIFY_USER_FEATURE) && deps.promptOutbox && deps.notifications ? { notifyUser: 1 } : {}),
        ...(environment ? { environment } : {}),
        ...(features.has("runtime-update-v1") && deps.runtimeUpdates ? { runtimeUpdate: 1 } : {}),
        ...(features.has("push-signals-v1") && deps.promptOutbox && pushSignals === 1 ? { pushSignals } : {}),
        loginRevision: revision, ...(features.has("history-replace-v1") ? { historyReplacement: 1 } : {}),
        ...(features.has("history-replace-v1") && features.has(HISTORY_DIGEST_FEATURE) && deps.store.workerHistoryDigests ? { historyDigest: 1 } : {}),
        ...workerGitIdentity(config, features.has("git-identity-v1"), features.has("creator-commit-identity-v1")),
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
  if (deps.execution) {
    const execution = deps.execution;
    app.post(`${CLOUD_V2_WORKER_API}/execution-leases/boot-clean`, async c => {
      const auth = await session(c, deps);
      if (!workerFeatures(c).has(ACTING_USER_FEATURE)) throw executionWorkerRequired();
      const input = await body(c, CloudV2BootCleanRequestSchema);
      return c.json(await execution.boots.clean(auth, input, deps.logger));
    });
    app.post(`${CLOUD_V2_WORKER_API}/turn-lease`, async c => {
      const auth = await session(c, deps);
      if (!workerFeatures(c).has(ACTING_USER_FEATURE)) throw executionWorkerRequired();
      return c.json(leaseReply(c, await execution.turnLease(auth, await body(c, CloudV2TurnLeaseRequestSchema))));
    });
    app.post(`${CLOUD_V2_WORKER_API}/terminal-lease`, async c => {
      const auth = await session(c, deps);
      return c.json(leaseReply(c, await execution.clients.terminalLease(auth, await body(c, CloudV2TerminalLeaseRequestSchema))));
    });
    app.post(`${CLOUD_V2_WORKER_API}/client-lease`, async c => {
      const auth = await session(c, deps);
      return c.json(leaseReply(c, await execution.clients.operationLease(auth, await body(c, CloudV2ClientLeaseRequestSchema))));
    });
    app.post(`${CLOUD_V2_WORKER_API}/execution-leases/renew`, async c => {
      const auth = await session(c, deps);
      if (!workerFeatures(c).has(ACTING_USER_FEATURE)) throw executionWorkerRequired();
      const input = await body(c, CloudV2RenewRequestSchema);
      return c.json(await execution.renew(auth, input.contextIds));
    });
    app.post(`${CLOUD_V2_WORKER_API}/bootstrap-lease`, async c => {
      const auth = await session(c, deps);
      if (!workerFeatures(c).has(ACTING_USER_FEATURE)) throw executionWorkerRequired();
      const input = await body(c, CloudV2BootstrapLeaseRequestSchema);
      return c.json(leaseReply(c, await execution.bootstrapLease(auth, input.contextId)));
    });
    app.post(`${CLOUD_V2_WORKER_API}/execution-leases/:id/retired`, async c => {
      const auth = await session(c, deps);
      if (!workerFeatures(c).has(ACTING_USER_FEATURE)) throw executionWorkerRequired();
      const id = z.uuid().safeParse(c.req.param("id"));
      if (!id.success) throw new HttpError(400, "invalid_request", "Invalid execution context");
      return c.json(await execution.retired(auth, id.data, await body(c, CloudV2RetiredRequestSchema)));
    });
  }
  if (deps.notifications) {
    const notifications = deps.notifications, path = `${CLOUD_V2_WORKER_API}/notifications`;
    const route = new Hono().onError((error,c) => {
      if (!(error instanceof HttpError)) console.error("[notify-user] request_failed");
      const failure = error instanceof HttpError ? error : new HttpError(503,"notifications_unavailable","Notifications are temporarily unavailable");
      if (failure.status === 429) c.header("Retry-After",String(error instanceof NotificationRateLimit ? error.retryAfter : 60));
      return c.json({ error: { code: failure.code,message: failure.message } },failure.status);
    });
    route.use(path,bodyLimit({ maxSize: 16*1024,onError: c => c.json({ error: { code: "payload_too_large",message: "Request is too large" } },413) }));
    route.post(path,async c => {
      if (!deps.promptOutbox || !workerFeatures(c).has(NOTIFY_USER_FEATURE)) throw unauthorized();
      const auth = await session(c,deps), input = await body(c,NotifyUserWorkerRequestSchema);
      await notifications.accept({ token: auth.token,bootId: auth.bootId,workspaceId: auth.workspace.id,accessEpoch: auth.workspace.accessEpoch },input);
      return c.body(null,202);
    });
    app.route("/",route);
  }
  if (deps.localCommands) {
    const local = new Hono().onError(localRouteError);
    const { requests, signals } = deps.localCommands, path = `${CLOUD_V2_WORKER_API}/local-commands`, empty = z.object({}).strict();
    const authority = async (c: Context) => {
      if (!deps.promptOutbox || !workerFeatures(c).has(LOCAL_COMMANDS_FEATURE)) throw unauthorized();
      return session(c,deps);
    };
    local.use(`${path}*`, bodyLimit({ maxSize: 256*1024, onError: c => c.json({ error: { code: "payload_too_large", message: "Request is too large" } },413) }));
    local.use(`${path}*`, async (c,next) => {
      await next();
      if (c.res.status === 429 && !c.res.headers.has("Retry-After")) c.header("Retry-After","60");
    });
    local.post(path, async c => {
      const auth = await authority(c), input = await localBody(c,LocalCommandSubmissionSchema);
      const result = await requests.create(auth.token,auth.bootId,input);
      return c.json(result.receipt,result.replay ? 200 : 201);
    });
    local.post(`${path}/retire-sender`, async c => {
      const auth = await authority(c), input = await localBody(c,z.object({ chatId: LocalCommandIdSchema, executionId: LocalCommandIdSchema }).strict());
      await requests.retireSender(auth.token,auth.bootId,input.chatId); return c.json({ ok: true });
    });
    local.get(`${path}/:requestId`, async c => {
      const query = z.object({ waitMs: z.coerce.number().int().min(0).max(25_000).default(0) }).strict().safeParse(c.req.query());
      if (!query.success) throw new HttpError(400,"invalid_request","Invalid local command wait");
      const id = localUuid(c.req.param("requestId")), deadline = Date.now()+query.data.waitMs;
      let auth = await authority(c), firstState: string | undefined;
      if (query.data.waitMs) { try { await signals.start(); } catch { throw localUnavailable(); } }
      for (;;) {
        const waiter = query.data.waitMs ? signals.wait(requestSignal(auth.workspace.id,id),Math.max(0,deadline-Date.now()),c.req.raw.signal) : undefined;
        try {
          const current = await requests.read(auth.token,auth.bootId,id), receipt = current.receipt;
          if (receipt.state === "terminal" || (firstState !== undefined && receipt.state !== firstState) || Date.now() >= deadline) return c.json(receipt);
          firstState = receipt.state;
          if (!waiter || !signals.healthy() || c.req.raw.signal.aborted) throw localUnavailable();
          // A passive projection also observes deadlines if a maintenance
          // replica is down; no connection is held during either wait.
          let timer: NodeJS.Timeout | undefined;
          try { await Promise.race([waiter.wait,new Promise<void>(resolve => { timer = setTimeout(resolve,Math.max(0,current.wakeAt-Date.now())); timer.unref(); })]); }
          finally { clearTimeout(timer); }
          if (c.req.raw.signal.aborted) throw localUnavailable();
          auth = await authority(c);
        } finally { waiter?.dispose(); }
      }
    });
    local.post(`${path}/:requestId/cancel`, async c => {
      const auth = await authority(c); await localBody(c,empty,true);
      return c.json(await requests.cancel(auth.token,auth.bootId,localUuid(c.req.param("requestId"))));
    });
    local.post(`${path}/:requestId/ack`, async c => {
      const auth = await authority(c); await localBody(c,empty,true);
      await requests.ack(auth.token,auth.bootId,localUuid(c.req.param("requestId"))); return c.body(null,204);
    });
    app.route("/",local);
  }
  app.post(`${CLOUD_V2_WORKER_API}/hello`, async c => {
    const input = await body(c, CloudV2WorkerHelloSchema);
    const token = bearer(c);
    const handoff = c.req.header("x-zeros-runtime-handoff");
    if (handoff) {
      if (!workerFeatures(c).has("runtime-update-v1") || !z.string().uuid().safeParse(handoff).success || !deps.runtimeUpdates) throw unauthorized();
      const identity = await deps.runtimeUpdates.session(token, input.bootId, handoff, input.runtimeSha256);
      if (!identity) throw unauthorized();
      if (deps.workspaceSync && !await deps.workspaceSync.advertise(token, input.bootId, workerFeatures(c).has(SYNC_FEATURE), handoff, workerFeatures(c).has(SYNC_CONTEXT_FEATURE) && workerFeatures(c).has("acting-user-v1"))) throw unauthorized();
      if (deps.store.chatEdits && !await deps.store.chatEdits.advertise(token, input.bootId, workerFeatures(c).has("chat-edit-v1"), handoff)) throw unauthorized();
      if (deps.localCommands && workerFeatures(c).has(LOCAL_COMMANDS_FEATURE)
        && !await deps.localCommands.requests.advertise(token,input.bootId,true,handoff)) throw unauthorized();
      return c.json({ config: await configuration(deps, identity, token, input.bootId, workerFeatures(c), "admission", handoff) });
    }
    let runtimeSha256 = deps.runtimeSha256, identity: CloudV2WorkerSession | null = null;
    if (deps.runtimeSha256ForWorkspace) {
      if (!deps.store.workerHelloIdentity) throw new HttpError(503, "worker_runtime_unavailable", "Worker runtime could not be verified");
      identity = await deps.store.workerHelloIdentity(token);
      if (!identity) throw unauthorized();
      runtimeSha256 = await deps.runtimeSha256ForWorkspace(identity);
    }
    if (input.runtimeSha256 !== runtimeSha256 && !(workerFeatures(c).has("runtime-update-v1") && deps.runtimeHandoffs &&
        await deps.runtimeHandoffs.runtime(token, input.bootId) === input.runtimeSha256))
      throw new HttpError(409, "worker_runtime_mismatch", "Worker runtime requires an update");
    if (deps.promptOutbox && !(c.req.header("x-zeros-worker-features") ?? "").split(",").map(value => value.trim()).includes("prompt-outbox-v1"))
      throw new HttpError(409, "worker_runtime_mismatch", "Worker runtime requires an update");
    const recoveryCapable = workerFeatures(c).has(CLOUD_RECOVERY_QUIESCE_FEATURE);
    if (identity?.recoveryAttemptId && (!deps.recovery || !await deps.recovery.hello(token, input.bootId, input.runtimeSha256, recoveryCapable, identity.recoveryAttemptId)))
      throw unauthorized();
    const workspace = await deps.store.beginWorkerHello(token, input.bootId, workerFeatures(c).has(ACTING_USER_FEATURE), input.runtimeSha256, workerFeatures(c).has(SYNC_CONTEXT_FEATURE), recoveryCapable);
    if (!workspace) throw unauthorized();
    if (deps.workspaceSync && !await deps.workspaceSync.advertise(token, input.bootId, workerFeatures(c).has(SYNC_FEATURE), undefined, workerFeatures(c).has(SYNC_CONTEXT_FEATURE) && workerFeatures(c).has("acting-user-v1"))) throw unauthorized();
    if (deps.store.chatEdits && !await deps.store.chatEdits.advertise(token, input.bootId, workerFeatures(c).has("chat-edit-v1"))) throw unauthorized();
    if (deps.localCommands && workerFeatures(c).has(LOCAL_COMMANDS_FEATURE)
      && !await deps.localCommands.requests.advertise(token,input.bootId,true)) throw unauthorized();
    const configStarted = Date.now();
    const config = await configuration(deps, workspace, token, input.bootId, workerFeatures(c));
    const configMs = Math.max(0, Date.now() - configStarted);
    const ready = await deps.store.acceptWorkerHello(token, input.bootId, {
      accessEpoch: workspace.accessEpoch, loginRevision: config.loginRevision ?? workspace.loginRevision,
    });
    if (!ready) throw unauthorized();
    if (workerFeatures(c).has("runtime-update-v1")) await deps.runtimeHandoffs?.recordRuntime(token, input.bootId, input.runtimeSha256);
    if (ready.helloTiming) emitCloudV2Timing(deps.timing, { workspaceId: ready.id.slice(0, 8), phase: "worker_hello", ...ready.helloTiming, configMs });
    if (ready.boatSandboxId) void deps.outboundProof?.({ workspaceId: ready.id, bootId: input.bootId,
      sandboxId: ready.boatSandboxId, accessEpoch: workspace.accessEpoch }).catch(() => {});
    return c.json({ config });
  });
  app.post(`${CLOUD_V2_WORKER_API}/runtime`, async c => {
    if (!workerFeatures(c).has("runtime-update-v1") || !deps.runtimeUpdates) throw new HttpError(404, "not_found", "Runtime update is unavailable.");
    const token = bearer(c), bootId = c.req.header("x-zeros-worker-boot");
    if (!bootId || !z.string().uuid().safeParse(bootId).success) throw unauthorized();
    return c.json(await deps.runtimeUpdates.request(token, bootId, await body(c, CloudRuntimeUpdateRequestSchema)));
  });
  app.post(`${CLOUD_V2_WORKER_API}/recovery`, async c => {
    if (!workerFeatures(c).has(CLOUD_RECOVERY_QUIESCE_FEATURE) || !deps.recovery)
      throw new HttpError(404, "not_found", "Recovery is unavailable.");
    const auth = await session(c, deps), input = await body(c, CloudRecoveryRequestSchema);
    return c.json(CloudRecoveryReplySchema.parse(await deps.recovery.request(auth.token, auth.bootId, input)));
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
    const auth = await session(c, deps);
    await body(c, z.object({}).strict());
    if (!await deps.store.failWorkerCheckout(auth.token, auth.bootId)) throw unauthorized();
    return c.json({ ok: true });
  });
  app.post(`${CLOUD_V2_WORKER_API}/environment`, async c => {
    const auth = await session(c, deps, true), report = await body(c, CloudEnvironmentReportSchema);
    const handoff = c.req.header("x-zeros-runtime-handoff");
    if (handoff && await deps.runtimeUpdates?.environment(auth.token, auth.bootId, handoff, report)) return c.json({ sequence: report.sequence });
    if (!deps.environmentReport) throw new HttpError(404, "not_found", "Environment status is unavailable.");
    await deps.environmentReport(auth.token, auth.bootId, report);
    return c.json({ sequence: report.sequence });
  });
  app.post(`${CLOUD_V2_WORKER_API}/setup`, async c => {
    if (!workerFeatures(c).has("setup-status-v1") || !deps.store.reportWorkerSetup)
      throw new HttpError(404, "not_found", "Setup status is unavailable.");
    const auth = await session(c, deps, true), report = await body(c, CloudV2SetupStatusSchema);
    const handoff = c.req.header("x-zeros-runtime-handoff");
    await deps.store.reportWorkerSetup(auth.token, auth.bootId, report,
      { accessEpoch: auth.workspace.accessEpoch, ...(handoff ? { handoff } : {}) });
    if (auth.workspace.recoveryAttemptId) await deps.recovery?.setup(auth.token, auth.bootId, auth.workspace.recoveryAttemptId, report);
    return c.body(null, 204);
  });
  app.post(`${CLOUD_V2_WORKER_API}/history`, async c => {
    const auth = await session(c, deps), input = await body(c, CloudV2WorkerHistorySchema);
    if (input.bootId !== auth.bootId) throw unauthorized();
    if (input.chatEditAcks !== undefined && !workerFeatures(c).has("chat-edit-v1"))
      throw new HttpError(400, "invalid_request", "Unsupported worker history fields");
    if (input.messages?.digest !== undefined && (!workerFeatures(c).has(HISTORY_DIGEST_FEATURE) || !workerFeatures(c).has("history-replace-v1")))
      throw new HttpError(400, "invalid_request", "Unsupported worker history fields");
    const { t: _t, bootId, sequence, ...history } = input;
    await deps.store.writeWorkerHistory(auth.token, bootId, sequence, history,
      workerFeatures(c).has(HISTORY_DIGEST_FEATURE) && workerFeatures(c).has("history-replace-v1"));
    return c.json({ sequence });
  });
  app.post(`${CLOUD_V2_WORKER_API}/history/digests`, async c => {
    if (!workerFeatures(c).has(HISTORY_DIGEST_FEATURE) || !workerFeatures(c).has("history-replace-v1") || !deps.store.workerHistoryDigests)
      throw new HttpError(404, "not_found", "History digests are unavailable");
    const bootId = c.req.header("x-zeros-worker-boot");
    if (!bootId || !z.string().uuid().safeParse(bootId).success) throw unauthorized();
    await body(c, z.object({}).strict());
    const reply = await deps.store.workerHistoryDigests(bearer(c), bootId);
    if (!reply) throw unauthorized();
    return c.json(reply);
  });
  app.post(`${CLOUD_V2_WORKER_API}/activity`, async c => {
    // Activity releases no source or credential. Its current worker/boot proof
    // still applies, but a GitHub outage must never turn a busy VM into idle.
    const auth = await session(c, deps), { idle } = await body(c, CloudV2WorkerActivitySchema);
    if (!idle) await deps.store.markActive(auth.workspace.id);
    const loginRevision = auth.workspace.executionMode === "active"
      ? await deps.execution?.deps.logins.refreshAvailability(auth.workspace.id) : null;
    return c.json({ loginRevision: loginRevision ?? auth.workspace.loginRevision, state: auth.workspace.state });
  });
  app.get(`${CLOUD_V2_WORKER_API}/config`, async c => {
    const auth = await session(c, deps, true);
    return c.json({ config: await configuration(deps, auth.workspace, auth.token, auth.bootId, workerFeatures(c), "continuation", c.req.header("x-zeros-runtime-handoff")) });
  });
  app.post(`${CLOUD_V2_WORKER_API}/mcp/:id/authorization`, async c => {
    const auth = await session(c, deps), input = await body(c, z.object({ force: z.boolean().optional(), contextId: z.uuid().optional() }).strict());
    const id = z.string().uuid().safeParse(c.req.param("id"));
    if (auth.workspace.executionMode === "active") {
      if (!id.success) throw new HttpError(400, "invalid_request", "Invalid MCP server");
      return c.json(await deps.execution!.mcpAuthorization(auth, input.contextId, id.data, input.force ?? false));
    }
    assertLegacyMaterial(auth.workspace);
    if (!id.success || !deps.mcpAuthorization) throw new HttpError(404, "not_found", "MCP server not found");
    const result = await deps.mcpAuthorization(auth.workspace, id.data, input.force ?? false);
    if (!sameMaterialAuthority(auth.workspace, await deps.store.workerSession(auth.token, auth.bootId))) throw unauthorized();
    return c.json(result);
  });
  app.post(`${CLOUD_V2_WORKER_API}/github-token`, async c => {
    const auth = await session(c, deps);
    const input = await body(c, z.object({ purpose: z.enum(["git", "gh"]).optional(), failedTokenSha256: z.string().length(64).regex(/^[a-f0-9]{64}$/).optional(), contextId: z.uuid().optional() }).strict());
    assertLegacyMaterial(auth.workspace);
    let granted: { token: string; expiresAt: number };
    try {
      if (auth.workspace.executionMode === "active") return c.json(await deps.execution!.githubToken(auth, input.contextId, input.purpose ?? "git", input.failedTokenSha256));
      if (auth.workspace.state !== "stopping") {
        if (deps.continueSource) await deps.continueSource(auth.workspace, auth.workspace);
        else await deps.authorizeSource?.(auth.workspace);
      }
      granted = await deps.githubToken(auth.workspace, input.purpose ?? "git", ...(input.failedTokenSha256 ? [input.failedTokenSha256] : []));
    } catch (error) {
      const failure = cloudGithubFailure(error);
      if (auth.workspace.executionMode === "active" && failure.kind !== "http") throw error;
      deps.logger?.warn("[cloud-v2] GitHub credential unavailable", failure);
      return c.json({ error: { code: "github_token_unavailable", reason: failure.reason } }, 409);
    }
    if (!sameMaterialAuthority(auth.workspace, await deps.store.workerSession(auth.token, auth.bootId))) throw unauthorized();
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
      let auth = await session(c, deps);
      const { waitMs, held } = await body(c, CloudV2PromptPullSchema);
      const features = workerFeatures(c);
      if (waitMs > CLOUD_V2_PROMPT_POLL_MS && !features.has("push-signals-v1"))
        throw new HttpError(400, "invalid_request", "Longer delivery polls require push signal support");
      const forWorker = async (batch: CloudV2PromptPullReply): Promise<CloudV2PromptPullReply> => {
        if (!features.has("chat-edit-v1")) { const { chatEdits: _edits, ...legacy } = batch; batch = legacy; }
        if (!features.has("session-name-v1")) batch = { ...batch, prompts: batch.prompts.map(({ sessionName: _name, ...item }) => item) };
        if (features.has("agent-interactions-v1")) return batch;
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
      const pull = async (mode: "new" | "due"): Promise<CloudV2PromptPullReply> => {
        if (auth.workspace.recoveryAttemptId && deps.recovery) {
          const state = await deps.recovery.pull(auth.token, auth.bootId, auth.workspace.recoveryAttemptId);
          if (state.hold) return { prompts: [], stops: [],
            ...(state.hint && features.has(CLOUD_RECOVERY_QUIESCE_FEATURE) ? { recovery: state.hint } : {}) };
        }
        return features.has("chat-edit-v1") ? outbox.pull(auth.token, auth.bootId, held, { chatEdits: mode }) : outbox.pull(auth.token, auth.bootId, held);
      };
      const reply = async (batch: CloudV2PromptPullReply) => {
        const value = await forWorker(batch);
        if (auth.workspace.boatSandboxId) void deps.outboundProof?.({ workspaceId: auth.workspace.id, bootId: auth.bootId,
          sandboxId: auth.workspace.boatSandboxId, accessEpoch: auth.workspace.accessEpoch }).catch(() => {});
        return c.json(value);
      };
      try {
        const first = await pull(waiter ? "new" : "due");
        if (!waiter || first.prompts.length || first.stops.length || first.chatEdits?.length || first.recovery) return await reply(first);
        await waiter.wait;
        if (c.req.raw.signal.aborted) throw new HttpError(503, "request_cancelled", "Delivery poll ended");
        auth = await session(c, deps);
        return await reply(await pull("due"));
      } finally { waiter?.dispose(); }
    });
    app.post(`${CLOUD_V2_WORKER_API}/prompts/ack`, async c => {
      const auth = await session(c, deps);
      return c.json(await outbox.ack(auth.token, auth.bootId, await body(c, CloudV2PromptAckSchema)));
    });
    app.post(`${CLOUD_V2_WORKER_API}/prompts/begin`, async c => {
      const auth = await session(c, deps);
      const input = await body(c, CloudV2PromptBeginSchema);
      if (auth.workspace.executionMode === "active") return c.json(await deps.execution!.begin(auth, input));
      return c.json(await outbox.begin(auth.token, auth.bootId, input));
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
