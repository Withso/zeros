import { mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { betaStaffBootstrapMain } from "./beta-staff-bootstrap-cli";

const descriptorProbe = vi.hoisted(() => ({ file: null as string | null, afterStat: null as (() => Promise<void>) | null,
  readLengths: [] as number[], closed: 0, failure: null as "read" | "close" | null }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const afterStat = async (file: unknown) => {
    if (String(file) === descriptorProbe.file && descriptorProbe.afterStat) {
      const mutate = descriptorProbe.afterStat; descriptorProbe.afterStat = null; await mutate();
    }
  };
  return { ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args); await afterStat(args[0]); return result;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) !== descriptorProbe.file) return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === "stat") return async () => { const result = await target.stat(); await afterStat(args[0]); return result; };
        if (key === "read") return (...parameters: any[]) => {
          if (descriptorProbe.failure === "read") throw new Error("Synthetic private filesystem detail");
          descriptorProbe.readLengths.push(parameters[2]); return (target.read as any)(...parameters);
        };
        if (key === "close") return async () => {
          descriptorProbe.closed++; await target.close();
          if (descriptorProbe.failure === "close") throw new Error("Synthetic private filesystem detail");
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
    },
  };
});

const sourceSha = "a".repeat(40), subject = "11111111-1111-4111-8111-111111111111";
const actor = "22222222-2222-4222-8222-222222222222", organization = "33333333-3333-4333-8333-333333333333";
const githubPrefix = "/repos/example/zeros";
const githubPaths = new Set([`${githubPrefix}/actions/artifacts/456`, `${githubPrefix}/actions/workflows/preflight.yml/runs`,
  `${githubPrefix}/actions/workflows/codeql.yml/runs`, `${githubPrefix}/commits/release%2F1.2.3`,
  `${githubPrefix}/actions/runs/123/attempts/1`, `${githubPrefix}/actions/runs/123/attempts/1/jobs`]);
