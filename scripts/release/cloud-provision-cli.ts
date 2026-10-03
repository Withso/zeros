import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CHANNELS, ReleaseIdentity, releaseSource, type PromotionConfig } from "./contracts";
import { CLOUD_WORKER_VARIABLES, cloudProvisionSummary, planCloudProvision } from "./cloud-provision";
import { assertNotOlderBranch, createProviders } from "./providers";
import { jsonClient } from "./io";

class CloudProvisionFailure extends Error {
  constructor(names: string[]) { super([...new Set(names)].sort().map(name => `${name} fail`).join("\n")); }
}
const reject = (...names: string[]): never => { throw new CloudProvisionFailure(names); };

export function cloudProvisionConfig(env: NodeJS.ProcessEnv) {
  const mode = env.CLOUD_PROVISION_MODE ?? "plan";
  if (mode !== "plan" && mode !== "apply") reject("CLOUD_PROVISION_MODE");
  if (env.RELEASE_CHANNEL === "alpha" && mode === "apply") reject("RELEASE_CHANNEL");
  let source;
  try { source = releaseSource(env); } catch { return reject("RELEASE_CHANNEL", "RELEASE_SHA", "RELEASE_BRANCH", "GITHUB_REPOSITORY"); }
  if (![undefined, "", "true", "false"].includes(env.CLOUD_PROVISION_ENABLE_CLOUD)) reject("CLOUD_PROVISION_ENABLE_CLOUD");
  // With worker promotion off, the worker lane cannot select or qualify an
  // image, so cloud is enabled on a selected tuple without native qualification.
  const qualificationRequired = env.ZEROS_WORKER_PROMOTION === "enabled";
  if (![undefined, "", "true", "false"].includes(env.CLOUD_PROVISION_ADOPT_BASE_WORKER)) reject("CLOUD_PROVISION_ADOPT_BASE_WORKER");
  const adoptBaseWorker = env.CLOUD_PROVISION_ADOPT_BASE_WORKER === "true";
  if (adoptBaseWorker && qualificationRequired) reject("CLOUD_PROVISION_ADOPT_BASE_WORKER");
  if (adoptBaseWorker && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(env.BOAT_BASE_SNAPSHOT ?? "")) reject("BOAT_BASE_SNAPSHOT");
  if (env.PLANETSCALE_DATABASE !== `zeros-control-plane-${source.channel}`) reject("PLANETSCALE_DATABASE");
  for (const name of ["RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID"]) {
    if (!z.string().uuid().safeParse(env[name]).success) reject(name);
  }
  if (!env.RAILWAY_DEPLOY_TOKEN?.trim()) reject("RAILWAY_DEPLOY_TOKEN");
  if (mode === "apply") {
    if (env.CLOUD_PROVISION_CONFIRM !== env.PLANETSCALE_DATABASE) reject("CLOUD_PROVISION_CONFIRM");
    if (env.GITHUB_ACTIONS !== "true" || env.CI !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_HEAD_REF) reject("GITHUB_EVENT_NAME");
  }
  const config: PromotionConfig = { ...source, ...CHANNELS[source.channel], cloudRequired: false, requireQualifiedWorker: false, provider: "boat",
    runId: env.GITHUB_RUN_ID ?? "", runAttempt: env.GITHUB_RUN_ATTEMPT ?? "",
    projectId: env.RAILWAY_PROJECT_ID!, environmentId: env.RAILWAY_ENVIRONMENT_ID!, serviceId: env.RAILWAY_SERVICE_ID!,
    organization: "", database: env.PLANETSCALE_DATABASE!, databaseBranch: "main", accountId: "", surfaces: [] };
  return { config, mode, enableCloud: env.CLOUD_PROVISION_ENABLE_CLOUD === "true", qualificationRequired,
    baseSnapshot: adoptBaseWorker ? env.BOAT_BASE_SNAPSHOT! : null };
}

/** The shared base image Alpha currently serves, when it is this channel's
 * configured base (one Boat account). Public identity only; no credentials. */
