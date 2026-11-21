import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import {
  CloudRepositoryLevels, PRIVATE_REPOSITORY_LIMIT, migrateRepositoryLevels, revertRepositoryLevelsMigration,
} from "./repository-levels.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;

d("GitHub at two levels", () => {
  let pool: pg.Pool, levels: CloudRepositoryLevels, org: string;
  let owner: string, admin: string, member: string, other: string, removed: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    levels = new CloudRepositoryLevels(pool);
    [owner, admin, member, other, removed] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const id of [owner, admin, member, other, removed]) await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')", [id, `u-${id}@example.test`]);
    await grantTestPro(pool, owner, admin, member, other, removed);
    org = randomUUID();
    await pool.query("INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1,$2,'Withso',$3,false,true)",
      [org, `org-${org}`, owner]);
    await pool.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'member'),($1,$5,'member')`,
      [org, owner, admin, member, other]);
  });
  const connectOrganization = (by = admin, installationId = 501, account = "withso") =>
    levels.connect(org, by, { installationId, accountLogin: account, level: "organization" });
  const expectCode = async (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code });

  it("keeps each member's personal connections and private repositories to that member, admins included", async () => {
    const mine = await levels.connect(org, member, { installationId: 700, accountLogin: "member-gh", level: "personal" });
    await levels.add(org, member, { repository: "member-gh/notes", repositoryId: "9001", level: "private", connectionId: mine.id });
    for (const viewer of [owner, admin, other]) {
      expect((await levels.connections(org, viewer)).map(row => row.id)).not.toContain(mine.id);
      expect((await levels.repositories(org, viewer)).private).toEqual([]);
      expect(await levels.levelFor(org, viewer, "member-gh/notes")).toBeNull();
      await expectCode(levels.disconnect(org, viewer, mine.id), "not_found");
    }
    expect((await levels.connections(org, member)).map(row => [row.id, row.mine])).toEqual([[mine.id, true]]);
    expect((await levels.repositories(org, member)).private.map(row => row.repository)).toEqual(["member-gh/notes"]);
    await expectCode(levels.connections(org, removed), "not_found");
    await expectCode(levels.repositories(org, removed), "not_found");
  });

  it("keeps a member's private repositories from everyone after they leave, and lets them do nothing", async () => {
    const entry = await levels.add(org, member, { repository: "member-gh/notes", repositoryId: "9001", level: "private" });
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, member]);
    for (const viewer of [owner, admin, other]) {
      expect((await levels.repositories(org, viewer)).private).toEqual([]);
      expect(await levels.levelFor(org, viewer, "member-gh/notes")).toBeNull();
      await expectCode(levels.share(org, viewer, entry.id), viewer === other ? "forbidden" : "not_found");
      await expectCode(levels.remove(org, viewer, entry.id), "not_found");
    }
    for (const action of [levels.repositories(org, member), levels.connections(org, member), levels.remove(org, member, entry.id),
      levels.add(org, member, { repository: "member-gh/more", repositoryId: "9002", level: "private" })])
      await expectCode(action, "not_found");
  });

  it("lets owners and admins add shared repositories through an organization connection only", async () => {
    await expectCode(levels.add(org, admin, { repository: "withso/zeros", repositoryId: "42", level: "shared" }), "organization_connection_required");
    await expectCode(connectOrganization(member), "forbidden");
    const connection = await connectOrganization(admin);
    for (const [by, code] of [[member, "forbidden"], [removed, "not_found"]] as const)
      await expectCode(levels.add(org, by, { repository: "withso/zeros", repositoryId: "42", level: "shared" }), code);
    const shared = await levels.add(org, owner, { repository: "Withso/Zeros", repositoryId: "42", level: "shared" });
    expect(shared).toMatchObject({ repository: "withso/zeros", level: "shared", connectionId: connection.id });
    for (const viewer of [owner, admin, member, other]) expect((await levels.repositories(org, viewer)).shared.map(row => row.id)).toEqual([shared.id]);
    // Shared wins: nobody can add it for themselves.
    await expectCode(levels.add(org, member, { repository: "withso/zeros", repositoryId: "42", level: "private" }), "repository_already_shared");
    await expect(levels.add(org, member, { repository: "withso/zeros", repositoryId: "42", level: "private" }))
      .rejects.toThrow("This repository is already available to everyone in Withso.");
    await expectCode(levels.remove(org, member, shared.id), "forbidden");
    await levels.remove(org, admin, shared.id);
  });

  it("folds every member's private entry into the shared one when an admin shares it; their workspaces stay theirs", async () => {
    await connectOrganization(admin);
    const mine = await levels.add(org, admin, { repository: "withso/api", repositoryId: "77", level: "private" });
    const theirs = await levels.add(org, member, { repository: "withso/api", repositoryId: "77", level: "private" });
    const workspace = randomUUID();
    await pool.query(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, private_owner_user_id)
      VALUES ($1,$2,$3,'api','withso/api','zeros/a','main','stopped',$3)`, [workspace, org, member]);
    await expectCode(levels.share(org, member, theirs.id), "forbidden");
    // An admin cannot see, or share, another member's entry.
    await expectCode(levels.share(org, admin, theirs.id), "not_found");
    const shared = await levels.share(org, admin, mine.id);
    expect(shared).toMatchObject({ level: "shared", repositoryId: "77" });
    for (const viewer of [admin, member]) expect((await levels.repositories(org, viewer)).private).toEqual([]);
    expect(await levels.levelFor(org, member, "withso/api")).toMatchObject({ level: "shared" });
    expect((await pool.query("SELECT creator_user_id, private_owner_user_id FROM cloud_v2_workspaces WHERE id=$1", [workspace])).rows[0])
      .toEqual({ creator_user_id: member, private_owner_user_id: member });
  });

  it("asks for an organization connection that can read a repository before sharing it", async () => {
    await connectOrganization(admin, 501, "someone-else");
    const mine = await levels.add(org, admin, { repository: "withso/api", repositoryId: "77", level: "private" });
    await expect(levels.share(org, admin, mine.id)).rejects.toMatchObject({ code: "organization_connection_required",
      message: "Connect withso on GitHub for the organization first." });
  });

  it("records an installation once per organization and moves a member's personal link up, keeping their repositories private", async () => {
    const personal = await levels.connect(org, member, { installationId: 501, accountLogin: "withso", level: "personal" });
    const kept = await levels.add(org, member, { repository: "withso/tools", repositoryId: "88", level: "private", connectionId: personal.id });
    const organization = await connectOrganization(admin);
    expect(organization.level).toBe("organization");
    expect(await connectOrganization(owner)).toMatchObject({ id: organization.id });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_github_installations WHERE org_id=$1 AND installation_id=501", [org])).rows[0].n).toBe(1);
    expect((await levels.repositories(org, member)).private).toEqual([expect.objectContaining({ id: kept.id, connectionId: organization.id, level: "private" })]);
    // A member linking it again uses the organization's.
    expect(await levels.connect(org, other, { installationId: 501, accountLogin: "withso", level: "personal" })).toMatchObject({ id: organization.id });
  });

  it("keeps at most 20 private repositories per member, and none while the organization forbids them", async () => {
    for (let index = 0; index < PRIVATE_REPOSITORY_LIMIT; index++)
      await levels.add(org, member, { repository: `member/r${index}`, repositoryId: String(100 + index), level: "private" });
    await expectCode(levels.add(org, member, { repository: "member/more", repositoryId: "999", level: "private" }), "private_repository_limit");
    await levels.add(org, other, { repository: "member/more", repositoryId: "999", level: "private" });
    await expectCode(levels.setPersonalAllowed(org, member, false), "forbidden");
    await levels.setPersonalAllowed(org, admin, false);
    await expectCode(levels.add(org, other, { repository: "member/again", repositoryId: "1000", level: "private" }), "personal_repositories_forbidden");
    expect(await levels.levelFor(org, other, "member/more")).toMatchObject({ level: "private", allowed: false });
    // Existing entries stay theirs; the setting stops refreshing and creating.
    expect((await levels.repositories(org, other))).toMatchObject({ personalAllowed: false, private: [expect.objectContaining({ repository: "member/more" })] });
  });

  it("migrates live Cloud Computer repositories to shared ones under organization connections: dry run, idempotent, reversible", async () => {
    // Shaped like production: a succeeded build with admitted source targets, members' own sign-ins.
    const build = randomUUID();
    await pool.query(`INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, snapshot_id, created_by, source_policy_version, source_targets)
      VALUES ($1,$2,3,$3,'succeeded','zeros-alpha-org-v3',$4,3,$5)`, [build, org,
      JSON.stringify({ repositories: [{ repository: "Withso/zeros", commit: "a".repeat(40), branch: "main" }, { repository: "withso/web" }, { repository: "acme/lib" }] }),
      admin, JSON.stringify([{ repository: "withso/zeros", repositoryId: "42" }, { repository: "withso/web", repositoryId: "43" }, { repository: "acme/lib", repositoryId: "44" }])]);
    await pool.query("INSERT INTO cloud_v2_computers (org_id, active_build_id, snapshot_name) VALUES ($1,$2,'zeros-alpha-org-v3')", [org, build]);
    await pool.query("INSERT INTO cloud_github_selections (org_id, owner_user_id, selected_method) VALUES ($1,$2,'github-app')", [org, member]);
    const credentials = (await pool.query("SELECT * FROM cloud_github_selections ORDER BY owner_user_id")).rows;
    expect(await migrateRepositoryLevels(pool, { dryRun: true })).toEqual({ organizations: 1, connections: 2, repositories: 3 });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_repositories")).rows[0].n).toBe(0);
    expect(await migrateRepositoryLevels(pool)).toEqual({ organizations: 1, connections: 2, repositories: 3 });
    expect(await migrateRepositoryLevels(pool)).toEqual({ organizations: 1, connections: 0, repositories: 0 });
    const shared = (await levels.repositories(org, member)).shared.map(row => row.repository).sort();
    expect(shared).toEqual(["acme/lib", "withso/web", "withso/zeros"]);
    expect((await levels.connections(org, member)).map(row => [row.accountLogin, row.level, row.installationId])).toEqual([
      ["acme", "organization", null], ["withso", "organization", null]]);
    expect((await pool.query("SELECT * FROM cloud_github_selections ORDER BY owner_user_id")).rows).toEqual(credentials);
    // Connecting the installation binds the migrated connection instead of adding another.
    const bound = await connectOrganization(admin, 501, "withso");
    expect((await levels.connections(org, admin)).filter(row => row.accountLogin === "withso")).toEqual([expect.objectContaining({ id: bound.id, installationId: 501 })]);
    expect(await revertRepositoryLevelsMigration(pool)).toEqual({ connections: 1, repositories: 3 });
    expect((await levels.repositories(org, member)).shared).toEqual([]);
    expect((await levels.connections(org, admin)).map(row => row.accountLogin)).toEqual(["withso"]);
  });
});
