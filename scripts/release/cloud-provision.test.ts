import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../apps/control-plane/src/config";
import { releaseCanaryConfiguration } from "../../apps/control-plane/src/cloud-workspaces/release-canaries";
import { CHANNELS, type Channel } from "./contracts";
import { cloudProvisionConfig, cloudProvisionMain } from "./cloud-provision-cli";
import { CLOUD_CANARY_INPUTS, CLOUD_ENABLE_FLAGS, CLOUD_KEYRINGS, CLOUD_OWNER_SECRETS, CLOUD_WORKER_VARIABLES,
  cloudProvisionSummary, planCloudProvision } from "./cloud-provision";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const projectId = "11111111-1111-4111-8111-111111111111", environmentId = "22222222-2222-4222-8222-222222222222";
const serviceId = "33333333-3333-4333-8333-333333333333", actorId = "44444444-4444-4444-8444-444444444444";
const organizationId = "55555555-5555-4555-8555-555555555555";
const keyring = (version = 1) => JSON.stringify({ [version]: randomBytes(32).toString("base64url") });

function fixture(channel: Channel = "beta") {
  const inputs: NodeJS.ProcessEnv = {
    RELEASE_CHANNEL: channel, RELEASE_SHA: "a".repeat(40), GITHUB_SHA: "a".repeat(40),
    RELEASE_BRANCH: channel === "alpha" ? "main" : "release/0.1.20", GITHUB_REPOSITORY: "example/zeros",
    GITHUB_ACTIONS: "true", CI: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1",
    RAILWAY_PROJECT_ID: projectId, RAILWAY_ENVIRONMENT_ID: environmentId, RAILWAY_SERVICE_ID: serviceId,
    PLANETSCALE_DATABASE: `zeros-control-plane-${channel}`, RAILWAY_DEPLOY_TOKEN: "synthetic-railway-token",
    CLOUD_PROVISION_MODE: "apply", CLOUD_PROVISION_CONFIRM: `zeros-control-plane-${channel}`,
    BOAT_ACCOUNT_SCOPE: "shared-test-account", BOAT_BILLING_ORG: "team_66666666-6666-4666-8666-666666666666",
    BOAT_API_KEY: "synthetic-non-admin-boat-key", CLOUD_WORKSPACE_S3_ACCESS_KEY_ID: "synthetic-r2-access-id",
    CLOUD_WORKSPACE_S3_SECRET_ACCESS_KEY: "synthetic-r2-secret-key", RESEND_API_KEY: "synthetic-resend-key",
    CLOUD_ACCOUNT_ID: "a".repeat(32),
  };
  const current: Record<string, string> = {
    DATABASE_URL: "postgresql://app:synthetic-database-password@database.test:5432/zeros",
    NODE_ENV: "production", AUTH_PROVIDER: "workos", AUTH_AUDIENCE: CHANNELS[channel].api,
    AUTH_ISSUER: "https://auth.example.test", AUTH_JWKS_URL: "https://auth.example.test/jwks",
    AUTH_WEB_CLIENT_ID: "test-web-client", AUTH_DESKTOP_CLIENT_ID: "test-desktop-client", APP_ORIGIN: CHANNELS[channel].app,
    WORKOS_API_KEY: "synthetic-workos-key", WORKOS_COOKIE_PASSWORD: "synthetic-cookie-password-at-least-32-characters",
    WORKOS_WEBHOOK_SECRET: "synthetic-webhook-secret", GITHUB_APP_ID: "1", GITHUB_APP_CLIENT_ID: "test-app-client",
    GITHUB_APP_CLIENT_SECRET: "synthetic-github-client-secret", GITHUB_APP_SLUG: "test-app", GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_OAUTH_CALLBACK_URL: `${CHANNELS[channel].api}/github/callback`,
    GITHUB_COMPLETION_PAGE_URL: `${CHANNELS[channel].app}/github/connected`,
    ...(CHANNELS[channel].ops ? { OPS_ORIGIN: CHANNELS[channel].ops! } : {}),
  };
  return { channel, inputs, current };
}
function tuple(channel: Channel = "beta") {
  return { CLOUD_WORKSPACE_PROVIDER: "boat", BOAT_SNAPSHOT_ID: `zeros-${channel}-qualified-test`, BOAT_IMAGE_BUILD_SHA256: "b".repeat(64),
    ZEROS_CLOUD_SOURCE_COMMIT: "a".repeat(40), ZEROS_CLOUD_IMAGE_ARCHITECTURE: "linux/amd64", CLOUD_WORKSPACE_STORAGE_MIB: "20480" };
}
function qualifiedIdentity(channel: Channel = "beta", selected = tuple(channel)) {
  return { version: 1, ready: true, sourceSha: "a".repeat(40), channel, maintenance: false,
    migrations: { state: "current", head: "0001_initial.sql", expectedHead: "0001_initial.sql", manifestSha256: "d".repeat(64) },
    cloud: { enabled: false, ready: true, state: "disabled" }, workerQualified: true,
    worker: { provider: selected.CLOUD_WORKSPACE_PROVIDER, imageRef: `boat:${selected.BOAT_SNAPSHOT_ID}@sha256:${selected.BOAT_IMAGE_BUILD_SHA256}`,
      sourceSha: selected.ZEROS_CLOUD_SOURCE_COMMIT, architecture: selected.ZEROS_CLOUD_IMAGE_ARCHITECTURE, storageMiB: Number(selected.CLOUD_WORKSPACE_STORAGE_MIB) } };
}
function canaries(inputs: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ZEROS_RELEASE_CANARIES_ENABLED: "true", RUNTIME_QUALIFICATION_ACTOR_USER_ID: actorId,
    WORKER_CANARY_ORGANIZATION_ID: organizationId, WORKER_CANARY_REPOSITORY: "example/zeros",
    WORKER_CANARY_ADMISSION_TOKEN: "synthetic-admission-token-at-least-32-characters",
    WORKER_ADMISSION_CONFIG_JSON: JSON.stringify({ version: 1, registry: {
      endpoint: `https://${"b".repeat(32)}.r2.cloudflarestorage.com`, bucket: "synthetic-shared-registry",
      accessKeyId: "synthetic-registry-access-id", secretAccessKey: "synthetic-registry-secret", encryptionKey: "c".repeat(64),
    }, profile: { boat: { accountScope: inputs.BOAT_ACCOUNT_SCOPE, billingOrg: inputs.BOAT_BILLING_ORG, baseSnapshot: "test-base" },
      railway: { projectId }, planetscale: { organization: "test-organization", database: "test-dev-database" },
      cloudflare: { accountId: "b".repeat(32) } } }),
  };
}
function generated(plan: ReturnType<typeof planCloudProvision>) {
  return Object.fromEntries(plan.generate.map(name => [name, keyring()]));
}
function statuses(plan: ReturnType<typeof planCloudProvision>) {
  return Object.fromEntries(plan.rows.map(row => [row.name, row.status]));
}