function trustedGithubRead(call: string) {
  try {
    const target = new URL(call.slice(call.indexOf(" ") + 1));
    return call.startsWith("GET ") && target.origin === "https://api.github.com" && githubPaths.has(target.pathname);
  } catch { return false; }
}
const directories: string[] = [];
afterEach(async () => {
  descriptorProbe.file = null; descriptorProbe.afterStat = null; descriptorProbe.readLengths.length = 0; descriptorProbe.closed = 0; descriptorProbe.failure = null;
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(channel: "beta" | "production" = "beta") {
  const directory = await mkdtemp(path.join(os.tmpdir(), `zeros-${channel}-staff-cli-`)); directories.push(directory);
  const eventPath = path.join(directory, "event.json");
  await writeFile(eventPath, JSON.stringify({ repository: { full_name: "example/zeros", fork: false },
    ref: "release/1.2.3", sender: { login: "synthetic-operator" } }));
  const env: NodeJS.ProcessEnv = { RELEASE_CHANNEL: channel, RELEASE_BRANCH: "release/1.2.3", RELEASE_SHA: sourceSha,
    GITHUB_SHA: sourceSha, GITHUB_REPOSITORY: "example/zeros", GITHUB_REF: "refs/heads/release/1.2.3", GITHUB_REF_NAME: "release/1.2.3",
    GITHUB_WORKFLOW_REF: "example/zeros/.github/workflows/staff-owner-bootstrap.yml@refs/heads/release/1.2.3",
    GITHUB_WORKFLOW_SHA: sourceSha, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_ACTOR: "synthetic-operator",
    GITHUB_ACTIONS: "true", CI: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: eventPath,
    PLANETSCALE_ORG: "synthetic-org", PLANETSCALE_DATABASE: `zeros-control-plane-${channel}`, PLANETSCALE_BRANCH: "main",
    PLANETSCALE_SERVICE_TOKEN_ID: "synthetic-token-id", PLANETSCALE_SERVICE_TOKEN: "synthetic-provider-token",
    STAFF_BOOTSTRAP_MODE: "plan", STAFF_BOOTSTRAP_CONFIRM: `zeros-control-plane-${channel}`, STAFF_SUBJECT_USER_ID: subject,
    STAFF_ACTOR_USER_ID: actor, STAFF_OWNER_ORGANIZATION_ID: organization, STAFF_EXPECTED_EMAIL: "owner@example.test",
    STAFF_REASON: "Bootstrap the reviewed active Beta organization owner.", GH_TOKEN: "synthetic-github-token",
    STAFF_BOOTSTRAP_INTENT_ARTIFACT_ID: "456" };
  const approvalRun = { id: 123, run_attempt: 1, head_sha: sourceSha, head_branch: "release/1.2.3", event: "workflow_dispatch",
    path: ".github/workflows/staff-owner-bootstrap.yml", actor: { login: "synthetic-operator" },
    repository: { full_name: "example/zeros", fork: false }, head_repository: { full_name: "example/zeros", fork: false } };
  const approvalJob = { id: 789, run_id: 123, run_attempt: 1, head_sha: sourceSha, name: "Approve Production staff owner bootstrap",
    status: "completed", conclusion: "success", steps: [{ name: "Record the approved staff bootstrap", status: "completed", conclusion: "success" }] };
  const state = { exists: false, checkoutSha: sourceSha, branchSha: sourceSha, artifactSha: sourceSha, artifactExpired: false,
    artifactRun: 123, artifactName: `${channel}-staff-owner-intent-123-1`, preflight: "success", approvalRun, approvalJobs: [approvalJob],
    subjectRole: (channel === "production" ? "developer" : null) as string | null, revision: channel === "production" ? 2 : 1 };
  const calls: string[] = [];
  const role = { id: "temporary-role", name: `zeros-${channel}-staff-123`, branch: { id: "main-branch", name: "main" },
    actor: { id: "synthetic-token-id" }, username: "synthetic_owner.mainbranch", password: "synthetic-one-time-password",
    access_host_url: "synthetic.pg.psdb.cloud", ready: true, expires_at: new Date(Date.now() + 3_600_000).toISOString() };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url)), route = target.pathname, method = init?.method ?? "GET";
    const call = `${method} ${target.href}`; calls.push(call);
    const planetScalePrefix = `/v1/organizations/synthetic-org/databases/zeros-control-plane-${channel}`;
    let body: unknown, status = 200;
    if (trustedGithubRead(call)) {
      if (route === `${githubPrefix}/actions/artifacts/456`) body = { id: 456, name: state.artifactName, expired: state.artifactExpired,
        workflow_run: { id: state.artifactRun, head_sha: state.artifactSha, head_branch: "release/1.2.3" } };
      else if (route === `${githubPrefix}/commits/release%2F1.2.3`) body = { sha: state.branchSha };
      else if (route === `${githubPrefix}/actions/runs/123/attempts/1`) body = state.approvalRun;
      else if (route === `${githubPrefix}/actions/runs/123/attempts/1/jobs`) {
        const page = Number(target.searchParams.get("page") || "1");
        body = { total_count: state.approvalJobs.length, jobs: state.approvalJobs.slice((page - 1) * 100, page * 100) };
      }
      else {
        const preflight = route === `${githubPrefix}/actions/workflows/preflight.yml/runs`;
        body = { total_count: 1, workflow_runs: [{ id: preflight ? 1 : 2, run_attempt: 1, name: preflight ? "Preflight" : "CodeQL",
          path: `.github/workflows/${preflight ? "preflight" : "codeql"}.yml`, head_sha: sourceSha, status: "completed",
          conclusion: preflight ? state.preflight : "success", event: "push", repository: { full_name: "example/zeros" },
          head_repository: { full_name: "example/zeros" } }] };
      }
    } else if (target.origin === "https://api.planetscale.com") {
      if (route === planetScalePrefix && method === "GET") body = { id: `${channel}-database`, name: `zeros-control-plane-${channel}`, kind: "postgresql", default_branch: "main" };
      else if (route === `${planetScalePrefix}/branches/main` && method === "GET") body = { id: "main-branch", name: "main", kind: "postgresql", production: true };
      else if (route === `${planetScalePrefix}/branches/main/roles` && method === "GET") body = { data: state.exists ? [role] : [] };
      else if (route === `${planetScalePrefix}/branches/main/roles` && method === "POST") { state.exists = true; body = role; status = 201; }
      else if (route === `${planetScalePrefix}/branches/main/roles/temporary-role`) {
        if (method === "DELETE") { state.exists = false; status = 204; body = null; }
        else if (method === "GET") { status = state.exists ? 200 : 404; body = state.exists ? role : null; }
        else throw new Error("Unexpected synthetic route");
      } else throw new Error("Unexpected synthetic route");
    } else throw new Error("Unexpected synthetic origin or route");
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  });
  const client = { release: vi.fn(), query: vi.fn(async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith("UPDATE users")) {
      expect(parameters).toEqual([subject, "platform_owner"]); state.subjectRole = "platform_owner"; state.revision++;
      return { rows: [{ auth_revision: state.revision }] };
    }
    return { rows: sql.includes("owns_users") ? [{ principal: "postgres", owns_users: true, owns_audit: true, can_update_staff: true, can_write_audit: true }]
      : sql.includes("FROM organizations") ? [{ is_personal: false, lifecycle_status: "active", deleted_at: null, role: "owner" }]
      : sql.includes("FROM users") ? [{ id: subject, email: "owner@example.test", staff_role: state.subjectRole, auth_status: "active", auth_revision: state.revision },
        { id: actor, email: "actor@example.test", staff_role: channel === "production" ? "platform_owner" : null,
          auth_status: "active", auth_revision: channel === "production" ? 2 : 1 }] : [] };
  }) };
  const pool = { connect: vi.fn(async () => client), end: vi.fn(async () => {}) } as unknown as pg.Pool;
  const options = { cwd: directory, fetch: fetcher as typeof fetch, command: vi.fn(async () => state.checkoutSha), createPool: vi.fn(() => pool) };
  return { directory, eventPath, env, state, calls, client, pool, options,
    invoke: (args: string[]) => betaStaffBootstrapMain(args, env, options) };
}

