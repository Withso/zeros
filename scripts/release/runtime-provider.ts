import { z } from "zod";
import { RuntimeReleaseSchema } from "../../apps/control-plane/src/cloud/runtime-release";
import type { CloudV2RuntimeStore } from "../../apps/control-plane/src/cloud/runtime";
import { validateDatabaseConnections } from "../../apps/control-plane/src/database-config";
import { parseDatabaseTarget } from "../../apps/control-plane/src/database-target";
import { DIGEST, requireCheck } from "./contracts";
import { jsonClient, poll, sleep } from "./io";
import { RuntimeLiveIdentity, assertRuntimeLive, runtimeOrigin, type RuntimeReleaseConfig, type RuntimePin } from "./runtime-contracts";
import { assertEmptyRuntimeDrain, type RuntimeDrainLease, type RuntimeDrainStatus } from "./runtime-release";
import { assertRuntimeDrainBudget, assertRuntimeDrainRecovery, boundRuntimeDrainLease, RUNTIME_STAGE_BUDGET_MS, RUNTIME_READINESS_BUDGET_MS, RUNTIME_CLEANUP_BUDGET_MS } from "./runtime-drain";
import { runtimeJson } from "./runtime-proof";
import { RuntimeProviderIntentSchema, type RuntimeProviderIntent, type RuntimeProviderRecovery } from "./runtime-journal";
import { requireCurrentAlphaRuntime } from "./runtime-alpha";
import { identityPin } from "./runtime-identity";

const deploymentSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), status: z.string(),
  projectId: z.string().uuid(), environmentId: z.string().uuid(), serviceId: z.string().uuid(),
  meta: z.object({ commitHash: z.string().optional(), branch: z.string().optional() }).nullable(),
});
type Deployment = z.infer<typeof deploymentSchema>;
const stopped = new Set(["REMOVED", "FAILED", "SKIPPED", "CANCELED"]);

function variablePin(variables: Record<string, unknown>, previous = false): RuntimePin | null {
  const sha256 = variables[previous ? "CLOUD_V2_RUNTIME_PREVIOUS_SHA256" : "CLOUD_V2_RUNTIME_SHA256"];
  const raw = variables[previous ? "CLOUD_V2_RUNTIME_PREVIOUS_RELEASE_METADATA" : "CLOUD_V2_RUNTIME_RELEASE_METADATA"];
  if (previous && !sha256 && !raw) return null;
  requireCheck(typeof sha256 === "string" && DIGEST.test(sha256), "Runtime configuration has no valid digest");
  let release: RuntimePin["release"] = null;
  if (raw) {
    requireCheck(typeof raw === "string" && raw.length <= 4096, "Runtime metadata is invalid");
    try { release = RuntimeReleaseSchema.parse(JSON.parse(raw)); }
    catch { requireCheck(false, "Runtime metadata is invalid"); }
    requireCheck(release.sha256 === sha256, "Runtime metadata does not belong to its pin");
  }
  return { sha256, release };
}