describe("cloud backend planning", () => {
  it("does not label a complete but unproved worker tuple qualified", () => {
    const options = fixture(); Object.assign(options.current, tuple());
    const plan = planCloudProvision({ ...options, enableCloud: true });
    expect(plan.enableGate).toMatchObject({ ok: false });
    expect(plan.enableGate.names).toContain("WORKER_QUALIFICATION");
    expect(CLOUD_ENABLE_FLAGS.every(name => plan.desired[name] === "false")).toBe(true);
  });
  it("materializes a real cloud-off account/canary bootstrap without inventing any worker tuple", () => {
    const options = fixture(); Object.assign(options.inputs, canaries(options.inputs));
    const initial = planCloudProvision(options);
    const materialized = planCloudProvision({ ...options, generatedKeyrings: generated(initial) });
    const values = { ...options.current, ...materialized.desired, RAILWAY_ENVIRONMENT_NAME: options.channel,
      RAILWAY_GIT_COMMIT_SHA: options.inputs.RELEASE_SHA };
    const server = loadConfig(values, { error: () => {}, warn: () => {} });
    expect(server.cloudWorkspaces).toBeNull(); expect(server.selectedCloudWorker).toBeNull();
    expect(releaseCanaryConfiguration(server, values) !== null).toBe(true);
    expect(CLOUD_WORKER_VARIABLES.every(name => !Object.hasOwn(materialized.changes, name))).toBe(true);
  });
  it("preserves existing enabled and deliberately paused worker states on repeat provisioning", () => {
    const options = fixture(); Object.assign(options.current, tuple(), { CLOUD_WORKSPACES_ENABLED: "true",
      CLOUD_WORKSPACE_BACKGROUND_WORKERS_ENABLED: "false", CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "true" });
    const plan = planCloudProvision(options);
    expect(plan.validation.ok).toBe(true);
    expect(CLOUD_ENABLE_FLAGS.every(name => plan.desired[name] === options.current[name] && !Object.hasOwn(plan.changes, name))).toBe(true);
  });
  it("never repairs an invalid enabled state by silently turning cloud off", () => {
    const options = fixture(); options.current.CLOUD_WORKSPACES_ENABLED = "true";
    const plan = planCloudProvision(options);
    expect(plan.desired.CLOUD_WORKSPACES_ENABLED).toBe("true");
    expect(plan.validation.ok).toBe(false); expect(plan.validation.names).toContain("BOAT_SNAPSHOT_ID");
    expect(Object.hasOwn(plan.changes, "CLOUD_WORKSPACES_ENABLED")).toBe(false);
  });
  it("plans constants, generation and worker-owned missing inputs without materializing secrets or a tuple", () => {
    const plan = planCloudProvision(fixture());
    expect(plan.validation).toEqual({ ok: true, names: [] });
    expect(plan.missingInputs).toEqual([]);
    expect(plan.workerMissing).toEqual([...CLOUD_WORKER_VARIABLES]);
    expect(plan.generate).toEqual(CLOUD_KEYRINGS.map(row => row.name));
    expect(CLOUD_KEYRINGS.every(row => statuses(plan)[row.name] === "generate" && !Object.hasOwn(plan.changes, row.name))).toBe(true);
    expect(CLOUD_WORKER_VARIABLES.some(name => Object.hasOwn(plan.changes, name))).toBe(false);
    expect(CLOUD_ENABLE_FLAGS.every(name => plan.desired[name] === "false")).toBe(true);
    expect(statuses(plan).BOAT_ACCOUNT_SCOPE).toBe("set");
    expect(CLOUD_CANARY_INPUTS.every(name => statuses(plan)[name] === "missing-input")).toBe(true);
    expect(plan.desired.CLOUD_WORKSPACE_OBJECT_RESTORE_WINDOW_HOURS).toBe("336");
    expect(plan.desired.CLOUD_WORKSPACE_CPU_MILLICORES).toBe("4000");
    expect(plan.desired.CLOUD_WORKSPACE_MEMORY_MIB).toBe("8192");
  });
  it.each(["beta", "production"] as const)("derives %s origins/bucket, prefers an explicit endpoint and preserves its policy label", channel => {
    const options = fixture(channel);
    options.inputs.CLOUD_WORKSPACE_S3_ENDPOINT = "https://storage.example.test";
    options.current.BOAT_COMPUTE_POLICY_ID = "existing-channel-policy-v2";
    const plan = planCloudProvision(options);
    expect(plan.desired.CLOUD_WORKSPACE_S3_ENDPOINT).toBe("https://storage.example.test");
    expect(plan.desired.CLOUD_WORKSPACE_S3_BUCKET).toBe(`zeros-cloud-workspaces-${channel}`);
    expect(plan.desired.CLOUD_WORKSPACE_CONTROL_PLANE_URL).toBe(CHANNELS[channel].api);
    expect(statuses(plan).BOAT_COMPUTE_POLICY_ID).toBe("kept-existing");
    expect(plan.desired.BOAT_COMPUTE_POLICY_ID === options.current.BOAT_COMPUTE_POLICY_ID).toBe(true);
    expect(plan.validation.ok).toBe(true);
  });
  it("uses the Cloudflare account fallback and reports absent or malformed endpoint inputs by name", () => {
    const options = fixture();
    delete options.inputs.CLOUD_ACCOUNT_ID;
    options.inputs.CLOUDFLARE_ACCOUNT_ID = "d".repeat(32);
    expect(planCloudProvision(options).desired.CLOUD_WORKSPACE_S3_ENDPOINT).toBe(`https://${"d".repeat(32)}.r2.cloudflarestorage.com`);
    delete options.inputs.CLOUDFLARE_ACCOUNT_ID;
    expect(planCloudProvision(options).missingInputs).toContain("CLOUD_WORKSPACE_S3_ENDPOINT");
    options.inputs.CLOUD_ACCOUNT_ID = "synthetic-r2-secret-key";
    expect(planCloudProvision(options).missingInputs).toContain("CLOUD_ACCOUNT_ID");
  });
  it("retains a selected price policy's pricing and TTL instead of changing that policy on a repeat provision", () => {
    const options = fixture();
    Object.assign(options.current, { BOAT_COMPUTE_POLICY_ID: "qualified-price-policy-v2", BOAT_SECONDS_PER_DOLLAR: "200000", BOAT_TTL_SECONDS: "1200" });
    const plan = planCloudProvision(options);
    expect(["BOAT_SECONDS_PER_DOLLAR", "BOAT_TTL_SECONDS"].every(name => statuses(plan)[name] === "kept-existing" &&
      plan.desired[name] === options.current[name] && !Object.hasOwn(plan.changes, name))).toBe(true);
    expect(plan.validation.ok).toBe(true);
  });
  it("sets the worker lane's channel marker without taking ownership of its tuple", () => {
    const plan = planCloudProvision(fixture());
    expect(plan.desired.ZEROS_DEPLOY_ENV).toBe("beta");
    expect(CLOUD_WORKER_VARIABLES.some(name => Object.hasOwn(plan.changes, name))).toBe(false);
  });
  it("requires shared Boat identity inputs even when Railway already has them", () => {
    const options = fixture();
    options.current.BOAT_ACCOUNT_SCOPE = options.inputs.BOAT_ACCOUNT_SCOPE!;
    options.current.BOAT_BILLING_ORG = options.inputs.BOAT_BILLING_ORG!;
    delete options.inputs.BOAT_ACCOUNT_SCOPE; delete options.inputs.BOAT_BILLING_ORG;
    const plan = planCloudProvision(options);
    expect(plan.missingInputs).toEqual(["BOAT_ACCOUNT_SCOPE", "BOAT_BILLING_ORG"]);
    expect(statuses(plan).BOAT_ACCOUNT_SCOPE).toBe("missing-input");
    expect(Object.hasOwn(plan.changes, "BOAT_ACCOUNT_SCOPE")).toBe(false);
  });
  it("distinguishes unchanged, set, kept-existing and missing owner credentials without printing values", () => {
    const options = fixture();
    options.current.BOAT_API_KEY = options.inputs.BOAT_API_KEY!;
    options.current.CLOUD_WORKSPACE_S3_ACCESS_KEY_ID = "old-synthetic-access-id";
    options.current.RESEND_API_KEY = options.inputs.RESEND_API_KEY!;
    delete options.inputs.RESEND_API_KEY; delete options.inputs.CLOUD_WORKSPACE_S3_SECRET_ACCESS_KEY;
    const plan = planCloudProvision(options), rows = statuses(plan);
    expect(rows.BOAT_API_KEY).toBe("unchanged");
    expect(rows.CLOUD_WORKSPACE_S3_ACCESS_KEY_ID).toBe("set");
    expect(rows.RESEND_API_KEY).toBe("kept-existing");
    expect(rows.CLOUD_WORKSPACE_S3_SECRET_ACCESS_KEY).toBe("missing-input");
    const output = cloudProvisionSummary(plan).join("\n");
    expect([...Object.values(options.inputs), privateKey, "old-synthetic-access-id"].filter(value => value && value.length > 16)
      .some(value => output.includes(value!))).toBe(false);
  });
  it("generates independent keyrings once, and preserves every stored version and byte on repeat", () => {
    const options = fixture();
    const first = planCloudProvision(options), rings = generated(first);
    const materialized = planCloudProvision({ ...options, generatedKeyrings: rings });
    expect(new Set(Object.values(rings)).size).toBe(3);
    expect(materialized.validation.ok).toBe(true);
    const current = { ...options.current, ...materialized.desired };
    const repeat = planCloudProvision({ ...options, current });
    expect(repeat.generate).toEqual([]);
    expect(Object.keys(repeat.changes)).toEqual([]);
    for (const ring of CLOUD_KEYRINGS) {
      expect(repeat.desired[ring.name] === rings[ring.name]).toBe(true);
      current[ring.name] = keyring(7); current[ring.version] = "7";
    }
    const versioned = planCloudProvision({ ...options, current, generatedKeyrings: rings });
    expect(versioned.validation.ok).toBe(true);
    expect(versioned.generate).toEqual([]);
    expect(CLOUD_KEYRINGS.every(ring => versioned.desired[ring.name] === current[ring.name] && versioned.desired[ring.version] === "7" &&
      !Object.hasOwn(versioned.changes, ring.name) && !Object.hasOwn(versioned.changes, ring.version))).toBe(true);
  });
  it("adopts supported legacy V1 keys without rotation, and never repairs incomplete or invalid stored keyrings", () => {
    const options = fixture();
    for (const ring of CLOUD_KEYRINGS.slice(0, 2)) options.current[ring.legacy!] = randomBytes(32).toString("base64url");
    const legacy = planCloudProvision(options);
    expect(legacy.generate).toEqual([CLOUD_KEYRINGS[2].name]);
    expect(legacy.validation.ok).toBe(true);
    expect(CLOUD_KEYRINGS.slice(0, 2).every(ring => JSON.parse(legacy.desired[ring.name])["1"] === options.current[ring.legacy!] )).toBe(true);
    const ring = CLOUD_KEYRINGS[0];
    delete options.current[ring.legacy!]; options.current[ring.version] = "8";
    const partial = planCloudProvision(options);
    expect(partial.generate.includes(ring.name)).toBe(false);
    expect(partial.missingInputs).toContain(ring.name);
    options.current[ring.name] = "private-invalid-keyring-sentinel";
    const invalid = planCloudProvision(options);
    expect(invalid.validation.ok).toBe(false);
    expect(Object.hasOwn(invalid.changes, ring.name)).toBe(false);
    expect(cloudProvisionSummary(invalid).join("\n").includes(options.current[ring.name])).toBe(false);
  });
  it("fills only an unambiguous missing V1 selector, never guesses the current version of a multi-version ring", () => {
    const options = fixture(), ring = CLOUD_KEYRINGS[0];
    options.current[ring.name] = keyring();
    expect(planCloudProvision(options).desired[ring.version]).toBe("1");
    options.current[ring.name] = JSON.stringify({ ...JSON.parse(keyring()), ...JSON.parse(keyring(2)) });
    expect(planCloudProvision(options).missingInputs).toContain(ring.version);
    expect(Object.hasOwn(planCloudProvision(options).changes, ring.version)).toBe(false);
  });
  it("validates the generated full managed-Boat configuration with the real config loader", () => {
    const options = fixture(); Object.assign(options.current, tuple());
    const plan = planCloudProvision({ ...options, enableCloud: true, qualification: qualifiedIdentity() });
    const materialized = planCloudProvision({ ...options, enableCloud: true, qualification: qualifiedIdentity(), generatedKeyrings: generated(plan) });
    expect(materialized.validation.ok).toBe(true); expect(materialized.enableGate.ok).toBe(true);
    const config = loadConfig({ ...options.current, ...materialized.desired, DATABASE_URL: "postgresql://app@localhost:5432/zeros" },
      { error: () => {}, warn: () => {} });
    expect(config.cloudWorkspaces?.durability?.objectRestoreWindowMs).toBe(336 * 3_600_000);
    expect(config.cloudWorkspaces?.setupExecution !== null).toBe(true);
    expect(config.cloudWorkspaces?.backgroundWorkersEnabled).toBe(true);
    expect(config.cloudWorkspaces?.codexRefreshFingerprints?.currentKeyVersion).toBe(1);
    expect(CLOUD_KEYRINGS.every(ring => {
      const decoded = JSON.parse(materialized.desired[ring.name]);
      return Object.keys(decoded).join() === "1" && Buffer.from(decoded["1"], "base64url").length === 32 &&
        Buffer.from(decoded["1"], "base64url").toString("base64url") === decoded["1"];
    })).toBe(true);
  });
  it.each(CLOUD_WORKER_VARIABLES)("keeps every enable flag off if the worker lane has not set %s", name => {
    const options = fixture(); Object.assign(options.current, tuple()); delete options.current[name];
    const plan = planCloudProvision({ ...options, enableCloud: true });
    expect(plan.enableGate.ok).toBe(false); expect(plan.enableGate.names).toContain(name);
    expect(CLOUD_ENABLE_FLAGS.every(flag => plan.desired[flag] === "false")).toBe(true);
    expect(CLOUD_WORKER_VARIABLES.some(field => Object.hasOwn(plan.changes, field))).toBe(false);
  });
  it.each([["BOAT_IMAGE_BUILD_SHA256", "invalid"], ["ZEROS_CLOUD_IMAGE_ARCHITECTURE", "linux/arm64"],
    ["CLOUD_WORKSPACE_STORAGE_MIB", "0"], ["CLOUD_WORKSPACE_PROVIDER", "daytona"]])("rejects an invalid selected tuple field %s", (name, value) => {
    const options = fixture(); Object.assign(options.current, tuple(), { [name]: value });
    const plan = planCloudProvision({ ...options, enableCloud: true });
    expect(plan.validation.ok).toBe(false); expect(plan.enableGate.ok).toBe(false);
    expect(CLOUD_ENABLE_FLAGS.every(flag => plan.desired[flag] === "false")).toBe(true);
  });
  it("validates optional release canaries and shared identity without treating the profile's canonical targets as channel targets", () => {
    const options = fixture(); Object.assign(options.inputs, canaries(options.inputs));
    expect(planCloudProvision(options).validation.ok).toBe(true);
    options.inputs.BOAT_ACCOUNT_SCOPE = "wrong-account";
    expect(planCloudProvision(options).validation.names).toContain("WORKER_ADMISSION_CONFIG_JSON");
    options.inputs.BOAT_ACCOUNT_SCOPE = "shared-test-account";
    delete options.inputs.WORKER_CANARY_ADMISSION_TOKEN;
    expect(planCloudProvision(options).validation.names).toContain("WORKER_CANARY_ADMISSION_TOKEN");
    expect(planCloudProvision(options).generate.includes("WORKER_CANARY_ADMISSION_TOKEN")).toBe(false);
  });
  it("refuses to silently enable previews or hide invalid existing API auth/keys", () => {
    const options = fixture(); options.current.CLOUD_WORKSPACE_PREVIEW_BASE_DOMAIN = "preview.example.test";
    expect(planCloudProvision(options).missingInputs).toContain("CLOUD_WORKSPACE_PREVIEW_BASE_DOMAIN");
    delete options.current.CLOUD_WORKSPACE_PREVIEW_BASE_DOMAIN;
    options.current.AUTH_JWKS_URL = "private-invalid-url-sentinel";
    expect(planCloudProvision(options).validation.names).toContain("AUTH_JWKS_URL");
    expect(cloudProvisionSummary(planCloudProvision(options)).join("\n").includes(options.current.AUTH_JWKS_URL)).toBe(false);
  });
});

