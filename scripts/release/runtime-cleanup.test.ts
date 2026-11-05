import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRuntimeCleanup } from "./runtime-cleanup";
import { runtimeReleaseConfig } from "./runtime-contracts";
import { prepareRuntimeDatabase, withRuntimeDatabase } from "./runtime-database";
import { withRuntimeHandoff, writeRuntimeHandoff } from "./runtime-handoff";
import { runtimeJournal, type RuntimeEventDetail } from "./runtime-journal";
import { writeRuntimeJson } from "./runtime-artifacts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-cleanup-composition-")); roots.push(root);
  const workspace = join(root, "workspace"), temporary = join(root, "temporary"); await mkdir(workspace); await mkdir(temporary);
  const env = { RUNNER_ENVIRONMENT: "github-hosted", RUNNER_TEMP: temporary, GITHUB_WORKSPACE: workspace,
    ZEROS_RUNTIME_RELEASE: "enabled", ZEROS_HOSTED_PROMOTION: "enabled", RUNTIME_RELEASE_CHANNEL: "alpha", RUNTIME_RELEASE_ACTION: "publish",
    RUNTIME_RELEASE_SOURCE_SHA: "2".repeat(40), RUNTIME_RELEASE_EXPECTED_CP_SHA: "3".repeat(40), RUNTIME_RELEASE_EXPECTED_SHA256: "a".repeat(64),
    GITHUB_REPOSITORY: "example/project", GITHUB_SHA: "1".repeat(40), GITHUB_WORKFLOW_SHA: "1".repeat(40), GITHUB_REF_NAME: "main", GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: "example/project/.github/workflows/runtime-release.yml@refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
    CLOUD_V2_RUNTIME_STORE_ENDPOINT: "https://store.example.test", CLOUD_V2_RUNTIME_STORE_BUCKET: "fixture-runtime", CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID: "synthetic-access", CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY: "synthetic-store-secret",
    PLANETSCALE_ORG: "example", PLANETSCALE_DATABASE: "zeros-control-plane-alpha", PLANETSCALE_BRANCH: "main", PLANETSCALE_SERVICE_TOKEN_ID: "fixture-actor", PLANETSCALE_SERVICE_TOKEN: "synthetic-provider-secret" };
  const config = runtimeReleaseConfig(env), journal = prepareRuntimeDatabase(config, env), trace: string[] = [], saved: unknown[] = [];
  const directory = join(workspace, ".context/runtime-release"), path = join(temporary, "zeros-runtime-cleanup-123-1/login.json");
  const role = { id: "role1", name: journal.role.name, username: "fixture.route1", password: "synthetic-login-password", access_host_url: "fixture.pg.psdb.cloud",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(), ready: true, branch: { id: "branch1", name: "main" }, actor: { id: env.PLANETSCALE_SERVICE_TOKEN_ID } };
  let allocated = false, deleted = false, refuseDelete = false;
  const request = vi.fn(async (method: string, path: string) => {
    if (path === "/databases/zeros-control-plane-alpha") return { status: 200, body: { id: "database1", name: env.PLANETSCALE_DATABASE, kind: "postgresql", default_branch: "main" } };
    if (path.endsWith("/branches/main")) return { status: 200, body: { id: "branch1", name: "main", kind: "postgresql", production: true } };
    if (method === "POST") { trace.push("allocate-login"); allocated = true; return { status: 201, body: role }; }
    if (path.includes("?per_page=")) return { status: 200, body: { data: allocated && !deleted ? [role] : [] } };
    if (method === "DELETE") { trace.push("delete-login"); if (!refuseDelete) deleted = true; return { status: 204, body: null }; }
    return deleted ? { status: 404, body: null } : { status: 200, body: role };
  });
  const record = runtimeJournal(config, event => writeRuntimeJson(join(directory, "events", `${String(event.sequence).padStart(4, "0")}.json`), event));
  const pool = { end: vi.fn(async () => { trace.push("pool-end"); }) }, verifyDatabaseRoute = vi.fn(async () => {});
  const database = { planetScale: request, createPool: vi.fn(() => pool), verifyDatabaseRoute,
    save: value => record({ kind: "database", journal: value }),
    retain: (login, expiresAt) => writeRuntimeHandoff(config, env, login, expiresAt, () => {}), deferCleanupOnFailure: true };
  const claims = { version: 1 as const, iss: "zeros-runtime-release" as const, aud: "zeros-cloud-runtime-canary" as const, channel: "alpha" as const,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900, jti: randomUUID(), runId: config.runId, runAttempt: config.runAttempt,
    creatorUserId: randomUUID(), organizationId: randomUUID(), repositoryId: "42", runtimeSha256: "b".repeat(64), sourceSha: config.sourceSha!, createKey: "fixture-runtime-create" };
  const canary: RuntimeEventDetail = { kind: "canary", claims, keyId: "dedicated-fixture", grantSha256: "c".repeat(64) };
  const lease = { version: 1 as const, id: randomUUID(), runId: config.runId, liveCpSha: config.expectedCpSha,
    priorRuntimeSha256: config.expectedRuntimeSha256, expiresAt: new Date(Date.now() + 900_000).toISOString() };
  const next = { sha256: "b".repeat(64), release: { version: 1 as const, sha256: "b".repeat(64), sourceSha: config.sourceSha!, sourceSha256: "d".repeat(64),
    qualification: { channel: "alpha" as const, runId: config.runId, runAttempt: 1, completedAt: new Date().toISOString(), receiptSha256: "e".repeat(64), deleted: true as const } } };
  const stage: RuntimeEventDetail = { kind: "stage", phase: "confirmed", previous: { sha256: config.expectedRuntimeSha256, release: null },
    next, retainedPrevious: null, servingDeploymentId: "old-deployment", lease };
  const provider = { verifyDatabaseRoute, recover: vi.fn(async () => { trace.push("recover-pin"); return { releaseDrain: true }; }), stage: vi.fn(), deploy: vi.fn() };
  const drain = { beginDrain: vi.fn(), inspectDrain: vi.fn(), endDrain: vi.fn(async () => { trace.push("end-drain"); return { version: 1, lease, released: true }; }) };
  const status = { version: 1 as const, lease, state: "active" as const, ready: true, liveCount: 0, unresolvedCount: 0, runtimeAdoptionCount: 0 };
  const services = {
    store: vi.fn(() => ({ saveEvent: vi.fn(async value => { saved.push(value); }), close: vi.fn() })),
    provider: vi.fn(() => provider), pool: database.createPool, planetScale: vi.fn(() => request),
    handoff: (source, input, use) => withRuntimeHandoff(source, input, use, () => {}),
    retireCanary: vi.fn(async () => { trace.push("retire-canary"); return { deleted: true, workspaceId: randomUUID() }; }),
    existingDrain: vi.fn(async () => status as typeof status | null), drain: vi.fn(() => drain),
  };
  const interrupt = async (details: RuntimeEventDetail[] = []) => {
    await expect(withRuntimeDatabase(config, env, journal, database, async () => {
      for (const detail of details) await record(detail);
      throw new Error("fixture-interrupted-after-handoff");
    })).rejects.toThrow(/operation/);
    trace.length = 0;
  };
  const cleanup = () => runRuntimeCleanup(env, { root: workspace, services: services as never });
  return { root, workspace, env, config, directory, path, role, journal, trace, saved, pool, request, services, provider, drain, canary, stage, lease,
    record, interrupt, cleanup, deleted: () => deleted, refuseDelete: () => { refuseDelete = true; } };
}

