import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "../../auth.js";
import { withSystemTx } from "../../db.js";
import { CloudTeamSharing } from "./store.js";
import { teamCursorKey } from "./contract.js";
import { teamSharingFixture, type TeamSharingFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("active cloud Creator ownership through the router and PostgreSQL", () => {
  let pool: pg.Pool, f: TeamSharingFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 5000 }); });
  beforeEach(async () => {
    f = await teamSharingFixture(pool, { ownership: true });
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode='active' WHERE id=$1", [f.workspace.id]);
  });
  afterAll(() => pool.end());
  afterEach(() => vi.restoreAllMocks());
  const path = () => `/v1/cloud-v2/workspaces/${f.workspace.id}`;
  const call = (suffix = "", method = "GET", body?: unknown, user: AuthedUser = f.creator, ownership = true) => f.app.request(`${path()}${suffix}`, {
    method, headers: { "x-test-actor": user.id, "x-zeros-team-sharing": "1",
      ...(ownership ? { "x-zeros-team-ownership": "1" } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const state = async () => (await pool.query(`SELECT creator_user_id,created_by_user_id,creator_revision::text,
    creator_absent_reason,creator_absent_at,login_revision::text,access_epoch::text,stop_generation::text,
    state,worker_token_hash,worker_boot_id,active_at,updated_at FROM cloud_v2_workspaces WHERE id=$1`, [f.workspace.id])).rows[0];
  const transfer = (toUserId = f.viewer.id, expectedCreatorUserId: string | null = f.creator.id, expectedCreatorRevision = "1") =>
    ({ requestId: randomUUID(), toUserId, expectedCreatorUserId, expectedCreatorRevision });

  it("negotiates ownership while preserving old assigned documents", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ teamSharing: 1, teamOwnership: 1, workspace: {
      creatorUserId: f.creator.id, createdByUserId: f.creator.id, teamOwnership: 1, creatorRevision: "1", noCreatorReason: null, canReassign: true,
    } });
    const old = await (await call("", "GET", undefined, f.creator, false)).json();
    for (const key of ["teamOwnership", "creatorRevision", "noCreatorReason", "canReassign"]) expect(old.workspace).not.toHaveProperty(key);
    const page = await (await f.call(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}&limit=1`, "GET", undefined, f.creator)).json();
    const cursor = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8"));
    expect(cursor.key).toBe(teamCursorKey([f.creator.id,f.organizationId,null,false,false,false,null,"exclude"]));
  });

  it("transfers only ownership, follows the prior Creator and removes the new Creator's follow", async () => {
    await f.sharing.mark(f.workspace.id, f.viewer, "follow", true);
    const before = await state(), body = transfer(), response = await call("/reassign", "POST", body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ teamOwnership: 1, workspace: { creatorUserId: f.viewer.id, creatorRevision: "2" },
      reassignment: { requestId: body.requestId, fromUserId: f.creator.id, toUserId: f.viewer.id, creatorRevision: "2" } });
    const after = await state();
    expect(after).toMatchObject({ ...before, creator_user_id: f.viewer.id, creator_revision: "2", login_revision: String(BigInt(before.login_revision) + 1n) });
    expect((await pool.query("SELECT user_id FROM cloud_v2_workspace_followers WHERE workspace_id=$1 ORDER BY user_id", [f.workspace.id])).rows)
      .toEqual([{ user_id: f.creator.id }]);
  });

  it("preserves canonical repository metadata while projecting current ownership", async () => {
    const documents = f.github.metadata.documents.bind(f.github.metadata);
    const updatedAt = new Date(Date.now() + 1000).toISOString();
    vi.spyOn(f.github.metadata, "documents").mockImplementation(async (...args) => (await documents(...args))
      .map(row => ({ ...row, repository: "renamed/project", updatedAt })));
    const response = await call("/reassign", "POST", transfer());
    expect(response.status).toBe(200);
    expect((await response.json()).workspace).toMatchObject({ creatorUserId: f.viewer.id, repository: "renamed/project", updatedAt });
  });

  it("replays an exact request after the caller becomes an ordinary member, but never a different body", async () => {
    await pool.query("UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]);
    const body = transfer();
    const first = await call("/reassign", "POST", body);
    expect(first.status).toBe(200);
    const receipt = (await first.json()).reassignment, before = await state();
    const replay = await call("/reassign", "POST", body);
    expect(replay.status).toBe(200); expect((await replay.json()).reassignment).toEqual(receipt);
    expect(await state()).toEqual(before);
    const conflict = await call("/reassign", "POST", { ...body, toUserId: f.admin.id });
    expect(conflict.status).toBe(409); expect((await conflict.json()).error.code).toBe("reassign_conflict");
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
    expect((await call("/reassign", "POST", body)).status).toBe(404);
  });

  it("compares the Creator and revision, and keeps same-Creator requests inert", async () => {
    const before = await state();
    const same = await call("/reassign", "POST", transfer(f.creator.id));
    expect(same.status).toBe(200); expect(await state()).toEqual(before);
    const stale = await call("/reassign", "POST", transfer(f.viewer.id, f.creator.id, "2"));
    expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe("creator_changed");
  });

  it("records one receipt for concurrent identical retries and does not revive an expired receipt", async () => {
    const body = transfer();
    const responses = await Promise.all([call("/reassign", "POST", body), call("/reassign", "POST", body)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const [first, second] = await Promise.all(responses.map(response => response.json()));
    expect(first.reassignment).toEqual(second.reassignment);
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_v2_reassignments WHERE workspace_id=$1", [f.workspace.id])).rows[0].count).toBe(1);
    await pool.query("UPDATE cloud_v2_reassignments SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1", [f.workspace.id]);
    const expired = await call("/reassign", "POST", body);
    expect(expired.status).toBe(409); expect((await expired.json()).error.code).toBe("creator_changed");
    expect((await state()).creator_revision).toBe("2");
  });

  it("lists eligible candidates without requiring an agent login", async () => {
    const response = await call("/reassign-candidates");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.creatorRevision).toBe("1"); expect(body.nextCursor).toBeNull();
    expect(body.candidates).toEqual(expect.arrayContaining([
      { userId: f.viewer.id, eligible: true, agentLogins: {} }, { userId: f.admin.id, eligible: true, agentLogins: {} },
    ]));
    expect(body.candidates.some((row: { userId: string }) => row.userId === f.creator.id)).toBe(false);
  });

  it("requires a manager, both opt-ins and an active workspace", async () => {
    const member = await call("/reassign", "POST", transfer(), f.viewer);
    expect(member.status).toBe(403); expect((await member.json()).error.code).toBe("workspace_management_denied");
    const old = await call("/reassign", "POST", transfer(), f.creator, false);
    expect(old.status).toBe(409); expect((await old.json()).error.code).toBe("team_ownership_required");
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode='prepared' WHERE id=$1", [f.workspace.id]);
    const legacy = await call("/reassign", "POST", transfer());
    expect(legacy.status).toBe(409); expect((await legacy.json()).error.code).toBe("team_activation_required");
  });

  it("bounds candidate load and rejects a forged or oversized reassignment before writing", async () => {
    for (const body of [{ ...transfer(), actorUserId: f.creator.id }, { ...transfer(), expectedCreatorRevision: "0" }])
      expect((await call("/reassign", "POST", body)).status).toBe(400);
    expect((await call("/reassign", "POST", { ...transfer(), extra: "x".repeat(16 * 1024) })).status).toBe(413);
    expect((await call("/reassign-candidates?limit=201")).status).toBe(400);
    for (let n = 0; n < 12; n++) expect((await call("/reassign-candidates?limit=1")).status).toBe(200);
    const limited = await call("/reassign-candidates?limit=1");
    expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toMatch(/^[1-9][0-9]*$/);
    expect((await state()).creator_revision).toBe("1");
    expect((await pool.query("SELECT 1 FROM cloud_v2_reassignments WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
  });

  it("clears a departed Creator durably and does not restore ownership when they rejoin", async () => {
    const before = await state();
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
    const after = await state();
    expect(after).toMatchObject({ ...before, creator_user_id: null, creator_revision: "2", creator_absent_reason: "left",
      creator_absent_at: expect.any(Date), login_revision: String(BigInt(before.login_revision) + 1n) });
    await withSystemTx(pool, tx => tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [f.organizationId, f.creator.id]));
    expect(await state()).toEqual(after);
    const document = await call("", "GET", undefined, f.viewer);
    expect(document.status).toBe(200);
    expect((await document.json()).workspace).toMatchObject({ creatorUserId: null, noCreatorReason: "left", canReassign: false });
    const assign = await call("/reassign", "POST", transfer(f.viewer.id, null, "2"), f.admin);
    expect(assign.status).toBe(200); expect((await assign.json()).workspace.creatorUserId).toBe(f.viewer.id);
  });

  it("still negotiates documents with ownership writes disabled", async () => {
    f = await teamSharingFixture(pool, { ownership: false });
    await pool.query("UPDATE cloud_v2_workspaces SET execution_mode='active' WHERE id=$1", [f.workspace.id]);
    const read = await call();
    expect(read.status).toBe(200); expect((await read.json()).workspace).toMatchObject({ teamOwnership: 1, canReassign: false });
    const write = await call("/reassign", "POST", transfer());
    expect(write.status).toBe(409); expect((await write.json()).error.code).toBe("team_ownership_required");
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
    expect((await pool.query("SELECT creator_user_id FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].creator_user_id).toBe(f.creator.id);
  });

  it("omits null Creators before old-client pagination and keeps the new filter admin-only", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET created_at=clock_timestamp()+interval '1 second' WHERE id=$1", [f.workspace.id]);
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
    const old = await f.call(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}&limit=1`, "GET", undefined, f.viewer);
    expect(old.status).toBe(200);
    expect(await old.json()).toMatchObject({ workspaces: [{ id: f.own.id }], nextCursor: null });
    const read = (user: AuthedUser, query = "") => f.app.request(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}&creator=none${query}`, {
      headers: { "x-test-actor": user.id, "x-zeros-team-sharing": "1", "x-zeros-team-ownership": "1" },
    });
    const admin = await read(f.admin);
    expect(admin.status).toBe(200); expect((await admin.json()).workspaces.map((w: { id: string }) => w.id)).toEqual([f.workspace.id]);
    expect((await read(f.viewer)).status).toBe(403);
    expect((await read(f.admin, "&mine=1")).status).toBe(400);
    const direct = await call("", "GET", undefined, f.admin, false);
    expect(direct.status).toBe(409); expect((await direct.json()).error.code).toBe("team_ownership_required");
    const plain = await f.call(path(), "GET", undefined, f.admin, false);
    expect(plain.status).toBe(409); expect((await plain.json()).error.code).toBe("team_ownership_required");
  });

  it("keeps null-Creator documents available when the write switch is turned off", async () => {
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
    const off = new CloudTeamSharing(pool, f.store, f.github, pool, undefined, { ownership: false });
    expect(await off.get(f.workspace.id, f.admin, true)).toMatchObject({ creatorUserId: null, canReassign: false });
    await expect(off.ownership.reassign(f.workspace.id, f.admin, transfer(f.viewer.id, null, "2")))
      .rejects.toMatchObject({ status: 409, code: "team_ownership_required" });
  });

  it("checks every source for a candidate and keeps provider uncertainty distinct from ineligibility", async () => {
    const id = randomUUID();
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_v2_workspaces(id,org_id,creator_user_id,name,repository,branch,base_branch,state,source_repositories,execution_mode)
        VALUES($1,$2,$3,'Sources','example/project','snapshot','main','stopped',ARRAY['example/project','example/snapshot'],'active')`, [id, f.organizationId, f.creator.id]);
      await tx.query("INSERT INTO cloud_v2_github_sources(workspace_id,source_repository,repository_id) VALUES($1,'example/project',42),($1,'example/snapshot',43)", [id]);
    });
    f.workspace = await f.store.get(id, f.creator.id);
    f.denied.add(`${f.viewer.id}:43`);
    const list = await call("/reassign-candidates");
    expect(list.status).toBe(200);
    expect((await list.json()).candidates).toContainEqual({ userId: f.viewer.id, eligible: false, reason: "repository_access_required" });
    const refuse = await call("/reassign", "POST", transfer());
    expect(refuse.status).toBe(422); expect((await refuse.json()).error.code).toBe("assignee_ineligible");
    f.unavailable.add(f.admin.id);
    await pool.query("DELETE FROM cloud_github_source_verifications WHERE owner_user_id=$1", [f.admin.id]);
    f.github.source.invalidate({ userId: f.admin.id });
    const unknown = await call("/reassign-candidates");
    expect(unknown.status).toBe(503); expect((await unknown.json()).error.code).toBe("github_verification_unavailable");
    expect((await state()).creator_revision).toBe("1");
  });

  it.each(["target", "caller"] as const)("refuses a held transfer after the %s leaves and rejoins", async who => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const admit = f.sharing.ownership.people.admit.bind(f.sharing.ownership.people);
    vi.spyOn(f.sharing.ownership.people, "admit").mockImplementationOnce(async (...args) => {
      const proof = await admit(...args); entered.resolve(); await release.promise; return proof;
    });
    const pending = call("/reassign", "POST", transfer());
    try {
      await entered.promise;
      const person = who === "target" ? f.viewer : f.creator;
      await withSystemTx(pool, async tx => {
        await tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, person.id]);
        await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,$3)", [f.organizationId, person.id, who === "target" ? "member" : "owner"]);
      });
    } finally { release.resolve(); }
    const response = await pending;
    expect(response.status).toBe(who === "target" ? 422 : 404);
    expect((await pool.query("SELECT 1 FROM cloud_v2_reassignments WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
  });

  it("commits one winner for concurrent Creator CAS and rejects an old candidates cursor", async () => {
    const page = await (await call("/reassign-candidates?limit=1")).json();
    expect(page.nextCursor).toEqual(expect.any(String));
    const responses = await Promise.all([call("/reassign", "POST", transfer()), call("/reassign", "POST", transfer(f.admin.id))]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect((await state()).creator_revision).toBe("2");
    const stale = await call(`/reassign-candidates?limit=1&cursor=${page.nextCursor}`);
    expect(stale.status).toBe(409); expect((await stale.json()).error.code).toBe("creator_changed");
  });

  it("rolls the transfer back if target source access is withdrawn after its initial locked check", async () => {
    const assert = f.sharing.ownership.people.assert.bind(f.sharing.ownership.people);
    let withdrawn = false;
    vi.spyOn(f.sharing.ownership.people, "assert").mockImplementation(async (...args) => {
      const person = await assert(...args);
      if (args[1] && !withdrawn) {
        withdrawn = true;
        const changed = await withSystemTx(pool, tx => tx.query(`UPDATE cloud_github_source_verifications
          SET failure_status=403,failure_code='github_access_required' WHERE org_id=$1 AND owner_user_id=$2`, [f.organizationId, f.viewer.id]));
        expect(changed.rowCount).toBe(1);
      }
      return person;
    });
    const response = await call("/reassign", "POST", transfer());
    expect(withdrawn).toBe(true);
    expect(response.status).toBe(422); expect((await response.json()).error.code).toBe("assignee_ineligible");
    expect((await state()).creator_user_id).toBe(f.creator.id);
    expect((await pool.query("SELECT 1 FROM cloud_v2_reassignments WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
  });

  it("never combines new ownership with follow flags from before the transfer", async () => {
    const documents = f.github.metadata.documents.bind(f.github.metadata);
    let metadataRead = false, changed = false;
    vi.spyOn(f.github.metadata, "documents").mockImplementation(async (...args) => {
      const result = await documents(...args); metadataRead = true; return result;
    });
    const assert = f.sharing.authority.assertMany.bind(f.sharing.authority);
    vi.spyOn(f.sharing.authority, "assertMany").mockImplementation(async (...args) => {
      if (metadataRead && args[1] && !changed) {
        changed = true; await f.sharing.ownership.reassign(f.workspace.id, f.creator, transfer());
      }
      return assert(...args);
    });
    const response = await call();
    expect(changed).toBe(true);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("github_verification_unavailable");
    expect((await (await call()).json()).workspace).toMatchObject({ creatorUserId: f.viewer.id, following: true });
  });
});
