import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { loadConfig } from "../config.js";
import { createReleaseCanaryAdmissionRoutes, createReleaseCanaryDesignationRoutes } from "./release-canary-routes.js";
import { DatabaseReleaseCanaryService, DatabaseReleaseCanaryDesignationService, releaseCanaryDesignationConfiguration, releaseCanaryConfiguration } from "./release-canaries.js";

const owner = "11111111-1111-4111-8111-111111111111", credentialId = "22222222-2222-4222-8222-222222222222";
const token = "synthetic-release-only-admission-token";
const config = { ownerUserId: owner, organizationId: "33333333-3333-4333-8333-333333333333", channel: "alpha", sourceSha: "a".repeat(40),
  repository: "example/zeros", tokenSha256: createHash("sha256").update(token).digest("hex"), keys: {}, boat: {} } as any;
const input = { operationId: "44444444-4444-4444-8444-444444444444", expectedDesignationId: "0", credentialRevision: 1, enabled: true, models: ["gpt-5.6-luna"] };

function fakePool(selected?: any, ownerAllowed = true, uncertain = false) {
  const writes: any[] = [];
  const query = vi.fn(async (sql: string, values?: any[]) => {
    if (sql.includes("READ ONLY")) throw new Error("Canary transactions must permit consent locks and audited mutations");
    if (sql.includes("FROM users account")) return { rowCount: ownerAllowed ? 1 : 0, rows: [] };
    if (sql.includes("FROM cloud_agent_credentials")) return { rowCount: 1, rows: [{ id: credentialId, owner_user_id: owner, kind: "codex-chatgpt", revision: "1", current_version: 1, revoked_at: null }] };
    if (sql.includes("FROM audit_log pending")) return { rowCount: uncertain ? 1 : 0, rows: uncertain ? [{ busy: true }] : [] };
    if (sql.includes("FROM audit_log") && sql.includes("subject->>'operationId'")) return { rowCount: 0, rows: [] };
    if (sql.includes("FROM audit_log")) return { rowCount: selected ? 1 : 0, rows: selected ? [selected] : [] };
    if (sql.startsWith("INSERT INTO audit_log")) { writes.push(JSON.parse(values![3])); return { rowCount: 1, rows: [{ id: "42" }] }; }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { connect: async () => ({ query, release: vi.fn() }) } as any, query, writes };
}

describe("audited owner credential designation", () => {
  it("assembles release-only native admission before the first worker tuple and customer enablement", () => {
    const env = { DATABASE_URL: "postgresql://app@localhost/zeros", AUTH0_DOMAIN: "example.test", AUTH_AUDIENCE: "https://api.example.test",
      RAILWAY_ENVIRONMENT_NAME: "beta", RAILWAY_GIT_COMMIT_SHA: "a".repeat(40), CLOUD_WORKSPACES_ENABLED: "false",
      CLOUD_WORKSPACE_SECRET_KEYS_JSON: JSON.stringify({ "1": Buffer.alloc(32, 1).toString("base64url") }),
      BOAT_API_KEY: "synthetic-bootstrap-boat-key", BOAT_ACCOUNT_SCOPE: "shared-test-account",
      BOAT_BILLING_ORG: "team_66666666-6666-4666-8666-666666666666", ZEROS_RELEASE_CANARIES_ENABLED: "true",
      RUNTIME_QUALIFICATION_ACTOR_USER_ID: owner, WORKER_CANARY_ORGANIZATION_ID: config.organizationId,
      WORKER_CANARY_REPOSITORY: "example/zeros", WORKER_CANARY_ADMISSION_TOKEN: token,
      WORKER_ADMISSION_CONFIG_JSON: JSON.stringify({ version: 1, registry: { endpoint: `https://${"b".repeat(32)}.r2.cloudflarestorage.com`, bucket: "test-registry",
        accessKeyId: "synthetic-access-id", secretAccessKey: "synthetic-secret-key", encryptionKey: "c".repeat(64) },
        profile: { boat: { accountScope: "shared-test-account", billingOrg: "team_66666666-6666-4666-8666-666666666666", baseSnapshot: "test-base" },
          railway: { projectId: owner }, planetscale: { organization: "test-org", database: "test-db" }, cloudflare: { accountId: "b".repeat(32) } } }) };
    const server = loadConfig(env);
    expect(server.cloudWorkspaces).toBeNull();
    expect(releaseCanaryConfiguration(server, env)).toMatchObject({ channel: "beta", sourceSha: env.RAILWAY_GIT_COMMIT_SHA,
      keys: { currentKeyVersion: 1 }, boat: { apiKey: env.BOAT_API_KEY, billingOrg: env.BOAT_BILLING_ORG } });
    for (const changed of [{ BOAT_ACCOUNT_SCOPE: "wrong-account" }, { ZEROS_RELEASE_CANARIES_ENABLED: "false" },
      { WORKER_CANARY_ADMISSION_TOKEN: "short" }]) expect(releaseCanaryConfiguration(server, { ...env, ...changed })).toBeNull();
    expect(releaseCanaryConfiguration({ ...server, databaseMaintenanceMode: true }, env)).toBeNull();
    expect(releaseCanaryConfiguration({ ...server, deploymentChannel: "development" }, env)).toBeNull();
  });
  it("allows authenticated consent before the pipeline token, native keys and paid admission are enabled", async () => {
    const server = { deploymentChannel: "alpha", databaseMaintenanceMode: false } as any;
    const env = { RUNTIME_QUALIFICATION_ACTOR_USER_ID: owner, WORKER_CANARY_ORGANIZATION_ID: config.organizationId };
    const designation = releaseCanaryDesignationConfiguration(server, env)!;
    expect(designation).toEqual({ ownerUserId: owner, organizationId: config.organizationId, channel: "alpha" });
    expect(releaseCanaryConfiguration(server, env)).toBeNull();
    const service = new DatabaseReleaseCanaryDesignationService(fakePool().pool, designation);
    expect(await service.readDesignation(owner, credentialId)).toMatchObject({ enabled: false, lastUsedAt: null });
    expect(await service.designate(owner, credentialId, input)).toEqual({ designationId: "42", enabled: true });
    for (const changed of [{ deploymentChannel: "development" }, { databaseMaintenanceMode: true }])
      expect(releaseCanaryDesignationConfiguration({ ...server, ...changed }, env)).toBeNull();
  });
  it("reports last use and visibly invalidates approval after reconnecting", async () => {
    const selected = { id: "42", subject: { enabled: true, credentialRevision: 1, models: ["gpt-5.6-luna"] } };
    const available = fakePool(selected), original = available.query.getMockImplementation()!;
    available.query.mockImplementation(async (sql, values) => {
      if (sql.includes("created_at")) return { rowCount: 1, rows: [{ created_at: new Date("2026-09-29T12:00:00.000Z") }] };
      if (sql.includes("FROM cloud_agent_credentials")) return { rowCount: 1, rows: [{ id: credentialId, owner_user_id: owner, kind: "codex-chatgpt", revision: "2", current_version: 2, revoked_at: null }] };
      return original(sql, values);
    });
    expect(await new DatabaseReleaseCanaryService(available.pool, config).readDesignation(owner, credentialId)).toEqual({
      designationId: "42", credentialRevision: 2, enabled: false, models: [], lastUsedAt: "2026-09-29T12:00:00.000Z",
    });
  });
  it("defaults off and writes only exact owner credential consent, with a stable replay hash", async () => {
    const empty = fakePool(), service = new DatabaseReleaseCanaryService(empty.pool, config);
    expect(await service.readDesignation(owner, credentialId)).toMatchObject({ designationId: "0", enabled: false });
    expect(await service.designate(owner, credentialId, input)).toEqual({ designationId: "42", enabled: true });
    expect(empty.writes[0]).toMatchObject({ channel: "alpha", allowanceOwnerUserId: owner, credentialId });
    const subject = Object.fromEntries(Object.entries(empty.writes[0]).reverse()), replay = fakePool({ id: "42", subject });
    expect(await new DatabaseReleaseCanaryService(replay.pool, config).designate(owner, credentialId, input)).toEqual({ designationId: "42", enabled: true });
    expect(replay.writes).toHaveLength(0);
    await expect(new DatabaseReleaseCanaryService(replay.pool, config).designate(owner, credentialId, { ...input, enabled: false })).rejects.toThrow("operation changed");
  });
  it("refuses other users, inactive owners, stale revisions and extra credential material", async () => {
    const available = fakePool(), service = new DatabaseReleaseCanaryService(available.pool, config);
    await expect(service.designate(credentialId, credentialId, input)).rejects.toThrow("allowance");
    await expect(new DatabaseReleaseCanaryService(fakePool(undefined, false).pool, config).designate(owner, credentialId, input)).rejects.toThrow("allowance");
    await expect(service.designate(owner, credentialId, { ...input, credentialRevision: 2 })).rejects.toThrow("unavailable");
    await expect(service.designate(owner, credentialId, { ...input, material: "synthetic-never-accepted" })).rejects.toThrow("invalid");
    expect(available.writes).toHaveLength(0);
  });
  it("rejects admission before database access unless the release-only bearer is exact", async () => {
    const available = fakePool(), service = new DatabaseReleaseCanaryService(available.pool, config);
    for (const authorization of [undefined, "Bearer wrong-token", `Basic ${token}`]) {
      await expect(service.preflight({}, authorization)).rejects.toThrow("authentication");
      await expect(service.admit({}, authorization)).rejects.toThrow("authentication");
    }
    expect(available.query).not.toHaveBeenCalled();
  });
  it("fences a different operation while that designated credential has uncertain preparation or dispatch", async () => {
    const designation = { id: "42", action: "cloud.release_canary.designated", subject: { enabled: true, credentialId, credentialRevision: 1,
      channel: "alpha", allowanceOwnerUserId: owner, models: ["gpt-5.6-luna"] } };
    const available = fakePool(designation, true, true), service = new DatabaseReleaseCanaryService(available.pool, config);
    const operationId = "55555555-5555-4555-8555-555555555555";
    await expect(service.admit({ version: 1, ownerUserId: owner, organizationId: config.organizationId, channel: "alpha", sourceSha: config.sourceSha,
      repository: "example/zeros", operationId, runId: "123", runAttempt: "1", branch: "main", qualificationProfile: "smoke",
      credentialId, credentialRevision: 1, designationId: "42", kind: "codex-chatgpt", model: "gpt-5.6-luna",
      target: { id: "bx_test", attempt: operationId, snapshotId: "test-image", sourceCommit: config.sourceSha, buildSha256: "b".repeat(64) } }, `Bearer ${token}`)).rejects.toThrow("credential requires reconciliation");
    expect(available.writes).toHaveLength(0);
    expect(available.query.mock.calls.some(([sql]) => sql.includes("cloud_agent_credential_versions") || sql.includes("cloud_codex_auth_caches"))).toBe(false);
    const statements = available.query.mock.calls.map(([sql]) => sql);
    expect(statements.findIndex(sql => sql.includes("FROM cloud_agent_credentials") && sql.includes("FOR UPDATE"))).toBeLessThan(statements.findIndex(sql => sql.includes("FROM audit_log pending")));
  });
});

describe("server-discovered release canary designations", () => {
  const selection = { version: 1, ownerUserId: owner, organizationId: config.organizationId, channel: "alpha", sourceSha: config.sourceSha,
    repository: config.repository, qualificationProfile: "smoke", runId: "91", runAttempt: "2", branch: "main" };
  const candidates = () => [
    { id: "55555555-5555-4555-8555-555555555555", kind: "claude-setup-token", model: "claude-haiku-4-5" },
    { id: credentialId, kind: "codex-chatgpt", model: "gpt-5.6-luna" },
    { id: "66666666-6666-4666-8666-666666666666", kind: "cursor-api-key", model: "composer-2.5" },
  ].map((row, index) => ({ id: row.id, owner_user_id: owner, kind: row.kind, revision: "3", current_version: 4, revoked_at: null,
    designation_id: String(40 + index), designation_action: "cloud.release_canary.designated", designation_subject: {
      enabled: true, credentialId: row.id, credentialRevision: 3, channel: "alpha", allowanceOwnerUserId: owner, models: [row.model],
    } }));
  const serviceFor = (rows: ReturnType<typeof candidates>) => {
    const available = fakePool(), original = available.query.getMockImplementation()!;
    available.query.mockImplementation(async (sql, values) => sql.includes("JOIN LATERAL")
      ? { rowCount: rows.length, rows } : original(sql, values));
    return { ...available, service: new DatabaseReleaseCanaryService(available.pool, config) };
  };
  it("discovers only the exact three opted-in revisions/models without a CI-side list", async () => {
    const available = serviceFor(candidates());
    expect(await available.service.preflight(selection, `Bearer ${token}`)).toEqual({ ready: true, ...selection,
      connections: candidates().map(row => ({ kind: row.kind, credentialId: row.id, credentialRevision: 3,
        designationId: row.designation_id, model: row.designation_subject.models[0] })),
    });
    expect(available.query.mock.calls.every(([sql]) => !sql.includes("cloud_agent_credential_versions") && !sql.includes("cloud_codex_auth_caches"))).toBe(true);
    expect(available.writes).toHaveLength(0);
  });
  it("names each missing or ambiguous kind and never chooses one arbitrarily", async () => {
    for (const row of candidates()) {
      await expect(serviceFor(candidates().filter(candidate => candidate.kind !== row.kind)).service.preflight(selection, `Bearer ${token}`))
        .rejects.toThrow(`designation missing for ${row.kind}`);
      const duplicate = { ...row, id: "77777777-7777-4777-8777-777777777777", designation_id: "99",
        designation_subject: { ...row.designation_subject, credentialId: "77777777-7777-4777-8777-777777777777" } };
      await expect(serviceFor([...candidates(), duplicate]).service.preflight(selection, `Bearer ${token}`))
        .rejects.toThrow(`designation ambiguous for ${row.kind}`);
    }
  });
  it("excludes stale, revoked, disabled, wrong-owner and wrong-channel consent", async () => {
    for (const change of [
      { revision: "4" }, { revoked_at: new Date() }, { owner_user_id: credentialId },
      { designation_subject: { ...candidates()[0]!.designation_subject, enabled: false } },
      { designation_subject: { ...candidates()[0]!.designation_subject, channel: "beta" } },
    ]) {
      const rows = candidates(); rows[0] = { ...rows[0]!, ...change } as typeof rows[number];
      await expect(serviceFor(rows).service.preflight(selection, `Bearer ${token}`)).rejects.toThrow("designation missing for claude-setup-token");
    }
  });
  it("requires the pinned approved SMOKE model but binds an explicitly approved FULL model", async () => {
    const rows = candidates(); rows[0]!.designation_subject.models = ["explicit-full-test-model"];
    await expect(serviceFor(rows).service.preflight(selection, `Bearer ${token}`)).rejects.toThrow("model not approved for claude-setup-token");
    expect(await serviceFor(rows).service.preflight({ ...selection, qualificationProfile: "full" }, `Bearer ${token}`))
      .toMatchObject({ connections: [expect.objectContaining({ kind: "claude-setup-token", model: "explicit-full-test-model" }), expect.anything(), expect.anything()] });
  });
  it("rejects caller-supplied selections, wrong scope and invalid run binding before discovery", async () => {
    const available = serviceFor(candidates());
    for (const change of [{ connections: [] }, { sourceSha: "b".repeat(40) }, { branch: "release/1.2.3" }, { runAttempt: "0" }])
      await expect(available.service.preflight({ ...selection, ...change }, `Bearer ${token}`)).rejects.toThrow("canary");
    expect(available.query).not.toHaveBeenCalled();
  });
});

describe("release-only HTTP boundary", () => {
  const service = () => ({ preflight: vi.fn(async () => ({ ready: true })), admit: vi.fn(async () => ({ started: true })),
    readDesignation: vi.fn(async () => ({ enabled: false })), designate: vi.fn(async () => ({ enabled: true })) });
  const appFor = (selected: ReturnType<typeof service>) => {
    const app = new Hono();
    app.route("/", createReleaseCanaryAdmissionRoutes(selected));
    app.use("/v1/*", async (context, next) => { context.set("user", { id: owner } as any); await next(); });
    app.route("/", createReleaseCanaryDesignationRoutes(selected));
    app.onError((error, context) => error instanceof HTTPException ? error.getResponse() : error instanceof HttpError ? context.json({ error: error.code }, error.status) : context.json({ error: "unavailable" }, 500));
    return app;
  };
  it("exposes only bounded no-store admissions, never a user credential or workspace API", async () => {
    const selected = service(), app = appFor(selected);
    const response = await app.request("/internal/v1/release-canaries/admissions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(selected.admit).toHaveBeenCalledWith({}, `Bearer ${token}`);
    expect((await app.request("/internal/v1/release-canaries/credentials")).status).toBe(404);
    expect((await app.request("/internal/v1/release-canaries/admissions", { method: "POST", body: "x".repeat(16_385) })).status).toBe(413);
    expect(selected.admit).toHaveBeenCalledOnce();
  });
  it("binds designation to the authenticated user, not request identity fields", async () => {
    const selected = service(), app = appFor(selected);
    expect((await app.request(`/v1/cloud-agent-credentials/${credentialId}/release-canary`)).status).toBe(200);
    expect(selected.readDesignation).toHaveBeenCalledWith(owner, credentialId);
    await app.request(`/v1/cloud-agent-credentials/${credentialId}/release-canary`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(selected.designate).toHaveBeenCalledWith(owner, credentialId, input);
  });
});
