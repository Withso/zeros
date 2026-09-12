import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import { consumeCloudWorkspaceGrant } from "./grants.js";
import { DatabaseCloudWorkspaceSetupAdmissionBroker } from "./setup-admission-broker.js";
import {
  seedCanonicalCloudWorkspaceAuthority,
  seedCanonicalCloudWorkspacePrerequisites,
  seedCanonicalWorkspaceSettingsVersion,
} from "./test-fixtures.js";
import type { CloudWorkspaceSetupExecution } from "./setup-worker.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d("cloud workspace setup admission broker", () => {
  let pool: pg.Pool;
  let setup: CloudWorkspaceSetupExecution;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    const userId = randomUUID();
    setup = await withSystemTx(pool, async (tx) => {
      const organizationId = randomUUID();
      const teamId = randomUUID();
      const workspaceId = randomUUID();
      await tx.query(
        `INSERT INTO users (id, email, display_name)
         VALUES ($1, $2, 'Setup Admission Owner')`,
        [userId, `setup-admission-${userId}@example.test`],
      );
      await tx.query(
        `INSERT INTO organizations (
           id, slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, $2, 'Setup Admission', $3, false, true)`,
        [organizationId, `setup-admission-${randomUUID()}`, userId],
      );
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [organizationId, userId],
      );
      await tx.query(
        `INSERT INTO teams (
           id, org_id, slug, name, is_default, created_by
         ) VALUES ($1, $2, 'default', 'Default', true, $3)`,
        [teamId, organizationId, userId],
      );
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'maintainer')`,
        [teamId, organizationId, userId],
      );
      const canonical = await seedCanonicalCloudWorkspacePrerequisites(tx, {
        organizationId,
        ownerUserId: userId,
      });
      await tx.query(
        `INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision, repository_id, owner_user_id,
           assignee_user_id, status, desired_state
         ) VALUES ($1, $2, $3, $4, 'Setup Admission Workspace',
                   'github.com', 'withso', 'zeros', 'main',
                   $5, $4, $4, 'setting_up', 'running')`,
        [
          workspaceId,
          organizationId,
          teamId,
          userId,
          canonical.repositoryId,
        ],
      );
      await seedCanonicalCloudWorkspaceAuthority(tx, {
        workspaceId,
        organizationId,
        ownerUserId: userId,
      });
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         ) VALUES ($1, 1, $2, 'daytona', 'snapshot-pinned-id',
                   'linux/amd64', 2000, 4096, 20480, $3, $4, $5)`,
        [
          workspaceId,
          organizationId,
          "a".repeat(40),
          userId,
          canonical.providerConnectionId,
        ],
      );
      const settingsDocument = { schemaVersion: 1, values: {} };
      const settings = JSON.stringify(settingsDocument);
      const settingsVersionId = await seedCanonicalWorkspaceSettingsVersion(tx, {
        workspaceId,
        organizationId,
        generation: 1,
        createdBy: userId,
        effectiveDocument: settingsDocument,
      });
      await tx.query(
        `INSERT INTO cloud_workspace_setup_specs (
           workspace_id, generation, org_id, repository_forge,
           repository_owner, repository_name, repository_revision,
           settings_snapshot, settings_snapshot_sha256,
           workspace_settings_version_id
         ) VALUES ($1, 1, $2, 'github.com', 'withso', 'zeros', 'main',
                   $3::jsonb, digest($3::jsonb::text, 'sha256'), $4)`,
        [workspaceId, organizationId, settings, settingsVersionId],
      );
      const run = await tx.query<{ id: string }>(
        `INSERT INTO cloud_workspace_setup_runs (
           workspace_id, generation, org_id, attempt, state, claim_count,
           execution_fence, lease_owner, lease_expires_at,
           last_heartbeat_at, started_at
         ) VALUES ($1, 1, $2, 1, 'running', 1, 4, 'setup-worker-test',
                   now() + interval '5 minutes', now(), now())
         RETURNING id`,
        [workspaceId, organizationId],
      );
      return {
        setupRunId: run.rows[0]!.id,
        workspaceId,
        organizationId,
        authority: { accountUserId: userId },
        generation: 1,
        attempt: 1,
        executionFence: 4,
        provider: { name: "daytona", resourceId: `sandbox-${workspaceId}` },
        image: {
          ref: "snapshot-pinned-id",
          sourceCommit: "a".repeat(40),
        },
        repository: {
          forge: "github.com",
          owner: "withso",
          name: "zeros",
          revision: "main",
          githubInstallationId: null,
        },
        settings: {
          version: 1,
          snapshot: { schemaVersion: 1, values: {} },
          sha256: createHash("sha256")
            .update('{"values": {}, "schemaVersion": 1}')
            .digest("hex"),
        },
      };
    });
  });

  it("stores only a digest and consumes exactly the matching run and fence", async () => {
    const broker = new DatabaseCloudWorkspaceSetupAdmissionBroker({
      pool,
      endpoint:
        "https://control.example.test/v1/internal/cloud-workspaces/setup",
      ttlSeconds: 60,
    });
    const admission = await broker.issue(setup, new AbortController().signal);
    expect(admission).toMatchObject({
      workspaceId: setup.workspaceId,
      generation: setup.generation,
      setupRunId: setup.setupRunId,
      executionFence: setup.executionFence,
    });
    expect(admission.token).toMatch(/^zws_[A-Za-z0-9_-]{43}$/);

    const stored = await pool.query<{
      token_digest: string;
      visible: string;
      setup_run_id: string;
      setup_execution_fence: string;
    }>(
      `SELECT encode(token_hash, 'hex') AS token_digest,
              row_to_json(g)::text AS visible, setup_run_id,
              setup_execution_fence
       FROM cloud_workspace_endpoint_grants g WHERE id = $1`,
      [admission.id],
    );
    expect(stored.rows[0]).toMatchObject({
      token_digest: createHash("sha256").update(admission.token).digest("hex"),
      setup_run_id: setup.setupRunId,
      setup_execution_fence: String(setup.executionFence),
    });
    expect(stored.rows[0]!.visible).not.toContain(admission.token);

    await expect(
      withSystemTx(pool, (tx) =>
        consumeCloudWorkspaceGrant(tx, {
          token: admission.token,
          workspaceId: setup.workspaceId,
          generation: setup.generation,
          organizationId: setup.organizationId,
          accountUserId: setup.authority.accountUserId,
          purpose: "setup",
          setup: {
            setupRunId: setup.setupRunId,
            executionFence: setup.executionFence + 1,
          },
          audience: admission.endpoint,
        }),
      ),
    ).resolves.toBeNull();

    const consumed = await withSystemTx(pool, (tx) =>
      consumeCloudWorkspaceGrant(tx, {
        token: admission.token,
        workspaceId: setup.workspaceId,
        generation: setup.generation,
        organizationId: setup.organizationId,
        accountUserId: setup.authority.accountUserId,
        purpose: "setup",
        setup: {
          setupRunId: setup.setupRunId,
          executionFence: setup.executionFence,
        },
        audience: admission.endpoint,
      }),
    );
    expect(consumed).toMatchObject({
      setupRunId: setup.setupRunId,
      executionFence: setup.executionFence,
    });
    await expect(
      withSystemTx(pool, (tx) =>
        consumeCloudWorkspaceGrant(tx, {
          token: admission.token,
          workspaceId: setup.workspaceId,
          generation: setup.generation,
          organizationId: setup.organizationId,
          accountUserId: setup.authority.accountUserId,
          purpose: "setup",
          setup: {
            setupRunId: setup.setupRunId,
            executionFence: setup.executionFence,
          },
          audience: admission.endpoint,
        }),
      ),
    ).resolves.toBeNull();
  });

  it("rejects unbound inserts and stale execution fences", async () => {
    await expect(
      withSystemTx(pool, (tx) =>
        tx.query(
          `INSERT INTO cloud_workspace_endpoint_grants (
             workspace_id, generation, org_id, account_user_id, purpose,
             audience, token_hash, account_revision, authorization_revision,
             expires_at
           ) VALUES ($1, 1, $2, $3, 'setup', 'https://control.example.test/',
                     $4, 1, 1, now() + interval '1 minute')`,
          [
            setup.workspaceId,
            setup.organizationId,
            setup.authority.accountUserId,
            createHash("sha256").update(randomUUID()).digest(),
          ],
        ),
      ),
    ).rejects.toThrow(/execution binding/i);

    const broker = new DatabaseCloudWorkspaceSetupAdmissionBroker({
      pool,
      endpoint: "https://control.example.test/setup",
    });
    await expect(
      broker.issue(
        { ...setup, executionFence: setup.executionFence + 1 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "setup_admission_ineligible",
      retryable: false,
    });
  });

  it("rejects readiness attestations outside the live immutable setup contract", async () => {
    const insertAttestation = (imageRef: string) =>
      withSystemTx(pool, (tx) =>
        tx.query(
          `INSERT INTO cloud_workspace_setup_attestations (
             setup_run_id, workspace_id, generation, org_id, execution_fence,
             image_ref, image_source_commit, repository_revision,
             repository_commit, settings_version, settings_snapshot_sha256,
             engine_instance_id, engine_protocol_version, engine_health,
             durable_record_connected
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                     decode($11, 'hex'), $12, 11, 'ready', true)`,
          [
            setup.setupRunId,
            setup.workspaceId,
            setup.generation,
            setup.organizationId,
            setup.executionFence,
            imageRef,
            setup.image.sourceCommit,
            setup.repository.revision,
            "c".repeat(40),
            setup.settings.version,
            setup.settings.sha256,
            randomUUID(),
          ],
        ),
      );

    await expect(insertAttestation("different-image")).rejects.toThrow(
      /attestation.*live setup contract/i,
    );

    await withSystemTx(pool, (tx) =>
      tx.query(
        `UPDATE cloud_workspace_setup_runs
         SET lease_expires_at = now() - interval '1 second',
             last_heartbeat_at = now() - interval '2 seconds'
         WHERE id = $1`,
        [setup.setupRunId],
      ),
    );
    await expect(insertAttestation(setup.image.ref)).rejects.toThrow(
      /attestation.*live setup contract/i,
    );
  });

  it("retires an admission idempotently without retaining its token", async () => {
    const broker = new DatabaseCloudWorkspaceSetupAdmissionBroker({
      pool,
      endpoint: "https://control.example.test/setup",
    });
    const admission = await broker.issue(setup, new AbortController().signal);
    await expect(broker.revoke(admission, "failed")).resolves.toBeUndefined();
    await expect(broker.revoke(admission, "failed")).resolves.toBeUndefined();
    const row = await pool.query<{ revoked: boolean; visible: string }>(
      `SELECT revoked_at IS NOT NULL AS revoked, row_to_json(g)::text AS visible
       FROM cloud_workspace_endpoint_grants g WHERE id = $1`,
      [admission.id],
    );
    expect(row.rows[0]).toMatchObject({ revoked: true });
    expect(row.rows[0]!.visible).not.toContain(admission.token);
  });

  it("keeps the abort result when best-effort grant retirement also fails", async () => {
    const broker = new DatabaseCloudWorkspaceSetupAdmissionBroker({
      pool,
      endpoint: "https://control.example.test/setup",
    });
    vi.spyOn(broker, "revoke").mockRejectedValueOnce(
      new Error("database unavailable during retirement"),
    );
    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads > 1;
      },
    } as AbortSignal;

    await expect(broker.issue(setup, signal)).rejects.toMatchObject({
      code: "setup_execution_aborted",
      retryable: true,
    });
  });
});