async function servedBaseWorker(baseSnapshot: string, options: { fetch?: typeof fetch; pause?: (ms: number) => Promise<void> }) {
  let value: unknown;
  try { value = await jsonClient(options.fetch, options.pause)(`${CHANNELS.alpha.api}/v1/release-identity`, { headers: { "Cache-Control": "no-store" } }); }
  catch { return reject("ADOPT_BASE_WORKER"); }
  const served = ReleaseIdentity.safeParse(value), worker = served.success ? served.data.worker : null;
  if (!served.success || served.data.channel !== "alpha" || !served.data.cloud.enabled || served.data.cloud.state !== "healthy" ||
    worker?.provider !== "boat") return reject("ADOPT_BASE_WORKER");
  if (/^boat:([a-z0-9][a-z0-9-]{0,62})@/.exec(worker.imageRef)?.[1] !== baseSnapshot) return reject("BOAT_BASE_SNAPSHOT");
  return worker;
}

function randomKeyring(): string {
  const bytes = randomBytes(32);
  try { return JSON.stringify({ "1": bytes.toString("base64url") }); } finally { bytes.fill(0); }
}

export async function cloudProvisionMain(env: NodeJS.ProcessEnv, options: {
  fetch?: typeof fetch; log?: (line: string) => void; createKeyring?: () => string; pause?: (ms: number) => Promise<void>;
} = {}): Promise<{ mode: string; changed: boolean }> {
  const log = options.log ?? console.log;
  try {
    const { config, mode, enableCloud, qualificationRequired, baseSnapshot } = cloudProvisionConfig(env);
    const providers = createProviders(config, env, options);
    const target = { projectId: config.projectId, environmentId: config.environmentId, serviceId: config.serviceId };
    const read = async (): Promise<Record<string, string>> => {
      const data = await providers.railway(`query CloudProvisionRead($projectId:String!,$environmentId:String!,$serviceId:String!) {
        variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)
        environment(id:$environmentId) { id name projectId unmergedChangesCount config(decryptVariables:false) }
        serviceInstance(environmentId:$environmentId,serviceId:$serviceId) { serviceId environmentId domains { customDomains { domain } } }
        serviceInstanceAutoDeployStatus(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId) { enabled }
        environmentStagedChanges(environmentId:$environmentId) { patch }
      }`, target);
      const environment = data.environment, instance = data.serviceInstance, source = environment?.config?.services?.[config.serviceId]?.source;
      const staged = data.environmentStagedChanges?.patch;
      if (environment?.id !== config.environmentId || environment?.projectId !== config.projectId || environment?.name !== config.channel ||
        instance?.serviceId !== config.serviceId || instance?.environmentId !== config.environmentId ||
        source?.repo?.toLowerCase() !== config.repository.toLowerCase() || source?.rootDirectory !== "apps/control-plane" ||
        !(config.channel === "alpha" ? source?.branch === "main" : /^release\/\d+\.\d+\.\d+$/.test(source?.branch ?? "")) ||
        !instance?.domains?.customDomains?.some((domain: { domain: string }) => domain.domain === new URL(config.api).hostname)) reject("RAILWAY_TARGET");
      if (mode === "apply") {
        if (![0, null].includes(environment.unmergedChangesCount) || staged === null || typeof staged !== "object" ||
          Array.isArray(staged) || Object.keys(staged).length !== 0 || data.serviceInstanceAutoDeployStatus?.enabled !== false) reject("RAILWAY_TARGET");
        try { assertNotOlderBranch(config.branch, source.branch); } catch { reject("RELEASE_BRANCH"); }
      }
      const variables: unknown = data.variables;
      if (variables === null || typeof variables !== "object" || Array.isArray(variables) ||
        !Object.values(variables).every(value => typeof value === "string")) reject("RAILWAY_VARIABLES");
      return variables as Record<string, string>;
    };
    const current = await read();
    const readQualification = async (): Promise<unknown> => {
      if (CLOUD_WORKER_VARIABLES.some(name => !current[name]?.trim())) return undefined;
      try { return await jsonClient(options.fetch, options.pause)(`${config.api}/v1/release-identity`, { headers: { "Cache-Control": "no-store" } }); }
      catch { return undefined; }
    };
    let adoptWorker;
    if (baseSnapshot) {
      const selected = CLOUD_WORKER_VARIABLES.filter(name => Object.hasOwn(current, name));
      // A partial tuple is never completed or replaced; a complete one stays selected.
      if (selected.length > 0 && (selected.length < CLOUD_WORKER_VARIABLES.length || selected.some(name => !current[name]?.trim()))) reject("WORKER_TUPLE");
      if (selected.length === 0) adoptWorker = await servedBaseWorker(baseSnapshot, options);
    }
    const qualification = qualificationRequired ? await readQualification() : undefined;
    const plan = planCloudProvision({ channel: config.channel, current, inputs: env, enableCloud, qualification, adoptWorker, qualificationRequired });
    for (const line of cloudProvisionSummary(plan)) log(line);
    if (mode === "plan") return { mode, changed: false };
    const failures = [...plan.missingInputs, ...plan.validation.names, ...(enableCloud ? plan.enableGate.names : [])];
    if (failures.length) throw new CloudProvisionFailure(failures);
    const latest = await read();
    if (Object.keys(current).length !== Object.keys(latest).length || Object.entries(current).some(([name, value]) => latest[name] !== value)) reject("RAILWAY_VARIABLES");
    const generatedKeyrings = Object.fromEntries(plan.generate.map(name => [name, (options.createKeyring ?? randomKeyring)()]));
    const materialized = planCloudProvision({ channel: config.channel, current, inputs: env, enableCloud, generatedKeyrings,
      qualification: enableCloud && qualificationRequired ? await readQualification() : qualification, adoptWorker, qualificationRequired });
    if (!materialized.validation.ok) throw new CloudProvisionFailure(materialized.validation.names);
    if (enableCloud && !materialized.enableGate.ok) throw new CloudProvisionFailure(materialized.enableGate.names);
    // Only an explicit adoption into an entirely absent tuple may write it;
    // otherwise the worker lane owns these variables.
    const tupleChanges = CLOUD_WORKER_VARIABLES.filter(name => Object.hasOwn(materialized.changes, name));
    const adoptedTuple = !!adoptWorker && tupleChanges.length === CLOUD_WORKER_VARIABLES.length && tupleChanges.every(name => !Object.hasOwn(current, name));
    if (tupleChanges.length && !adoptedTuple || materialized.generate.some(name => !Object.hasOwn(materialized.changes, name))) reject("WORKER_TUPLE");
    const changed = Object.keys(materialized.changes).length > 0;
    if (changed) {
      await providers.railway(`mutation CloudProvisionApply($input:VariableCollectionUpsertInput!) { variableCollectionUpsert(input:$input) }`,
        { input: { ...target, variables: materialized.changes, replace: false, skipDeploys: true } }).catch(() => undefined);
    }
    let confirmed;
    try { confirmed = changed ? await read() : latest; } catch { return reject("RAILWAY_READBACK"); }
    const unconfirmed = Object.entries(materialized.desired).filter(([name, value]) => confirmed[name] !== value).map(([name]) => name);
    if (unconfirmed.length) throw new CloudProvisionFailure(unconfirmed);
    if (Object.entries(current).some(([name, value]) => !Object.hasOwn(materialized.changes, name) && confirmed[name] !== value)) reject("RAILWAY_VARIABLES");
    log(`RAILWAY_WRITE ${changed ? "pass" : "unchanged"}`);
    return { mode, changed };
  } catch (error) {
    if (error instanceof CloudProvisionFailure) throw error;
    return reject("PROVISION");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void cloudProvisionMain(process.env).catch(error => {
  console.error(error instanceof CloudProvisionFailure ? error.message : "PROVISION fail");
  process.exitCode = 1;
});
