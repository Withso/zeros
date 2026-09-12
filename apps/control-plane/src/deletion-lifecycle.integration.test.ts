import { randomBytes, randomUUID } from "node:crypto";

import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ensureUser,
  resolveAuthenticatedUser,
  type AuthedUser,
} from "./auth.js";
import { HttpError } from "./authz.js";
import {
  createDeletionLifecycleRoutes,
  DeletionLifecycleProcessor,
} from "./deletion-lifecycle.js";
import { runMigrations } from "./migrate.js";
import { createOpsRoutes } from "./ops.js";
import {
  MAX_ACCOUNT_WORKOS_ERASURE_SUBJECTS,
  workOSProviderSubjectHash,
  workOSProviderSubjectLockKey,
} from "./workos-provider-locks.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

type DeletionResponse = {
  deletion: {
    id: string;
    recoveryCode: string;
    state: string;
    targetKind: "account" | "organization";
    targetId: string;
  };
};

d("account, organization, and operator deletion lifecycle", () => {
  let pool: pg.Pool;
  let actor: AuthedUser;
  let app: Hono;

  const signup = (name: string) => {
    const suffix = randomUUID().replaceAll("-", "");
    const now = Math.floor(Date.now() / 1_000);
    return ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_${suffix}`,
      email: `${name.toLowerCase()}-${suffix}@example.test`,
      displayName: name,
      session: {
        id: `session_${suffix}`,
        clientKind: "web",
        authTime: now,
        tokenExpiresAt: now + 3_600,
      },
    });
  };

  const asActor = (user: AuthedUser) => {
    actor = user;
  };

  const request = (
    path: string,
    init?: { method?: string; body?: Record<string, unknown> },
  ) =>
    app.request(path, {
      method: init?.method ?? "GET",
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });

  const createOrganization = async (
    owner: AuthedUser,
    name: string,
  ): Promise<string> => {
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}`;
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (
         slug, name, created_by, is_personal, cloud_workspaces_allowed
       ) VALUES ($1, $2, $3, false, true)
       RETURNING id`,
      [slug, name, owner.id],
    );
    const organizationId = organization.rows[0]!.id;
    await pool.query(
      `INSERT INTO organization_members (org_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [organizationId, owner.id],
    );
    const team = await pool.query<{ id: string }>(
      `INSERT INTO teams (org_id, slug, name, is_default, created_by)
       VALUES ($1, 'default', 'Default', true, $2)
       RETURNING id`,
      [organizationId, owner.id],
    );
    await pool.query(
      `INSERT INTO team_members (team_id, org_id, user_id, role)
       VALUES ($1, $2, $3, 'maintainer')`,
      [team.rows[0]!.id, organizationId, owner.id],
    );
    return organizationId;
  };

  const addOrganizationMember = async (
    organizationId: string,
    user: AuthedUser,
    role: "owner" | "admin" | "member",
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO organization_members (org_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [organizationId, user.id, role],
    );
    await pool.query(
      `INSERT INTO team_members (team_id, org_id, user_id, role)
       SELECT id, org_id, $2,
              CASE WHEN $3::organization_role IN ('owner', 'admin')
                   THEN 'maintainer'::team_role ELSE 'member'::team_role END
       FROM teams WHERE org_id = $1 AND is_default AND deleted_at IS NULL`,
      [organizationId, user.id, role],
    );
  };

  const createRepository = async (
    organizationId: string,
    createdBy: string,
  ): Promise<string> => {
    const repository = await pool.query<{ id: string }>(
      `INSERT INTO repositories (
         org_id, forge, forge_repository_id, owner_name,
         repository_name, created_by
       ) VALUES ($1, 'github.com', $2, 'withso', 'zeros', $3)
       RETURNING id`,
      [organizationId, `fixture-${randomUUID()}`, createdBy],
    );
    return repository.rows[0]!.id;
  };

  const createProviderConnection = async (
    organizationId: string,
    ownerUserId: string,
  ): Promise<string> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const connection = await client.query<{ id: string }>(
        `INSERT INTO provider_connections (
           org_id, owner_kind, owner_user_id, provider, display_name,
           credential_source, current_version, state
         ) VALUES ($1, 'user', $2, 'daytona', 'Legacy Daytona',
                   'hosted', 1, 'active')
         RETURNING id`,
        [organizationId, ownerUserId],
      );
      await client.query(
        `INSERT INTO provider_connection_versions (
           connection_id, org_id, version, credential_source,
           endpoint, created_by
         ) VALUES ($1, $2, 1, 'hosted', 'hosted://daytona', $3)`,
        [connection.rows[0]!.id, organizationId, ownerUserId],
      );
      await client.query("COMMIT");
      return connection.rows[0]!.id;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  const scheduleAccount = async (user: AuthedUser) => {
    asActor(user);
    const response = await request("/v1/account/deletion", {
      method: "POST",
      body: { confirmation: "DELETE MY ACCOUNT" },
    });
    const body = (await response.json()) as DeletionResponse;
    return { response, body };
  };

  const makeDue = async (requestId: string) => {
    // Cases retain their rows in this schema. Mature retries from an earlier
    // case must not steal this case's tick(1) or private claim() calls.
    await pool.query(
      `UPDATE deletion_requests
       SET next_attempt_at = GREATEST(
             next_attempt_at,
             now() + interval '1 hour'
           )
       WHERE id <> $1
         AND state IN ('scheduled', 'purging', 'provider_deleting', 'failed')`,
      [requestId],
    );
    await pool.query(
      `UPDATE deletion_requests
       SET requested_at = requested_at - interval '31 days',
           purge_after = purge_after - interval '31 days',
           next_attempt_at = now()
       WHERE id = $1`,
      [requestId],
    );
  };

  const succeedPurgeCommand = async (requestId: string) => {
    const request = await pool.query<{ purge_command_id: string | null }>(
      `SELECT purge_command_id FROM deletion_requests WHERE id = $1`,
      [requestId],
    );
    const commandId = request.rows[0]!.purge_command_id;
    expect(commandId).not.toBeNull();
    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now(),
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 OR payload->>'deletionRequestId' = $2::text`,
      [commandId, requestId],
    );
    await pool.query(
      `UPDATE deletion_requests SET next_attempt_at = now() WHERE id = $1`,
      [requestId],
    );
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 3 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    actor = await signup("Bootstrap");

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", actor);
      await next();
    });
    app.route("/", createDeletionLifecycleRoutes(pool));
    app.route("/", createOpsRoutes(pool, "alpha"));
    app.onError((error, c) => {
      if (error instanceof HttpError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      }
      throw error;
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("cascades a sole-member Pro organization and restores the exact account snapshot", async () => {
    const customer = await signup("ProOwner");
    const organizationId = await createOrganization(customer, "Solo Pro");
    const { response, body } = await scheduleAccount(customer);

    expect(response.status).toBe(202);
    expect(body.deletion).toMatchObject({
      state: "scheduled",
      targetKind: "account",
      targetId: customer.id,
    });
    const account = await pool.query<{
      auth_status: string;
      deletion_request_id: string;
    }>(`SELECT auth_status, deletion_request_id FROM users WHERE id = $1`, [
      customer.id,
    ]);
    expect(account.rows[0]).toEqual({
      auth_status: "deletion_pending",
      deletion_request_id: body.deletion.id,
    });
    const organization = await pool.query<{
      lifecycle_status: string;
      parent_request_id: string;
    }>(
      `SELECT o.lifecycle_status, r.parent_request_id
       FROM organizations o
       JOIN deletion_requests r ON r.id = o.deletion_request_id
       WHERE o.id = $1`,
      [organizationId],
    );
    expect(organization.rows[0]).toEqual({
      lifecycle_status: "scheduled",
      parent_request_id: body.deletion.id,
    });
    await expect(
      pool.query(
        `SELECT status FROM auth_sessions
         WHERE user_id = $1 AND status = 'active'`,
        [customer.id],
      ),
    ).resolves.toMatchObject({ rows: [] });

    asActor({ ...customer, accountStatus: "deletion_pending" });
    const restored = await request("/v1/account/deletion/restore", {
      method: "POST",
      body: { requestId: body.deletion.id },
    });
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({
      deletion: { id: body.deletion.id, state: "restored" },
    });
    await expect(
      pool.query(
        `SELECT auth_status, deletion_request_id FROM users WHERE id = $1`,
        [customer.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ auth_status: "active", deletion_request_id: null }],
    });
    await expect(
      pool.query(
        `SELECT lifecycle_status, deletion_request_id
         FROM organizations WHERE id = $1`,
        [organizationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ lifecycle_status: "active", deletion_request_id: null }],
    });
  });

  it("requires ownership transfer but leaves a shared Business organization active", async () => {
    const departingOwner = await signup("BusinessOwner");
    const secondOwner = await signup("BusinessSuccessor");
    const organizationId = await createOrganization(
      departingOwner,
      "Shared Business",
    );
    await addOrganizationMember(organizationId, secondOwner, "member");

    const blocked = await scheduleAccount(departingOwner);
    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toMatchObject({
      error: { code: "ownership_transfer_required" },
    });

    await pool.query(
      `UPDATE organization_members SET role = 'owner'
       WHERE org_id = $1 AND user_id = $2`,
      [organizationId, secondOwner.id],
    );
    const scheduled = await scheduleAccount(departingOwner);
    expect(scheduled.response.status).toBe(202);
    await expect(
      pool.query(
        `SELECT lifecycle_status, deletion_request_id
         FROM organizations WHERE id = $1`,
        [organizationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ lifecycle_status: "active", deletion_request_id: null }],
    });
    await expect(
      pool.query(
        `SELECT role FROM organization_members
         WHERE org_id = $1 AND user_id = $2`,
        [organizationId, secondOwner.id],
      ),
    ).resolves.toMatchObject({ rows: [{ role: "owner" }] });

    asActor({ ...departingOwner, accountStatus: "deletion_pending" });
    const restored = await request("/v1/account/deletion/restore", {
      method: "POST",
      body: { requestId: scheduled.body.deletion.id },
    });
    expect(restored.status).toBe(200);
  });

  it("waits for WorkOS user deletion before final account erasure and completion notification", async () => {
    const customer = await signup("AccountPurge");
    const originalEmail = customer.email;
    const scheduled = await scheduleAccount(customer);
    expect(scheduled.response.status).toBe(202);
    const requestId = scheduled.body.deletion.id;
    const candidateSubject = `user_account_purge_candidate_${randomUUID().replaceAll("-", "")}`;
    const candidateCredentialHash = randomBytes(32);
    await pool.query(
      `INSERT INTO workos_browser_sessions (
         credential_hash, kind, sealed_session, provider_session_id,
         provider_sub, email, display_name, access_token_expires_at,
         expires_at, revision
       ) VALUES ($1, 'session', 'sealed-candidate', $2, $3, $4, $5,
                 now() + interval '1 hour', now() + interval '7 days', 1)`,
      [
        candidateCredentialHash,
        `session_account_purge_candidate_${randomUUID().replaceAll("-", "")}`,
        candidateSubject,
        originalEmail,
        "Account Purge Candidate",
      ],
    );
    const detachedSessionId = `session_detached_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `INSERT INTO auth_sessions (
         provider_session_id, provider_sub, user_id, client_kind, status,
         revoked_at, revocation_reason
       ) VALUES ($1, $2, NULL, 'unknown', 'revoked', now(),
                 'workos_session_revoked')`,
      [detachedSessionId, customer.identity.subject],
    );
    const invitationEventId = `event_invitation_${randomUUID().replaceAll("-", "")}`;
    const controlInvitationEventId = `event_invitation_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `INSERT INTO workos_event_inbox (
         event_id, event_type, event_created_at, source, object_id,
         workos_organization_id, data, state, attempt_count, processed_at
       ) VALUES
         ($1, 'invitation.revoked', now(), 'webhook', $2, $3,
          jsonb_build_object('id', $2::text, 'email', $4::text),
          'ignored', 1, now()),
         ($5, 'invitation.revoked', now(), 'webhook', $6, $3,
          jsonb_build_object('id', $6::text, 'email', $7::text),
          'ignored', 1, now())`,
      [
        invitationEventId,
        `invitation_${randomUUID().replaceAll("-", "")}`,
        `org_${randomUUID().replaceAll("-", "")}`,
        originalEmail,
        controlInvitationEventId,
        `invitation_${randomUUID().replaceAll("-", "")}`,
        `retained-${randomUUID()}@example.test`,
      ],
    );
    const unlinkedIdentityEventId = `event_identity_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `INSERT INTO identity_provider_events (
         event_id, event_type, event_created_at, provider_sub, email,
         email_verified, status, processed_at
       ) VALUES ($1, 'user.updated', now(), $2, $3, true,
                 'unlinked', now())`,
      [
        unlinkedIdentityEventId,
        `user_unlinked_${randomUUID().replaceAll("-", "")}`,
        originalEmail,
      ],
    );
    const historicalCommand = await pool.query<{ id: string }>(
      `INSERT INTO workos_command_outbox (
         operation, idempotency_key, aggregate_key, ordering_key,
         aggregate_revision, provider_object_id, payload, state, completed_at
       ) VALUES (
         'session.revoke', $1, $2, $2, 1, $3,
         jsonb_build_object(
           'sessionId', 'session_historical',
           'workosUserId', $3::text,
           'email', $4::text
         ),
         'succeeded', now()
       )
       RETURNING id`,
      [
        `privacy-account-${randomUUID()}`,
        `privacy-account:${customer.id}`,
        customer.identity.subject,
        originalEmail,
      ],
    );
    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now()
       WHERE user_id = $1 AND operation = 'sessions.revoke_all'
         AND state = 'queued'`,
      [customer.id],
    );
    await makeDue(requestId);

    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "test-account-purge",
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(`SELECT state FROM deletion_requests WHERE id = $1`, [
        requestId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: "provider_deleting" }] });
    await expect(
      pool.query(
        `SELECT metadata->'workosSubjectHashes'->>0 AS subject_hash
         FROM deletion_request_events
         WHERE deletion_request_id = $1
           AND action = 'purge.provider_erasure_fenced'
         ORDER BY subject_hash`,
        [requestId],
      ),
    ).resolves.toMatchObject({
      rows: [
        workOSProviderSubjectHash({ kind: "user", id: candidateSubject }),
        workOSProviderSubjectHash({
          kind: "user",
          id: customer.identity.subject,
        }),
      ]
        .sort()
        .map((subject_hash) => ({ subject_hash })),
    });
    await expect(
      pool.query(
        `SELECT operation, provider_object_id, state,
                payload->>'workosUserId' AS workos_user_id,
                payload->>'deletionRequestId' AS deletion_request_id
         FROM workos_command_outbox
         WHERE operation = 'user.delete' AND user_id = $1
           AND payload->>'deletionRequestId' = $2::text
         ORDER BY workos_user_id`,
        [customer.id, requestId],
      ),
    ).resolves.toMatchObject({
      rows: [customer.identity.subject, candidateSubject]
        .sort()
        .map((workos_user_id) => ({
          operation: "user.delete",
          state: "queued",
          workos_user_id,
          provider_object_id: workos_user_id,
          deletion_request_id: requestId,
        })),
    });

    await succeedPurgeCommand(requestId);
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(`SELECT state FROM deletion_requests WHERE id = $1`, [
        requestId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: "purged" }] });
    await expect(
      pool.query(
        `SELECT auth_status, email::text, display_name
         FROM users WHERE id = $1`,
        [customer.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          auth_status: "deleted",
          email: expect.stringMatching(/^deleted\+[a-f0-9]+@deleted\.invalid$/),
          display_name: null,
        },
      ],
    });
    await expect(
      pool.query(`SELECT 1 FROM user_identities WHERE user_id = $1`, [
        customer.id,
      ]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      pool.query(`SELECT 1 FROM workos_command_outbox WHERE id = $1`, [
        historicalCommand.rows[0]!.id,
      ]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      pool.query(`SELECT 1 FROM auth_sessions WHERE provider_session_id = $1`, [
        detachedSessionId,
      ]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      pool.query(
        `SELECT 1 FROM workos_browser_sessions WHERE credential_hash = $1`,
        [candidateCredentialHash],
      ),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      pool.query(
        `SELECT event_id FROM workos_event_inbox
         WHERE event_id = ANY($1::text[]) ORDER BY event_id`,
        [[invitationEventId, controlInvitationEventId]],
      ),
    ).resolves.toMatchObject({
      rows: [{ event_id: controlInvitationEventId }],
    });
    await expect(
      pool.query(`SELECT 1 FROM identity_provider_events WHERE event_id = $1`, [
        unlinkedIdentityEventId,
      ]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM workos_command_outbox command
         WHERE position($1::text in command.aggregate_key) > 0
            OR position($1::text in command.ordering_key) > 0
            OR command.provider_object_id = $2
            OR command.payload::text LIKE '%' || $2 || '%'
            OR command.payload::text LIKE '%' || $3 || '%'`,
        [customer.id, customer.identity.subject, originalEmail],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      pool.query(
        `SELECT destination_email::text, user_id
         FROM security_notification_outbox
         WHERE template = 'account_deletion_completed'
           AND destination_email = $1`,
        [originalEmail],
      ),
    ).resolves.toMatchObject({
      rows: [{ destination_email: originalEmail, user_id: null }],
    });

    const replaySessionId = customer.authentication.sessionId;
    if (!replaySessionId) throw new Error("WorkOS signup session is missing");
    const now = Math.floor(Date.now() / 1_000);
    await expect(
      resolveAuthenticatedUser(pool, {
        provider: "workos",
        providerSubject: customer.identity.subject,
        email: originalEmail,
        displayName: "AccountPurge",
        session: {
          id: replaySessionId,
          clientKind: "web",
          authTime: now,
          tokenExpiresAt: now + 3_600,
        },
      }),
    ).rejects.toMatchObject({ status: 401, code: "account_deleted" });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::integer FROM user_identities
            WHERE provider = 'workos' AND provider_sub = $1) AS identities,
           (SELECT count(*)::integer FROM auth_sessions
            WHERE provider = 'workos' AND provider_session_id = $2) AS sessions,
           (SELECT count(*)::integer FROM organizations o
            JOIN users u ON u.id = o.created_by
            WHERE u.email = $3 AND o.is_personal) AS personal_organizations`,
        [customer.identity.subject, replaySessionId, originalEmail],
      ),
    ).resolves.toMatchObject({
      rows: [{ identities: 0, sessions: 0, personal_organizations: 0 }],
    });
  });

  it("waits for an in-flight WorkOS user mutation and drains queued account commands before deletion", async () => {
    const customer = await signup("AccountProviderRace");
    const scheduled = await scheduleAccount(customer);
    expect(scheduled.response.status).toBe(202);
    const requestId = scheduled.body.deletion.id;
    const session = await pool.query<{ provider_session_id: string }>(
      `INSERT INTO auth_sessions (
         provider_session_id, provider_sub, user_id, client_kind, status,
         revoked_at, revocation_reason
       ) VALUES ($1, $2, $3, 'web', 'revoked', now(),
                 'account_deletion_scheduled')
       RETURNING provider_session_id`,
      [
        `session_scope_${randomUUID().replaceAll("-", "")}`,
        customer.identity.subject,
        customer.id,
      ],
    );
    const sessionOnlyCommand = await pool.query<{ id: string }>(
      `INSERT INTO workos_command_outbox (
         operation, idempotency_key, aggregate_key, ordering_key,
         aggregate_revision, payload
       ) VALUES (
         'session.revoke', $1, $2, $2, 1,
         jsonb_build_object('sessionId', $3::text)
       ) RETURNING id`,
      [
        `account-session-only-${randomUUID()}`,
        `unlinked-session:${randomUUID()}`,
        session.rows[0]!.provider_session_id,
      ],
    );
    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now()
       WHERE user_id = $1 AND operation = 'sessions.revoke_all'
         AND state = 'queued'`,
      [customer.id],
    );
    await makeDue(requestId);

    const providerConnection = await pool.connect();
    await providerConnection.query(
      `SELECT pg_advisory_lock(
         hashtextextended('workos-provider-user:' || $1::text, 0)
       )`,
      [customer.id],
    );
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "account-provider-race-purge-worker",
      logger: { warn: () => undefined, error: () => undefined },
    });
    let settled = false;
    const processing = processor.tick(1).finally(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
    } finally {
      await providerConnection.query(
        `SELECT pg_advisory_unlock(
           hashtextextended('workos-provider-user:' || $1::text, 0)
         )`,
        [customer.id],
      );
      providerConnection.release();
    }
    await expect(processing).resolves.toBe(1);
    await expect(
      pool.query(
        `SELECT state, purge_command_id, lease_owner
         FROM deletion_requests WHERE id = $1`,
        [requestId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "purging", purge_command_id: null, lease_owner: null }],
    });
    await expect(
      pool.query(
        `SELECT operation, state FROM workos_command_outbox WHERE id = $1`,
        [sessionOnlyCommand.rows[0]!.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ operation: "session.revoke", state: "queued" }],
    });
  });

  it("serializes account purge with an authenticated WorkOS subject", async () => {
    const customer = await signup("AccountAuthenticationRace");
    const scheduled = await scheduleAccount(customer);
    expect(scheduled.response.status).toBe(202);
    const requestId = scheduled.body.deletion.id;
    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now()
       WHERE user_id = $1 AND operation = 'sessions.revoke_all'
         AND state = 'queued'`,
      [customer.id],
    );
    await makeDue(requestId);

    const subjectLockKey = workOSProviderSubjectLockKey({
      kind: "user",
      id: customer.identity.subject,
    });
    const authenticationConnection = await pool.connect();
    await authenticationConnection.query(
      `SELECT pg_advisory_lock(hashtextextended($1::text, 0))`,
      [subjectLockKey],
    );
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "account-authentication-race-purge-worker",
      logger: { warn: () => undefined, error: () => undefined },
    });
    let settled = false;
    const processing = processor.tick(1).finally(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
    } finally {
      await authenticationConnection.query(
        `SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`,
        [subjectLockKey],
      );
      authenticationConnection.release();
    }

    await expect(processing).resolves.toBe(1);
    await expect(
      pool.query(
        `SELECT request.state, event.metadata
         FROM deletion_requests request
         JOIN deletion_request_events event
           ON event.deletion_request_id = request.id
          AND event.action = 'purge.provider_erasure_fenced'
         WHERE request.id = $1`,
        [requestId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "provider_deleting",
          metadata: {
            provider: "workos",
            workosSubjectHashes: [
              workOSProviderSubjectHash({
                kind: "user",
                id: customer.identity.subject,
              }),
            ],
          },
        },
      ],
    });
  });

  it("defers provider-lock contention without spending a purge attempt", async () => {
    const customer = await signup("AccountPurgeLockContention");
    const scheduled = await scheduleAccount(customer);
    expect(scheduled.response.status).toBe(202);
    const requestId = scheduled.body.deletion.id;
    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now()
       WHERE user_id = $1 AND operation = 'sessions.revoke_all'
         AND state = 'queued'`,
      [customer.id],
    );
    await makeDue(requestId);

    const subjectLockKey = workOSProviderSubjectLockKey({
      kind: "user",
      id: customer.identity.subject,
    });
    const blocker = await pool.connect();
    await blocker.query(
      `SELECT pg_advisory_lock(hashtextextended($1::text, 0))`,
      [subjectLockKey],
    );
    const processing = new DeletionLifecycleProcessor(pool, {
      workerId: "account-purge-lock-contender",
      providerLockTimeoutMs: 25,
      logger: { warn: () => undefined, error: () => undefined },
    }).tick(1);
    await new Promise((resolve) => setTimeout(resolve, 75));
    await blocker.query(
      `SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`,
      [subjectLockKey],
    );
    blocker.release();
    await expect(processing).resolves.toBe(1);

    await expect(
      pool.query(
        `SELECT state, attempt_count, lease_owner, lease_expires_at,
                last_error_code
         FROM deletion_requests WHERE id = $1`,
        [requestId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "purging",
          attempt_count: 0,
          lease_owner: null,
          lease_expires_at: null,
          last_error_code: "workos_provider_lock_timeout",
        },
      ],
    });
  });

  it("rejects cloud workspace ownership by permanent local-only Personal organizations at the database boundary", async () => {
    const customer = await signup("PersonalInvariant");
    const personal = await pool.query<{ org_id: string; team_id: string }>(
      `SELECT o.id AS org_id, t.id AS team_id
       FROM organizations o
       JOIN teams t ON t.org_id = o.id AND t.is_default
       WHERE o.created_by = $1 AND o.is_personal`,
      [customer.id],
    );
    const repositoryId = await createRepository(
      personal.rows[0]!.org_id,
      customer.id,
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(
        client.query(
          `INSERT INTO cloud_workspaces (
             id, org_id, team_id, created_by, repository_id,
             owner_user_id, assignee_user_id, display_name,
             repository_forge, repository_owner, repository_name,
             repository_revision, status, desired_state
           ) VALUES ($1, $2, $3, $4, $5, $4, $4,
                     'Impossible Personal Cloud',
                     'github.com', 'withso', 'zeros', 'main',
                     'requested', 'running')`,
          [
            randomUUID(),
            personal.rows[0]!.org_id,
            personal.rows[0]!.team_id,
            customer.id,
            repositoryId,
          ],
        ),
      ).rejects.toThrow(/Personal organizations are local-only/i);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("keeps organization Personal classification immutable", async () => {
    const customer = await signup("PersonalClassification");
    const personal = await pool.query<{ id: string }>(
      `SELECT id FROM organizations
       WHERE created_by = $1 AND is_personal`,
      [customer.id],
    );
    const collaborativeId = await createOrganization(
      customer,
      "Classification Company",
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(
        client.query(
          `UPDATE organizations SET is_personal = false WHERE id = $1`,
          [personal.rows[0]!.id],
        ),
      ).rejects.toThrow(/Personal classification is immutable/i);
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await expect(
        client.query(
          `UPDATE organizations SET is_personal = true WHERE id = $1`,
          [collaborativeId],
        ),
      ).rejects.toThrow(/Personal classification is immutable/i);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("fails closed before WorkOS erasure when a legacy Personal cloud-workspace invariant is violated", async () => {
    const customer = await signup("LegacyPersonalInvariant");
    const personal = await pool.query<{ org_id: string; team_id: string }>(
      `SELECT o.id AS org_id, t.id AS team_id
       FROM organizations o
       JOIN teams t ON t.org_id = o.id AND t.is_default
       WHERE o.created_by = $1 AND o.is_personal`,
      [customer.id],
    );
    const workspaceId = randomUUID();
    const repositoryId = await createRepository(
      personal.rows[0]!.org_id,
      customer.id,
    );
    const providerConnectionId = await createProviderConnection(
      personal.rows[0]!.org_id,
      customer.id,
    );
    // Model data that predates the database invariant. The bypass is local to
    // this transaction/session, so concurrent integration workers can never
    // observe a table-wide disabled trigger.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, repository_id,
           owner_user_id, assignee_user_id, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision, status, desired_state
         ) VALUES ($1, $2, $3, $4, $5, $4, $4,
                   'Legacy Personal Cloud',
                   'github.com', 'withso', 'zeros', 'main',
                   'requested', 'running')`,
        [
          workspaceId,
          personal.rows[0]!.org_id,
          personal.rows[0]!.team_id,
          customer.id,
          repositoryId,
        ],
      );
      await client.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, provider_connection_id,
           provider_connection_version, created_by
         ) VALUES ($1, 1, $2, 'daytona', 'snap-pinned', 'linux/amd64',
                   2000, 4096, 20480, $3, $4, 1, $5)`,
        [
          workspaceId,
          personal.rows[0]!.org_id,
          "a".repeat(40),
          providerConnectionId,
          customer.id,
        ],
      );
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    const scheduled = await scheduleAccount(customer);
    expect(scheduled.response.status).toBe(202);
    await makeDue(scheduled.body.deletion.id);
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "test-personal-cloud-invariant",
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(
        `SELECT state, last_error_code
         FROM deletion_requests WHERE id = $1`,
        [scheduled.body.deletion.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "failed",
          last_error_code: "personal_cloud_workspace_invariant_violation",
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM workos_command_outbox
         WHERE operation = 'user.delete' AND user_id = $1`,
        [customer.id],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("fails closed before WorkOS erasure when Personal has an orphan cloud repository", async () => {
    const customer = await signup("PersonalRepositoryInvariant");
    const personal = await pool.query<{ id: string }>(
      `SELECT id FROM organizations
       WHERE created_by = $1 AND is_personal`,
      [customer.id],
    );
    await createRepository(personal.rows[0]!.id, customer.id);

    const scheduled = await scheduleAccount(customer);
    expect(scheduled.response.status).toBe(202);
    await makeDue(scheduled.body.deletion.id);
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "test-personal-repository-invariant",
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(
        `SELECT state, last_error_code
         FROM deletion_requests WHERE id = $1`,
        [scheduled.body.deletion.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "failed",
          last_error_code: "personal_cloud_workspace_invariant_violation",
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM workos_command_outbox
         WHERE operation = 'user.delete' AND user_id = $1`,
        [customer.id],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("fails closed before WorkOS erasure when Personal has orphaned physical blob metadata", async () => {
    const customer = await signup("PersonalBlobInvariant");
    const personal = await pool.query<{ id: string }>(
      `SELECT id FROM organizations
       WHERE created_by = $1 AND is_personal`,
      [customer.id],
    );
    const blobId = randomUUID();
    await pool.query(
      `INSERT INTO workspace_blobs (
         id, org_id, plaintext_sha256, ciphertext_sha256, plaintext_bytes,
         ciphertext_bytes, object_key, encryption_key_version, nonce, auth_tag,
         state, available_at
       ) VALUES ($1, $2, $3, $4, 128, 128, $5, 1, $6, $7,
                 'available', now())`,
      [
        blobId,
        personal.rows[0]!.id,
        randomBytes(32),
        randomBytes(32),
        `workspace/v2/${personal.rows[0]!.id}/${blobId}/k1`,
        randomBytes(12),
        randomBytes(16),
      ],
    );

    const scheduled = await scheduleAccount(customer);
    expect(scheduled.response.status).toBe(202);
    await makeDue(scheduled.body.deletion.id);
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "test-personal-blob-invariant",
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(
        `SELECT state, last_error_code
         FROM deletion_requests WHERE id = $1`,
        [scheduled.body.deletion.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "failed",
          last_error_code: "personal_cloud_workspace_invariant_violation",
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM workos_command_outbox
         WHERE operation = 'user.delete' AND user_id = $1`,
        [customer.id],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("fails closed instead of truncating an oversized WorkOS subject capture", async () => {
    const customer = await signup("ProviderSubjectOverflow");
    const scheduled = await scheduleAccount(customer);
    expect(scheduled.response.status).toBe(202);
    const prefix = randomUUID().replaceAll("-", "");
    await pool.query(
      `INSERT INTO workos_browser_sessions (
         credential_hash, kind, sealed_session, provider_session_id,
         provider_sub, email, display_name, access_token_expires_at,
         expires_at, revision
       )
       SELECT digest($1 || ':' || candidate::text, 'sha256'),
              'session', 'sealed-overflow',
              'session_overflow_' || $1 || '_' || candidate::text,
              'user_overflow_' || $1 || '_' || candidate::text,
              $2::citext, 'Overflow Candidate', now() + interval '1 hour',
              now() + interval '7 days', 1
       FROM generate_series(1, $3::integer) candidate`,
      [prefix, customer.email, MAX_ACCOUNT_WORKOS_ERASURE_SUBJECTS],
    );
    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now()
       WHERE user_id = $1 AND operation = 'sessions.revoke_all'
         AND state = 'queued'`,
      [customer.id],
    );
    await makeDue(scheduled.body.deletion.id);

    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "test-provider-subject-overflow",
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(
        `SELECT state, last_error_code
         FROM deletion_requests WHERE id = $1`,
        [scheduled.body.deletion.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "failed",
          last_error_code: "workos_user_erasure_subject_limit_exceeded",
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT count(*)::int AS count FROM workos_command_outbox
         WHERE operation = 'user.delete' AND user_id = $1`,
        [customer.id],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("fails closed when a captured WorkOS subject has no request-bound delete command", async () => {
    const customer = await signup("MissingProviderDeleteCommand");
    const scheduled = await scheduleAccount(customer);
    expect(scheduled.response.status).toBe(202);
    await pool.query(
      `UPDATE workos_command_outbox
       SET state = 'succeeded', completed_at = now(), updated_at = now()
       WHERE user_id = $1 AND operation = 'sessions.revoke_all'
         AND state = 'queued'`,
      [customer.id],
    );
    await makeDue(scheduled.body.deletion.id);

    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "test-missing-provider-delete-command",
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    await pool.query(
      `UPDATE deletion_requests
       SET purge_command_id = NULL, next_attempt_at = now()
       WHERE id = $1`,
      [scheduled.body.deletion.id],
    );
    await pool.query(
      `DELETE FROM workos_command_outbox
       WHERE operation = 'user.delete' AND user_id = $1
         AND payload->>'deletionRequestId' = $2::text`,
      [customer.id, scheduled.body.deletion.id],
    );

    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(
        `SELECT request.state, request.last_error_code,
                account.auth_status,
                EXISTS (
                  SELECT 1 FROM user_identities identity
                  WHERE identity.user_id = account.id
                    AND identity.provider = 'workos'
                ) AS identity_retained
         FROM deletion_requests request
         JOIN users account ON account.id = request.target_user_id
         WHERE request.id = $1`,
        [scheduled.body.deletion.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "failed",
          last_error_code: "provider_delete_command_missing",
          auth_status: "deletion_pending",
          identity_retained: true,
        },
      ],
    });
  });

  it("does not schedule Organization purge before deleted workspace data is erased", async () => {
    const owner = await signup("OrgDataErasure");
    const organizationId = await createOrganization(owner, "Erase Company");
    const repositoryId = await createRepository(organizationId, owner.id);
    const team = await pool.query<{ id: string }>(
      `SELECT id FROM teams WHERE org_id = $1 AND is_default`,
      [organizationId],
    );
    const workspaceId = randomUUID();
    const providerConnectionId = await createProviderConnection(
      organizationId,
      owner.id,
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, repository_id,
           owner_user_id, assignee_user_id, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision, status, desired_state, deleted_at
         ) VALUES ($1, $2, $3, $4, $5, $4, $4, 'Awaiting Erasure',
                   'github.com', 'withso', 'zeros', 'main',
                   'deleted', 'deleted', now())`,
        [workspaceId, organizationId, team.rows[0]!.id, owner.id, repositoryId],
      );
      await client.query(
        `INSERT INTO workspace_billing_epochs (
           workspace_id, billing_epoch, org_id, billing_owner_user_id,
           entitlement_scope, entitlement_plan, entitlement_revision,
           created_by
         ) VALUES ($1, 1, $2, $3, 'organization', 'business', 1, $3)`,
        [workspaceId, organizationId, owner.id],
      );
      await client.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, provider_connection_id,
           provider_connection_version, created_by
         ) VALUES ($1, 1, $2, 'daytona', 'snap-pinned', 'linux/amd64',
                   2000, 4096, 20480, $3, $4, 1, $5)`,
        [
          workspaceId,
          organizationId,
          "a".repeat(40),
          providerConnectionId,
          owner.id,
        ],
      );
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    asActor(owner);
    const blocked = await request(`/v1/organizations/${organizationId}`, {
      method: "DELETE",
      body: { confirmation: "Erase Company" },
    });
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "organization_has_cloud_workspaces" },
    });

    await pool.query(
      `UPDATE cloud_workspaces SET data_deleted_at = now() WHERE id = $1`,
      [workspaceId],
    );
    const scheduled = await request(`/v1/organizations/${organizationId}`, {
      method: "DELETE",
      body: { confirmation: "Erase Company" },
    });
    expect(scheduled.status).toBe(202);
  });

  it("waits for an in-flight WorkOS organization mutation and drains it before provider deletion", async () => {
    const owner = await signup("ProviderRaceOwner");
    const organizationId = await createOrganization(
      owner,
      "Provider Race Company",
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `INSERT INTO workos_organization_links (
         organization_id, workos_organization_id, external_id, state
       ) VALUES ($1::uuid, $2, $1::uuid::text, 'active')`,
      [organizationId, workosOrganizationId],
    );
    await pool.query(
      `INSERT INTO workos_command_outbox (
         operation, idempotency_key, aggregate_key, ordering_key,
         aggregate_revision, organization_id, payload, state,
         attempt_count, lease_owner, lease_expires_at
       ) VALUES (
         'organization.update', $1, $2, $2, 2, $3::uuid,
         jsonb_build_object('externalId', $3::text, 'name', 'Provider Race'),
         'processing', 1, 'in-flight-provider-worker',
         now() + interval '60 seconds'
       )`,
      [
        `provider-race-${randomUUID()}`,
        `organization:${organizationId}`,
        organizationId,
      ],
    );

    asActor(owner);
    const scheduled = await request(`/v1/organizations/${organizationId}`, {
      method: "DELETE",
      body: { confirmation: "Provider Race Company" },
    });
    expect(scheduled.status).toBe(202);
    const body = (await scheduled.json()) as DeletionResponse;
    await makeDue(body.deletion.id);

    const providerConnection = await pool.connect();
    await providerConnection.query(
      `SELECT pg_advisory_lock(
         hashtextextended('workos-provider-org:' || $1::text, 0)
       )`,
      [organizationId],
    );
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "provider-race-purge-worker",
      logger: { warn: () => undefined, error: () => undefined },
    });
    let settled = false;
    const processing = processor.tick(1).finally(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
    } finally {
      await providerConnection.query(
        `SELECT pg_advisory_unlock(
           hashtextextended('workos-provider-org:' || $1::text, 0)
         )`,
        [organizationId],
      );
      providerConnection.release();
    }
    await expect(processing).resolves.toBe(1);
    await expect(
      pool.query(
        `SELECT state, purge_command_id, lease_owner
         FROM deletion_requests WHERE id = $1`,
        [body.deletion.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "purging", purge_command_id: null, lease_owner: null }],
    });
  });

  it("waits for WorkOS organization deletion before erasing tenant data", async () => {
    const owner = await signup("OrgPurge");
    const member = await signup("OrgMember");
    const organizationId = await createOrganization(owner, "Purge Company");
    await addOrganizationMember(organizationId, member, "member");
    const repositoryId = await createRepository(organizationId, owner.id);
    const providerConnectionId = await createProviderConnection(
      organizationId,
      owner.id,
    );
    const workspaceId = randomUUID();
    const team = await pool.query<{ id: string }>(
      `SELECT id FROM teams WHERE org_id = $1 AND is_default`,
      [organizationId],
    );
    const cloudClient = await pool.connect();
    try {
      await cloudClient.query("BEGIN");
      await cloudClient.query(
        `INSERT INTO cloud_workspaces (
         id, org_id, team_id, created_by, repository_id,
         owner_user_id, assignee_user_id, display_name,
         repository_forge, repository_owner, repository_name,
         repository_revision, status, desired_state, deleted_at, data_deleted_at
       ) VALUES ($1, $2, $3, $4, $5, $4, $4, 'Purged Workspace',
                 'github.com', 'withso', 'zeros', 'main',
                 'deleted', 'deleted', now(), now())`,
        [workspaceId, organizationId, team.rows[0]!.id, owner.id, repositoryId],
      );
      await cloudClient.query(
        `INSERT INTO workspace_billing_epochs (
         workspace_id, billing_epoch, org_id, billing_owner_user_id,
         entitlement_scope, entitlement_plan, entitlement_revision, created_by
       ) VALUES ($1, 1, $2, $3, 'organization', 'business', 1, $3)`,
        [workspaceId, organizationId, owner.id],
      );
      await cloudClient.query(
        `INSERT INTO cloud_workspace_generations (
         workspace_id, generation, org_id, provider, image_ref,
         architecture, cpu_millicores, memory_mib, storage_mib,
         source_commit, provider_connection_id, provider_connection_version,
         created_by
       ) VALUES ($1, 1, $2, 'daytona', 'snap-pinned', 'linux/amd64',
                 2000, 4096, 20480, $3, $4, 1, $5)`,
        [
          workspaceId,
          organizationId,
          "a".repeat(40),
          providerConnectionId,
          owner.id,
        ],
      );
      await cloudClient.query(
        `INSERT INTO cloud_workspace_usage_events (
         org_id, workspace_id, generation, authority_epoch,
         actor_user_id, billing_owner_user_id, billing_epoch, provider,
         meter, quantity, source_idempotency_key, occurred_at, metadata,
         provider_connection_id, provider_connection_version, request_sha256
       ) VALUES ($1, $2, 1, 1, $3, $3, 1, 'daytona',
                 'cpu_millisecond', 1, $4, now(), '{"tenant":"Purge Company"}',
                 $5, 1, $6)`,
        [
          organizationId,
          workspaceId,
          owner.id,
          `purge-usage-${randomUUID()}`,
          providerConnectionId,
          randomBytes(32),
        ],
      );
      await cloudClient.query("COMMIT");
    } finally {
      await cloudClient.query("ROLLBACK").catch(() => undefined);
      cloudClient.release();
    }
    await pool.query(
      `INSERT INTO cloud_workspace_object_storage_limits (
         org_id, max_organization_bytes, max_workspace_bytes, updated_by
       ) VALUES ($1, 1048576, 524288, $2)`,
      [organizationId, owner.id],
    );
    await pool.query(
      `INSERT INTO cloud_workspace_quota_changes (
         org_id, actor_user_id, next_max_workspaces,
         next_max_running_workspaces, next_max_cpu_millicores,
         next_max_memory_mib, next_max_storage_mib, deployment_channel,
         target_fingerprint, database_principal, reason
       ) VALUES ($1, $2, 2, 1, 1000, 2048, 10240, 'alpha',
                 '0123456789abcdef', 'migration-owner',
                 'Organization privacy-purge integration fixture')`,
      [organizationId, owner.id],
    );
    await pool.query(
      `INSERT INTO cloud_workspace_object_storage_limit_changes (
         org_id, actor_user_id, next_organization_bytes,
         next_workspace_bytes, deployment_channel, target_fingerprint,
         database_principal, reason
       ) VALUES ($1, $2, 1048576, 524288, 'alpha',
                 '0123456789abcdef', 'migration-owner',
                 'Organization privacy-purge integration fixture')`,
      [organizationId, owner.id],
    );
    await pool.query(
      `INSERT INTO cloud_workspace_object_rotation_retry_changes (
         org_id, blob_id, actor_user_id, target_key_version,
         source_key_version, prior_attempt_count, prior_error_code,
         prior_target_sha256, next_target_sha256, fence_revision,
         fence_fenced_at, job_snapshot_fingerprint, deployment_channel,
         target_fingerprint, database_principal, reason
       ) VALUES ($1, $2, $3, 2, 1, 1, 'rotation_write_failed',
                 $4, $5, 1, now(), $6, 'alpha',
                 '0123456789abcdef', 'migration-owner',
                 'Organization privacy-purge rotation retry fixture')`,
      [
        organizationId,
        randomUUID(),
        owner.id,
        randomBytes(32),
        randomBytes(32),
        randomBytes(16).toString("hex"),
      ],
    );
    const historicalCommand = await pool.query<{ id: string }>(
      `INSERT INTO workos_command_outbox (
         operation, idempotency_key, aggregate_key, ordering_key,
         aggregate_revision, organization_id, provider_object_id, payload,
         state, completed_at
       ) VALUES ('organization.update', $1, $2, $2, 1, $3,
                 'org_historical', '{"name":"Purge Company"}',
                 'succeeded', now())
       RETURNING id`,
      [
        `privacy-purge-${randomUUID()}`,
        `privacy-purge:${organizationId}`,
        organizationId,
      ],
    );
    const fencedBlobId = randomUUID();
    await pool.query(
      `INSERT INTO workspace_blob_object_deletions (
         object_key, org_id, blob_id, reserved_bytes, fenced_at
       ) VALUES ($1, $2, $3, 0, now())`,
      [
        `workspace/v2/${organizationId}/${fencedBlobId}/k1`,
        organizationId,
        fencedBlobId,
      ],
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `INSERT INTO workos_organization_links (
         organization_id, workos_organization_id, external_id, state
       ) VALUES ($1::uuid, $2, $1::uuid::text, 'active')`,
      [organizationId, workosOrganizationId],
    );
    await pool.query(
      `INSERT INTO workos_membership_projections (
         workos_membership_id, workos_organization_id, workos_user_id,
         organization_id, user_id, status, role, last_provider_event_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', 'owner', now())`,
      [
        `membership_${randomUUID().replaceAll("-", "")}`,
        workosOrganizationId,
        `user_${randomUUID().replaceAll("-", "")}`,
        organizationId,
        owner.id,
      ],
    );
    const staleMembershipId = `membership_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `INSERT INTO workos_membership_projections (
         workos_membership_id, workos_organization_id, workos_user_id,
         organization_id, user_id, status, role, last_provider_event_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', 'owner', now())`,
      [
        staleMembershipId,
        `org_${randomUUID().replaceAll("-", "")}`,
        `user_${randomUUID().replaceAll("-", "")}`,
        organizationId,
        owner.id,
      ],
    );
    const controlOrganizationId = await createOrganization(
      owner,
      "Purge Isolation Company",
    );
    await pool.query(
      `INSERT INTO cloud_workspace_quota_changes (
         org_id, actor_user_id, next_max_workspaces,
         next_max_running_workspaces, next_max_cpu_millicores,
         next_max_memory_mib, next_max_storage_mib, deployment_channel,
         target_fingerprint, database_principal, reason
       ) VALUES ($1, $2, 3, 2, 1500, 3072, 20480, 'alpha',
                 'fedcba9876543210', 'migration-owner',
                 'Cross-tenant purge isolation integration fixture')`,
      [controlOrganizationId, owner.id],
    );
    const activeSystemClient = await pool.connect();
    try {
      await activeSystemClient.query("BEGIN");
      await activeSystemClient.query("SET LOCAL ROLE zeros_app");
      await activeSystemClient.query(
        "SELECT set_config('app.system', 'on', true)",
      );
      await expect(
        activeSystemClient.query(
          `DELETE FROM cloud_workspace_usage_events WHERE org_id = $1`,
          [organizationId],
        ),
      ).rejects.toThrow(/usage events are append-only/i);
    } finally {
      await activeSystemClient.query("ROLLBACK").catch(() => undefined);
      activeSystemClient.release();
    }

    asActor(owner);
    const scheduled = await request(`/v1/organizations/${organizationId}`, {
      method: "DELETE",
      body: { confirmation: "Purge Company" },
    });
    expect(scheduled.status).toBe(202);
    const body = (await scheduled.json()) as DeletionResponse;
    await makeDue(body.deletion.id);
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "test-organization-purge",
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    const purgeCommand = await pool.query<{
      id: string;
      operation: string;
      state: string;
    }>(
      `SELECT command.id, command.operation, command.state
       FROM workos_command_outbox command
       WHERE command.id = (
         SELECT purge_command_id FROM deletion_requests WHERE id = $1
       )`,
      [body.deletion.id],
    );
    expect(purgeCommand).toMatchObject({
      rows: [{ operation: "organization.delete", state: "queued" }],
    });
    await expect(
      pool.query(
        `SELECT metadata FROM deletion_request_events
         WHERE deletion_request_id = $1
           AND action = 'purge.provider_erasure_fenced'`,
        [body.deletion.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          metadata: {
            provider: "workos",
            workosSubjectHashes: [
              workOSProviderSubjectHash({
                kind: "organization",
                id: workosOrganizationId,
              }),
            ],
          },
        },
      ],
    });
    await expect(
      pool.query(`DELETE FROM cloud_workspace_usage_events WHERE org_id = $1`, [
        organizationId,
      ]),
    ).rejects.toThrow(/usage events are append-only/i);
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM workspace_blob_object_deletions WHERE org_id = $1`,
        [organizationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    for (let poll = 0; poll < 25; poll += 1) {
      await pool.query(
        `UPDATE deletion_requests SET next_attempt_at = now() WHERE id = $1`,
        [body.deletion.id],
      );
      expect(await processor.tick(1)).toBe(1);
    }
    await expect(
      pool.query(
        `SELECT state, attempt_count FROM deletion_requests WHERE id = $1`,
        [body.deletion.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "provider_deleting", attempt_count: 1 }],
    });
    await succeedPurgeCommand(body.deletion.id);
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(`SELECT 1 FROM organizations WHERE id = $1`, [organizationId]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM workspace_blob_object_deletions WHERE org_id = $1`,
        [organizationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM cloud_workspace_quota_changes WHERE org_id = $1`,
        [controlOrganizationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM workos_membership_projections
         WHERE workos_membership_id = $1`,
        [staleMembershipId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM workos_membership_projections
         WHERE workos_organization_id = $1`,
        [workosOrganizationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      pool.query(
        `SELECT
           (SELECT count(*)::integer FROM cloud_workspace_quota_changes
            WHERE org_id = $1) AS quota_changes,
           (SELECT count(*)::integer
            FROM cloud_workspace_object_storage_limit_changes
            WHERE org_id = $1) AS storage_changes,
           (SELECT count(*)::integer FROM cloud_workspace_usage_events
            WHERE org_id = $1) AS usage_events,
           (SELECT count(*)::integer
            FROM cloud_workspace_object_rotation_retry_changes
            WHERE org_id = $1) AS rotation_retry_changes,
           (SELECT count(*)::integer FROM workos_command_outbox
            WHERE organization_id = $1) AS workos_commands`,
        [organizationId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          quota_changes: 0,
          storage_changes: 0,
          usage_events: 0,
          rotation_retry_changes: 0,
          workos_commands: 0,
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT 1 FROM workos_command_outbox
         WHERE id = ANY($1::uuid[])`,
        [[historicalCommand.rows[0]!.id, purgeCommand.rows[0]!.id]],
      ),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM workos_command_outbox command
         WHERE position($1::text in command.aggregate_key) > 0
            OR position($1::text in command.ordering_key) > 0
            OR command.provider_object_id IN ($2, 'org_historical')
            OR command.payload::text LIKE '%' || $1::text || '%'
            OR command.payload::text LIKE '%Purge Company%'`,
        [organizationId, workosOrganizationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      pool.query(
        `SELECT count(*)::integer AS count
         FROM security_notification_outbox
         WHERE template = 'organization_deletion_completed'
           AND destination_email IN ($1, $2)`,
        [owner.email, member.email],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });

  it("resumes a scheduled purge when WorkOS already reported the Organization deleted", async () => {
    const owner = await signup("ProviderDeletedOrg");
    const organizationId = await createOrganization(
      owner,
      "Provider Deleted Company",
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `INSERT INTO workos_organization_links (
         organization_id, workos_organization_id, external_id, state
       ) VALUES ($1::uuid, $2, $1::uuid::text, 'active')`,
      [organizationId, workosOrganizationId],
    );

    asActor(owner);
    const scheduled = await request(`/v1/organizations/${organizationId}`, {
      method: "DELETE",
      body: { confirmation: "Provider Deleted Company" },
    });
    expect(scheduled.status).toBe(202);
    const body = (await scheduled.json()) as DeletionResponse;
    await pool.query(
      `UPDATE organizations
       SET lifecycle_status = 'provider_deleted', deleted_at = now()
       WHERE id = $1`,
      [organizationId],
    );
    await pool.query(
      `UPDATE workos_organization_links SET state = 'deleted' WHERE organization_id = $1`,
      [organizationId],
    );
    await makeDue(body.deletion.id);
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "test-provider-deleted-organization",
      logger: { warn: () => undefined, error: () => undefined },
    });

    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(
        `SELECT request.state, organization.lifecycle_status,
                command.operation, command.state AS command_state
         FROM deletion_requests request
         JOIN organizations organization
           ON organization.id = request.target_organization_id
         JOIN workos_command_outbox command
           ON command.id = request.purge_command_id
         WHERE request.id = $1`,
        [body.deletion.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "provider_deleting",
          lifecycle_status: "purging",
          operation: "organization.delete",
          command_state: "queued",
        },
      ],
    });
    await succeedPurgeCommand(body.deletion.id);
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(`SELECT 1 FROM organizations WHERE id = $1`, [organizationId]),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("fences a reclaimed same-worker deletion lease with a monotonic revision", async () => {
    // Model overdue work left by a prior case.
    // The fixture must isolate the request being exercised from that backlog.
    const previousOwner = await signup("PreviousDeletionLease");
    const previous = await scheduleAccount(previousOwner);
    expect(previous.response.status).toBe(202);
    await makeDue(previous.body.deletion.id);
    await pool.query(
      `UPDATE deletion_requests
       SET requested_at = requested_at - interval '1 day',
           purge_after = purge_after - interval '1 day'
       WHERE id = $1`,
      [previous.body.deletion.id],
    );

    const owner = await signup("DeletionLeaseFence");
    const organizationId = await createOrganization(
      owner,
      "Lease Fence Company",
    );
    const workosOrganizationId = `org_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `INSERT INTO workos_organization_links (
         organization_id, workos_organization_id, external_id, state
       ) VALUES ($1::uuid, $2, $1::uuid::text, 'active')`,
      [organizationId, workosOrganizationId],
    );
    asActor(owner);
    const scheduled = await request(`/v1/organizations/${organizationId}`, {
      method: "DELETE",
      body: { confirmation: "Lease Fence Company" },
    });
    expect(scheduled.status).toBe(202);
    const body = (await scheduled.json()) as DeletionResponse;
    await makeDue(body.deletion.id);
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "shared-deletion-worker",
      logger: { warn: () => undefined, error: () => undefined },
    });
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(`SELECT state FROM deletion_requests WHERE id = $1`, [
        body.deletion.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: "provider_deleting" }] });
    await pool.query(
      `UPDATE deletion_requests SET next_attempt_at = now() WHERE id = $1`,
      [body.deletion.id],
    );

    type InternalClaim = { id: string; lease_revision: string | number };
    const controls = processor as unknown as {
      claim(): Promise<InternalClaim | null>;
      release(request: InternalClaim, delayMs: number): Promise<void>;
    };
    const first = await controls.claim();
    expect(first).toMatchObject({ id: body.deletion.id });
    await pool.query(
      `UPDATE deletion_requests
       SET lease_expires_at = now() - interval '1 second', next_attempt_at = now()
       WHERE id = $1`,
      [body.deletion.id],
    );
    const second = await controls.claim();
    expect(second).toMatchObject({ id: body.deletion.id });
    expect(Number(second!.lease_revision)).toBeGreaterThan(
      Number(first!.lease_revision),
    );

    await controls.release(first!, 0);
    await expect(
      pool.query<{
        lease_owner: string | null;
        lease_revision: string | number;
      }>(
        `SELECT lease_owner, lease_revision
         FROM deletion_requests WHERE id = $1`,
        [body.deletion.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          lease_owner: "shared-deletion-worker",
          lease_revision: String(second!.lease_revision),
        },
      ],
    });
    await controls.release(second!, 0);
    await expect(
      pool.query(`SELECT lease_owner FROM deletion_requests WHERE id = $1`, [
        body.deletion.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ lease_owner: null }] });
  });

  it("does not purge an Organization until detached object keys are durably fenced", async () => {
    const owner = await signup("OrgFencePurge");
    const organizationId = await createOrganization(owner, "Fence Company");
    const blobId = randomUUID();
    await pool.query(
      `INSERT INTO workspace_blob_object_deletions (
         object_key, org_id, blob_id, reserved_bytes
       ) VALUES ($1, $2, $3, 128)`,
      [`workspace/v2/${organizationId}/${blobId}/k1`, organizationId, blobId],
    );

    asActor(owner);
    const scheduled = await request(`/v1/organizations/${organizationId}`, {
      method: "DELETE",
      body: { confirmation: "Fence Company" },
    });
    expect(scheduled.status).toBe(202);
    const body = (await scheduled.json()) as DeletionResponse;
    await makeDue(body.deletion.id);
    const processor = new DeletionLifecycleProcessor(pool, {
      workerId: "test-organization-fence-purge",
      logger: { warn: () => undefined, error: () => undefined },
    });

    for (let poll = 0; poll < 25; poll += 1) {
      await pool.query(
        `UPDATE deletion_requests SET next_attempt_at = now() WHERE id = $1`,
        [body.deletion.id],
      );
      expect(await processor.tick(1)).toBe(1);
    }
    await expect(
      pool.query(
        `SELECT state, attempt_count, last_error_code
         FROM deletion_requests WHERE id = $1`,
        [body.deletion.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "purging",
          attempt_count: 1,
          last_error_code: null,
        },
      ],
    });
    await expect(
      pool.query(`SELECT id FROM organizations WHERE id = $1`, [
        organizationId,
      ]),
    ).resolves.toMatchObject({ rows: [{ id: organizationId }] });

    await pool.query(
      `UPDATE workspace_blob_object_deletions
       SET reserved_bytes = 0, fenced_at = now(), last_error_code = NULL
       WHERE org_id = $1`,
      [organizationId],
    );
    await pool.query(
      `UPDATE deletion_requests SET next_attempt_at = now() WHERE id = $1`,
      [body.deletion.id],
    );
    expect(await processor.tick(1)).toBe(1);
    await pool.query(
      `UPDATE deletion_requests SET next_attempt_at = now() WHERE id = $1`,
      [body.deletion.id],
    );
    expect(await processor.tick(1)).toBe(1);
    await expect(
      pool.query(`SELECT 1 FROM organizations WHERE id = $1`, [organizationId]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      pool.query(
        `SELECT disposition
         FROM workos_provider_erasure_reconciliations
         WHERE deletion_request_id = $1`,
        [body.deletion.id],
      ),
    ).resolves.toMatchObject({
      rows: [{ disposition: "no_workos_subject" }],
    });
  });

  it("requires exact-case owner grants and two people for Business recovery and forced purge", async () => {
    const customer = await signup("OpsCustomer");
    const coworker = await signup("OpsCoworker");
    const owner = await signup("PlatformOwner");
    const developer = await signup("Developer");
    await pool.query(
      `UPDATE users SET staff_role = 'platform_owner' WHERE id = $1`,
      [owner.id],
    );
    await pool.query(
      `UPDATE users SET staff_role = 'developer' WHERE id = $1`,
      [developer.id],
    );
    const organizationId = await createOrganization(customer, "Ops Business");
    await addOrganizationMember(organizationId, coworker, "member");

    asActor(customer);
    const scheduled = await request(`/v1/organizations/${organizationId}`, {
      method: "DELETE",
      body: { confirmation: "Ops Business" },
    });
    const body = (await scheduled.json()) as DeletionResponse;
    const code = body.deletion.recoveryCode;
    const supportCaseReference = "CASE-OPS-1001";
    const verified = {
      supportCaseReference,
      ownershipVerification: "confirmed_out_of_band",
    };

    asActor({ ...owner, staffRole: "platform_owner" });
    const lookup = await request(`/v1/ops/deletions/${code}/lookup`, {
      method: "POST",
      body: verified,
    });
    expect(lookup.status).toBe(200);
    await expect(lookup.json()).resolves.toMatchObject({
      target: { businessOrganization: true, name: "Ops Business" },
    });
    const ownerRestore = await request(`/v1/ops/deletions/${code}/restore`, {
      method: "POST",
      body: verified,
    });
    expect(ownerRestore.status).toBe(409);
    await expect(ownerRestore.json()).resolves.toMatchObject({
      error: { code: "two_person_approval_required" },
    });
    const grantResponse = await request(`/v1/ops/deletions/${code}/grants`, {
      method: "POST",
      body: {
        ...verified,
        granteeUserId: developer.id,
        capability: "deletion.restore",
        expiresInMinutes: 15,
      },
    });
    expect(grantResponse.status).toBe(201);
    const grant = (await grantResponse.json()) as { grant: { id: string } };

    asActor({ ...developer, staffRole: "developer" });
    const wrongCaseLookup = await request(`/v1/ops/deletions/${code}/lookup`, {
      method: "POST",
      body: { ...verified, supportCaseReference: "CASE-WRONG-1001" },
    });
    expect(wrongCaseLookup.status).toBe(404);
    const restored = await request(`/v1/ops/deletions/${code}/restore`, {
      method: "POST",
      body: { ...verified, grantId: grant.grant.id },
    });
    expect(restored.status).toBe(200);
    await expect(
      pool.query(`SELECT used_at FROM staff_operation_grants WHERE id = $1`, [
        grant.grant.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ used_at: expect.any(Date) }] });

    // A grant is a one-shot approval, including when the downstream state
    // transition fails after authorization. Burning it first prevents a
    // partial-success/retry path from replaying destructive authority.
    const failureOrganizationId = await createOrganization(
      customer,
      "Grant Failure",
    );
    asActor(customer);
    const failureScheduled = await request(
      `/v1/organizations/${failureOrganizationId}`,
      {
        method: "DELETE",
        body: { confirmation: "Grant Failure" },
      },
    );
    const failureBody = (await failureScheduled.json()) as DeletionResponse;
    const failureVerified = {
      supportCaseReference: "CASE-OPS-1003",
      ownershipVerification: "confirmed_out_of_band",
    };
    asActor({ ...owner, staffRole: "platform_owner" });
    const failureGrantResponse = await request(
      `/v1/ops/deletions/${failureBody.deletion.recoveryCode}/grants`,
      {
        method: "POST",
        body: {
          ...failureVerified,
          granteeUserId: developer.id,
          capability: "deletion.restore",
          expiresInMinutes: 15,
        },
      },
    );
    const failureGrant = (await failureGrantResponse.json()) as {
      grant: { id: string };
    };
    await pool.query(
      `UPDATE deletion_requests
       SET state = 'failed', purge_started_at = now()
       WHERE id = $1`,
      [failureBody.deletion.id],
    );
    asActor({ ...developer, staffRole: "developer" });
    const failedRestore = await request(
      `/v1/ops/deletions/${failureBody.deletion.recoveryCode}/restore`,
      {
        method: "POST",
        body: { ...failureVerified, grantId: failureGrant.grant.id },
      },
    );
    expect(failedRestore.status).toBe(409);
    await expect(failedRestore.json()).resolves.toMatchObject({
      error: { code: "deletion_not_recoverable" },
    });
    await expect(
      pool.query(`SELECT used_at FROM staff_operation_grants WHERE id = $1`, [
        failureGrant.grant.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ used_at: expect.any(Date) }] });

    asActor(customer);
    const forceScheduled = await request(
      `/v1/organizations/${organizationId}`,
      {
        method: "DELETE",
        body: { confirmation: "Ops Business" },
      },
    );
    const forceBody = (await forceScheduled.json()) as DeletionResponse;
    const forceCode = forceBody.deletion.recoveryCode;
    const forceCase = "CASE-OPS-1002";
    const forceVerified = {
      supportCaseReference: forceCase,
      ownershipVerification: "confirmed_out_of_band",
    };
    asActor({ ...owner, staffRole: "platform_owner" });
    const ownerForce = await request(
      `/v1/ops/deletions/${forceCode}/force-purge`,
      {
        method: "POST",
        body: {
          ...forceVerified,
          confirmation: `FORCE PURGE ${forceCode}`,
        },
      },
    );
    expect(ownerForce.status).toBe(409);
    const forceGrantResponse = await request(
      `/v1/ops/deletions/${forceCode}/grants`,
      {
        method: "POST",
        body: {
          ...forceVerified,
          granteeUserId: developer.id,
          capability: "deletion.force_purge",
          expiresInMinutes: 15,
        },
      },
    );
    const forceGrant = (await forceGrantResponse.json()) as {
      grant: { id: string };
    };
    asActor({ ...developer, staffRole: "developer" });
    const purging = await request(
      `/v1/ops/deletions/${forceCode}/force-purge`,
      {
        method: "POST",
        body: {
          ...forceVerified,
          grantId: forceGrant.grant.id,
          confirmation: `FORCE PURGE ${forceCode}`,
        },
      },
    );
    expect(purging.status).toBe(202);
    await expect(purging.json()).resolves.toMatchObject({
      deletion: { state: "purging" },
    });
  });
});
