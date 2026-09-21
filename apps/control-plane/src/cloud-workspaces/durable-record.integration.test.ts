import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import {
  DatabaseCloudWorkspaceDurableRecordService,
  WorkspaceRecordError,
} from "./durable-record.js";
import {
  seedReadyCloudWorkspace,
  ensureCloudPilotUser,
  type ReadyCloudWorkspaceFixture,
} from "./test-fixtures.js";
import { DatabaseCloudWorkspaceCollaborationService } from "./actors.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d("cloud workspace durable record", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let service: DatabaseCloudWorkspaceDurableRecordService;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    service = new DatabaseCloudWorkspaceDurableRecordService({
      pool,
      workosEnabled: false,
    });
  });

  function appendInput() {
    return {
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
      expectedRevision: 0,
      idempotencyKey: `record-${randomUUID()}`,
      mutations: [
        {
          entityKind: "chat" as const,
          entityId: "chat-1",
          operation: "upsert" as const,
          schemaVersion: 1,
          document: { title: "Recovery-safe chat" },
          occurredAt: new Date().toISOString(),
        },
        {
          entityKind: "message" as const,
          entityId: "message-1",
          operation: "upsert" as const,
          schemaVersion: 1,
          document: { chatId: "chat-1", role: "user", text: "hello" },
          occurredAt: new Date().toISOString(),
        },
      ],
    };
  }

  it("shares durable history with an invited Pro viewer and fences revocation", async () => {
    await service.append(appendInput());
    const guest = await ensureCloudPilotUser(pool, { provider: "workos", providerSubject: `user_${randomUUID()}`,
      email: `reader-${randomUUID()}@example.test`, displayName: "Guest reader" });
    await pool.query(`INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source)
      VALUES ($1,'pro','active',true,'operator')`, [guest.id]);
    const collaboration = new DatabaseCloudWorkspaceCollaborationService(pool);
    const owner = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, actorUserId: fixture.userId };
    await collaboration.setSharing({ ...owner, sharingMode: "organization", expectedRevision: 1 });
    const invitation = await collaboration.invite({ ...owner, email: guest.email, role: "viewer" });
    await collaboration.accept({ actorUserId: guest.id, token: invitation.token, identity: guest.identity });
    const input = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, accountUserId: guest.id, afterRevision: 0 };
    await expect(service.read(input)).resolves.toMatchObject({ currentRevision: 2, events: [
      { entityId: "chat-1" }, { entityId: "message-1" },
    ] });
    expect((await pool.query("SELECT 1 FROM organization_members WHERE org_id=$1 AND user_id=$2", [fixture.organizationId, guest.id])).rowCount).toBe(0);
    await collaboration.revokeGuest({ ...owner, guestUserId: guest.id });
    await expect(service.read(input)).rejects.toMatchObject({ status: 404 });
  });

  it("reads records concurrently with other readers holding shared scope locks", async () => {
    await service.append(appendInput());
    const held = await pool.connect();
    const readPool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: "-c lock_timeout=250ms" });
    try {
      await held.query("BEGIN");
      await held.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [fixture.organizationId]);
      await held.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR SHARE", [fixture.workspaceId]);
      await expect(new DatabaseCloudWorkspaceDurableRecordService({ pool: readPool, workosEnabled: false }).read({
        workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, accountUserId: fixture.userId, afterRevision: 0,
      })).resolves.toMatchObject({ currentRevision: 2 });
    } finally { await held.query("ROLLBACK"); held.release(); await readPool.end(); }
  });

  it("reads the authoritative engine projection with shared scope locks", async () => {
    await service.append(appendInput());
    const held = await pool.connect();
    const readPool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: "-c lock_timeout=250ms" });
    try {
      await held.query("BEGIN");
      await held.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR SHARE", [fixture.workspaceId]);
      await held.query("SELECT id FROM cloud_workspace_engine_instances WHERE id=$1 FOR SHARE", [fixture.engineInstanceId]);
      await expect(new DatabaseCloudWorkspaceDurableRecordService({ pool: readPool, workosEnabled: false }).headForEngine({
        ...appendInput(), afterEntityKind: null, afterEntityId: null,
      })).resolves.toMatchObject({ currentRevision: 2 });
    } finally { await held.query("ROLLBACK"); held.release(); await readPool.end(); }
  });

  it("lets an active owner recover history after entitlement cancellation but rejects lost membership", async () => {
    await service.append(appendInput());
    await pool.query("UPDATE organization_entitlements SET status='cancelled' WHERE org_id=$1", [fixture.organizationId]);
    const input = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
      accountUserId: fixture.userId, afterRevision: 0 };
    await expect(service.read(input)).resolves.toMatchObject({ currentRevision: 2 });
    await pool.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [fixture.teamId, fixture.userId]);
    await expect(service.read(input)).rejects.toMatchObject({ status: 404 });
  });

  it("appends a consecutive batch, projects entities, and replays exactly once", async () => {
    const input = appendInput();
    await expect(service.append(input)).resolves.toEqual({
      firstRevision: 1,
      lastRevision: 2,
      currentRevision: 2,
      replayed: false,
    });
    await expect(service.append(input)).resolves.toEqual({
      firstRevision: 1,
      lastRevision: 2,
      currentRevision: 2,
      replayed: true,
    });

    await expect(
      service.read({
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        accountUserId: fixture.userId,
        afterRevision: 0,
      }),
    ).resolves.toMatchObject({
      currentRevision: 2,
      snapshotRequired: false,
      entities: [],
      events: [
        { revision: 1, entityKind: "chat", entityId: "chat-1" },
        { revision: 2, entityKind: "message", entityId: "message-1" },
      ],
      hasMore: false,
    });
    const stored = await pool.query(
      `SELECT (SELECT count(*)::integer FROM workspace_record_batches) AS batches,
              (SELECT count(*)::integer FROM workspace_record_events) AS events,
              (SELECT count(*)::integer FROM workspace_record_entities) AS entities,
              (SELECT count(*)::integer FROM cloud_workspace_outbox
               WHERE event_type = 'workspace.record_appended') AS outbox`,
    );
    expect(stored.rows).toEqual([
      { batches: 1, events: 2, entities: 2, outbox: 1 },
    ]);
  });

  it("paginates an exact engine recovery projection under current authority", async () => {
    await service.append(appendInput());
    const scope = {
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      generation: 1,
      engineInstanceId: fixture.engineInstanceId,
      heartbeatToken: fixture.heartbeatToken,
    };
    const first = await service.headForEngine({
      ...scope,
      afterEntityKind: null,
      afterEntityId: null,
      limit: 1,
    });
    expect(first).toMatchObject({
      currentRevision: 2,
      entries: [{ entityKind: "chat", entityId: "chat-1" }],
      next: { entityKind: "chat", entityId: "chat-1" },
    });
    await expect(
      service.headForEngine({
        ...scope,
        afterEntityKind: first.next!.entityKind,
        afterEntityId: first.next!.entityId,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      currentRevision: 2,
      entries: [{ entityKind: "message", entityId: "message-1" }],
      next: null,
    });
  });

  it("detects revision races and idempotency-key parameter reuse", async () => {
    const input = appendInput();
    await service.append(input);
    await expect(
      service.append({ ...appendInput(), expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      service.append({
        ...input,
        mutations: [
          {
            ...input.mutations[0]!,
            document: { title: "different" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("serializes concurrent writers so only one consumes the expected revision", async () => {
    const outcomes = await Promise.allSettled([
      service.append(appendInput()),
      service.append(appendInput()),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(WorkspaceRecordError);
    expect(rejected?.reason).toMatchObject({ code: "revision_conflict" });
  });

  it("revokes writes immediately when current membership authority disappears", async () => {
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `DELETE FROM team_members
         WHERE team_id = $1 AND org_id = $2 AND user_id = $3`,
        [fixture.teamId, fixture.organizationId, fixture.userId],
      );
    });
    await expect(service.append(appendInput())).rejects.toMatchObject({
      code: "engine_authority_rejected",
    });
  });
});
