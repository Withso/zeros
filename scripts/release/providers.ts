import { ReleaseIdentity, WorkerIdentity, requireCheck, type PromotionConfig, type Surface } from "./contracts";
import { command, jsonClient, poll, type Command } from "./io";
import type { z } from "zod";

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
  }`, target);
  async function inspectRailway() {
    const data = await readRailway(), environment = data.environment;
    requireCheck(data.serviceInstanceAutoDeployStatus?.enabled === false, "Disable independent Railway autodeploy before enabling hosted promotion");
    requireCheck(environment?.id === config.environmentId && environment.projectId === config.projectId && environment.name === config.channel &&
      environment.unmergedChangesCount === 0 && data.serviceInstance?.serviceId === config.serviceId && data.serviceInstance.environmentId === config.environmentId,
    "Railway target mismatch or outstanding staged changes");
    const source = environment.config?.services?.[config.serviceId]?.source;
    requireCheck(source?.repo === config.repository && source.checkSuites === false && source.rootDirectory === "apps/control-plane",
      "Railway source/root must match this repository and Wait for CI must be disabled");
    requireCheck(data.serviceInstance.domains?.customDomains?.some((row: { domain: string }) => row.domain === new URL(config.api).hostname), "Railway API domain mismatch");
    if (config.channel !== "alpha") assertNotOlderBranch(config.branch, source.branch);
    else requireCheck(source.branch === "main", "Railway Alpha source must be main");
    return source;
  }
  async function inspectPages(surface: Surface) {
    const project = await pages(pagesPath(surface)), source = project.source?.config;
    const expected = publicPagesEnvironment(config, surface, {}), vars = project.deployment_configs?.production?.env_vars;
    requireCheck(project.name === (surface === "app" ? config.appProject : config.opsProject) &&
      project.domains?.includes(new URL(expected.APP_ORIGIN).hostname), "Pages project/domain identity mismatch");
    requireCheck(!project.source || source?.production_deployments_enabled === false && source?.preview_deployment_setting === "none",
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
  return {
    railway,
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
    async inspect() { await inspectRailway(); for (const surface of config.surfaces) await inspectPages(surface); },
    async retarget() {
      const source = await inspectRailway();
      if (source.branch !== config.branch) {
        // Commit only this explicit patch, with deployments suppressed. Never
        // accept a shared staging area that may contain someone else's edits.
        await railway(`mutation PromotionCommit($environmentId:String!,$patch:EnvironmentConfig!) {
          environmentPatchCommit(environmentId:$environmentId,patch:$patch,skipDeploys:true,commitMessage:"Zeros release source retarget")
        }`, { environmentId: config.environmentId, patch: { services: { [config.serviceId]: { source: { branch: config.branch, checkSuites: false } } } } });
        requireCheck((await inspectRailway()).branch === config.branch, "Railway source retarget was not confirmed");
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
    async waitIdentity(manifest: { head: string; sha256: string }, expectedWorker?: z.infer<typeof WorkerIdentity>) {
      return poll(async () => {
        let value: unknown;
        try { value = await json(`${config.api}/v1/release-identity`); } catch { return false; }
        const parsed = ReleaseIdentity.safeParse(value);
        if (!parsed.success) return false;
        const identity = parsed.data;
        if (identity.channel !== config.channel || identity.sourceSha !== config.sourceSha || identity.migrations.head !== manifest.head ||
          identity.migrations.expectedHead !== manifest.head || identity.migrations.manifestSha256 !== manifest.sha256) return false;
        if (config.cloudRequired && (!identity.cloud.enabled || identity.cloud.state !== "healthy" || identity.worker?.provider !== config.provider ||
          identity.workerQualified !== true || !expectedWorker)) return false;
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
