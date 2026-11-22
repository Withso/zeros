import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudRepositoryLevels } from "./repository-levels.js";
import { CloudProjects, PERSONAL_PROJECT_LIMIT, PROJECT_REPOSITORY_LIMIT, migrateProjects, revertProjectsMigration } from "./projects.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const repo = (repository: string, id: string, extra: Record<string, string> = {}) => ({ repository, repositoryId: id, ...extra });

d("cloud projects and GitHub at two levels", () => {
  let pool: pg.Pool, levels: CloudRepositoryLevels, projects: CloudProjects, org: string;
  let owner: string, admin: string, member: string, other: string, removed: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    levels = new CloudRepositoryLevels(pool);
    projects = new CloudProjects(pool);
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
  const personal = (by: string, name: string, repositories = [repo("member-gh/notes", "9001")]) =>
    projects.create(org, by, { name, level: "personal", repositories });

  it("keeps each member's personal connections and projects to that member, admins included", async () => {
    const link = await levels.connect(org, member, { installationId: 700, accountLogin: "member-gh", level: "personal" });
    const mine = await personal(member, "Notes");
    expect(mine).toMatchObject({ level: "personal", ownerUserId: member, canEdit: true,
      repositories: [{ repository: "member-gh/notes", repositoryId: "9001", connectionId: link.id, position: 0 }] });
    for (const viewer of [owner, admin, other]) {
      expect((await levels.connections(org, viewer)).map(row => row.id)).not.toContain(link.id);
      expect(await projects.list(org, viewer)).toEqual([]);
      expect([...(await projects.usedBy(org, viewer, ["9001"])).keys()]).toEqual([]);
      expect(await projects.forRepository(org, viewer, "member-gh/notes")).toBeNull();
      expect(await projects.oneRepositoryProjects(org, viewer)).toEqual([]);
      await expectCode(projects.get(org, viewer, mine.id), "not_found");
      await expectCode(projects.update(org, viewer, mine.id, { name: "Taken" }), "not_found");
      await expectCode(projects.remove(org, viewer, mine.id), "not_found");
      await expectCode(projects.share(org, viewer, mine.id), viewer === other ? "forbidden" : "not_found");
      await expectCode(levels.disconnect(org, viewer, link.id), "not_found");
    }
    // Nobody's personal projects reach a server-side listing that has no viewer.
    expect(await projects.oneRepositoryProjects(org, null)).toEqual([]);
    expect((await projects.list(org, member)).map(row => row.id)).toEqual([mine.id]);
    expect((await projects.usedBy(org, member, ["9001"])).get("9001")).toEqual([{ id: mine.id, name: "Notes" }]);
    await expectCode(projects.list(org, removed), "not_found");
    await expectCode(levels.connections(org, removed), "not_found");
  });

  it("keeps a member's personal projects from everyone after they leave, and lets them do nothing", async () => {
    const mine = await personal(member, "Notes");
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, member]);
    for (const viewer of [owner, admin, other]) {
      expect(await projects.list(org, viewer)).toEqual([]);
      await expectCode(projects.get(org, viewer, mine.id), "not_found");
      await expectCode(projects.remove(org, viewer, mine.id), "not_found");
    }
    for (const action of [() => projects.list(org, member), () => projects.get(org, member, mine.id), () => projects.remove(org, member, mine.id),
      () => personal(member, "More"), () => levels.connections(org, member)])
      await expectCode(action(), "not_found");
  });

  it("lets owners and admins create and edit organization projects, only from repositories an organization connection reaches", async () => {
    await expectCode(projects.create(org, admin, { name: "Zeros", level: "organization", repositories: [repo("withso/zeros", "42")] }),
      "organization_connection_required");
    await expect(projects.create(org, admin, { name: "Zeros", level: "organization", repositories: [repo("withso/zeros", "42")] }))
      .rejects.toThrow("Connect withso on GitHub for projects to use withso/zeros.");
    // A member's personal link is not the organization's.
    await levels.connect(org, admin, { installationId: 700, accountLogin: "withso", level: "personal" });
    await expectCode(projects.create(org, admin, { name: "Zeros", level: "organization", repositories: [repo("withso/zeros", "42")] }),
      "organization_connection_required");
    await expectCode(connectOrganization(member, 501), "forbidden");
    const connection = await connectOrganization(admin, 501);
    for (const [by, code] of [[member, "forbidden"], [removed, "not_found"]] as const)
      await expectCode(projects.create(org, by, { name: "Zeros", level: "organization", repositories: [repo("withso/zeros", "42")] }), code);
    const zeros = await projects.create(org, owner, { name: "Zeros", level: "organization",
      repositories: [repo("Withso/Zeros", "42", { defaultBranch: "main", setup: "pnpm install" }), repo("withso/web", "43")] });
    expect(zeros).toMatchObject({ level: "organization", ownerUserId: null, repositories: [
      { repository: "withso/zeros", connectionId: connection.id, defaultBranch: "main", setup: "pnpm install", position: 0 },
      { repository: "withso/web", connectionId: connection.id, position: 1 }] });
    // Every member sees and uses it; only owners and admins edit it.
    for (const viewer of [owner, admin, member, other]) expect((await projects.list(org, viewer)).map(row => [row.id, row.canEdit]))
      .toEqual([[zeros.id, viewer === owner || viewer === admin]]);
    await expectCode(projects.update(org, member, zeros.id, { name: "Mine" }), "forbidden");
    await expectCode(projects.remove(org, member, zeros.id), "forbidden");
    // The same repository in another project has its own branch and setup.
    const docs = await projects.create(org, admin, { name: "Docs", level: "organization", repositories: [repo("withso/zeros", "42", { defaultBranch: "docs" })] });
    expect(docs.repositories[0]).toMatchObject({ defaultBranch: "docs", setup: null });
    await expectCode(projects.create(org, admin, { name: "zeros", level: "organization", repositories: [repo("withso/web", "43")] }), "project_name_taken");
    // Only what changed is reported, so only that copy rebuilds.
    expect((await projects.update(org, admin, zeros.id, { name: "Zeros app" })).change).toBeNull();
    expect((await projects.update(org, admin, zeros.id, { repositories: [repo("withso/zeros", "42", { defaultBranch: "main", setup: "pnpm i" }),
      repo("withso/web", "43")] })).change).toBe("setup_changed");
    expect((await projects.update(org, admin, zeros.id, { repositories: [repo("withso/zeros", "42", { defaultBranch: "next", setup: "pnpm i" }),
      repo("withso/web", "43")] })).change).toBe("branch_changed");
    expect((await projects.update(org, admin, zeros.id, { repositories: [repo("withso/web", "43"), repo("withso/zeros", "42")] })).change)
      .toBe("repositories_changed");
    await projects.remove(org, admin, docs.id);
  });

  it("shares an admin's own personal project with the organization once a connection reaches it; its workspaces stay private", async () => {
    const mine = await projects.create(org, admin, { name: "API", level: "personal", repositories: [repo("withso/api", "77")] });
    const theirs = await projects.create(org, member, { name: "API", level: "personal", repositories: [repo("withso/api", "77")] });
    const workspace = randomUUID();
    await pool.query(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state, private_owner_user_id, project_id)
      VALUES ($1,$2,$3,'api','withso/api','zeros/a','main','stopped',$3,$4)`, [workspace, org, admin, mine.id]);
    // "Share with" is offered only where it can succeed: the admin's own, every repository reachable through an organization connection.
    const offered = async (user: string) => Object.fromEntries((await projects.list(org, user)).map(row => [row.id, row.canShare]));
    expect(await offered(admin)).toMatchObject({ [mine.id]: false });
    await expectCode(projects.share(org, admin, mine.id), "organization_connection_required");
    await connectOrganization(admin, 501, "withso");
    expect(await offered(admin)).toMatchObject({ [mine.id]: true });
    expect(await offered(member)).toMatchObject({ [theirs.id]: false });
    expect((await projects.get(org, admin, mine.id)).canShare).toBe(true);
    await expectCode(projects.share(org, member, theirs.id), "forbidden");
    // An admin cannot see, or share, another member's project.
    await expectCode(projects.share(org, admin, theirs.id), "not_found");
    const shared = await projects.share(org, admin, mine.id);
    expect(shared).toMatchObject({ level: "organization", ownerUserId: null, canShare: false, repositories: [expect.objectContaining({ connectionId: expect.any(String) })] });
    expect((await projects.list(org, other)).map(row => row.id)).toEqual([shared.id]);
    // The member's own project of the same repository is still theirs alone.
    expect((await projects.list(org, member)).map(row => row.id)).toEqual([shared.id, theirs.id]);
    expect((await pool.query("SELECT creator_user_id, private_owner_user_id FROM cloud_v2_workspaces WHERE id=$1", [workspace])).rows[0])
      .toEqual({ creator_user_id: admin, private_owner_user_id: admin });
  });

  it("records an installation once per organization and moves a member's personal link up, keeping their projects theirs", async () => {
    const link = await levels.connect(org, member, { installationId: 501, accountLogin: "withso", level: "personal" });
    const kept = await projects.create(org, member, { name: "Tools", level: "personal", repositories: [repo("withso/tools", "88", { connectionId: link.id })] });
    const organization = await connectOrganization(admin);
    expect(organization.level).toBe("organization");
    expect(await connectOrganization(owner)).toMatchObject({ id: organization.id });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_github_installations WHERE org_id=$1 AND installation_id=501", [org])).rows[0].n).toBe(1);
    expect(await projects.get(org, member, kept.id)).toMatchObject({ level: "personal", repositories: [expect.objectContaining({ connectionId: organization.id })] });
    expect(await levels.connect(org, other, { installationId: 501, accountLogin: "withso", level: "personal" })).toMatchObject({ id: organization.id });
  });

  it(`keeps at most ${PERSONAL_PROJECT_LIMIT} personal projects per member and ${PROJECT_REPOSITORY_LIMIT} repositories per project, and none while forbidden`, async () => {
    for (let index = 0; index < PERSONAL_PROJECT_LIMIT; index++) await personal(member, `P${index}`, [repo(`member/r${index}`, String(100 + index))]);
    await expectCode(personal(member, "More"), "personal_project_limit");
    await personal(other, "More");
    await connectOrganization(admin, 501, "withso");
    // Organization projects have no such limit.
    for (let index = 0; index < PERSONAL_PROJECT_LIMIT + 1; index++)
      await projects.create(org, admin, { name: `O${index}`, level: "organization", repositories: [repo(`withso/r${index}`, String(500 + index))] });
    const many = Array.from({ length: PROJECT_REPOSITORY_LIMIT + 1 }, (_, index) => repo(`withso/m${index}`, String(900 + index)));
    await expectCode(projects.create(org, admin, { name: "Many", level: "organization", repositories: many }), "project_repository_limit");
    await projects.create(org, admin, { name: "Ten", level: "organization", repositories: many.slice(0, PROJECT_REPOSITORY_LIMIT) });
    await expectCode(projects.create(org, admin, { name: "Twice", level: "organization", repositories: [repo("withso/a", "1"), repo("withso/a", "1")] }), "invalid_input");
    await expectCode(levels.setPersonalAllowed(org, member, false), "forbidden");
    await levels.setPersonalAllowed(org, admin, false);
    await expectCode(personal(other, "Again"), "personal_projects_forbidden");
    // Existing ones stay theirs; the setting stops refreshing and creating.
    expect((await projects.list(org, other)).filter(row => row.level === "personal").map(row => row.name)).toEqual(["More"]);
    expect(await levels.access(org, other)).toEqual({ admin: false, personalAllowed: false });
  });

  it("answers released desktops from one-repository projects only, the organization's first, and syncs their recipe into them", async () => {
    await connectOrganization(admin, 501, "withso");
    const zeros = await projects.create(org, admin, { name: "zeros", level: "organization", repositories: [repo("withso/zeros", "42", { defaultBranch: "main" })] });
    await projects.create(org, admin, { name: "Pair", level: "organization", repositories: [repo("withso/web", "43"), repo("withso/api", "44")] });
    const mine = await projects.create(org, member, { name: "Mine", level: "personal", repositories: [repo("withso/zeros", "42")] });
    const notes = await projects.create(org, member, { name: "Notes", level: "personal", repositories: [repo("withso/notes", "45")] });
    expect((await projects.forRepository(org, member, "Withso/Zeros"))?.id).toBe(zeros.id);
    expect((await projects.forRepository(org, member, "withso/notes"))?.id).toBe(notes.id);
    expect(await projects.forRepository(org, member, "withso/web")).toBeNull();
    expect((await projects.oneRepositoryProjects(org, member)).map(row => row.id)).toEqual([zeros.id, mine.id, notes.id]);
    expect((await projects.oneRepositoryProjects(org, null)).map(row => row.id)).toEqual([zeros.id]);
    // A released desktop saves its recipe: entries become, update or remove one-repository organization projects.
    const shown = async () => Number((await pool.query("SELECT recipe_revision FROM cloud_v2_computers WHERE org_id=$1", [org])).rows[0]?.recipe_revision ?? 0);
    const { changed } = await projects.syncRecipe(org, admin, [{ repository: "withso/zeros", repositoryId: "42", ref: "main", setup: "pnpm install" },
      { repository: "withso/web", repositoryId: "43" }], await shown());
    const after = await projects.oneRepositoryProjects(org, null);
    expect(after.map(row => [row.name, row.repositories[0]!.repository, row.repositories[0]!.setup])).toEqual([["zeros", "withso/zeros", "pnpm install"],
      ["web", "withso/web", null]]);
    expect(changed).toEqual([{ projectId: zeros.id, change: "setup_changed" }, { projectId: after[1]!.id, change: "project_created" }]);
    expect((await projects.list(org, admin)).map(row => row.name)).toEqual(["Pair", "web", "zeros"]);
    await projects.syncRecipe(org, admin, [{ repository: "withso/web", repositoryId: "43" }], await shown());
    expect((await projects.oneRepositoryProjects(org, null)).map(row => row.name)).toEqual(["web"]);
    // The member's own projects are never touched by a recipe save.
    expect((await projects.list(org, member)).filter(row => row.level === "personal").map(row => row.id)).toEqual([mine.id, notes.id]);
  });

  it("migrates live Cloud Computer repositories to one-repository organization projects: dry run, idempotent, reversible", async () => {
    // Shaped like production: a succeeded build with admitted source targets, members' own sign-ins.
    const build = randomUUID();
    await pool.query(`INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, snapshot_id, created_by, source_policy_version, source_targets)
      VALUES ($1,$2,3,$3,'succeeded','zeros-alpha-org-v3',$4,3,$5)`, [build, org,
      JSON.stringify({ repositories: [{ repository: "Withso/zeros", commit: "a".repeat(40), branch: "main", setup: "pnpm install" }, { repository: "withso/web", ref: "next" },
        { repository: "acme/zeros" }] }),
      admin, JSON.stringify([{ repository: "withso/zeros", repositoryId: "42" }, { repository: "withso/web", repositoryId: "43" }, { repository: "acme/zeros", repositoryId: "44" }])]);
    await pool.query("INSERT INTO cloud_v2_computers (org_id, active_build_id, snapshot_name) VALUES ($1,$2,'zeros-alpha-org-v3')", [org, build]);
    await pool.query("INSERT INTO cloud_github_selections (org_id, owner_user_id, selected_method) VALUES ($1,$2,'github-app')", [org, member]);
    const credentials = (await pool.query("SELECT * FROM cloud_github_selections ORDER BY owner_user_id")).rows;
    expect(await migrateProjects(pool, { dryRun: true })).toEqual({ organizations: 1, connections: 2, projects: 3 });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_projects")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_github_installations")).rows[0].n).toBe(0);
    expect(await migrateProjects(pool)).toEqual({ organizations: 1, connections: 2, projects: 3 });
    expect(await migrateProjects(pool)).toEqual({ organizations: 1, connections: 0, projects: 0 });
    const migrated = await projects.list(org, member);
    // Named after the repository; a second repository of that name gets its owner too.
    expect(migrated.map(row => [row.name, row.level, row.repositories.map(entry => [entry.repository, entry.repositoryId, entry.defaultBranch, entry.setup])])).toEqual([
      ["acme/zeros", "organization", [["acme/zeros", "44", null, null]]],
      ["web", "organization", [["withso/web", "43", "next", null]]],
      ["zeros", "organization", [["withso/zeros", "42", null, "pnpm install"]]]]);
    expect((await levels.connections(org, member)).map(row => [row.accountLogin, row.level, row.installationId])).toEqual([
      ["acme", "organization", null], ["withso", "organization", null]]);
    expect((await pool.query("SELECT * FROM cloud_github_selections ORDER BY owner_user_id")).rows).toEqual(credentials);
    // Connecting the installation binds the migrated connection instead of adding another.
    const bound = await connectOrganization(admin, 501, "withso");
    expect((await levels.connections(org, admin)).filter(row => row.accountLogin === "withso")).toEqual([expect.objectContaining({ id: bound.id, installationId: 501 })]);
    // A project someone edited since is theirs now and stays.
    await projects.update(org, admin, migrated[1]!.id, { name: "Web app" });
    expect(await revertProjectsMigration(pool)).toEqual({ connections: 1, projects: 2 });
    expect((await projects.list(org, member)).map(row => row.name)).toEqual(["Web app"]);
    expect((await levels.connections(org, admin)).map(row => row.accountLogin)).toEqual(["withso"]);
  });

  it("reverts every migrated project nobody edited, however many there are", async () => {
    // Many rows, so two timestamps taken a microsecond apart would show.
    const count = 60, build = randomUUID();
    const repositories = Array.from({ length: count }, (_, index) => ({ repository: `withso/r${index}` }));
    await pool.query(`INSERT INTO cloud_v2_computer_builds (id, org_id, version, recipe, state, snapshot_id, created_by, source_policy_version, source_targets)
      VALUES ($1,$2,1,$3,'succeeded','zeros-alpha-org-v1',$4,3,$5)`, [build, org, JSON.stringify({ repositories }), admin,
      JSON.stringify(repositories.map((entry, index) => ({ repository: entry.repository, repositoryId: String(1000 + index) })))]);
    await pool.query("INSERT INTO cloud_v2_computers (org_id, active_build_id, snapshot_name) VALUES ($1,$2,'zeros-alpha-org-v1')", [org, build]);
    expect(await migrateProjects(pool)).toEqual({ organizations: 1, connections: 1, projects: count });
    expect(await revertProjectsMigration(pool)).toEqual({ connections: 1, projects: count });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_projects")).rows[0].n).toBe(0);
  });

  describe("a released desktop's recipe save", () => {
    const revision = async () => Number((await pool.query("SELECT recipe_revision FROM cloud_v2_computers WHERE org_id=$1", [org])).rows[0]?.recipe_revision ?? 0);
    const names = async () => (await projects.list(org, admin)).map(row => row.name);
    beforeEach(async () => { await connectOrganization(admin, 501, "withso"); });

    it("is refused when a project was created in the new UI after the list was loaded, and removes nothing", async () => {
      const shown = await revision();
      await projects.create(org, owner, { name: "web", level: "organization", repositories: [repo("withso/web", "43")] });
      await expectCode(projects.syncRecipe(org, admin, [], shown), "computer_recipe_changed");
      expect(await names()).toEqual(["web"]);
    });

    it("is refused when a project was edited, removed or shared after the list was loaded", async () => {
      const web = await projects.create(org, owner, { name: "web", level: "organization", repositories: [repo("withso/web", "43")] });
      const api = await projects.create(org, owner, { name: "api", level: "organization", repositories: [repo("withso/api", "44")] });
      const mine = await projects.create(org, admin, { name: "mine", level: "personal", repositories: [repo("withso/tools", "45")] });
      for (const change of [() => projects.update(org, owner, web.id, { repositories: [repo("withso/web", "43", { setup: "make" })] }),
        () => projects.remove(org, owner, api.id), () => projects.share(org, admin, mine.id)]) {
        const shown = await revision();
        await change();
        await expectCode(projects.syncRecipe(org, admin, [repo("withso/web", "43")], shown), "computer_recipe_changed");
      }
      expect((await projects.get(org, admin, web.id)).repositories[0]!.setup).toBe("make");
      expect(await names()).toEqual(["mine", "web"]);
    });

    it("applies a save made from the current list, which may remove a project, and moves the revision", async () => {
      await projects.create(org, owner, { name: "web", level: "organization", repositories: [repo("withso/web", "43")] });
      const shown = await revision();
      const saved = await projects.syncRecipe(org, admin, [repo("withso/api", "44")], shown);
      expect(saved.revision).toBeGreaterThan(shown);
      expect(saved.revision).toBe(await revision());
      expect(await names()).toEqual(["api"]);
      // The other order: a project created after that save still survives the next stale one.
      await projects.create(org, owner, { name: "docs", level: "organization", repositories: [repo("withso/docs", "46")] });
      await expectCode(projects.syncRecipe(org, admin, [repo("withso/api", "44")], saved.revision), "computer_recipe_changed");
      expect(await names()).toEqual(["api", "docs"]);
    });

    it("never touches personal projects, whose writes leave the revision alone", async () => {
      const shown = await revision();
      const notes = await projects.create(org, member, { name: "notes", level: "personal", repositories: [repo("withso/notes", "47")] });
      await projects.update(org, member, notes.id, { name: "Notes" });
      expect(await revision()).toBe(shown);
      await projects.syncRecipe(org, admin, [], shown);
      expect((await projects.list(org, member)).map(row => row.name)).toEqual(["Notes"]);
    });

    it("without a revision (the oldest clients' build), adds and updates but never removes", async () => {
      await projects.create(org, owner, { name: "web", level: "organization", repositories: [repo("withso/web", "43")] });
      await projects.syncRecipe(org, admin, [repo("withso/api", "44")], null);
      expect(await names()).toEqual(["api", "web"]);
    });
  });
});
