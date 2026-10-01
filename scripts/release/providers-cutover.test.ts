import { describe, expect, it } from "vitest";
import { promotionConfig } from "./contracts";
import { createProviders, publicPagesEnvironment } from "./providers";

const sha = "a".repeat(40);
const config = promotionConfig({ RELEASE_CHANNEL: "beta", RELEASE_SHA: sha, GITHUB_SHA: sha, RELEASE_BRANCH: "release/1.2.3",
  GITHUB_REPOSITORY: "example/zeros", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1", ZEROS_HOSTED_PROMOTION: "enabled",
  RAILWAY_DEPLOY_TOKEN: "fixture", PLANETSCALE_SERVICE_TOKEN_ID: "fixture", PLANETSCALE_SERVICE_TOKEN: "fixture", CLOUDFLARE_API_TOKEN: "fixture",
  RAILWAY_PROJECT_ID: "11111111-1111-4111-8111-111111111111", RAILWAY_ENVIRONMENT_ID: "22222222-2222-4222-8222-222222222222", RAILWAY_SERVICE_ID: "33333333-3333-4333-8333-333333333333",
  PLANETSCALE_ORG: "example", PLANETSCALE_DATABASE: "zeros-control-plane-beta", PLANETSCALE_BRANCH: "main", CLOUDFLARE_ACCOUNT_ID: "c".repeat(32), CF_PAGES_APP_PROJECT: "zeros-web-beta", AUTH_PROVIDER: "workos" });
const workosEnv = { AUTH_ISSUER: "https://auth-api.example.com/", AUTH_JWKS_URL: "https://auth-api.example.com/sso/jwks/client_desktop",
  AUTH_WEB_CLIENT_ID: "client_web", AUTH_DESKTOP_CLIENT_ID: "client_desktop" };

function fixture(state: { autoDeploy: boolean; checkSuites: boolean; pagesAuto: boolean; staged?: unknown; identity?: unknown;
  services?: string[]; deployments?: { id: string; status: string }[][] }) {
  const calls: any[] = [];
  let current: { id: string; status: string }[] = [];
  const variables: Record<string, string> = { SECRET: "must-not-be-returned" };
  const branch = "release/1.2.2";
  const project = () => ({ name: config.appProject, production_branch: branch, domains: ["app-beta.zeros.build"],
    source: { type: "github", config: { owner: "example", repo_name: "zeros", production_branch: branch, production_deployments_enabled: state.pagesAuto, preview_deployment_setting: "none" } },
    deployment_configs: { production: { env_vars: Object.fromEntries(Object.entries(publicPagesEnvironment(config, "app", {})).map(([k, v]) => [k, { value: v }])) } } });
  const fetcher: typeof fetch = async (url, init) => {
    const request = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: String(url), method: init?.method, ...request });
    if (String(url).endsWith("/v1/release-identity")) return Response.json(state.identity ?? {}, { status: 503 });
    if (String(url).includes("cloudflare")) {
      if (init?.method === "PATCH") state.pagesAuto = request.source.config.production_deployments_enabled;
      return Response.json({ success: true, result: project() });
    }
    const q: string = request.query;
    if (q.includes("CutoverWaitForCiHold")) { state.checkSuites = request.variables.patch.services[config.serviceId].source.checkSuites; return Response.json({ data: { environmentPatchCommit: "commit1" } }); }
    if (q.includes("CutoverServices")) return Response.json({ data: { environment: { serviceInstances: {
      edges: (state.services ?? [config.serviceId]).map(serviceId => ({ node: { serviceId } })) } } } });
    if (q.includes("CutoverDeployments")) {
      // Each poll's inventory may span pages: the fixture serves a `next` page
      // when its first row carries one.
      const after = request.variables.after;
      if (!after) current = state.deployments?.length && state.deployments.length > 1 ? state.deployments.shift()! : state.deployments?.[0] ?? [];
      const pagesFor = current;
      const split = pagesFor.findIndex(node => node.id === "--page--");
      const firstPage = split < 0 ? pagesFor : pagesFor.slice(0, split), nextPage = split < 0 ? [] : pagesFor.slice(split + 1);
      const rows = after === "cursor1" ? nextPage : firstPage;
      return Response.json({ data: { deployments: { edges: rows.map(node => ({ node })),
        pageInfo: { hasNextPage: !after && split >= 0, endCursor: !after && split >= 0 ? "cursor1" : null } } } });
    }
    if (q.includes("CutoverMaintenanceRead")) return Response.json({ data: { variables } });
    if (q.includes("CutoverMaintenance")) { Object.assign(variables, request.variables.input.variables); return Response.json({ data: { variableCollectionUpsert: true } }); }
    if (q.includes("PromotionState")) return Response.json({ data: {
      serviceInstanceAutoDeployStatus: { enabled: state.autoDeploy },
      environment: { id: config.environmentId, name: "beta", projectId: config.projectId, unmergedChangesCount: null,
        config: { services: { [config.serviceId]: { source: { repo: config.repository, rootDirectory: "apps/control-plane", checkSuites: state.checkSuites, branch } } } } },
      serviceInstance: { serviceId: config.serviceId, environmentId: config.environmentId, domains: { customDomains: [{ domain: "api-beta.zeros.build" }] } },
      environmentStagedChanges: state.staged ?? { id: "<empty>", patch: {} },
    } });
    throw new Error(`unexpected query ${q}`);
  };
  return { calls, variables, providers: createProviders(config, { ...workosEnv, RAILWAY_DEPLOY_TOKEN: "never-log", CLOUDFLARE_API_TOKEN: "never-log" }, {
    fetch: fetcher, pause: async () => {} }) };
}

