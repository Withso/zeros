import { describe, expect, it } from "vitest";
import { promotionConfig } from "./contracts";
import { createProviders, publicPagesEnvironment, assertNotOlderBranch } from "./providers";
import { jsonClient, poll } from "./io";
const workosEnv = { AUTH_ISSUER: "https://auth-api.example.com/", AUTH_JWKS_URL: "https://auth-api.example.com/sso/jwks/client_desktop",
  AUTH_WEB_CLIENT_ID: "client_web", AUTH_DESKTOP_CLIENT_ID: "client_desktop" };
const sha = "a".repeat(40);
const config = promotionConfig({ RELEASE_CHANNEL: "beta", RELEASE_SHA: sha, GITHUB_SHA: sha, RELEASE_BRANCH: "release/1.2.3",
  GITHUB_REPOSITORY: "example/zeros", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1", ZEROS_HOSTED_PROMOTION: "enabled",
  RAILWAY_DEPLOY_TOKEN: "fixture", PLANETSCALE_SERVICE_TOKEN_ID: "fixture", PLANETSCALE_SERVICE_TOKEN: "fixture", CLOUDFLARE_API_TOKEN: "fixture",
  RAILWAY_PROJECT_ID: "11111111-1111-4111-8111-111111111111", RAILWAY_ENVIRONMENT_ID: "22222222-2222-4222-8222-222222222222", RAILWAY_SERVICE_ID: "33333333-3333-4333-8333-333333333333",
  PLANETSCALE_ORG: "example", PLANETSCALE_DATABASE: "zeros-control-plane-beta", PLANETSCALE_BRANCH: "main", CLOUDFLARE_ACCOUNT_ID: "c".repeat(32), CF_PAGES_APP_PROJECT: "zeros-web-beta", AUTH_PROVIDER: "workos" });
