// The runtime canary (gate0) at every point of a ready-copies switch-on: it signs in and creates a workspace the old
// way, naming its repository. Its create must be accepted in each state of the probe organization; only the worker's
// own stages (here none, so it stops waiting for "running") lie beyond this test.
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { FakeBoat } from "./__fixtures__/boat-fake.js";
import { CloudV2ComputerBuilder, CloudV2Computers } from "./computer.js";
import { migrateProjects } from "./projects.js";
import { Gate0Failure, runCloudV2Gate0 } from "./gate0.js";
import { executionFixture, type ExecutionFixture } from "./execution/test-fixture.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const runtime = { sha256: "b".repeat(64), url: async () => "https://r2.example.test/runtime.tar.gz?sig=1" };
const SHARED = "zeros-base-1";

d("the runtime canary through a ready-copies switch-on", () => {
  let pool: pg.Pool, f: ExecutionFixture, boat: FakeBoat;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    f = await executionFixture(pool, { readyCopies: true });
    boat = new FakeBoat();
    // GitHub, as the seed answers it, plus the branch head a create reads.
    const github = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (value, init) => new URL(String(value)).pathname.endsWith("/branches/main")
      ? Response.json({ commit: { sha: "a".repeat(40) } }) : github(value, init));
  });
  afterEach(async () => { await f.close(); });

  const computers = (readyCopies: boolean, shared = false) => new CloudV2Computers(pool, pool,
    async (_o, _u, target) => ({ repository: target.repository, repositoryId: target.repositoryId ?? "42" }), undefined, {
      ...(readyCopies ? { readyCopies: true, runtimeSha256: runtime.sha256 } : {}),
      ...(shared ? { sharedBaseSnapshot: SHARED, sharedBaseAvailable: async () => true } : {}) });
  const build = (with_: CloudV2Computers) => new CloudV2ComputerBuilder({ computers: with_, compute: boat, channel: "alpha", runtime,
    cloneToken: async () => "synthetic-clone-token" }).tick();
  /** The probe organization before the switch: a Cloud Computer that installs its repository, and its project made at boot. */
  async function preSwitch() {
    const off = computers(false);
    await off.enqueue(f.organizationId, f.creator.id, { repositories: [{ repository: "example/project" }] }, { configure: true });
    await build(off);
    await migrateProjects(pool);
    // Once its base is live the canary's old-style create is answered from this project (repository_not_in_project
    // without it): one organization project holding exactly the canary repository, made at boot from the live build.
    expect((await pool.query(`SELECT count(*)::int AS n FROM cloud_projects p JOIN cloud_project_repositories r ON r.project_id = p.id
      WHERE p.org_id = $1 AND p.level = 'organization' AND r.repository = 'example/project'
        AND (SELECT count(*) FROM cloud_project_repositories c WHERE c.project_id = p.id) = 1`, [f.organizationId])).rows[0].n).toBe(1);
  }
  const STATES = {
    "a pre-switch build, the setting just on": async () => {},
    "its base being prepared": async () => { expect((await computers(true).ensureBase(f.organizationId)).state).toBe("preparing"); },
    "its base failed": async () => {
      await computers(true).ensureBase(f.organizationId);
      await pool.query("UPDATE cloud_v2_computer_builds SET state='failed', error_code='computer_install_script_failed', finished_at=clock_timestamp() WHERE automatic");
    },
    "its base live": async () => { await computers(true).ensureBase(f.organizationId); await build(computers(true)); },
    "the shared base live": async () => { boat.snapshots.set(SHARED, new Map()); expect((await computers(true, true).ensureBase(f.organizationId)).state).toBe("ready"); },
  } as const;

  it.each(Object.keys(STATES) as (keyof typeof STATES)[])("passes its create with %s", async state => {
    await preSwitch();
    await STATES[state]();
    const failure = await runCloudV2Gate0({ apiOrigin: "http://control-plane.test", organizationId: f.organizationId, repository: "example/project",
      accessToken: async () => "synthetic-session", timeoutMs: 300, pollMs: 50, log: () => {},
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        return f.app.request(url.pathname + url.search, init);
      }) as typeof fetch }).catch(error => error);
    // Past the repository list and the create; it stops only where a worker is needed.
    expect(failure).toBeInstanceOf(Gate0Failure);
    expect((failure as Gate0Failure).stage).toBe("running");
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_workspaces WHERE org_id=$1 AND name LIKE 'gate0-%'", [f.organizationId])).rows[0].n).toBe(1);
  });
});
