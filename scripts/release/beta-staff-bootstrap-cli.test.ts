import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { betaStaffBootstrapMain } from "./beta-staff-bootstrap-cli";

const sourceSha = "a".repeat(40), subject = "11111111-1111-4111-8111-111111111111";
const actor = "22222222-2222-4222-8222-222222222222", organization = "33333333-3333-4333-8333-333333333333";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-beta-staff-cli-")); directories.push(directory);
  const eventPath = path.join(directory, "event.json");
  await writeFile(eventPath, JSON.stringify({ repository: { full_name: "example/zeros", fork: false },
    ref: "release/1.2.3", sender: { login: "synthetic-operator" } }));
  const env: NodeJS.ProcessEnv = { RELEASE_CHANNEL: "beta", RELEASE_BRANCH: "release/1.2.3", RELEASE_SHA: sourceSha,
    GITHUB_SHA: sourceSha, GITHUB_REPOSITORY: "example/zeros", GITHUB_REF: "refs/heads/release/1.2.3", GITHUB_REF_NAME: "release/1.2.3",
    GITHUB_WORKFLOW_REF: "example/zeros/.github/workflows/staff-owner-bootstrap.yml@refs/heads/release/1.2.3",
    GITHUB_WORKFLOW_SHA: sourceSha, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_ACTOR: "synthetic-operator",
    GITHUB_ACTIONS: "true", CI: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: eventPath,
    PLANETSCALE_ORG: "synthetic-org", PLANETSCALE_DATABASE: "zeros-control-plane-beta", PLANETSCALE_BRANCH: "main",
    PLANETSCALE_SERVICE_TOKEN_ID: "synthetic-token-id", PLANETSCALE_SERVICE_TOKEN: "synthetic-provider-token",
    STAFF_BOOTSTRAP_MODE: "plan", STAFF_BOOTSTRAP_CONFIRM: "zeros-control-plane-beta", STAFF_SUBJECT_USER_ID: subject,
    STAFF_ACTOR_USER_ID: actor, STAFF_OWNER_ORGANIZATION_ID: organization, STAFF_EXPECTED_EMAIL: "owner@example.test",
    STAFF_REASON: "Bootstrap the reviewed active Beta organization owner.", GH_TOKEN: "synthetic-github-token",
    STAFF_BOOTSTRAP_INTENT_ARTIFACT_ID: "456" };
  const state = { exists: false, checkoutSha: sourceSha, artifactSha: sourceSha, artifactExpired: false, artifactRun: 123, preflight: "success" };
  const calls: string[] = [];
  const role = { id: "temporary-role", name: "zeros-beta-staff-123", branch: { id: "main-branch", name: "main" },
    actor: { id: "synthetic-token-id" }, username: "synthetic_owner.mainbranch", password: "synthetic-one-time-password",
    access_host_url: "synthetic.pg.psdb.cloud", ready: true, expires_at: new Date(Date.now() + 3_600_000).toISOString() };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url); calls.push(`${init?.method ?? "GET"} ${route}`);
    let body: unknown, status = 200;
    if (route.endsWith("/actions/artifacts/456")) body = { id: 456, name: "beta-staff-owner-intent-123-1", expired: state.artifactExpired,
      workflow_run: { id: state.artifactRun, head_sha: state.artifactSha, head_branch: "release/1.2.3" } };
    else if (route.includes("/actions/workflows/")) {
      const preflight = route.includes("preflight.yml");
      body = { total_count: 1, workflow_runs: [{ id: preflight ? 1 : 2, run_attempt: 1, name: preflight ? "Preflight" : "CodeQL",
        path: `.github/workflows/${preflight ? "preflight" : "codeql"}.yml`, head_sha: sourceSha, status: "completed",
        conclusion: preflight ? state.preflight : "success", event: "push", repository: { full_name: "example/zeros" },
        head_repository: { full_name: "example/zeros" } }] };
    } else if (route.includes("/commits/")) body = { sha: sourceSha };
    else if (route.endsWith("/databases/zeros-control-plane-beta")) body = { id: "beta-database", name: "zeros-control-plane-beta", kind: "postgresql", default_branch: "main" };
    else if (route.endsWith("/branches/main")) body = { id: "main-branch", name: "main", kind: "postgresql", production: true };
    else if (route.includes("/roles?")) body = { data: state.exists ? [role] : [] };
    else if (route.endsWith("/roles") && init?.method === "POST") { state.exists = true; body = role; status = 201; }
    else if (route.endsWith("/roles/temporary-role")) {
      if (init?.method === "DELETE") { state.exists = false; status = 204; body = null; }
      else { status = state.exists ? 200 : 404; body = state.exists ? role : null; }
    } else throw new Error("Unexpected synthetic route");
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  });
  const client = { release: vi.fn(), query: vi.fn(async (sql: string) => ({ rows: sql.includes("owns_users") ? [{
    principal: "postgres", owns_users: true, owns_audit: true, can_update_staff: true, can_write_audit: true,
  }] : sql.includes("FROM organizations") ? [{ is_personal: false, lifecycle_status: "active", deleted_at: null, role: "owner" }]
    : sql.includes("FROM users") ? [{ id: subject, email: "owner@example.test", staff_role: null, auth_status: "active", auth_revision: 1 },
      { id: actor, email: "actor@example.test", staff_role: null, auth_status: "active", auth_revision: 1 }] : [] })) };
  const pool = { connect: vi.fn(async () => client), end: vi.fn(async () => {}) } as unknown as pg.Pool;
  const options = { cwd: directory, fetch: fetcher as typeof fetch, command: vi.fn(async () => state.checkoutSha), createPool: vi.fn(() => pool) };
  return { directory, eventPath, env, state, calls, client, pool, options,
    invoke: (args: string[]) => betaStaffBootstrapMain(args, env, options) };
}

