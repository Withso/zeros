import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { ensureUser } from "./auth.js";
import { readWorkOSWorkerDeadlines } from "./workos-worker-deadlines.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;
d("account worker deadline projections and commit hints", () => {
  let pool: pg.Pool;
  let userId: string;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    userId = (
      await ensureUser(pool, {
        provider: "workos",
        providerSubject: "user_deadline_fixture",
        email: "deadline-fixture@example.test",
        displayName: "Worker fixture",
      })
    ).id;
  });
  const read = (deletions = true) => readWorkOSWorkerDeadlines(pool, deletions);
  function within(delay: number | undefined, ms: number) {
    expect(delay).toBeGreaterThan(ms - 1_000);
    expect(delay).toBeLessThanOrEqual(ms);
  }
  async function command(
    ordering: string,
    seconds: number,
    operation = "sessions.revoke_all",
    organizationId: string | null = null,
  ) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO workos_command_outbox
      (id,operation,idempotency_key,aggregate_key,ordering_key,aggregate_revision,organization_id,next_attempt_at)
      VALUES($1::uuid,$2,$1::text,$1::text,$3,1,$4,now()+($5::integer*interval '1 second'))`,
      [id, operation, ordering, organizationId, seconds],
    );
    return id;
  }
  it("sleeps through an older ordered command's retry and an in-flight lease", async () => {
    expect(await read()).toEqual({});
    const first = await command("same-order", 300),
      second = await command("same-order", 0);
    within((await read()).commands, 300_000);
    await pool.query(
      "UPDATE workos_command_outbox SET state='succeeded',completed_at=now() WHERE id=$1",
      [first],
    );
    expect((await read()).commands).toBeLessThanOrEqual(0);
    await pool.query(
      `UPDATE workos_command_outbox SET state='processing',lease_owner='fixture-worker',
      lease_expires_at=now()+interval '30 seconds' WHERE id=$1`,
      [second],
    );
    within((await read()).commands, 30_000);
  });
  it("respects organization provisioning dependencies without creating a cloud workspace", async () => {
    const organizationId = randomUUID();
    await pool.query(
      "INSERT INTO organizations(id,slug,name,created_by) VALUES($1,'worker-queue-fixture','Worker queue fixture',$2)",
      [organizationId, userId],
    );
    await pool.query(
      "INSERT INTO workos_organization_links(organization_id,external_id) VALUES($1::uuid,$1::text)",
      [organizationId],
    );
    await command(
      "organization-create",
      300,
      "organization.create",
      organizationId,
    );
    await command("membership-create", 0, "membership.create", organizationId);
    within((await read()).commands, 300_000);
    await pool.query(
      "UPDATE workos_organization_links SET state='active',workos_organization_id='org_fixture' WHERE organization_id=$1",
      [organizationId],
    );
    expect((await read()).commands).toBeLessThanOrEqual(0);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM cloud_v2_workspaces"))
        .rows[0].n,
    ).toBe(0);
  });
  it("leaves retired delivery providers asleep and respects Resend's delivery lease", async () => {
    await pool.query(
      `INSERT INTO security_notification_outbox(user_id,destination_email,template,delivery_provider)
      VALUES($1,'recipient@example.test','sessions_revoked','legacy_zeptomail')`,
      [userId],
    );
    expect((await read()).notifications).toBeUndefined();
    const id = (
      await pool.query(
        `INSERT INTO security_notification_outbox(user_id,destination_email,template,next_attempt_at)
      VALUES($1,'recipient@example.test','sessions_revoked',now()+interval '20 seconds') RETURNING id`,
        [userId],
      )
    ).rows[0].id;
    within((await read()).notifications, 20_000);
    await pool.query(
      `UPDATE security_notification_outbox SET state='sending',lease_owner='fixture-worker',
      lease_expires_at=now()+interval '40 seconds' WHERE id=$1`,
      [id],
    );
    within((await read()).notifications, 40_000);
  });
  it("retains the account purge deadline, lease and maximum attempts", async () => {
    const id = (
      await pool.query(
        `INSERT INTO deletion_requests(public_code,target_kind,target_id,target_user_id,
      requested_at,purge_after) VALUES('ZD-ABCD-EFGH','account',$1,$1,now()-interval '30 days'+interval '30 seconds',now()+interval '30 seconds')
      RETURNING id`,
        [userId],
      )
    ).rows[0].id;
    within((await read()).deletions, 30_000);
    expect((await read(false)).deletions).toBeUndefined();
    await pool.query(
      `UPDATE deletion_requests SET state='purging',purge_started_at=now(),attempt_count=20,
      lease_owner='fixture-worker',lease_expires_at=now()+interval '45 seconds' WHERE id=$1`,
      [id],
    );
    within((await read()).deletions, 45_000);
    await pool.query(
      "UPDATE deletion_requests SET state='failed',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
      [id],
    );
    expect((await read()).deletions).toBeUndefined();
  });
  it("publishes an empty future-deadline hint only after commit, including with no cloud workspace", async () => {
    const listener = await pool.connect(),
      writer = await pool.connect();
    const notices: pg.Notification[] = [];
    listener.on("notification", (notice) => notices.push(notice));
    await listener.query("LISTEN zeros_account_maintenance_work");
    const insert = () =>
      writer.query(
        `INSERT INTO security_notification_outbox(user_id,destination_email,template,next_attempt_at)
      VALUES($1,'recipient@example.test','sessions_revoked',now()+interval '10 minutes')`,
        [userId],
      );
    try {
      await writer.query("BEGIN");
      await insert();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(notices).toHaveLength(0);
      await writer.query("ROLLBACK");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(notices).toHaveLength(0);
      await writer.query("BEGIN");
      await insert();
      await writer.query("COMMIT");
      await vi.waitFor(() => expect(notices).toHaveLength(1), {
        timeout: 1_000,
        interval: 10,
      });
      expect(notices[0]).toMatchObject({
        channel: "zeros_account_maintenance_work",
        payload: "",
      });
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      listener.release(true);
    }
  });
});