function railwayHarness(channel: Channel = "beta") {
  const options = fixture(channel), variables = { ...options.current }, logs: string[] = [], writes: Record<string, any>[] = [];
  let reads = 0;
  const state = { failWrite: false, lostWrite: false, omitReadback: "", race: false, autoDeploy: false, wrongTarget: false,
    identity: qualifiedIdentity(channel) as unknown, qualificationReads: 0, revokeOnRecheck: false };
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url) === `${CHANNELS[channel].api}/v1/release-identity`) {
      state.qualificationReads++;
      if (state.revokeOnRecheck && state.qualificationReads > 1) return Response.json({ ...qualifiedIdentity(channel), workerQualified: false });
      return Response.json(state.identity);
    }
    if (String(url) !== "https://backboard.railway.com/graphql/v2") throw new Error("Unexpected request");
    const request = JSON.parse(String(init?.body));
    if (request.query.trim().startsWith("mutation")) {
      writes.push(request.variables.input);
      if (state.failWrite) return Response.json({ errors: [{ message: options.inputs.BOAT_API_KEY }] });
      Object.assign(variables, request.variables.input.variables);
      if (state.lostWrite) throw new Error(options.inputs.CLOUD_WORKSPACE_S3_SECRET_ACCESS_KEY);
      return Response.json({ data: { variableCollectionUpsert: true } });
    }
    reads++;
    if (state.race && reads === 2) variables.CLOUD_WORKSPACE_SECRET_KEYS_JSON = keyring();
    const rendered = { ...variables }; if (writes.length && state.omitReadback) delete rendered[state.omitReadback];
    return Response.json({ data: { variables: rendered, environment: { id: state.wrongTarget ? serviceId : environmentId,
      projectId, name: channel, unmergedChangesCount: 0,
      config: { services: { [serviceId]: { source: { repo: "example/zeros", branch: options.inputs.RELEASE_BRANCH, rootDirectory: "apps/control-plane" } } } } },
      serviceInstance: { serviceId, environmentId, domains: { customDomains: [{ domain: new URL(CHANNELS[channel].api).hostname }] } },
      serviceInstanceAutoDeployStatus: { enabled: state.autoDeploy }, environmentStagedChanges: { patch: {} } } });
  };
  const createKeyring = vi.fn(() => keyring());
  const dependencies = { fetch: fetcher, pause: async () => {}, log: (line: string) => logs.push(line), createKeyring };
  return { ...options, variables, logs, writes, state, createKeyring, dependencies, run: () => cloudProvisionMain(options.inputs, dependencies) };
}