describe("Beta staff bootstrap real CLI boundary", () => {
  it("prepares a private sanitized create intent after exact-source proof and captures actual parent identity without mutation", async () => {
    const test = await fixture(), result = await test.invoke(["--prepare"]);
    expect(result.role.phase).toBe("planned");
    expect(test.calls.every(call => call.startsWith("GET "))).toBe(true);
    expect(result.target.databaseId).toBe("beta-database");
    expect(result.target.branchId).toBe("main-branch");
    const target = path.join(test.directory, ".context/release/beta-staff-bootstrap-intent.json");
    const bytes = await readFile(target, "utf8");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    for (const forbidden of ["owner@example.test", "synthetic-provider-token", "synthetic-token-id", "synthetic-github-token", test.env.STAFF_REASON!]) {
      expect(bytes).not.toContain(forbidden);
    }
    await expect(test.invoke(["--prepare"])).rejects.toThrow("intent");
  });

  it("requires real current-run intent artifact metadata before opening the provider connection", async () => {
    const test = await fixture(); await test.invoke(["--prepare"]); test.calls.length = 0;
    delete test.env.STAFF_BOOTSTRAP_INTENT_ARTIFACT_ID;
    await expect(test.invoke(["--run"])).rejects.toThrow("intent");
    expect(test.calls).toEqual([]); expect(test.options.createPool).not.toHaveBeenCalled();
  });

  it.each(["wrong-sha", "expired", "wrong-run"])("rejects %s uploaded intent before provider access", async boundary => {
    const test = await fixture(); await test.invoke(["--prepare"]); test.calls.length = 0;
    if (boundary === "wrong-sha") test.state.artifactSha = "b".repeat(40);
    if (boundary === "expired") test.state.artifactExpired = true;
    if (boundary === "wrong-run") test.state.artifactRun = 124;
    await expect(test.invoke(["--run"])).rejects.toThrow("intent");
    expect(test.calls.every(call => call.includes("api.github.com"))).toBe(true);
  });

  it("runs the actual audited plan, records exact deletion and never remints on a same-attempt replay", async () => {
    const test = await fixture(); await test.invoke(["--prepare"]);
    const result = await test.invoke(["--run"]);
    expect(result.staff?.state).toBe("planned"); expect(result.role.deleted).toBe(true);
    expect(test.pool.end).toHaveBeenCalledOnce();
    const resultPath = path.join(test.directory, ".context/release/beta-staff-bootstrap-result.json");
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual(result);
    expect((await readdir(path.dirname(resultPath))).sort()).toEqual(["beta-staff-bootstrap-intent.json", "beta-staff-bootstrap-result.json"]);
    await expect(test.invoke(["--run"])).rejects.toThrow("recovery");
    expect(test.calls.filter(call => call.startsWith("POST "))).toHaveLength(1);
  });

  it.each(["checkout", "ci"])("refuses wrong %s before retaining or creating privileged intent", async boundary => {
    const test = await fixture();
    if (boundary === "checkout") test.state.checkoutSha = "b".repeat(40);
    if (boundary === "ci") test.state.preflight = "failure";
    await expect(test.invoke(["--prepare"])).rejects.toThrow("source");
    expect(test.options.createPool).not.toHaveBeenCalled();
    expect(test.calls.every(call => call.includes("api.github.com"))).toBe(true);
  });

  it("rejects unknown arguments and oversized event metadata without retaining raw errors", async () => {
    const test = await fixture();
    await expect(test.invoke(["--execute", "--role", "developer"])).rejects.toThrow("configuration");
    await writeFile(test.eventPath, "x".repeat(65 * 1024));
    await expect(test.invoke(["--prepare"])).rejects.toThrow("configuration");
    expect(test.calls).toEqual([]);
  });
});
