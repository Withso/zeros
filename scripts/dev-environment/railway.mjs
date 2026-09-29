import fs from "node:fs";
import { sha256 } from "./state.mjs";
import { hostedName } from "./hosted-state.mjs";
import { DevProviderError, providerJson, pollProvider, dispatchDevCreate, devCreateNotDispatched, acknowledgeDevCreate } from "./provider-http.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const API = "https://backboard.railway.com";
const ENVIRONMENTS = `query DevEnvironments($projectId: String!, $after: String) {
  environments(projectId: $projectId, first: 100, after: $after) {
    edges { node { id name projectId createdAt } } pageInfo { hasNextPage endCursor }
  }
}`;

export function railwayEnvironmentName(state) {
  // Railway rejects the 61-character PlanetScale name. Keep a compact label;
  // the encrypted receipt still binds the full owner and generation UUID.
  hostedName(state);
  return `dev-${state.owner.slice(0, 12)}-${sha256(state.generation).slice(0, 14)}`;
}

export function isRailwayOwnerName(name, state) {
  hostedName(state);
  return typeof name === "string" && (name.startsWith(`dev-${state.owner}-`) || name.startsWith(`dev-${state.owner.slice(0, 12)}-`));
}

export function railwayDevClient(config, fetchImpl = fetch) {
  if (!UUID.test(config?.projectId ?? "") || !UUID.test(config.serviceId ?? "") ||
      !Array.isArray(config.protectedEnvironmentIds) || !config.protectedEnvironmentIds.length ||
      config.protectedEnvironmentIds.some(id => !UUID.test(id)) || !config.apiToken) {
    throw new Error("Configure Railway project/service IDs, protected Alpha environment ID and a workspace API token");
  }
  return async (query, variables = {}, signal) => {
    const response = await providerJson("Railway", `${API}/graphql/v2`, { method: "POST", signal,
      headers: { authorization: `Bearer ${config.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }, fetchImpl);
    if (response.status !== 200 || response.body?.errors?.length || !response.body?.data) throw new DevProviderError("Railway", response.status === 200 ? "GraphQL rejected the operation" : response.status, response.requestId);
    return response.body.data;
  };
}

export async function listRailwayEnvironments(config, request) {
  const result = []; let after;
  for (let page = 0; page < 100; page++) {
    const data = (await request(ENVIRONMENTS, { projectId: config.projectId, ...(after ? { after } : {}) })).environments;
    if (!Array.isArray(data?.edges)) throw new Error("Invalid Railway environment inventory");
    result.push(...data.edges.map(edge => edge.node));
    if (data.pageInfo?.hasNextPage === false) return result;
    if (!data.pageInfo?.endCursor || data.pageInfo.endCursor === after) break;
    after = data.pageInfo.endCursor;
  }
  throw new Error("Railway environment inventory is incomplete; no absence was assumed");
}

function assertEnvironment(environment, receipt, state, config) {
  if (!environment || ![railwayEnvironmentName(state), hostedName(state)].includes(environment.name) || environment.name !== receipt.name ||
      !UUID.test(environment.id ?? "") || (receipt.id && receipt.id !== environment.id) ||
      environment.projectId !== config.projectId || receipt.projectId !== config.projectId || receipt.serviceId !== config.serviceId ||
      config.protectedEnvironmentIds.includes(environment.id) || /^(alpha|beta|production|main)$/i.test(environment.name)) {
    throw new Error("Railway environment is not this disposable Dev generation; no mutation was made");
  }
}

export async function inspectRailwayEnvironment(lease, config, request) {
  const receipt = lease.state.resources.railway;
  if (!receipt) return null;
  const all = await listRailwayEnvironments(config, request);
  const matches = all.filter(e => e.id === receipt.id || e.name === receipt.name);
  if (matches.length > 1) throw new Error("Ambiguous Railway Dev ownership");
  if (matches[0]) assertEnvironment(matches[0], receipt, lease.state, config);
  return matches[0] ?? null;
}

export async function ensureRailwayEnvironment(lease, config, request = railwayDevClient(config), { reconcileOnly = false } = {}) {
  if (!reconcileOnly && !["provisioning", "ready"].includes(lease.state.status)) throw new Error("Dev archive blocks Railway provisioning");
  let receipt = lease.state.resources.railway;
  if (!receipt || devCreateNotDispatched(receipt)) {
    if (reconcileOnly) return receipt;
    const environments = await listRailwayEnvironments(config, request);
    for (const id of config.protectedEnvironmentIds) {
      if (!environments.some(e => e.id === id)) throw new Error("The protected Railway environment is not visible in this project");
    }
    const name = railwayEnvironmentName(lease.state);
    if (environments.some(e => e.name === name)) throw new Error("Railway Dev name exists without its original ownership receipt");
    receipt = lease.state.resources.railway = { name, projectId: config.projectId, serviceId: config.serviceId,
      requestedAt: new Date().toISOString(), id: null };
    await lease.save(); await lease.fence();
    const data = await dispatchDevCreate(lease, receipt, "Railway", () => request(`mutation CreateDevEnvironment($input: EnvironmentCreateInput!) {
      environmentCreate(input: $input) { id name projectId createdAt }
    }`, { input: { projectId: config.projectId, name, ephemeral: false, skipInitialDeploys: true } }, lease.signal));
    assertEnvironment(data.environmentCreate, receipt, lease.state, config);
    receipt.id = data.environmentCreate.id; await lease.save();
  }
  const environment = await inspectRailwayEnvironment(lease, config, request);
  if (!environment) throw new Error("Railway Dev creation is unconfirmed; preserve its receipt and retry");
  if (!receipt.id) {
    const createdAt = Date.parse(environment.createdAt), requestedAt = Date.parse(receipt.requestedAt);
    if (!Number.isFinite(createdAt) || createdAt < requestedAt - 5000) throw new Error("Cannot prove the pending Railway creation belongs to this request");
    receipt.id = environment.id; await lease.save();
  }
  await acknowledgeDevCreate(lease, receipt);
  return receipt;
}

async function mutationFence(lease, config, request) {
  if (!await inspectRailwayEnvironment(lease, config, request)) throw new Error("The owned Railway Dev environment no longer exists");
  await lease.fence();
  return { environmentId: lease.state.resources.railway.id, serviceId: config.serviceId };
}

export async function configureRailwayBackend(lease, config, variables, request = railwayDevClient(config)) {
  const target = await mutationFence(lease, config, request);
  if (lease.state.status === "archiving") throw new Error("Cannot deploy while Dev archive is in progress");
  const hasInstance = async () => {
    const data = await request(`query DevServiceInstances($id: String!) {
      environment(id: $id) { serviceInstances { edges { node { serviceId } } } }
    }`, { id: target.environmentId }, lease.signal);
    const edges = data.environment?.serviceInstances?.edges;
    if (!Array.isArray(edges) || edges.length > 1 || edges.some(e => e.node?.serviceId !== target.serviceId)) {
      throw new Error("Unexpected service in the owned Dev environment; no configuration was replaced");
    }
    return edges.length === 1;
  };
  if (!await hasInstance()) {
    await lease.fence();
    // Updating settings on an empty environment does not create an instance.
    // Materialize only this service, without copying another environment or
    // starting a deployment before variables and limits have been configured.
    const service = lease.state.resources.railway.service ??= {};
    await dispatchDevCreate(lease, service, "Railway", () => request(`mutation PrepareDevService($environmentId: String!, $patch: EnvironmentConfig!) {
      environmentPatchCommit(environmentId: $environmentId, patch: $patch, skipDeploys: true)
    }`, { environmentId: target.environmentId,
      patch: { services: { [target.serviceId]: { isCreated: true, source: { repo: null, image: null } } } } }, lease.signal));
    await pollProvider("Railway Dev service creation", hasInstance, { signal: lease.signal });
  }
  if (lease.state.resources.railway.service) await acknowledgeDevCreate(lease, lease.state.resources.railway.service);
  await lease.fence();
  await request(`mutation DevVariables($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
    { input: { ...target, projectId: config.projectId, variables, replace: true, skipDeploys: true } }, lease.signal);
  await lease.fence();
  await request(`mutation DevService($environmentId: String!, $patch: EnvironmentConfig!) {
    environmentPatchCommit(environmentId: $environmentId, patch: $patch, skipDeploys: true)
  }`, { environmentId: target.environmentId, patch: { services: { [target.serviceId]: {
    source: { repo: null, image: null, rootDirectory: "/" }, build: { dockerfilePath: "Dockerfile", builder: "DOCKERFILE" }, deploy: {
    startCommand: "node dist/index.js", healthcheckPath: "/healthz", healthcheckTimeout: 180,
    numReplicas: 1, sleepApplication: false, restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 3,
    ...(config.region ? { multiRegionConfig: { [config.region]: { numReplicas: 1 } } } : {}), overlapSeconds: 0, drainingSeconds: 5,
  } } } } }, lease.signal);
  await lease.fence();
  await request(`mutation DevLimits($input: ServiceInstanceLimitsUpdateInput!) { serviceInstanceLimitsUpdate(input: $input) }`,
    { input: { ...target, vCPUs: config.vCPUs ?? 1, memoryGB: config.memoryGB ?? 1 } }, lease.signal);
}

export async function deployRailwayBackend(lease, config, artifact, request = railwayDevClient(config), fetchImpl = fetch, polling = {}) {
  const target = await mutationFence(lease, config, request);
  const receipt = lease.state.resources.railway;
  if (lease.state.status === "archiving") throw new Error("Cannot upload a backend while archiving");
  const body = fs.readFileSync(artifact.archive);
  if (body.length > 32 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(artifact.digest) || sha256(body) !== artifact.archiveSha256) throw new Error("Invalid backend deployment artifact");
  if (receipt.uploadPending && !receipt.deploymentId && !["planned", "rejected"].includes(receipt.uploadCreate?.phase)) throw new Error("Railway upload response is unconfirmed; reconcile the pending deployment before another upload");
  if (receipt.deploymentId && receipt.digest === artifact.digest) {
    const { deployment } = await request(`query DevDeployment($id: String!) { deployment(id: $id) { id projectId environmentId serviceId status deploymentStopped } }`, { id: receipt.deploymentId }, lease.signal);
    if (deployment?.projectId !== config.projectId || deployment.environmentId !== target.environmentId || deployment.serviceId !== config.serviceId) throw new Error("Railway deployment ownership changed");
    if (deployment.deploymentStopped || ["FAILED", "CRASHED", "REMOVED", "SKIPPED"].includes(deployment.status)) { delete receipt.deploymentId; delete receipt.uploadCreate; await lease.save(); }
  }
  if (receipt.digest !== artifact.digest || !receipt.deploymentId || receipt.deploymentRunId !== lease.state.runId) {
    // A new lifecycle run can change secrets/roles without changing the tar.
    // Keep uncertain previous dispatches; only a confirmed deployment or a
    // documented rejection authorizes another source upload.
    if (receipt.deploymentId) delete receipt.uploadCreate;
    receipt.uploadPending = true; lease.state.backendEverDeployed = true; receipt.digest = artifact.digest; delete receipt.deploymentId; await lease.save(); await lease.fence();
    const url = new URL(`${API}/project/${config.projectId}/environment/${target.environmentId}/up`);
    url.searchParams.set("serviceId", config.serviceId); url.searchParams.set("message", `zeros-dev:${lease.state.generation}:${artifact.digest}`);
    await dispatchDevCreate(lease, receipt, "Railway source upload", async () => {
      const response = await providerJson("Railway source upload", url, { method: "POST", signal: lease.signal, body,
        headers: { authorization: `Bearer ${config.apiToken}`, "content-type": "application/gzip" } }, fetchImpl);
      if (response.status !== 200 || !UUID.test(response.body?.deploymentId ?? "")) throw new DevProviderError("Railway source upload", response.status, response.requestId);
      receipt.deploymentId = response.body.deploymentId; receipt.deploymentRunId = lease.state.runId;
      receipt.uploadPending = false; await lease.save();
    }, { key: "uploadCreate" });
  }
  await pollProvider("Railway Dev deployment", async () => {
    const { deployment } = await request(`query DevDeployment($id: String!) { deployment(id: $id) { id projectId environmentId serviceId status } }`, { id: receipt.deploymentId }, lease.signal);
    if (deployment?.projectId !== config.projectId || deployment.environmentId !== target.environmentId || deployment.serviceId !== config.serviceId) throw new Error("Railway deployment ownership changed");
    if (["FAILED", "CRASHED", "REMOVED", "SKIPPED"].includes(deployment.status)) throw new Error("Railway Dev deployment failed; inspect its provider logs with secret redaction before retrying");
    return deployment.status === "SUCCESS";
  }, { signal: lease.signal, timeout: 600_000, ...polling });
}

export async function ensureRailwayDevDomain(lease, profile, ensureDns, request = railwayDevClient(profile.railway), { reconcileOnly = false } = {}) {
  const config = profile.railway, target = await mutationFence(lease, config, request);
  const domain = `api-dev-${lease.state.owner}.${profile.cloudflare.domain}`;
  const fields = `id domain projectId environmentId serviceId status { verificationToken verificationDnsHost dnsRecords { hostlabel requiredValue } }`;
  const data = await request(`query DevDomains($projectId: String!, $environmentId: String!, $serviceId: String!) {
    domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) { customDomains { ${fields} } }
  }`, { projectId: config.projectId, ...target }, lease.signal);
  const matches = data.domains.customDomains.filter(d => d.domain === domain);
  if (data.domains.customDomains.length !== matches.length || matches.length > 1) throw new Error("Unexpected custom domain in Dev backend environment");
  let receipt = lease.state.resources.railway.domain, value = matches[0];
  if (!receipt) {
    if (value) throw new Error("Dev API domain exists without its ownership receipt");
    if (reconcileOnly) return;
    receipt = lease.state.resources.railway.domain = { name: domain, create: { version: 1, phase: "planned", attempt: 1 } }; await lease.save();
  }
  if (receipt.name !== domain) throw new Error("Dev API domain receipt changed");
  if (!value) {
    if (reconcileOnly && devCreateNotDispatched(receipt)) return;
    if (!devCreateNotDispatched(receipt)) throw new Error("Dev API domain creation remains unconfirmed");
    value = (await dispatchDevCreate(lease, receipt, "Railway", () => request(`mutation DevDomain($input: CustomDomainCreateInput!) { customDomainCreate(input: $input) { ${fields} } }`,
      { input: { projectId: config.projectId, ...target, domain, targetPort: 3000 } }, lease.signal))).customDomainCreate;
  }
  if (!value || value.domain !== domain || value.environmentId !== target.environmentId || value.serviceId !== target.serviceId ||
      value.projectId !== config.projectId || (receipt.id && value.id !== receipt.id)) throw new Error("Dev API domain creation is unconfirmed or belongs to another environment");
  receipt.id = value.id; await lease.save();
  await acknowledgeDevCreate(lease, receipt);
  const routing = value.status?.dnsRecords?.filter(r => /^[a-z0-9.-]+\.up\.railway\.app$/.test(r.requiredValue ?? ""));
  if (routing?.length !== 1) throw new Error("Railway did not return one Dev API CNAME target");
  await ensureDns({ type: "CNAME", name: domain, content: routing[0].requiredValue });
  if (value.status.verificationToken) {
    const raw = value.status.verificationDnsHost;
    if (typeof raw !== "string") throw new Error("Railway did not return a DNS verification hostname");
    const name = raw.endsWith(`.${profile.cloudflare.domain}`) ? raw : `${raw}.${profile.cloudflare.domain}`;
    await ensureDns({ type: "TXT", name, content: value.status.verificationToken });
  }
}

export async function stopRailwayBackend(lease, config, request = railwayDevClient(config), polling = {}) {
  const receipt = lease.state.resources.railway;
  if (!receipt || receipt.deleted) return;
  if (!await inspectRailwayEnvironment(lease, config, request)) {
    if (!receipt.id && !devCreateNotDispatched(receipt)) throw new Error("An unconfirmed Railway creation must be reconciled before cleanup");
    return;
  }
  const target = await mutationFence(lease, config, request);
  const instances = async () => {
    const list = (await request(`query DevInstances($id: String!) {
    environment(id: $id) { serviceInstances { edges { node { serviceId activeDeployments { id status deploymentStopped }
      latestDeployment { id status deploymentStopped } } } } }
  }`, { id: target.environmentId }, lease.signal)).environment.serviceInstances.edges.map(e => e.node);
    if (list.some(i => i.serviceId !== config.serviceId)) throw new Error("Unexpected service in the owned Dev environment; cleanup stopped");
    return list;
  };
  const list = await instances();
  // Remove is Railway's durable shutdown operation. deploymentStop can leave
  // SUCCESS and live instances unchanged; a stop flag is not removal evidence.
  // A crashed deployment may restart automatically, so remove it as well.
  const terminal = deployment => ["REMOVED", "FAILED", "SKIPPED"].includes(deployment.status);
  const stopped = new Set();
  for (const instance of list) for (const deployment of [...instance.activeDeployments, instance.latestDeployment].filter(Boolean)) {
    if (stopped.has(deployment.id) || terminal(deployment) || deployment.status === "REMOVING") continue;
    await lease.fence();
    const mutation = ["BUILDING", "INITIALIZING", "QUEUED", "WAITING"].includes(deployment.status) ? "deploymentCancel" : "deploymentRemove";
    await request(`mutation StopDevDeployment($id: String!) { ${mutation}(id: $id) }`, { id: deployment.id }, lease.signal); stopped.add(deployment.id);
  }
  await pollProvider("Railway Dev backend shutdown", async () => (await instances()).every(i =>
    [...i.activeDeployments, i.latestDeployment].filter(Boolean).every(terminal)),
  { signal: lease.signal, ...polling });
  receipt.stopped = true; await lease.save();
}

export async function deleteRailwayEnvironment(lease, config, request = railwayDevClient(config), polling = {}) {
  const receipt = lease.state.resources.railway;
  if (!receipt || receipt.deleted) return;
  if (lease.state.status !== "archiving" || !lease.state.steps.backendStopped) throw new Error("Confirm owned backend shutdown before deleting the Dev environment");
  const environment = await inspectRailwayEnvironment(lease, config, request);
  if (!environment && !receipt.id && !devCreateNotDispatched(receipt)) throw new Error("Railway create request remains unconfirmed");
  if (environment) {
    if (!receipt.id) { receipt.id = environment.id; await lease.save(); }
    receipt.deleteRequested = true; await lease.save(); await lease.fence();
    await request(`mutation DeleteDevEnvironment($id: String!) { environmentDelete(id: $id) }`, { id: receipt.id }, lease.signal);
  }
  await pollProvider("Railway Dev environment deletion", async () => !await inspectRailwayEnvironment(lease, config, request), { signal: lease.signal, ...polling });
  receipt.deleted = true; await lease.save();
}