describe("Beta staff bootstrap real CLI boundary", () => {
  it("reads the checked descriptor even when the pathname is substituted after metadata validation", async () => {
    const test = await fixture(); descriptorProbe.file = test.eventPath;
    descriptorProbe.afterStat = async () => {
      await rename(test.eventPath, `${test.eventPath}.original`);
      await writeFile(test.eventPath, JSON.stringify({ repository: { full_name: "foreign/zeros", fork: false } }));
    };
    const result = await test.invoke(["--prepare"]);
    expect(result.source.repository).toBe("example/zeros");
    expect(descriptorProbe.closed).toBe(1);
    expect(descriptorProbe.readLengths.length).toBeGreaterThan(0);
    expect(descriptorProbe.readLengths.every(length => length <= 64 * 1024 + 1)).toBe(true);
  });

  it("bounds actual descriptor bytes and closes it when an initially small file grows after metadata validation", async () => {
    const test = await fixture(), event = JSON.parse(await readFile(test.eventPath, "utf8")); descriptorProbe.file = test.eventPath;
    descriptorProbe.afterStat = async () => { await writeFile(test.eventPath, JSON.stringify({ ...event, filler: "x".repeat(65 * 1024) })); };
    await expect(test.invoke(["--prepare"])).rejects.toThrow("configuration");
    expect(descriptorProbe.closed).toBe(1);
    expect(descriptorProbe.readLengths.every(length => length <= 64 * 1024 + 1)).toBe(true);
    expect(test.calls).toEqual([]);
  });

  it.each(["metadata", "read", "parse", "close"])("closes the descriptor and withholds private details after a %s failure", async boundary => {
    const test = await fixture(); descriptorProbe.file = test.eventPath;
    if (boundary === "metadata") descriptorProbe.afterStat = async () => { throw new Error("Synthetic private filesystem detail"); };
    if (boundary === "read" || boundary === "close") descriptorProbe.failure = boundary;
    if (boundary === "parse") await writeFile(test.eventPath, "Synthetic private filesystem detail");
    await expect(test.invoke(["--prepare"])).rejects.toThrow(/^Beta staff bootstrap configuration failed$/);
    expect(descriptorProbe.closed).toBe(1);
    expect(test.calls).toEqual([]);
  });

  it("accepts a regular JSON event at the exact 64 KiB boundary without unbounded reads", async () => {
    const test = await fixture(), event = await readFile(test.eventPath, "utf8"); descriptorProbe.file = test.eventPath;
    await writeFile(test.eventPath, event.padEnd(64 * 1024, " "));
    expect((await test.invoke(["--prepare"])).source.repository).toBe("example/zeros");
    expect(descriptorProbe.closed).toBe(1);
    expect(descriptorProbe.readLengths.every(length => length <= 64 * 1024 + 1)).toBe(true);
  });

  it.each([
    "https://api.github.com.attacker.test/repos/example/zeros/actions/artifacts/456",
    "https://attacker.test/api.github.com/repos/example/zeros/actions/artifacts/456",
    "https://api.github.com@attacker.test/repos/example/zeros/actions/artifacts/456",
    "http://api.github.com/repos/example/zeros/actions/artifacts/456",
    "https://api.github.com/repos/foreign/zeros/actions/artifacts/456",
  ])("never answers a foreign origin or repository in its synthetic proof client: %s", async url => {
    const test = await fixture();
    await expect(test.options.fetch(url)).rejects.toThrow();
    expect(trustedGithubRead(`GET ${url}`)).toBe(false);
  });

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
    expect(test.calls.every(trustedGithubRead)).toBe(true);
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
    expect(test.calls.every(trustedGithubRead)).toBe(true);
  });

  it("rejects unknown arguments and oversized event metadata without retaining raw errors", async () => {
    const test = await fixture();
    await expect(test.invoke(["--execute", "--role", "developer"])).rejects.toThrow("configuration");
    await writeFile(test.eventPath, "x".repeat(65 * 1024));
    await expect(test.invoke(["--prepare"])).rejects.toThrow("configuration");
    expect(test.calls).toEqual([]);
  });
});

