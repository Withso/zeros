import { refuseRetiredWorkerPromotion } from "./worker-retirement";
import { ReleaseIdentity, WorkerIdentity, requireCheck, type PromotionConfig, type Surface } from "./contracts";
import { command, jsonClient, poll, sleep, type Command } from "./io";
import type { z } from "zod";
import { verifyWorkOS, workosVerificationConfig } from "./workos";

export function publicPagesEnvironment(config: PromotionConfig, surface: Surface, env: NodeJS.ProcessEnv) {
  return { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, CI: "true", CF_PAGES: "1", CF_PAGES_BRANCH: config.branch,
    CF_PAGES_COMMIT_SHA: config.sourceSha, ZEROS_DEPLOY_ENV: config.channel, ZEROS_SURFACE: surface,
    AUTH_PROVIDER: "workos", APP_ORIGIN: surface === "ops" ? config.ops! : config.app, CONTROL_PLANE_URL: config.api,
    WORKOS_BROWSER_ROUTE_PREFIX: surface === "ops" ? "/ops" : "" };
}
export function assertNotOlderBranch(candidate: string, selected: unknown) {
  if (typeof selected !== "string" || !/^release\/\d+\.\d+\.\d+$/.test(selected)) return;
  const next = candidate.slice(8).split(".").map(BigInt), current = selected.slice(8).split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (next[i] === current[i]) continue;
    requireCheck(next[i] > current[i], "A newer release branch already owns this channel; refusing a superseded candidate");
    break;
  }
}
export function createProviders(config: PromotionConfig, env: NodeJS.ProcessEnv, options: {
  fetch?: typeof fetch; command?: Command; pause?: (ms: number) => Promise<void>;
} = {}) {
  const json = jsonClient(options.fetch, options.pause), run = options.command ?? command;
  const target = { projectId: config.projectId, environmentId: config.environmentId, serviceId: config.serviceId };
  const railway = async (query: string, variables: unknown) => {
    const result = await json("https://backboard.railway.com/graphql/v2", { method: "POST",
      headers: { "Project-Access-Token": env.RAILWAY_DEPLOY_TOKEN!, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) }, query.trim().startsWith("query"));
    requireCheck(!result.errors && result.data, "Railway rejected the operation; details withheld");
    return result.data;
  };
  const pagesPath = (surface: Surface) => `/accounts/${config.accountId}/pages/projects/${surface === "app" ? config.appProject : config.opsProject}`;
  const pages = async (route: string, method = "GET", body?: unknown) => {
    const result = await json(`https://api.cloudflare.com/client/v4${route}`, { method,
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, method === "GET");
    requireCheck(result.success === true && result.result, "Pages rejected the operation; details withheld");
    return result.result;
  };
  const readRailway = () => railway(`query PromotionState($projectId:String!,$environmentId:String!,$serviceId:String!) {
    serviceInstanceAutoDeployStatus(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId) { enabled }
    environment(id:$environmentId) { id name projectId unmergedChangesCount config(decryptVariables:false) }
    serviceInstance(environmentId:$environmentId,serviceId:$serviceId) { serviceId environmentId domains { customDomains { domain } } }
    environmentStagedChanges(environmentId:$environmentId) { id patch }
  }`, target);
  // A base environment reports a null fork count; staged dashboard edits appear
  // only in its staged-change patch, which must be readable and empty.
  const noStagedChanges = (environment: { unmergedChangesCount?: unknown }, staged: { patch?: unknown } | null | undefined) =>
    (environment.unmergedChangesCount === 0 || environment.unmergedChangesCount === null) &&
    staged?.patch !== null && typeof staged?.patch === "object" && !Array.isArray(staged.patch) && Object.keys(staged.patch).length === 0;
  async function inspectRailway(requireHeld = true) {
    const data = await readRailway(), environment = data.environment;
    if (requireHeld) requireCheck(data.serviceInstanceAutoDeployStatus?.enabled === false, "Disable independent Railway autodeploy before enabling hosted promotion");
    requireCheck(environment?.id === config.environmentId && environment.projectId === config.projectId && environment.name === config.channel &&
      noStagedChanges(environment, data.environmentStagedChanges) && data.serviceInstance?.serviceId === config.serviceId && data.serviceInstance.environmentId === config.environmentId,
    "Railway target mismatch or outstanding staged changes");
    const source = environment.config?.services?.[config.serviceId]?.source;
    requireCheck(source?.repo === config.repository && (!requireHeld || source.checkSuites !== true) && source.rootDirectory === "apps/control-plane",
      "Railway source/root must match this repository and Wait for CI must be disabled");
    requireCheck(data.serviceInstance.domains?.customDomains?.some((row: { domain: string }) => row.domain === new URL(config.api).hostname), "Railway API domain mismatch");
    if (config.channel !== "alpha") assertNotOlderBranch(config.branch, source.branch);
    else requireCheck(source.branch === "main", "Railway Alpha source must be main");
    return source;
  }
  async function inspectPages(surface: Surface, requireHeld = true) {
    const project = await pages(pagesPath(surface)), source = project.source?.config;
    const expected = publicPagesEnvironment(config, surface, {}), vars = project.deployment_configs?.production?.env_vars;
    requireCheck(project.name === (surface === "app" ? config.appProject : config.opsProject) &&
      project.domains?.includes(new URL(expected.APP_ORIGIN).hostname), "Pages project/domain identity mismatch");
    requireCheck(!requireHeld || !project.source || source?.production_deployments_enabled === false && source?.preview_deployment_setting === "none",
      "Disable independent Pages production and preview autodeploys before enabling hosted promotion");
    if (project.source) requireCheck(`${source.owner}/${source.repo_name}`.toLowerCase() === config.repository.toLowerCase(), "Pages repository mismatch");
    for (const name of ["ZEROS_DEPLOY_ENV", "AUTH_PROVIDER", "APP_ORIGIN", "CONTROL_PLANE_URL", "ZEROS_SURFACE", "WORKOS_BROWSER_ROUTE_PREFIX"] as const) {
      const actual = vars?.[name]?.value ?? (name === "ZEROS_SURFACE" ? "app" : name === "WORKOS_BROWSER_ROUTE_PREFIX" ? "" : undefined);
      requireCheck(actual === expected[name], "Pages production runtime variables do not match the channel/surface");
    }
    requireCheck(!Object.keys(vars ?? {}).some(name => /^(?:WORKOS_.*(?:KEY|PASSWORD|SECRET)|AUTH_BROKER_SECRET|ZEROS_DEV_)/.test(name)), "Pages retains forbidden server or Dev configuration");
    if (config.channel !== "alpha") assertNotOlderBranch(config.branch, project.production_branch);
    else requireCheck(project.production_branch === "main", "Pages Alpha source must be main");
    return project;
  }
  /** Railway models automatic deployments as GitHub deployment triggers: the
   * dashboard's Disable deletes them, and any source patch can recreate one.
   * Remove every trigger for this service and confirm autodeploy is off. */
  async function removeDeployTriggers() {
    // Railway recreates a trigger asynchronously after a source patch, so keep
    // removing until three consecutive reads, seconds apart, show none. The
    // deadline makes a provider that keeps recreating them stop here, with
    // this diagnostic, rather than at the job timeout.
    const deadline = Date.now() + 10 * 60_000;
    let clean = 0;
    for (let attempt = 0; attempt < 24 && clean < 3 && Date.now() < deadline; attempt++) {
      if (attempt > 0) await (options.pause ?? sleep)(5_000);
      const listed = await railway(`query CutoverTriggers($projectId:String!,$environmentId:String!,$serviceId:String!) {
        deploymentTriggers(first:50,projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId) { edges { node { id } } }
      }`, target);
      const ids: string[] = listed.deploymentTriggers?.edges?.map((edge: { node: { id: string } }) => edge.node.id) ?? [];
      for (const id of ids) {
        requireCheck(Date.now() < deadline, "Railway automatic deployments did not stay off after removing their triggers");
        const removed = await railway(`mutation CutoverTriggerDelete($id:String!) { deploymentTriggerDelete(id:$id) }`, { id });
        requireCheck(removed.deploymentTriggerDelete === true, "Railway deployment trigger removal is unconfirmed");
      }
      const after = await readRailway();
      clean = ids.length === 0 && after.serviceInstanceAutoDeployStatus?.enabled === false ? clean + 1 : 0;
    }
    requireCheck(clean >= 3, "Railway automatic deployments did not stay off after removing their triggers");
  }
  /** Read-only: every destination identity a cutover will touch, before any
   * hold. The channel environment must run only the control-plane service. */
  async function validateTargets() {
    workosVerificationConfig(env);
    await inspectRailway(false);
    const instances = await railway(`query CutoverServices($environmentId:String!) {
      environment(id:$environmentId) { serviceInstances { edges { node { serviceId } } } }
    }`, { environmentId: config.environmentId });
    const services = instances.environment?.serviceInstances?.edges?.map((edge: { node: { serviceId: string } }) => edge.node.serviceId) ?? [];
    requireCheck(services.length === 1 && services[0] === config.serviceId,
      "The channel environment runs another Railway service; account for every database writer before a cutover");
    for (const surface of config.surfaces) await inspectPages(surface, false);
  }
  return {
    railway,
    validateTargets,
    async updateWorkerIdentity(variables: Record<string, string>) {
      const expectedKeys = ["CLOUD_WORKSPACE_PROVIDER", "BOAT_SNAPSHOT_ID", "BOAT_IMAGE_BUILD_SHA256", "ZEROS_CLOUD_SOURCE_COMMIT", "ZEROS_CLOUD_IMAGE_ARCHITECTURE", "CLOUD_WORKSPACE_STORAGE_MIB"];
      requireCheck(Object.keys(variables).length === expectedKeys.length && expectedKeys.every(key => Object.hasOwn(variables, key)), "Worker tuple must be complete");
      const worker = WorkerIdentity.safeParse({ provider: variables.CLOUD_WORKSPACE_PROVIDER,
        imageRef: `boat:${variables.BOAT_SNAPSHOT_ID}@sha256:${variables.BOAT_IMAGE_BUILD_SHA256}`,
        sourceSha: variables.ZEROS_CLOUD_SOURCE_COMMIT, architecture: variables.ZEROS_CLOUD_IMAGE_ARCHITECTURE,
        storageMiB: Number(variables.CLOUD_WORKSPACE_STORAGE_MIB) });
      requireCheck(worker.success && worker.data.provider === "boat" && worker.data.sourceSha === config.sourceSha, "Invalid worker tuple identity");
      await inspectRailway();
      const result = await railway(`mutation WorkerIdentityUpdate($input:VariableCollectionUpsertInput!) { variableCollectionUpsert(input:$input) }`,
        { input: { ...target, variables, replace: false, skipDeploys: true } });
      requireCheck(result.variableCollectionUpsert === true, "Worker tuple update is unconfirmed");
      // The provider returns all rendered variables. Select only these public
      // fields for equality; never log, persist or forward the response.
      const confirmed = await railway(`query WorkerIdentityRead($projectId:String!,$environmentId:String!,$serviceId:String!) {
        variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)
      }`, target);
      requireCheck(expectedKeys.every(key => confirmed.variables?.[key] === variables[key]), "Worker tuple readback mismatch");
    },
    async inspect() { workosVerificationConfig(env); await inspectRailway(); for (const surface of config.surfaces) await inspectPages(surface); },
    verifyWorkOS: () => verifyWorkOS(config, env, options.fetch),
    async verifyPages(surface: Surface) {
      const origin = surface === "ops" ? config.ops! : config.app;
      const manifest = await json(`${origin}/zeros-deployment.json`);
      requireCheck(manifest?.version === 1 && manifest.commitSha === config.sourceSha && manifest.surface === surface, "Pages source changed before hosted finalization");
    },
    async verifyWorkerIdentity(expected: z.infer<typeof WorkerIdentity>) {
      const match = /^boat:([a-z0-9][a-z0-9-]{0,62})@sha256:([a-f0-9]{64})$/.exec(expected.imageRef);
      requireCheck(expected.provider === "boat" && match, "Worker receipt tuple is invalid");
      await inspectRailway();
      const result = await railway(`query WorkerIdentityRead($projectId:String!,$environmentId:String!,$serviceId:String!) {
        variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)
      }`, target);
      const variables = { CLOUD_WORKSPACE_PROVIDER: "boat", BOAT_SNAPSHOT_ID: match[1], BOAT_IMAGE_BUILD_SHA256: match[2],
        ZEROS_CLOUD_SOURCE_COMMIT: expected.sourceSha, ZEROS_CLOUD_IMAGE_ARCHITECTURE: expected.architecture, CLOUD_WORKSPACE_STORAGE_MIB: String(expected.storageMiB) };
      requireCheck(Object.entries(variables).every(([name, value]) => result.variables?.[name] === value), "Selected worker tuple changed after qualification; hosted finalization refused");
    },
    async retarget() {
      const source = await inspectRailway();
      if (source.branch !== config.branch) {
        // Commit only this explicit patch, with deployments suppressed. Never
        // accept a shared staging area that may contain someone else's edits.
        await railway(`mutation PromotionCommit($environmentId:String!,$patch:EnvironmentConfig!) {
          environmentPatchCommit(environmentId:$environmentId,patch:$patch,skipDeploys:true,commitMessage:"Zeros release source retarget")
        }`, { environmentId: config.environmentId, patch: { services: { [config.serviceId]: { source: { branch: config.branch } } } } });
        // A source patch can recreate the GitHub deployment trigger.
        await removeDeployTriggers();
        // The commit settles asynchronously (a staged change can show briefly):
        // wait for a clean inspection, then surface its exact error if it never comes.
        const settled = await poll(async () => {
          try { return (await inspectRailway()).branch === config.branch; } catch { return false; }
        }, { attempts: 24, sleep: options.pause }).catch(() => false);
        if (!settled) requireCheck((await inspectRailway()).branch === config.branch, "Railway source retarget was not confirmed");
      }
      for (const surface of config.surfaces) {
        const project = await inspectPages(surface);
        if (project.production_branch !== config.branch) {
          await pages(pagesPath(surface), "PATCH", { production_branch: config.branch,
            ...(project.source ? { source: { type: project.source.type, config: { ...project.source.config,
              production_branch: config.branch, production_deployments_enabled: false, preview_deployment_setting: "none" } } } : {}) });
          requireCheck((await inspectPages(surface)).production_branch === config.branch, "Pages source retarget was not confirmed");
        }
      }
    },
    /** Hold every independent deployer before an explicit cutover: Railway's
     * deployment triggers (automatic deployments and their Wait for CI), then
     * Pages production and preview builds. Branches stay; `retarget` moves them. */
    async holdDeploys() {
      await validateTargets();
      await removeDeployTriggers();
      for (const surface of config.surfaces) {
        const project = await pages(pagesPath(surface)), source = project.source?.config;
        if (!project.source || source?.production_deployments_enabled === false && source?.preview_deployment_setting === "none") continue;
        await pages(pagesPath(surface), "PATCH", { source: { type: project.source.type, config: { ...source,
          production_deployments_enabled: false, preview_deployment_setting: "none" } } });
        const held = (await pages(pagesPath(surface))).source?.config;
        requireCheck(held?.production_deployments_enabled === false && held?.preview_deployment_setting === "none", "Pages deploy hold was not confirmed");
      }
    },
    /** Every deployment except `activeId` must be gone: a replaced one can keep
     * serving through Railway's overlap and draining windows. */
    async waitPreviousDeploymentsStopped(activeId: string) {
      const stopped = new Set(["REMOVED", "FAILED", "CRASHED", "SKIPPED"]);
      await poll(async () => {
        // Read the whole inventory: an old writer can sit beyond any first page.
        const nodes: { id: string; status: string }[] = [];
        let after: string | null = null, complete = false;
        for (let page = 0; page < 40 && !complete; page++) {
          const result = await railway(`query CutoverDeployments($projectId:String!,$environmentId:String!,$serviceId:String!,$after:String) {
            deployments(first:100,after:$after,input:{projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId}) {
              edges { node { id status } } pageInfo { hasNextPage endCursor }
            }
          }`, { ...target, after });
          const connection = result.deployments;
          requireCheck(Array.isArray(connection?.edges), "Railway deployment inventory is unavailable");
          nodes.push(...connection.edges.map((edge: { node: { id: string; status: string } }) => edge.node));
          complete = connection.pageInfo?.hasNextPage === false;
          after = connection.pageInfo?.endCursor ?? null;
          requireCheck(complete || typeof after === "string", "Railway deployment inventory cannot be paged");
        }
        requireCheck(complete, "Railway deployment inventory exceeds its bound; confirm every old deployment stopped before migrating");
        requireCheck(nodes.some(node => node.id === activeId && node.status === "SUCCESS"), "The maintenance deployment is no longer the serving deployment");
        return nodes.every(node => node.id === activeId || stopped.has(node.status));
      }, { sleep: options.pause });
    },
    /** `DATABASE_MAINTENANCE_MODE` takes effect on the next explicit deploy. */
    async setMaintenance(on: boolean) {
      const value = on ? "true" : "false";
      await inspectRailway();
      const result = await railway(`mutation CutoverMaintenance($input:VariableCollectionUpsertInput!) { variableCollectionUpsert(input:$input) }`,
        { input: { ...target, variables: { DATABASE_MAINTENANCE_MODE: value }, replace: false, skipDeploys: true } });
      requireCheck(result.variableCollectionUpsert === true, "Maintenance switch update is unconfirmed");
      // The provider returns every rendered variable. Compare only this one;
      // never log, persist or forward the response.
      const confirmed = await railway(`query CutoverMaintenanceRead($projectId:String!,$environmentId:String!,$serviceId:String!) {
        variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)
      }`, target);
      requireCheck(confirmed.variables?.DATABASE_MAINTENANCE_MODE === value, "Maintenance switch readback mismatch");
    },
    /** The candidate in maintenance fences every writer: it skips schema
     * verification and serves only health and this identity, which answers 503. */
    async waitMaintenance() {
      return poll(async () => {
        let identity: any;
        try {
          const response = await (options.fetch ?? fetch)(`${config.api}/v1/release-identity`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
          identity = await response.json();
        } catch { return false; }
        return identity?.version === 1 && identity.channel === config.channel && identity.sourceSha === config.sourceSha &&
          identity.maintenance === true && identity.ready === false;
      }, { sleep: options.pause });
    },
    async deploy() {
      const result = await railway(`mutation PromotionDeploy($environmentId:String!,$serviceId:String!,$commitSha:String!) {
        serviceInstanceDeployV2(commitSha:$commitSha,environmentId:$environmentId,serviceId:$serviceId)
      }`, { environmentId: config.environmentId, serviceId: config.serviceId, commitSha: config.sourceSha });
      requireCheck(typeof result.serviceInstanceDeployV2 === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(result.serviceInstanceDeployV2), "Railway deployment acknowledgement missing");
      return result.serviceInstanceDeployV2 as string;
    },
    async waitDeployment(id: string) {
      await poll(async () => {
        const { deployment } = await railway(`query PromotionDeployment($id:String!) { deployment(id:$id) { id status projectId environmentId serviceId meta } }`, { id });
        requireCheck(deployment?.id === id && deployment.projectId === config.projectId && deployment.environmentId === config.environmentId && deployment.serviceId === config.serviceId,
          "Railway deployment target mismatch");
        requireCheck(!["FAILED", "CRASHED", "REMOVED", "SKIPPED", "CANCELED"].includes(deployment.status), "Railway deployment failed; roll forward after inspecting the migration receipt");
        if (deployment.status !== "SUCCESS") return false;
        requireCheck(deployment.meta?.commitHash === config.sourceSha && deployment.meta.branch === config.branch, "Railway deployed a different source SHA/branch");
        return true;
      }, { sleep: options.pause });
    },
    async waitIdentity(manifest: { head: string; sha256: string }, expectedWorker?: z.infer<typeof WorkerIdentity>, requireWorkerQualification = true) {
      if (config.requireQualifiedWorker || expectedWorker && requireWorkerQualification) refuseRetiredWorkerPromotion();
      return poll(async () => {
        let value: unknown;
        try { value = await json(`${config.api}/v1/release-identity`); } catch { return false; }
        const parsed = ReleaseIdentity.safeParse(value);
        if (!parsed.success) return false;
        const identity = parsed.data;
        if (identity.channel !== config.channel || identity.sourceSha !== config.sourceSha || identity.migrations.head !== manifest.head ||
          identity.migrations.expectedHead !== manifest.head || identity.migrations.manifestSha256 !== manifest.sha256) return false;
        if (expectedWorker && JSON.stringify(identity.worker) !== JSON.stringify(expectedWorker)) return false;
        return identity;
      }, { sleep: options.pause });
    },
    async publishPages(surface: Surface) {
      await inspectPages(surface);
      const buildEnv = publicPagesEnvironment(config, surface, env);
      await run("pnpm", ["build"], { cwd: "apps/web", env: buildEnv });
      await run("pnpm", ["exec", "wrangler", "pages", "deploy", "dist", "--project-name", surface === "app" ? config.appProject : config.opsProject!,
        "--branch", config.branch, "--commit-hash", config.sourceSha, "--commit-dirty=false"], {
        cwd: "apps/web", env: { ...buildEnv, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: config.accountId, WRANGLER_SEND_METRICS: "false" },
      });
      return poll(async () => {
        const project = await pages(pagesPath(surface)), deployment = project.canonical_deployment;
        if (deployment?.latest_stage?.status !== "success" || deployment.environment !== "production" ||
          deployment.deployment_trigger?.metadata?.commit_hash !== config.sourceSha || deployment.deployment_trigger?.metadata?.branch !== config.branch) return false;
        let manifest;
        try { manifest = await json(`${buildEnv.APP_ORIGIN}/zeros-deployment.json`); } catch { return false; }
        if (manifest?.commitSha !== config.sourceSha || manifest.surface !== surface || manifest.version !== 1) return false;
        requireCheck(/^[a-zA-Z0-9_-]{1,128}$/.test(deployment.id), "Pages deployment identity missing");
        return { id: deployment.id as string, surface };
      }, { sleep: options.pause });
    },
  };
}