describe("cutover provider adapters", () => {
  it("asks the owner to disable Railway automatic deployments before changing anything", async () => {
    const f = fixture({ autoDeploy: true, checkSuites: true, pagesAuto: true });
    await expect(f.providers.holdDeploys()).rejects.toThrow("Railway automatic deployments are on for beta: open the control-plane service's Settings in Railway and click Disable");
    expect(f.calls.every(call => !call.query || call.query.startsWith("query"))).toBe(true);
    expect(f.calls.some(call => call.method === "PATCH")).toBe(false);
  });

  it("holds Wait for CI and Pages builds without changing any branch", async () => {
    const f = fixture({ autoDeploy: false, checkSuites: true, pagesAuto: true });
    await expect(f.providers.inspect()).rejects.toThrow();
    await f.providers.holdDeploys();
    await expect(f.providers.inspect()).resolves.toBeUndefined();
    const ci = f.calls.find(call => call.query?.includes("CutoverWaitForCiHold"));
    expect(ci.query).toContain("skipDeploys:true");
    expect(ci.variables.patch).toEqual({ services: { [config.serviceId]: { source: { checkSuites: false } } } });
    const patch = f.calls.find(call => call.method === "PATCH");
    expect(patch.production_branch).toBeUndefined();
    expect(patch.source.config).toMatchObject({ production_branch: "release/1.2.2", production_deployments_enabled: false, preview_deployment_setting: "none" });
  });

  it("does nothing when every deployer is already held", async () => {
    const f = fixture({ autoDeploy: false, checkSuites: false, pagesAuto: false });
    await f.providers.holdDeploys();
    expect(f.calls.every(call => !call.query || call.query.startsWith("query"))).toBe(true);
    expect(f.calls.some(call => call.method === "PATCH")).toBe(false);
  });

  it("refuses to hold over someone else's staged Railway changes", async () => {
    const f = fixture({ autoDeploy: false, checkSuites: true, pagesAuto: true, staged: { id: "patch1", patch: { services: {} , shared: {} } } });
    await expect(f.providers.holdDeploys()).rejects.toThrow("outstanding staged changes");
    expect(f.calls.every(call => !call.query || call.query.startsWith("query"))).toBe(true);
  });

  it("refuses before any hold when the environment runs another service that could write", async () => {
    const f = fixture({ autoDeploy: false, checkSuites: true, pagesAuto: true, services: [config.serviceId, "44444444-4444-4444-8444-444444444444"] });
    await expect(f.providers.holdDeploys()).rejects.toThrow("runs another Railway service");
    expect(f.calls.every(call => !call.query || call.query.startsWith("query"))).toBe(true);
    expect(f.calls.some(call => call.method === "PATCH")).toBe(false);
  });

  it("waits until every replaced deployment is gone, not just until the new one serves", async () => {
    const f = fixture({ autoDeploy: false, checkSuites: false, pagesAuto: false, deployments: [
      [{ id: "fence", status: "SUCCESS" }, { id: "old", status: "REMOVING" }],
      [{ id: "fence", status: "SUCCESS" }, { id: "old", status: "REMOVED" }, { id: "older", status: "FAILED" }],
    ] });
    await f.providers.waitPreviousDeploymentsStopped("fence");
    expect(f.calls.filter(call => call.query?.includes("CutoverDeployments"))).toHaveLength(2);
    const replaced = fixture({ autoDeploy: false, checkSuites: false, pagesAuto: false, deployments: [[{ id: "fence", status: "REMOVED" }, { id: "newer", status: "SUCCESS" }]] });
    await expect(replaced.providers.waitPreviousDeploymentsStopped("fence")).rejects.toThrow("no longer the serving deployment");
  });

  it("finds an old writer on a later page of the deployment inventory", async () => {
    const page = { id: "--page--", status: "" };
    const f = fixture({ autoDeploy: false, checkSuites: false, pagesAuto: false, deployments: [
      [{ id: "fence", status: "SUCCESS" }, { id: "a", status: "REMOVED" }, page, { id: "old", status: "SUCCESS" }],
      [{ id: "fence", status: "SUCCESS" }, { id: "a", status: "REMOVED" }, page, { id: "old", status: "REMOVED" }],
    ] });
    await f.providers.waitPreviousDeploymentsStopped("fence");
    const reads = f.calls.filter(call => call.query?.includes("CutoverDeployments"));
    expect(reads.map(call => call.variables.after)).toEqual([null, "cursor1", null, "cursor1"]);
  });

  it("writes only the maintenance switch with deploys skipped and confirms it", async () => {
    const f = fixture({ autoDeploy: false, checkSuites: false, pagesAuto: false });
    await f.providers.setMaintenance(true);
    const write = f.calls.find(call => call.query?.includes("mutation CutoverMaintenance"));
    expect(write.variables.input).toMatchObject({ variables: { DATABASE_MAINTENANCE_MODE: "true" }, replace: false, skipDeploys: true });
    expect(f.variables.DATABASE_MAINTENANCE_MODE).toBe("true");
    await f.providers.setMaintenance(false);
    expect(f.variables.DATABASE_MAINTENANCE_MODE).toBe("false");
  });

  it("waits until the exact candidate itself serves maintenance", async () => {
    const fenced = { version: 1, ready: false, sourceSha: sha, channel: "beta", maintenance: true };
    await expect(fixture({ autoDeploy: false, checkSuites: false, pagesAuto: false, identity: fenced }).providers.waitMaintenance()).resolves.toBe(true);
    const oldBuild = { ...fenced, sourceSha: "b".repeat(40) };
    await expect(fixture({ autoDeploy: false, checkSuites: false, pagesAuto: false, identity: oldBuild }).providers.waitMaintenance()).rejects.toThrow();
  });
});