describe("Production current-run human approval proof", () => {
  it("requires an authenticated successful approval job before Production parent preparation", async () => {
    const test = await fixture("production"), result = await test.invoke(["--prepare"]);
    expect(result.source.channel).toBe("production"); expect(result.target.databaseId).toBe("production-database");
    expect(result.role.name).toBe("zeros-production-staff-123"); expect(result.version).toBe(1);
    const approval = test.calls.findIndex(call => call.includes("/attempts/1/jobs"));
    const provider = test.calls.findIndex(call => new URL(call.slice(4)).origin === "https://api.planetscale.com");
    expect(approval).toBeGreaterThanOrEqual(0); expect(provider).toBeGreaterThan(approval);
    const target = path.join(test.directory, ".context/release/production-staff-bootstrap-intent.json");
    descriptorProbe.file = target;
    descriptorProbe.afterStat = async () => {
      await rename(target, `${target}.original`);
      await writeFile(target, test.env.GH_TOKEN!);
    };
    const handle = await open(target, "r");
    try {
      expect((await handle.stat()).mode & 0o777).toBe(0o600);
      const retained = await handle.readFile("utf8");
      for (const forbidden of [test.env.STAFF_EXPECTED_EMAIL!, test.env.STAFF_REASON!, test.env.PLANETSCALE_SERVICE_TOKEN!, test.env.GH_TOKEN!]) expect(retained).not.toContain(forbidden);
    } finally { await handle.close(); }
    expect(descriptorProbe.closed).toBe(1);
  });
  it.each(["missing", "failure", "skipped", "cancelled", "pending", "step", "duplicate"])("refuses %s approval before any Production provider access", async boundary => {
    const test = await fixture("production");
    if (boundary === "missing") test.state.approvalJobs = [];
    else if (boundary === "duplicate") test.state.approvalJobs.push({ ...test.state.approvalJobs[0], id: 790 });
    else if (boundary === "pending") test.state.approvalJobs[0].status = "in_progress";
    else if (boundary === "step") test.state.approvalJobs[0].steps[0].conclusion = "skipped";
    else test.state.approvalJobs[0].conclusion = boundary;
    await expect(test.invoke(["--prepare"])).rejects.toThrow("approval");
    expect(test.calls.every(trustedGithubRead)).toBe(true); expect(test.options.createPool).not.toHaveBeenCalled();
    await expect(stat(path.join(test.directory, ".context/release/production-staff-bootstrap-intent.json"))).rejects.toThrow();
  });
  it.each(["run", "attempt", "sha", "branch", "workflow", "event", "actor", "repository", "fork", "head-repository", "job-run", "job-attempt", "job-sha"])("refuses an approval bound to another %s", async boundary => {
    const test = await fixture("production"), run = test.state.approvalRun, job = test.state.approvalJobs[0];
    if (boundary === "run") run.id = 124;
    if (boundary === "attempt") run.run_attempt = 2;
    if (boundary === "sha") run.head_sha = "b".repeat(40);
    if (boundary === "branch") run.head_branch = "release/1.2.4";
    if (boundary === "workflow") run.path = ".github/workflows/release.yml";
    if (boundary === "event") run.event = "push";
    if (boundary === "actor") run.actor.login = "other-operator";
    if (boundary === "repository") run.repository.full_name = "foreign/zeros";
    if (boundary === "fork") run.repository.fork = true;
    if (boundary === "head-repository") run.head_repository.full_name = "foreign/zeros";
    if (boundary === "job-run") job.run_id = 124;
    if (boundary === "job-attempt") job.run_attempt = 2;
    if (boundary === "job-sha") job.head_sha = "b".repeat(40);
    await expect(test.invoke(["--prepare"])).rejects.toThrow("approval");
    expect(test.calls.every(trustedGithubRead)).toBe(true);
  });
  it("reads complete bounded job pages rather than treating a partial list as approval", async () => {
    const test = await fixture("production"), approval = test.state.approvalJobs[0];
    test.state.approvalJobs = Array.from({ length: 100 }, (_, index) => ({ ...approval, id: 800 + index, name: `Synthetic other job ${index}` }));
    test.state.approvalJobs.push(approval);
    expect((await test.invoke(["--prepare"])).source.channel).toBe("production");
    expect(test.calls.some(call => call.includes("page=2"))).toBe(true);
  });
  it.each(["artifact", "journal"])("rejects a cross-channel %s before Production role access", async boundary => {
    const test = await fixture("production"); await test.invoke(["--prepare"]); test.calls.length = 0;
    if (boundary === "artifact") test.state.artifactName = "beta-staff-owner-intent-123-1";
    else {
      const file = path.join(test.directory, ".context/release/production-staff-bootstrap-intent.json");
      const journal = JSON.parse(await readFile(file, "utf8")); journal.source.channel = "beta";
      await writeFile(file, JSON.stringify(journal));
    }
    await expect(test.invoke(["--run"])).rejects.toThrow("intent"); expect(test.calls.every(trustedGithubRead)).toBe(true);
    expect(test.options.createPool).not.toHaveBeenCalled();
  });
  it("rechecks approval at run time instead of trusting prepare or an input flag", async () => {
    const test = await fixture("production"); await test.invoke(["--prepare"]); test.calls.length = 0;
    test.env.STAFF_PRODUCTION_APPROVED = "true"; test.state.approvalJobs[0].conclusion = "skipped";
    await expect(test.invoke(["--run"])).rejects.toThrow("approval"); expect(test.calls.every(trustedGithubRead)).toBe(true);
    expect(test.options.createPool).not.toHaveBeenCalled();
  });
  it.each(["checkout", "ci", "branch"])("requires Production's actual current %s proof before provider preparation", async boundary => {
    const test = await fixture("production");
    if (boundary === "checkout") test.state.checkoutSha = "b".repeat(40);
    if (boundary === "ci") test.state.preflight = "failure";
    if (boundary === "branch") test.state.branchSha = "b".repeat(40);
    await expect(test.invoke(["--prepare"])).rejects.toThrow("source");
    expect(test.calls.every(trustedGithubRead)).toBe(true); expect(test.options.createPool).not.toHaveBeenCalled();
  });
  it("rechecks approval after inventory and withholds Production role creation when proof changes", async () => {
    const test = await fixture("production"); await test.invoke(["--prepare"]); test.calls.length = 0;
    const fetcher = test.options.fetch;
    test.options.fetch = async (url, init) => {
      const result = await fetcher(url, init), target = new URL(String(url));
      if (target.origin === "https://api.planetscale.com" && target.pathname.endsWith("/roles") && (init?.method ?? "GET") === "GET") {
        test.state.approvalJobs[0].conclusion = "skipped";
      }
      return result;
    };
    await expect(test.invoke(["--run"])).rejects.toThrow("approval");
    expect(test.calls.some(call => call.startsWith("POST "))).toBe(false); expect(test.options.createPool).not.toHaveBeenCalled();
  });
  it("cleans the owned Production role when source drifts after creation, without a staff grant", async () => {
    const test = await fixture("production"); test.env.STAFF_BOOTSTRAP_MODE = "apply"; await test.invoke(["--prepare"]);
    const fetcher = test.options.fetch;
    test.options.fetch = async (url, init) => {
      const result = await fetcher(url, init);
      if (new URL(String(url)).origin === "https://api.planetscale.com" && init?.method === "POST") test.state.branchSha = "b".repeat(40);
      return result;
    };
    await expect(test.invoke(["--run"])).rejects.toThrow("source");
    expect(test.client.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE users"))).toBe(false);
    expect(test.calls.filter(call => call.startsWith("POST "))).toHaveLength(1);
    expect(test.calls.filter(call => call.startsWith("DELETE "))).toHaveLength(1); expect(test.state.exists).toBe(false);
  });
  it("applies one audited Production grant while preserving the existing owner and closes the owned role", async () => {
    const test = await fixture("production"); test.env.STAFF_BOOTSTRAP_MODE = "apply";
    await test.invoke(["--prepare"]); const result = await test.invoke(["--run"]);
    expect(result.staff?.state).toBe("changed"); expect(result.staff?.accountRevision).toBe(3); expect(result.role.deleted).toBe(true);
    expect(test.client.query.mock.calls.filter(([sql]) => sql.startsWith("UPDATE users"))).toEqual([[expect.any(String), [subject, "platform_owner"]]]);
    const audit = test.client.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO staff_role_changes"));
    expect(audit?.[1]).toEqual([subject, actor, "developer", "platform_owner", 3, "production", result.staff?.targetFingerprint, "postgres", test.env.STAFF_REASON]);
    expect(test.calls.filter(call => call.startsWith("POST "))).toHaveLength(1);
    expect(test.calls.filter(call => call.startsWith("DELETE "))).toHaveLength(1); expect(test.pool.end).toHaveBeenCalledOnce();
    const resultPath = path.join(test.directory, ".context/release/production-staff-bootstrap-result.json");
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual(result);
    expect((await readdir(path.dirname(resultPath))).sort()).toEqual(["production-staff-bootstrap-intent.json", "production-staff-bootstrap-result.json"]);
    await expect(test.invoke(["--run"])).rejects.toThrow("recovery");
    expect(test.calls.filter(call => call.startsWith("POST "))).toHaveLength(1);
  });
  it("retains Beta version-1 paths and requires no Production approval API for Beta", async () => {
    const test = await fixture(); await test.invoke(["--prepare"]); const result = await test.invoke(["--run"]);
    expect(result.version).toBe(1); expect(result.source.channel).toBe("beta"); expect(result.role.name).toBe("zeros-beta-staff-123");
    expect(test.calls.some(call => call.includes("/attempts/1"))).toBe(false);
    expect((await readdir(path.join(test.directory, ".context/release"))).sort()).toEqual(["beta-staff-bootstrap-intent.json", "beta-staff-bootstrap-result.json"]);
  });
});
