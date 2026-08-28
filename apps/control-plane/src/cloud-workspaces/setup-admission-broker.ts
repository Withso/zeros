import type pg from "pg";

import { audit } from "../audit.js";
import { withSystemTx } from "../db.js";
import {
  CloudWorkspaceGrantError,
  issueCloudWorkspaceGrant,
  normalizeCloudWorkspaceGrantAudience,
} from "./grants.js";
import type {
  CloudWorkspaceSetupAdmission,
  CloudWorkspaceSetupAdmissionBroker,
} from "./daytona-setup-executor.js";
import {
  CloudWorkspaceSetupError,
  type CloudWorkspaceSetupExecution,
} from "./setup-worker.js";

export type DatabaseCloudWorkspaceSetupAdmissionBrokerOptions = {
  pool: pg.Pool;
  endpoint: string;
  ttlSeconds?: number;
};

export class DatabaseCloudWorkspaceSetupAdmissionBroker implements CloudWorkspaceSetupAdmissionBroker {
  private readonly pool: pg.Pool;
  private readonly endpoint: string;
  private readonly ttlSeconds: number;

  constructor(options: DatabaseCloudWorkspaceSetupAdmissionBrokerOptions) {
    this.pool = options.pool;
    this.endpoint = normalizeCloudWorkspaceGrantAudience(options.endpoint);
    this.ttlSeconds = options.ttlSeconds ?? 120;
    if (
      !Number.isSafeInteger(this.ttlSeconds) ||
      this.ttlSeconds < 15 ||
      this.ttlSeconds > 900
    ) {
      throw new Error("setup admission ttlSeconds must be between 15 and 900");
    }
  }

  async issue(
    execution: CloudWorkspaceSetupExecution,
    signal: AbortSignal,
  ): Promise<CloudWorkspaceSetupAdmission> {
    if (signal.aborted) {
      throw new CloudWorkspaceSetupError(
        "setup_execution_aborted",
        "Cloud workspace setup execution was aborted",
        true,
      );
    }
    try {
      const grant = await withSystemTx(this.pool, (tx) =>
        issueCloudWorkspaceGrant(tx, {
          workspaceId: execution.workspaceId,
          generation: execution.generation,
          organizationId: execution.organizationId,
          accountUserId: execution.authority.accountUserId,
          purpose: "setup",
          setup: {
            setupRunId: execution.setupRunId,
            executionFence: execution.executionFence,
          },
          audience: this.endpoint,
          ttlSeconds: this.ttlSeconds,
          issuedBy: null,
        }),
      );
      if (signal.aborted) {
        await this.revoke(
          {
            id: grant.id,
            token: grant.token,
            endpoint: grant.audience,
            expiresAt: grant.expiresAt,
            workspaceId: grant.workspaceId,
            organizationId: grant.organizationId,
            generation: grant.generation,
            setupRunId: execution.setupRunId,
            executionFence: execution.executionFence,
          },
          "rejected",
        );
        throw new CloudWorkspaceSetupError(
          "setup_execution_aborted",
          "Cloud workspace setup execution was aborted",
          true,
        );
      }
      return {
        id: grant.id,
        token: grant.token,
        endpoint: grant.audience,
        expiresAt: grant.expiresAt,
        workspaceId: grant.workspaceId,
        organizationId: grant.organizationId,
        generation: grant.generation,
        setupRunId: grant.setupRunId!,
        executionFence: grant.executionFence!,
      };
    } catch (error) {
      if (error instanceof CloudWorkspaceSetupError) throw error;
      if (error instanceof CloudWorkspaceGrantError) {
        throw new CloudWorkspaceSetupError(
          error.code === "grant_subject_not_authorized"
            ? "setup_admission_ineligible"
            : "setup_admission_invalid",
          "Cloud workspace setup admission could not be issued",
          false,
        );
      }
      throw new CloudWorkspaceSetupError(
        "setup_admission_unavailable",
        "Cloud workspace setup admission is temporarily unavailable",
        true,
      );
    }
  }

  async revoke(
    admission: CloudWorkspaceSetupAdmission,
    disposition: "completed" | "failed" | "rejected",
  ): Promise<void> {
    await withSystemTx(this.pool, async (tx) => {
      const retired = await tx.query(
        `UPDATE cloud_workspace_endpoint_grants
         SET revoked_at = coalesce(revoked_at, now())
         WHERE id = $1 AND workspace_id = $2 AND org_id = $3
           AND generation = $4 AND purpose = 'setup'
           AND setup_run_id = $5 AND setup_execution_fence = $6
         RETURNING id`,
        [
          admission.id,
          admission.workspaceId,
          admission.organizationId,
          admission.generation,
          admission.setupRunId,
          admission.executionFence,
        ],
      );
      if ((retired.rowCount ?? 0) !== 1) {
        throw new CloudWorkspaceSetupError(
          "setup_admission_not_found",
          "Cloud workspace setup admission could not be retired",
          true,
        );
      }
      await audit(
        tx,
        admission.organizationId,
        null,
        "cloud_workspace.setup_admission_retired",
        {
          grantId: admission.id,
          workspaceId: admission.workspaceId,
          generation: admission.generation,
          setupRunId: admission.setupRunId,
          executionFence: admission.executionFence,
          disposition,
        },
      );
    });
  }
}
