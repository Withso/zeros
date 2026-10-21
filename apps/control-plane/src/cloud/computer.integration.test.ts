import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import type { CloudV2Compute } from "./boat.js";
import { CloudV2ComputerBuilder, CloudV2Computers, cloudV2SnapshotName } from "./computer.js";
import { CloudV2Store } from "./store.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const commit = "a".repeat(40);

d("cloud v2 Cloud Computer builds", () => {
  let pool: pg.Pool;
  let computers: CloudV2Computers;
  let org: string;
  let admin: string;
  let member: string;

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    computers = new CloudV2Computers(pool);
    [admin, member] = [randomUUID(), randomUUID()];
    for (const id of [admin, member]) await pool.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')`, [id, `u-${id}@example.test`]);
    org = randomUUID();
    await pool.query(`INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1, $2, 'Org', $3, false, true)`,
      [org, `org-${org}`, admin]);
    await pool.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, [org, admin, member]);
  });

  const recipe = { base: "zeros-v2-base-1", repositories: [{ repository: "withso/zeros", setup: "pnpm install" }] };

  function compute(): CloudV2Compute {
    return {
      create: vi.fn(async () => ({ sandboxId: "bx_build1" })),
      resume: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      exec: vi.fn(async (_id: string, command: string) => ({ exitCode: 0, stdout: command.includes("rev-parse") ? `Cloning\n${commit}\n` : "installed", timedOut: false })),
      saveSnapshot: vi.fn(async () => {}),
      deleteSnapshot: vi.fn(async () => {}),
    };
  }

  it("lets only owners and admins build, one build at a time", async () => {
    await expect(computers.requireAdmin(org, member)).rejects.toMatchObject({ status: 403 });
    await computers.requireAdmin(org, admin);
    const first = await computers.enqueue(org, admin, recipe);
    expect(first.version).toBe(1);
    await expect(computers.enqueue(org, admin, recipe)).rejects.toMatchObject({ code: "computer_build_in_progress" });
  });

  it("builds, pins commits, goes live as the one named snapshot and retires the previous one", async () => {
    const boat = compute();
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", cloneToken: async () => "ghs_token" });
    await computers.enqueue(org, admin, recipe);
    await builder.tick();
    let overview = await computers.overview(org);
    expect(overview.snapshotName).toBe(cloudV2SnapshotName("alpha", org, 1));
    expect(overview.builds[0]).toMatchObject({ state: "succeeded", version: 1 });
    expect(overview.builds[0]!.recipe.repositories[0]!.commit).toBe(commit);
    expect(await new CloudV2Store(pool).installedRepositories(org)).toEqual(["withso/zeros"]);
    const cloneCommand = vi.mocked(boat.exec).mock.calls[0]![1];
    expect(cloneCommand).not.toContain("ghs_token");

    vi.mocked(boat.create).mockResolvedValueOnce({ sandboxId: "bx_build2" });
    await computers.reactivate(org, admin, overview.builds[0]!.id);
    await builder.tick();
    overview = await computers.overview(org);
    expect(overview.snapshotName).toBe(cloudV2SnapshotName("alpha", org, 2));
    expect(overview.builds[0]!.recipe).toMatchObject({ rebuiltFrom: 1 });
    expect(overview.builds[0]!.recipe.repositories[0]!.commit).toBe(commit);
    expect(boat.deleteSnapshot).toHaveBeenCalledWith(cloudV2SnapshotName("alpha", org, 1));
    expect(boat.delete).toHaveBeenCalledWith("bx_build1");
    expect(overview.builds[1]).toMatchObject({ state: "succeeded", snapshotId: null });
  });

  it("records a failed setup without touching the live snapshot", async () => {
    const boat = compute();
    vi.mocked(boat.exec).mockResolvedValueOnce({ exitCode: 0, stdout: commit, timedOut: false })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "ERR! missing", timedOut: false });
    const builder = new CloudV2ComputerBuilder({ computers, compute: boat, channel: "alpha", cloneToken: async () => "ghs_token" });
    const build = await computers.enqueue(org, admin, recipe);
    await builder.tick();
    const overview = await computers.overview(org);
    expect(overview.snapshotName).toBeNull();
    expect(overview.builds[0]).toMatchObject({ state: "failed", errorCode: "computer_setup_failed" });
    expect(await computers.log(org, build.id)).toContain("ERR! missing");
    expect(boat.saveSnapshot).not.toHaveBeenCalled();
  });
});