export function runtimeProvider(config: RuntimeReleaseConfig, env: NodeJS.ProcessEnv, storage: CloudV2RuntimeStore, options: {
  fetch?: typeof fetch; cleanupFetch?: typeof fetch; pause?: typeof sleep; signal?: AbortSignal;
  recovery?: RuntimeProviderRecovery;
  inspectDrain(lease: RuntimeDrainLease): Promise<RuntimeDrainStatus>;
  record(intent: RuntimeProviderIntent): Promise<void>;
}) {
  const targetSchema = z.object({ projectId: z.string().uuid(), environmentId: z.string().uuid(), serviceId: z.string().uuid() });
  const parsed = targetSchema.safeParse({ projectId: env.RAILWAY_PROJECT_ID, environmentId: env.RAILWAY_ENVIRONMENT_ID, serviceId: env.RAILWAY_SERVICE_ID });
  requireCheck(parsed.success && env.RAILWAY_DEPLOY_TOKEN?.trim(), "Railway runtime release target is invalid");
  let readinessDeadline: number | undefined;
  const boundedFetch: typeof fetch = (url, init) => {
    requireCheck(readinessDeadline === undefined || Date.now() < readinessDeadline, "Runtime readiness budget was exhausted");
    return (options.fetch ?? fetch)(url, { ...init, ...(readinessDeadline === undefined ? {} : {
      signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, readinessDeadline - Date.now())), ...(init?.signal ? [init.signal] : [])]),
    }) });
  };
  let cleanupDeadline: number | undefined;
  const cleanupFetch: typeof fetch = (url, init) => {
    requireCheck(cleanupDeadline === undefined || Date.now() < cleanupDeadline, "Runtime cleanup budget was exhausted");
    return (options.cleanupFetch ?? options.fetch ?? fetch)(url, { ...init, ...(cleanupDeadline === undefined ? {} : {
      signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, cleanupDeadline - Date.now())), ...(init?.signal ? [init.signal] : [])]),
    }) });
  };
  const target = parsed.data, json = jsonClient(boundedFetch, options.pause), cleanupJson = jsonClient(cleanupFetch, options.pause), origin = runtimeOrigin(config.channel);
  let stagedTarget: RuntimePin | undefined, stagedPrevious: RuntimePin | undefined, deployAttempted = false, oldDeployment: string | undefined;
  let stageDispatched = false, deployDispatched = false, deploymentId: string | undefined, deploymentDeadline: number | undefined;
  let observedPrevious: RuntimePin | null | undefined;
  let recoveryLease: RuntimeDrainLease | undefined;
  if (options.recovery) {
    const stage = RuntimeProviderIntentSchema.parse(options.recovery.stage), deploy = options.recovery.deploy && RuntimeProviderIntentSchema.parse(options.recovery.deploy);
    requireCheck(stage.kind === "stage" && stage.previous.sha256 === config.expectedRuntimeSha256 && stage.next.release,
      "Runtime cleanup has no owned staged intent");
    recoveryLease = boundRuntimeDrainLease(config, stage.lease);
    stagedTarget = stage.next; stagedPrevious = stage.previous; observedPrevious = stage.retainedPrevious; oldDeployment = stage.servingDeploymentId; stageDispatched = true;
    if (deploy) {
      requireCheck(deploy.kind === "deploy" && deploy.cpSha === config.expectedCpSha && runtimeJson(deploy.next) === runtimeJson(stage.next) &&
        runtimeJson(deploy.lease) === runtimeJson(stage.lease) && (deploy.phase === "requested" ? deploy.deploymentId === null : deploy.deploymentId !== null),
        "Runtime cleanup deployment differs from its staged intent");
      deployDispatched = true; deploymentId = deploy.deploymentId ?? undefined;
    }
  }
  const railway = async (query: string, variables: unknown, cleanup = false) => {
    const result = await (cleanup ? cleanupJson : json)("https://backboard.railway.com/graphql/v2", { method: "POST",
      headers: { "Project-Access-Token": env.RAILWAY_DEPLOY_TOKEN!, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) }, query.startsWith("query"));
    requireCheck(!result.errors && result.data, "Railway rejected the runtime operation; details withheld");
    return result.data;
  };
  async function inspect(cleanup = false) {
    const data = await railway(`query RuntimeState($projectId:String!,$environmentId:String!,$serviceId:String!) {
      serviceInstanceAutoDeployStatus(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId) { enabled }
      environment(id:$environmentId) { id name projectId unmergedChangesCount config(decryptVariables:false) }
      serviceInstance(environmentId:$environmentId,serviceId:$serviceId) { serviceId environmentId domains { customDomains { domain } } }
      environmentStagedChanges(environmentId:$environmentId) { id patch }
      variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)
    }`, target, cleanup);
    const environment = data.environment, instance = data.serviceInstance, patch = data.environmentStagedChanges?.patch;
    requireCheck(data.serviceInstanceAutoDeployStatus?.enabled === false, "Independent Railway autodeploy must be disabled before runtime releases");
    requireCheck(environment?.id === target.environmentId && environment.projectId === target.projectId && environment.name === config.channel &&
      [0, null].includes(environment.unmergedChangesCount) && patch && typeof patch === "object" && !Array.isArray(patch) && Object.keys(patch).length === 0 &&
      instance?.serviceId === target.serviceId && instance.environmentId === target.environmentId, "Railway runtime target differs or has staged changes");
    const source = environment.config?.services?.[target.serviceId]?.source;
    requireCheck(source?.repo === config.repository && source.branch === config.branch && source.rootDirectory === "apps/control-plane" && source.checkSuites !== true,
      "Railway runtime release must retain the exact repository, branch and control-plane root");
    requireCheck(instance.domains?.customDomains?.some((row: { domain: string }) => row.domain === new URL(origin).hostname), "Railway runtime release domain differs");
    const variables = data.variables;
    requireCheck(variables && typeof variables === "object" && !Array.isArray(variables), "Railway variables are unavailable");
    for (const [name, expected] of Object.entries({ ENDPOINT: storage.endpoint, BUCKET: storage.bucket, ACCESS_KEY_ID: storage.accessKeyId, SECRET_ACCESS_KEY: storage.secretAccessKey })) {
      requireCheck(variables[`CLOUD_V2_RUNTIME_STORE_${name}`] === expected, "Runtime publication store differs from the live channel configuration");
    }
    return { variables, branch: source.branch as string };
  }
  async function inventory(cleanup = false): Promise<Deployment[]> {
    const rows: Deployment[] = []; let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const data = await railway(`query RuntimeDeployments($projectId:String!,$environmentId:String!,$serviceId:String!,$after:String) {
        deployments(first:100,after:$after,input:{projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId}) {
          edges { node { id status projectId environmentId serviceId meta } } pageInfo { hasNextPage endCursor }
        }
      }`, { ...target, after }, cleanup);
      const connection = data.deployments;
      const checked = z.array(z.object({ node: deploymentSchema })).safeParse(connection?.edges);
      requireCheck(checked.success && checked.data.length <= 100 && typeof connection.pageInfo?.hasNextPage === "boolean", "Railway runtime deployment inventory is unavailable");
      for (const { node } of checked.data) {
        requireCheck(node.projectId === target.projectId && node.environmentId === target.environmentId && node.serviceId === target.serviceId && !rows.some(row => row.id === node.id),
          "Railway runtime deployment inventory has foreign or repeated entries");
        rows.push(node);
      }
      if (!connection.pageInfo.hasNextPage) return rows;
      requireCheck(typeof connection.pageInfo.endCursor === "string" && connection.pageInfo.endCursor !== after, "Railway runtime deployment inventory cannot be paged");
      after = connection.pageInfo.endCursor;
    }
    requireCheck(false, "Railway runtime deployment inventory exceeds its bound");
  }
  function exactSource(deployment: Deployment) {
    requireCheck(deployment.meta?.commitHash === config.expectedCpSha && deployment.meta.branch === config.branch, "Railway deployed a different control-plane source");
  }
  async function readinessIdentity(): Promise<unknown | null> {
    let response: Response;
    try {
      response = await boundedFetch(`${origin}/v1/release-identity`, {
        redirect: "error", signal: AbortSignal.timeout(30_000),
      });
    } catch { return null; }
    if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
      await response.body?.cancel(); return null;
    }
    requireCheck(response.ok, "Runtime readiness request was refused; details withheld");
    try {
      const text = await response.text();
      requireCheck(text.length <= 2 * 1024 * 1024, "Runtime readiness exceeds its bound");
      return JSON.parse(text);
    } catch { requireCheck(false, "Runtime readiness is invalid; details withheld"); }
  }
  async function current(staged?: RuntimePin, cleanup = false) {
    const state = await inspect(cleanup), raw = await (cleanup ? cleanupJson : json)(`${origin}/v1/release-identity`), pin = identityPin(raw);
    const previous = variablePin(state.variables, true), configured = variablePin(state.variables)!;
    requireCheck(runtimeJson(configured) === runtimeJson(staged ?? pin) && (!staged || runtimeJson(previous) === runtimeJson(pin)), "Runtime staged pin or previous-pin readback differs");
    if (!staged && observedPrevious !== undefined) {
      requireCheck(runtimeJson(previous) === runtimeJson(observedPrevious), "Runtime previous pin changed during release");
    }
    const live = { identity: RuntimeLiveIdentity.parse(raw), branch: state.branch, current: pin, previous };
    assertRuntimeLive(config, live);
    const active = (await inventory(cleanup)).filter(row => !stopped.has(row.status));
    requireCheck(active.length === 1 && active[0].status === "SUCCESS", "A competing or unresolved deployment blocks runtime release");
    exactSource(active[0]);
    requireCheck(!oldDeployment || oldDeployment === active[0].id, "Serving control-plane deployment changed during runtime release");
    oldDeployment = active[0].id;
    if (!staged) observedPrevious = previous;
    return live;
  }
  return {
    current,
    async verifyDatabaseRoute(url: string) {
      try {
        const { variables } = await inspect(), runtime = variables.DATABASE_URL;
        requireCheck(typeof runtime === "string" && parseDatabaseTarget(runtime).hostname.endsWith(".pg.psdb.cloud") &&
          parseDatabaseTarget(url).hostname.endsWith(".pg.psdb.cloud"), "invalid route");
        validateDatabaseConnections({ DATABASE_URL: runtime, DATABASE_MIGRATION_URL: url, DATABASE_POOL_MAX: 2 });
      } catch { requireCheck(false, "Runtime database route differs from the serving channel; details withheld"); }
    },
    async stage(next: RuntimePin, previous: RuntimePin, lease: RuntimeDrainLease) {
      requireCheck(!options.recovery, "Runtime cleanup cannot stage a new pin");
      requireCheck(!stagedTarget && !deployAttempted, "A runtime stage was already attempted; reconcile before retrying");
      const checked = RuntimeReleaseSchema.safeParse(next.release);
      requireCheck(checked.success && checked.data.sha256 === next.sha256, "A runtime pin requires matching qualification");
      stagedTarget = next; stagedPrevious = previous;
      await current();
      await options.record({ kind: "stage", phase: "requested", previous, retainedPrevious: observedPrevious!, next, lease, servingDeploymentId: oldDeployment! });
      // The empty lease fences new work while serving ownership is refreshed after the drain wait.
      const drain = await options.inspectDrain(lease);
      assertEmptyRuntimeDrain(config, lease, drain);
      if (config.action === "promote") await requireCurrentAlphaRuntime(next.sha256, boundedFetch);
      requireCheck(runtimeJson((await current()).current) === runtimeJson(previous), "Previous runtime changed before staging");
      assertRuntimeDrainBudget(config, lease, drain, RUNTIME_STAGE_BUDGET_MS);
      requireCheck(!options.signal?.aborted, "Runtime staging was cancelled");
      stageDispatched = true;
      const result = await railway(`mutation RuntimeStage($input:VariableCollectionUpsertInput!) { variableCollectionUpsert(input:$input) }`, {
        input: { ...target, replace: false, skipDeploys: true, variables: {
          CLOUD_V2_RUNTIME_SHA256: next.sha256, CLOUD_V2_RUNTIME_RELEASE_METADATA: JSON.stringify(checked.data),
          CLOUD_V2_RUNTIME_PREVIOUS_SHA256: previous.sha256, CLOUD_V2_RUNTIME_PREVIOUS_RELEASE_METADATA: previous.release ? JSON.stringify(previous.release) : "",
        } },
      });
      requireCheck(result.variableCollectionUpsert === true, "Runtime pin staging is unconfirmed");
      await current(next);
      await options.record({ kind: "stage", phase: "confirmed", previous, retainedPrevious: observedPrevious!, next, lease, servingDeploymentId: oldDeployment! });
    },
    async deploy(cpSha: string, lease: RuntimeDrainLease) {
      requireCheck(!options.recovery, "Runtime cleanup cannot initiate deployment");
      requireCheck(stagedTarget && !deployAttempted && cpSha === config.expectedCpSha, "Runtime deploy lacks one exact staged intent");
      deployAttempted = true;
      await options.record({ kind: "deploy", phase: "requested", cpSha, next: stagedTarget, lease, deploymentId: null });
      const drain = await options.inspectDrain(lease);
      assertEmptyRuntimeDrain(config, lease, drain);
      if (config.action === "promote") await requireCurrentAlphaRuntime(stagedTarget.sha256, boundedFetch);
      await current(stagedTarget);
      assertRuntimeDrainBudget(config, lease, drain, RUNTIME_READINESS_BUDGET_MS + RUNTIME_CLEANUP_BUDGET_MS);
      requireCheck(!options.signal?.aborted, "Runtime deployment was cancelled");
      deploymentDeadline = Math.min(Date.now() + RUNTIME_READINESS_BUDGET_MS, Date.parse(lease.expiresAt) - RUNTIME_CLEANUP_BUDGET_MS);
      deployDispatched = true;
      const result = await railway(`mutation RuntimeDeploy($environmentId:String!,$serviceId:String!,$commitSha:String!) {
        serviceInstanceDeployV2(commitSha:$commitSha,environmentId:$environmentId,serviceId:$serviceId)
      }`, { environmentId: target.environmentId, serviceId: target.serviceId, commitSha: cpSha });
      requireCheck(typeof result.serviceInstanceDeployV2 === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(result.serviceInstanceDeployV2), "Runtime deployment acknowledgement is unconfirmed");
      deploymentId = result.serviceInstanceDeployV2;
      await options.record({ kind: "deploy", phase: "confirmed", cpSha, next: stagedTarget, lease, deploymentId: result.serviceInstanceDeployV2 });
      return result.serviceInstanceDeployV2 as string;
    },
    async wait(id: string, next: RuntimePin, lease: RuntimeDrainLease) {
      requireCheck(deployDispatched && deploymentDeadline && deploymentId === id && stagedTarget && runtimeJson(stagedTarget) === runtimeJson(next) && id !== oldDeployment, "Runtime readiness does not belong to the deployment intent");
      readinessDeadline = deploymentDeadline;
      try { await poll(async () => {
        assertEmptyRuntimeDrain(config, lease, await options.inspectDrain(lease));
        const state = await inspect(), rows = await inventory(), targetDeployment = rows.find(row => row.id === id);
        requireCheck(targetDeployment && !stopped.has(targetDeployment.status) && targetDeployment.status !== "CRASHED", "Runtime deployment failed; reconcile the staged pin before retrying");
        exactSource(targetDeployment);
        requireCheck(rows.every(row => row.id === id || row.id === oldDeployment || stopped.has(row.status)), "A competing deployment appeared during runtime readiness");
        requireCheck(runtimeJson(variablePin(state.variables)) === runtimeJson(next), "Runtime pin changed during deployed readiness");
        requireCheck(stagedPrevious && runtimeJson(variablePin(state.variables, true)) === runtimeJson(stagedPrevious), "Previous runtime pin changed during deployed readiness");
        if (targetDeployment.status !== "SUCCESS" || rows.some(row => row.id === oldDeployment && !stopped.has(row.status))) return false;
        const raw = await readinessIdentity();
        if (raw === null) return false;
        const pin = identityPin(raw);
        if (pin.sha256 === config.expectedRuntimeSha256) return false;
        const identity = RuntimeLiveIdentity.parse(raw);
        requireCheck(runtimeJson(pin) === runtimeJson(next) && identity.sourceSha === config.expectedCpSha && identity.channel === config.channel, "Deployed runtime identity differs from the release intent");
        assertEmptyRuntimeDrain(config, lease, await options.inspectDrain(lease));
        requireCheck(Date.now() < readinessDeadline!, "Runtime readiness budget was exhausted");
        return true;
      }, { sleep: options.pause, attempts: 48, timeoutMs: Math.max(0, readinessDeadline - Date.now()) }); }
      finally { readinessDeadline = undefined; }
      await options.record({ kind: "deploy", phase: "ready", cpSha: config.expectedCpSha, next, lease, deploymentId: id });
    },
    async recover(lease: RuntimeDrainLease): Promise<{ releaseDrain: boolean }> {
      if (recoveryLease) requireCheck(runtimeJson(boundRuntimeDrainLease(config, lease)) === runtimeJson(recoveryLease), "Runtime cleanup lease changed");
      if (!stageDispatched) return { releaseDrain: true };
      requireCheck(stagedTarget && observedPrevious !== undefined, "Runtime recovery has no owned staging record");
      cleanupDeadline = Math.min(Date.now() + RUNTIME_CLEANUP_BUDGET_MS, Date.parse(lease.expiresAt));
      try {
      if (deployDispatched) {
        if (!deploymentId) return { releaseDrain: false };
        const rows = await inventory(true), targetDeployment = rows.find(row => row.id === deploymentId);
        if (!targetDeployment) return { releaseDrain: false };
        exactSource(targetDeployment);
        if (targetDeployment.status === "SUCCESS" && rows.every(row => row.id === deploymentId || stopped.has(row.status))) {
          const state = await inspect(true), raw = await cleanupJson(`${origin}/v1/release-identity`), pin = identityPin(raw);
          const identity = RuntimeLiveIdentity.parse(raw);
          requireCheck(runtimeJson(variablePin(state.variables)) === runtimeJson(stagedTarget) && runtimeJson(variablePin(state.variables, true)) === runtimeJson(stagedPrevious) && runtimeJson(pin) === runtimeJson(stagedTarget) &&
            identity.sourceSha === config.expectedCpSha && identity.channel === config.channel, "Runtime recovery observed another serving release");
          return { releaseDrain: true };
        }
        if (!stopped.has(targetDeployment.status)) return { releaseDrain: false };
      }
      let previous: RuntimePin;
      try { previous = (await current(stagedTarget, true)).current; }
      catch { await current(undefined, true); return { releaseDrain: true }; }
      await options.record({ kind: "restore", phase: "requested", previous, retainedPrevious: observedPrevious, next: stagedTarget, lease, servingDeploymentId: oldDeployment! });
      const drain = await options.inspectDrain(lease);
      assertRuntimeDrainRecovery(config, lease, drain);
      await current(stagedTarget, true);
      assertRuntimeDrainRecovery(config, lease, drain);
      const result = await railway(`mutation RuntimeRestore($input:VariableCollectionUpsertInput!) { variableCollectionUpsert(input:$input) }`, {
        input: { ...target, replace: false, skipDeploys: true, variables: {
          CLOUD_V2_RUNTIME_SHA256: previous.sha256, CLOUD_V2_RUNTIME_RELEASE_METADATA: previous.release ? JSON.stringify(previous.release) : "",
          CLOUD_V2_RUNTIME_PREVIOUS_SHA256: observedPrevious?.sha256 ?? "",
          CLOUD_V2_RUNTIME_PREVIOUS_RELEASE_METADATA: observedPrevious?.release ? JSON.stringify(observedPrevious.release) : "",
        } },
      }, true);
      requireCheck(result.variableCollectionUpsert === true, "Runtime staged-pin restoration is unconfirmed");
      await current(undefined, true);
      await options.record({ kind: "restore", phase: "confirmed", previous, retainedPrevious: observedPrevious, next: stagedTarget, lease, servingDeploymentId: oldDeployment! });
      return { releaseDrain: true };
      } finally { cleanupDeadline = undefined; }
    },
  };
}
