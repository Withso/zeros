import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudV2Store } from "./store.js";
import { CloudGithubPrStore } from "./github-pr-store.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("cloud GitHub checkout metadata", () => {
  let pool: pg.Pool, workspaces: CloudV2Store, github: CloudGithubPrStore;
  let organizationId: string, creatorUserId: string, otherUserId: string;
  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 3,
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    workspaces = new CloudV2Store(pool);
    github = new CloudGithubPrStore(pool);
    organizationId = randomUUID();
    creatorUserId = randomUUID();
    otherUserId = randomUUID();
    for (const id of [creatorUserId, otherUserId])
      await pool.query(
        "INSERT INTO users(id,email,display_name) VALUES($1,$2,'User')",
        [id, `${id}@example.test`],
      );
    await grantTestPro(pool, creatorUserId, otherUserId);
    await pool.query(
      "INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Org',$3,false,true)",
      [organizationId, `org-${organizationId}`, creatorUserId],
    );
    await pool.query(
      "INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",
      [organizationId, creatorUserId, otherUserId],
    );
  });
  async function fixture() {
    const workspace = await workspaces.createWorkspace({
      id: randomUUID(),
      organizationId,
      creatorUserId,
      name: "Workspace",
      repository: "old-owner/project",
      branch: "topic",
      baseBranch: "main",
      computerBuildId: null,
    });
    const token = await workspaces.rotateWorkerToken(workspace.id),
      boot = randomUUID();
    await workspaces.acceptWorkerHello(token, boot);
    return { workspace, token, boot };
  }
  const initial = {
    sequence: 1,
    branch: "topic",
    baseBranch: "main",
    headSha: "a".repeat(40),
  };
  const identity = {
    repositoryId: "42",
    repository: "new-owner/project",
    defaultBranch: "main",
    private: true,
    canPush: true,
  };

  it("pins repository identity while preserving the checkout path and original workspace record", async () => {
    const { workspace, token, boot } = await fixture();
    await github.checkout(token, boot, initial);
    const context = await github.context(workspace.id, creatorUserId);
    await github.repository(context, identity);
    expect(await github.context(workspace.id, creatorUserId)).toMatchObject({
      repositoryId: "42",
      repository: "new-owner/project",
      revision: context.revision,
    });
    expect((await github.documents([workspace]))[0]).toMatchObject({
      repository: "new-owner/project",
      checkoutPath: "/home/user/old-owner/project",
      github: {
        repositoryId: "42",
        branch: "topic",
        baseBranch: "main",
        headSha: initial.headSha,
      },
    });
    expect((await workspaces.get(workspace.id, creatorUserId)).repository).toBe(
      "old-owner/project",
    );
    await expect(
      github.repository(await github.context(workspace.id, creatorUserId), {
        ...identity,
        repositoryId: "99",
      }),
    ).rejects.toMatchObject({ code: "github_repository_changed" });
  });

  it("orders reports within a boot, accepts lost acknowledgements and rejects conflicting reuse", async () => {
    const { workspace, token, boot } = await fixture();
    await github.checkout(token, boot, initial);
    const first = await github.context(workspace.id, creatorUserId);
    await github.checkout(token, boot, initial);
    await github.checkout(token, boot, {
      ...initial,
      sequence: 3,
      branch: "second",
      headSha: "b".repeat(40),
    });
    const second = await github.context(workspace.id, creatorUserId);
    expect(second).toMatchObject({ branch: "second", headSha: "b".repeat(40) });
    expect(second.revision).not.toBe(first.revision);
    await github.checkout(token, boot, { ...initial, sequence: 2 });
    expect(await github.context(workspace.id, creatorUserId)).toEqual(second);
    await expect(
      github.checkout(token, boot, { ...initial, sequence: 3 }),
    ).rejects.toMatchObject({ code: "github_checkout_conflict" });
  });

  it("never rolls a canonical name back when an older successful permission refresh arrives late", async () => {
    const { workspace, token, boot } = await fixture();
    await github.checkout(token, boot, initial);
    const context = await github.context(workspace.id, creatorUserId);
    const observed = (at: string) => ({ at: new Date(at), assertCurrent: async () => {} });
    await github.repository(context, identity, observed("2026-01-01T00:00:00Z"));
    const current = await github.context(workspace.id, creatorUserId);
    await github.repository(current, identity, observed("2026-01-01T00:20:00Z"));
    const revision = await workspaces.loginRevision(workspace.id);
    await github.repository(current, { ...identity, repository: "intermediate/project" }, observed("2026-01-01T00:10:00Z"));
    expect((await github.context(workspace.id, creatorUserId)).repository).toBe(identity.repository);
    expect(await workspaces.loginRevision(workspace.id)).toBe(revision);
    expect(await github.aliases(workspace)).not.toContain("intermediate/project");
    await expect(github.repository(current, { ...identity, repositoryId: "99" }, observed("2025-01-01T00:00:00Z")))
      .rejects.toMatchObject({ code: "github_repository_changed" });
  });

  it("rejects an old worker boot and retires an old checkout revision after restart", async () => {
    const { workspace, token, boot } = await fixture();
    await github.checkout(token, boot, initial);
    const prior = await github.context(workspace.id, creatorUserId),
      nextBoot = randomUUID();
    await workspaces.acceptWorkerHello(token, nextBoot);
    await expect(
      github.checkout(token, boot, { ...initial, sequence: 2 }),
    ).rejects.toMatchObject({ code: "worker_boot_changed" });
    await github.checkout(token, nextBoot, initial);
    expect(
      (await github.context(workspace.id, creatorUserId)).revision,
    ).not.toBe(prior.revision);
    await expect(github.repository(prior, identity)).rejects.toMatchObject({
      code: "github_authorization_changed",
    });
  });

  it("never discloses another creator's metadata and revokes reports after membership removal", async () => {
    const { workspace, token, boot } = await fixture();
    await github.checkout(token, boot, initial);
    await expect(
      github.context(workspace.id, otherUserId),
    ).rejects.toMatchObject({ code: "not_found" });
    await pool.query(
      "DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2",
      [organizationId, creatorUserId],
    );
    await expect(
      github.context(workspace.id, creatorUserId),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      github.checkout(token, boot, { ...initial, sequence: 2 }),
    ).rejects.toMatchObject({ code: "worker_boot_changed" });
  });

  it("does not advertise new GitHub capability for an unobserved legacy checkout", async () => {
    const { workspace } = await fixture();
    await github.repository(
      await github.context(workspace.id, creatorUserId),
      identity,
    );
    expect((await github.documents([workspace]))[0]).not.toHaveProperty(
      "github",
    );
  });
});
