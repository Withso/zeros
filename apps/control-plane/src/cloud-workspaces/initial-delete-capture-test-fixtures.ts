import type pg from "pg";
import { seedInitialSetupDelete } from "./initial-setup-delete-test-fixtures.js";
import type { InitialDeleteCaptureRequest } from "../manage-cloud-initial-delete-capture.js";

/** Builds on the frozen parent regression without changing its fixture bytes. */
export async function seedInitialDeleteCapture(pool: pg.Pool) {
  const fixture = await seedInitialSetupDelete(pool);
  await fixture.ready();
  await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [fixture.userId]);
  const setupRunId = (await pool.query("SELECT setup_run_id FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0].setup_run_id as string;
  const slug = (await pool.query("SELECT slug FROM organizations WHERE id=$1", [fixture.organizationId])).rows[0].slug as string;
  const request: InitialDeleteCaptureRequest = {
    version: 1, channel: "development", organizationId: fixture.organizationId,
    expectedOrganizationSlug: slug, workspaceId: fixture.workspaceId,
    ownerUserId: fixture.userId, operatorUserId: fixture.userId, deleteIntentId: fixture.deleteId,
    generation: 1, engineInstanceId: fixture.engineInstanceId, setupRunId,
    bootId: fixture.bootId, writerEpoch: fixture.writerEpoch, allocationLeaseId: fixture.leaseId,
  };
  return { ...fixture, setupRunId, request };
}