describe("guarded cloud backend CLI", () => {
  it("leaves plans read-only, including Alpha, and never generates plan keys", async () => {
    for (const channel of ["alpha", "beta", "production"] as const) {
      const harness = railwayHarness(channel); harness.inputs.CLOUD_PROVISION_MODE = "plan";
      expect(await harness.run()).toEqual({ mode: "plan", changed: false });
      expect(harness.writes.length).toBe(0); expect(harness.createKeyring.mock.calls.length).toBe(0);
    }
  });
  it("refuses Alpha apply and unconfirmed/non-dispatch/wrong-database mutations before network access", async () => {
    const alpha = railwayHarness("alpha");
    await expect(alpha.run()).rejects.toThrow("RELEASE_CHANNEL fail"); expect(alpha.writes.length).toBe(0);
    for (const patch of [{ CLOUD_PROVISION_CONFIRM: "wrong" }, { GITHUB_EVENT_NAME: "pull_request" },
      { PLANETSCALE_DATABASE: "zeros-control-plane-production" }, { RELEASE_BRANCH: "main" }]) {
      const harness = railwayHarness(); Object.assign(harness.inputs, patch);
      await expect(harness.run()).rejects.toThrow(/fail/);
      expect(harness.writes.length).toBe(0); expect(harness.logs.length).toBe(0);
    }
    expect(() => cloudProvisionConfig({ ...fixture().inputs, CLOUD_PROVISION_ENABLE_CLOUD: "yes" })).toThrow("CLOUD_PROVISION_ENABLE_CLOUD fail");
  });
  it("uses one non-deploying upsert, verifies readback, and does not regenerate or write on an identical repeat", async () => {
    const harness = railwayHarness();
    expect(await harness.run()).toEqual({ mode: "apply", changed: true });
    expect(harness.writes.length).toBe(1); expect(harness.createKeyring.mock.calls.length).toBe(3);
    expect(harness.writes[0].replace).toBe(false); expect(harness.writes[0].skipDeploys).toBe(true);
    expect(harness.writes[0].projectId).toBe(projectId); expect(harness.writes[0].environmentId).toBe(environmentId);
    expect(CLOUD_WORKER_VARIABLES.some(name => Object.hasOwn(harness.writes[0].variables, name))).toBe(false);
    expect(await harness.run()).toEqual({ mode: "apply", changed: false });
    expect(harness.writes.length).toBe(1); expect(harness.createKeyring.mock.calls.length).toBe(3);
  });
  it("reconciles a lost response by readback without another mutation or key generation", async () => {
    const harness = railwayHarness(); harness.state.lostWrite = true;
    expect(await harness.run()).toEqual({ mode: "apply", changed: true });
    expect(harness.writes.length).toBe(1); expect(harness.createKeyring.mock.calls.length).toBe(3);
  });
  it.each(["BOAT_ACCOUNT_SCOPE", "BOAT_BILLING_ORG"])("refuses apply with missing shared %s even if it is stored", async name => {
    const harness = railwayHarness(); harness.variables[name] = harness.inputs[name]!; delete harness.inputs[name];
    await expect(harness.run()).rejects.toThrow(`${name} fail`);
    expect(harness.writes.length).toBe(0); expect(harness.createKeyring.mock.calls.length).toBe(0);
  });
  it("refuses an enable request before the complete tuple, then enables atomically without changing that tuple", async () => {
    const harness = railwayHarness(); harness.inputs.CLOUD_PROVISION_ENABLE_CLOUD = "true";
    await expect(harness.run()).rejects.toThrow("BOAT_SNAPSHOT_ID fail"); expect(harness.writes.length).toBe(0);
    Object.assign(harness.variables, tuple());
    expect(await harness.run()).toEqual({ mode: "apply", changed: true });
    expect(CLOUD_ENABLE_FLAGS.every(name => harness.writes[0].variables[name] === "true")).toBe(true);
    expect(CLOUD_WORKER_VARIABLES.some(name => Object.hasOwn(harness.writes[0].variables, name))).toBe(false);
    delete harness.inputs.CLOUD_PROVISION_ENABLE_CLOUD;
    expect(await harness.run()).toEqual({ mode: "apply", changed: false });
    expect(CLOUD_ENABLE_FLAGS.every(name => harness.variables[name] === "true")).toBe(true);
    expect(harness.writes.length).toBe(1);
  });
  it("refuses unqualified, mismatched, stale-source, wrong-channel and unavailable worker approval without writes", async () => {
    const approved = qualifiedIdentity();
    for (const identity of [{ ...approved, workerQualified: false }, { ...approved, workerQualified: undefined },
      { ...approved, worker: { ...approved.worker, imageRef: `boat:wrong-worker@sha256:${"e".repeat(64)}` } },
      { ...approved, worker: { ...approved.worker, storageMiB: 40960 } }, { ...approved, worker: { ...approved.worker, sourceSha: "f".repeat(40) } },
      { ...approved, sourceSha: "f".repeat(40) }, { ...approved, channel: "production" },
      { ...approved, migrations: { ...approved.migrations, head: "0002_pending.sql" } }, null]) {
      const harness = railwayHarness(); Object.assign(harness.variables, tuple());
      harness.inputs.CLOUD_PROVISION_ENABLE_CLOUD = "true"; harness.state.identity = identity;
      await expect(harness.run()).rejects.toThrow("WORKER_QUALIFICATION fail");
      expect(harness.writes.length).toBe(0); expect(harness.createKeyring).not.toHaveBeenCalled();
    }
    const revoked = railwayHarness(); Object.assign(revoked.variables, tuple());
    revoked.inputs.CLOUD_PROVISION_ENABLE_CLOUD = "true"; revoked.state.revokeOnRecheck = true;
    await expect(revoked.run()).rejects.toThrow("WORKER_QUALIFICATION fail"); expect(revoked.writes.length).toBe(0);
  });
  it("rejects target drift, autodeploy, racing variable writes, invalid generated keys and incomplete readback", async () => {
    for (const state of [{ wrongTarget: true }, { autoDeploy: true }, { race: true }]) {
      const harness = railwayHarness(); Object.assign(harness.state, state);
      await expect(harness.run()).rejects.toThrow(/RAILWAY_(?:TARGET|VARIABLES) fail/);
      expect(harness.writes.length).toBe(0); expect(harness.createKeyring.mock.calls.length).toBe(0);
    }
    const invalid = railwayHarness(); invalid.createKeyring.mockReturnValue("private-invalid-generated-key-sentinel");
    await expect(invalid.run()).rejects.toThrow("CLOUD_WORKSPACE_SECRET_KEYS_JSON fail"); expect(invalid.writes.length).toBe(0);
    const readback = railwayHarness(); readback.state.omitReadback = "CLOUD_WORKSPACE_S3_SECRET_ACCESS_KEY";
    await expect(readback.run()).rejects.toThrow("CLOUD_WORKSPACE_S3_SECRET_ACCESS_KEY fail"); expect(readback.writes.length).toBe(1);
  });
  it("never emits credentials or generated key material in output, config diagnostics, provider errors or thrown messages", async () => {
    const output: string[] = [];
    const spies = ["log", "warn", "error"].map(method => vi.spyOn(console, method as "log").mockImplementation((...values) => { output.push(values.join(" ")); }));
    try {
      const harness = railwayHarness(); Object.assign(harness.inputs, canaries(harness.inputs));
      harness.variables.INTERCOM_TOKEN = "synthetic-intercom-key"; harness.variables.INTERCOM_REGION = "private-diagnostic-sentinel";
      await cloudProvisionMain(harness.inputs, { ...harness.dependencies, log: undefined });
      const secrets = [...CLOUD_OWNER_SECRETS, "RAILWAY_DEPLOY_TOKEN", "WORKER_CANARY_ADMISSION_TOKEN", "WORKER_ADMISSION_CONFIG_JSON"]
        .map(name => harness.inputs[name]!).concat(privateKey, "private-diagnostic-sentinel", ...CLOUD_KEYRINGS.flatMap(ring =>
          [harness.variables[ring.name], ...Object.values(JSON.parse(harness.variables[ring.name])) as string[]]));
      harness.state.failWrite = true; harness.inputs.BOAT_API_KEY = "different-synthetic-boat-key"; secrets.push(harness.inputs.BOAT_API_KEY);
      try { await cloudProvisionMain(harness.inputs, { ...harness.dependencies, log: undefined }); } catch (error) { output.push(String(error)); }
      harness.variables.GITHUB_APP_PRIVATE_KEY = "private-malformed-rsa-key-sentinel"; secrets.push(harness.variables.GITHUB_APP_PRIVATE_KEY);
      try { await cloudProvisionMain(harness.inputs, { ...harness.dependencies, log: undefined }); } catch (error) { output.push(String(error)); }
      expect(output.length > 0).toBe(true);
      expect(secrets.some(secret => output.join("\n").includes(secret))).toBe(false);
    } finally { for (const spy of spies) spy.mockRestore(); }
  });
});