describe.skipIf(process.platform !== "linux")("deterministic same-job runtime cleanup", () => {
  it("retires a canary and the same acknowledged login after interrupted qualification", async () => {
    const f = await fixture(); await f.interrupt([f.canary]);
    expect(await f.cleanup()).toMatchObject({ status: "success", databaseDeleted: true, canaryDeleted: true, drain: "absent" });
    expect(f.trace).toEqual(["retire-canary", "pool-end", "delete-login"]);
    expect(f.request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
    expect(f.services.retireCanary).toHaveBeenCalledWith(f.config, f.canary, f.env, f.pool, expect.any(Object));
    expect(f.drain.beginDrain).not.toHaveBeenCalled(); expect(f.provider.stage).not.toHaveBeenCalled(); expect(f.provider.deploy).not.toHaveBeenCalled();
    await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(f.saved)).not.toContain(f.role.password); expect(JSON.stringify(f.saved)).not.toContain(f.env.PLANETSCALE_SERVICE_TOKEN);
  });
  it("restores its recorded staged pin before ending the existing drain and deleting the login", async () => {
    const f = await fixture(); await f.interrupt([f.stage]);
    expect(await f.cleanup()).toMatchObject({ status: "success", databaseDeleted: true, drain: "released" });
    expect(f.trace).toEqual(["recover-pin", "end-drain", "pool-end", "delete-login"]);
    expect(f.services.provider.mock.calls[0][3]).toMatchObject({ recovery: { stage: f.stage } });
    expect(f.drain.beginDrain).not.toHaveBeenCalled();
  });
  it("keeps a pending rollout drained while still deleting the login and private handoff", async () => {
    const f = await fixture(); await f.interrupt([f.stage]); f.provider.recover.mockResolvedValue({ releaseDrain: false });
    await expect(f.cleanup()).rejects.toThrow(/unconfirmed/);
    expect(f.drain.endDrain).not.toHaveBeenCalled(); expect(f.deleted()).toBe(true);
    await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(f.directory, "runtime-cleanup.json"), "utf8"))).toMatchObject({ status: "refused", drain: "unresolved", databaseDeleted: true });
  });
  it.each([true, false])("only reads the receipt after a lost begin reply (allocated=%s)", async allocated => {
    const f = await fixture(); await f.interrupt([{ kind: "drain", phase: "requested", lease: null }]);
    if (!allocated) f.services.existingDrain.mockResolvedValue(null);
    expect(await f.cleanup()).toMatchObject({ status: "success", drain: allocated ? "released" : "absent" });
    expect(f.services.existingDrain).toHaveBeenCalledExactlyOnceWith(f.config, f.pool);
    expect(f.drain.beginDrain).not.toHaveBeenCalled(); expect(f.drain.endDrain).toHaveBeenCalledTimes(allocated ? 1 : 0);
  });
  it("still deletes the login if exact canary retirement is refused", async () => {
    const f = await fixture(); await f.interrupt([f.canary]); f.services.retireCanary.mockRejectedValue(new Error("synthetic-private-failure"));
    await expect(f.cleanup()).rejects.toThrow(/unconfirmed/); expect(f.deleted()).toBe(true);
    await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(f.directory, "runtime-cleanup.json"), "utf8")).not.toContain("synthetic-private-failure");
  });
  it("unlinks its private file but cannot report success without confirmed login deletion", async () => {
    const f = await fixture(); await f.interrupt(); f.refuseDelete();
    await expect(f.cleanup()).rejects.toThrow(/unconfirmed/); expect(f.deleted()).toBe(false);
    await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(f.directory, "runtime-cleanup.json"), "utf8"))).toMatchObject({ status: "refused", databaseDeleted: false });
  });
  it("refuses foreign event bindings before provider or database cleanup and unlinks the handoff", async () => {
    const f = await fixture(); await f.interrupt([f.canary]);
    const path = join(f.directory, "events/0001.json"), event = JSON.parse(await readFile(path, "utf8"));
    event.source.workflowSha = "9".repeat(40); await writeFile(path, JSON.stringify(event));
    const before = f.request.mock.calls.length;
    await expect(f.cleanup()).rejects.toThrow(/unconfirmed/); expect(f.request.mock.calls).toHaveLength(before);
    expect(f.services.retireCanary).not.toHaveBeenCalled(); await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("performs no provider operation when execution ended before requesting a login", async () => {
    const f = await fixture(); expect(await f.cleanup()).toMatchObject({ status: "success", databaseDeleted: true, drain: "absent" });
    expect(f.request).not.toHaveBeenCalled(); expect(f.services.store).not.toHaveBeenCalled();
  });
});