function fixture(railwayAuto = false, pagesAuto = false, staged: { unmergedChangesCount: number | null; stagedChanges: unknown } =
  { unmergedChangesCount: 0, stagedChanges: { id: "<empty>", patch: {} } }, settleReads = 0, pagesVars: Record<string, string | null> = {}) {
  let branch = "release/1.2.2", webBranch = branch, triggers: string[] = [], settling = 0;
  const calls: any[] = [], commands: any[] = [];
  let selectedWorker = {};
  const project = () => ({ name: config.appProject, production_branch: webBranch, domains: ["app-beta.zeros.build"],
    source: { type: "github", config: { owner: "example", repo_name: "zeros", production_deployments_enabled: pagesAuto, preview_deployment_setting: "none" } },
    deployment_configs: { production: { env_vars: Object.fromEntries([
      ...Object.entries(publicPagesEnvironment(config, "app", {})).filter(([k]) => !(k in pagesVars)),
      ...Object.entries(pagesVars).filter((entry): entry is [string, string] => entry[1] !== null),
    ].map(([k,v]) => [k,{value:v}])) } },
    canonical_deployment: { id: "page1", environment: "production", latest_stage: { status: "success" }, deployment_trigger: { metadata: { commit_hash: sha, branch: config.branch } } } });
  const fetcher: typeof fetch = async (url, init) => {
    const request = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, ...request, method: init?.method });
    if (String(url).endsWith("zeros-deployment.json")) return Response.json({ version: 1, commitSha: sha, surface: "app" });
    if (String(url).includes("cloudflare")) {
      if (init?.method === "PATCH") webBranch = request.production_branch;
      return Response.json({ success: true, result: project() });
    }
    const q = request.query;
    if (q.includes("PromotionState")) return Response.json({ data: {
      serviceInstanceAutoDeployStatus: { enabled: railwayAuto || triggers.length > 0 },
      environment: { id: config.environmentId, name: "beta", projectId: config.projectId, unmergedChangesCount: staged.unmergedChangesCount,
        config: { services: { [config.serviceId]: { source: { repo: config.repository, rootDirectory: "apps/control-plane", checkSuites: false, branch } } } } },
      serviceInstance: { serviceId: config.serviceId, environmentId: config.environmentId, domains: { customDomains: [{ domain: "api-beta.zeros.build" }] } },
      environmentStagedChanges: settling > 0 && settling-- ? { id: "settling", patch: { services: {} } } : staged.stagedChanges,
    } });
    if (q.includes("PromotionCommit")) { branch = request.variables.patch.services[config.serviceId].source.branch; triggers = ["recreated"]; settling = settleReads; return Response.json({ data: { environmentPatchCommit: "commit1" } }); }
    if (q.includes("CutoverTriggers")) return Response.json({ data: { deploymentTriggers: { edges: triggers.map(id => ({ node: { id } })) } } });
    if (q.includes("CutoverTriggerDelete")) { triggers = triggers.filter(id => id !== request.variables.id); return Response.json({ data: { deploymentTriggerDelete: true } }); }
    if (q.includes("PromotionDeployment")) return Response.json({ data: { deployment: { id: "deploy1", status: "SUCCESS", projectId: config.projectId,
      serviceId: config.serviceId, environmentId: config.environmentId, meta: { commitHash: sha, branch: config.branch } } } });
    return Response.json({ data: { serviceInstanceDeployV2: "deploy1" } });
  };
  return { calls, commands, providers: createProviders(config, { ...workosEnv, RAILWAY_DEPLOY_TOKEN: "never-log", CLOUDFLARE_API_TOKEN: "never-log" }, {
    fetch: fetcher, pause: async () => {}, command: async (...args) => { commands.push(args); return "private CLI output"; },
  }) };
}
describe("release provider adapters", () => {
  it.each([[true,false],[false,true]])("refuses independent autodeploy before mutations (%s/%s)", async (r,p) => {
    const f = fixture(r,p); await expect(f.providers.inspect()).rejects.toThrow("autodeploy");
    expect(f.calls.every(row => !row.query || row.query.startsWith("query"))).toBe(true);
  });
  it("accepts a Pages project that omits AUTH_PROVIDER, and refuses another provider", async () => {
    await expect(fixture(false, false, undefined, 0, { AUTH_PROVIDER: null }).providers.inspect()).resolves.not.toThrow();
    await expect(fixture(false, false, undefined, 0, { AUTH_PROVIDER: "" }).providers.inspect()).resolves.not.toThrow();
    await expect(fixture(false, false, undefined, 0, { AUTH_PROVIDER: "auth0" }).providers.inspect())
      .rejects.toThrow("Pages production runtime variables do not match the channel/surface");
  });
  it("accepts Railway's null unmerged count when the staged-change patch is empty", async () => {
    // The live shape on a clean base environment: no fork count, an empty staged patch.
    const f = fixture(false, false, { unmergedChangesCount: null, stagedChanges: { id: "<empty>", status: "STAGED", patch: {} } });
    await expect(f.providers.inspect()).resolves.not.toThrow();
    expect(f.calls.find(row => row.query?.includes("PromotionState")).query).toContain("environmentStagedChanges(");
  });
  it.each([
    ["a staged change", { unmergedChangesCount: null, stagedChanges: { id: "patch1", patch: { services: { x: { source: { branch: "main" } } } } } }],
    ["unmerged fork changes", { unmergedChangesCount: 2, stagedChanges: { id: "<empty>", patch: {} } }],
    ["an unreadable staged state", { unmergedChangesCount: null, stagedChanges: null }],
  ])("refuses %s before mutations", async (_name, staged) => {
    const f = fixture(false, false, staged);
    await expect(f.providers.inspect()).rejects.toThrow("staged changes");
    expect(f.calls.every(row => !row.query || row.query.startsWith("query"))).toBe(true);
  });
  it("retargets Beta with deploys suppressed, then deploys only the event SHA", async () => {
    const f = fixture(); await f.providers.retarget(); const id = await f.providers.deploy(); await f.providers.waitDeployment(id);
    expect(f.calls.find(row => row.query?.includes("PromotionCommit")).query).toContain("skipDeploys:true");
    expect(f.calls.find(row => row.query?.includes("PromotionCommit")).query).toContain("environmentPatchCommit(");
    expect(f.calls.find(row => row.query?.includes("PromotionCommit")).variables.patch).toEqual({ services: { [config.serviceId]: { source: { branch: "release/1.2.3" } } } });
    // The source patch recreated a GitHub trigger; the retarget removed it again.
    expect(f.calls.filter(row => row.query?.includes("CutoverTriggerDelete")).map(row => row.variables.id)).toEqual(["recreated"]);
    expect(f.calls.some(row => row.query?.includes("environmentStageChanges"))).toBe(false);
    expect(f.calls.find(row => row.query?.includes("PromotionDeploy(")).variables.commitSha).toBe(sha);
    expect(f.calls.find(row => row.method === "PATCH").source.config.production_deployments_enabled).toBe(false);
  });
  it("builds with hosted guards, uploads a fixed SHA, and verifies the real manifest contract", async () => {
    const f = fixture(); expect(await f.providers.publishPages("app")).toEqual({ id: "page1", surface: "app" });
    expect(f.commands[0][2].env).toMatchObject({ CF_PAGES: "1", CF_PAGES_BRANCH: "release/1.2.3", CF_PAGES_COMMIT_SHA: sha });
    expect(f.commands[0][2].env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(f.commands[1][1]).toContain(sha);
    expect(JSON.stringify(f.commands.map(row => row[1]))).not.toContain("never-log");
  });
  it("waits for a retarget's transient staged change to settle before confirming it", async () => {
    const f = fixture(false, false, undefined, 2);
    await f.providers.retarget();
    // Two settling reads after the patch, then a clean confirmation.
    expect(f.calls.filter(row => row.query?.includes("PromotionState")).length).toBeGreaterThanOrEqual(4);
  });
  it("rejects a release branch older than the selected destination", () => {
    expect(() => assertNotOlderBranch("release/1.2.3", "release/1.3.0")).toThrow("superseded");
    expect(() => assertNotOlderBranch("release/1.10.0", "release/1.9.9")).not.toThrow();
  });
  it("never replays an ambiguous mutation and never returns provider body errors", async () => {
    let attempts = 0;
    const request = jsonClient(async () => { attempts++; throw new Error("private-token"); }, async () => {});
    await expect(request("https://example.invalid", {method:"POST"}, false)).rejects.not.toThrow("private-token");
    expect(attempts).toBe(1);
    await expect(request("https://example.invalid")).rejects.toThrow();
    expect(attempts).toBe(4);
  });
  it("bounds readiness waits", async () => {
    let reads = 0; await expect(poll(async () => { reads++; return false; }, { attempts: 2, sleep: async () => {} })).rejects.toThrow("timed out");
    expect(reads).toBe(2);
  });

  it("does not accept HTTP 200 until SHA, ledger manifest and maintenance all match", async () => {
    const manifest = { head: "0112_test.sql", sha256: "e".repeat(64) };
    const ready = { version: 1, ready: true, sourceSha: sha, channel: "beta", maintenance: false,
      migrations: { state: "current", head: manifest.head, expectedHead: manifest.head, manifestSha256: manifest.sha256 },
      cloud: { enabled: false, ready: true, state: "disabled" }, worker: null };
    const replies = [{ ...ready, sourceSha: "f".repeat(40) }, { ...ready, maintenance: true },
      { ...ready, migrations: { ...ready.migrations, state: "controlled" } },
      { ...ready, migrations: { ...ready.migrations, manifestSha256: "d".repeat(64) } }, ready];
    let reads = 0;
    const provider = createProviders(config, {}, { fetch: async () => { reads++; return Response.json(replies.shift()); }, pause: async () => {} });
    expect(await provider.waitIdentity(manifest)).toEqual(ready);
    expect(reads).toBe(5);
  });


  it("rejects a successful Railway deployment with another SHA", async () => {
    const provider = createProviders(config, {}, { fetch: async () => Response.json({ data: { deployment: {
      id: "d1", status: "SUCCESS", projectId: config.projectId, environmentId: config.environmentId, serviceId: config.serviceId,
      meta: { commitHash: "f".repeat(40), branch: config.branch },
    } } }), pause: async () => {} });
    await expect(provider.waitDeployment("d1")).rejects.toThrow("different source");
  });

});
