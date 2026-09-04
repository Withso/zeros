import type pg from "pg";

import { withSystemTx } from "../db.js";
import { authorizeCloudWorkspaceOperation } from "./authorization.js";
import { assertCurrentCloudEngineAuthority } from "./engine-authority.js";
import {
  CloudWorkspaceGrantError,
  consumeCloudWorkspaceEngineConnectGrant,
  issueCloudWorkspaceGrant,
  normalizeCloudWorkspaceGrantAudience,
} from "./grants.js";

export const CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH =
  "/internal/v1/cloud-workspaces/engine/client-admission" as const;
export const CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_AUDIENCE =
  "zeros-cloud-workspace-engine-client-admission-v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GRANT_TOKEN_PATTERN = /^zws_[A-Za-z0-9_-]{43}$/;
const HEARTBEAT_TOKEN_PATTERN = /^zwh_[A-Za-z0-9_-]{43}$/;

export class CloudWorkspaceEngineClientAdmissionError extends Error {
  constructor(
    public readonly code:
      | "engine_client_admission_invalid"
      | "engine_client_admission_ineligible"
      | "engine_client_admission_rejected",
    message: string,
  ) {
    super(message);
    this.name = "CloudWorkspaceEngineClientAdmissionError";
  }
}

export type CloudWorkspaceEngineClientAdmission = {
  version: 1;
  audience: typeof CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_AUDIENCE;
  workspaceId: string;
  organizationId: string;
  generation: number;
  authorityEpoch: number;
  engineInstanceId: string;
  remotePort: number;
  grantToken: string;
  expiresAt: string;
};

export type DatabaseCloudWorkspaceEngineClientAdmissionServiceOptions = {
  pool: pg.Pool;
  endpoint: string;
  enginePort: number;
  ttlSeconds?: number;
  workosEnabled?: boolean;
};

/** Issues desktop-facing, one-use bridge capabilities and redeems them only
 * when the exact current engine proves its heartbeat authority. The engine's
 * long-lived bootstrap bearer never leaves the sandbox. */
export class DatabaseCloudWorkspaceEngineClientAdmissionService {
  private readonly pool: pg.Pool;
  private readonly endpoint: string;
  private readonly enginePort: number;
  private readonly ttlSeconds: number;
  private readonly workosEnabled: boolean;

  constructor(
    options: DatabaseCloudWorkspaceEngineClientAdmissionServiceOptions,
  ) {
    this.pool = options.pool;
    this.endpoint = normalizeCloudWorkspaceGrantAudience(options.endpoint);
    const endpoint = new URL(this.endpoint);
    if (endpoint.pathname !== CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH) {
      throw new Error("engine client admission endpoint is invalid");
    }
    this.enginePort = options.enginePort;
    this.ttlSeconds = options.ttlSeconds ?? 120;
    this.workosEnabled = options.workosEnabled === true;
    if (
      !Number.isSafeInteger(this.enginePort) ||
      this.enginePort < 1 ||
      this.enginePort > 65_535 ||
      this.enginePort === 22_222 ||
      !Number.isSafeInteger(this.ttlSeconds) ||
      this.ttlSeconds < 15 ||
      this.ttlSeconds > 900
    ) {
      throw new Error("engine client admission configuration is invalid");
    }
  }

  async issue(input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
  }): Promise<CloudWorkspaceEngineClientAdmission> {
    if (
      !UUID_PATTERN.test(input.organizationId) ||
      !UUID_PATTERN.test(input.workspaceId) ||
      !UUID_PATTERN.test(input.actorUserId)
    ) {
      throw new CloudWorkspaceEngineClientAdmissionError(
        "engine_client_admission_invalid",
        "Engine client admission input is invalid",
      );
    }
    try {
      return await withSystemTx(this.pool, async (tx) => {
        const workspace = await tx.query<{
          team_id: string;
          owner_user_id: string;
          current_generation: number;
          authority_epoch: string | number;
          desired_state: string;
          status: string;
        }>(
          `SELECT team_id, owner_user_id, current_generation, authority_epoch,
                  desired_state, status
           FROM cloud_workspaces
           WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
           FOR UPDATE`,
          [input.workspaceId, input.organizationId],
        );
        const current = workspace.rows[0];
        if (
          !current ||
          current.desired_state !== "running" ||
          !["ready", "busy"].includes(current.status)
        ) {
          throw new CloudWorkspaceEngineClientAdmissionError(
            "engine_client_admission_ineligible",
            "Cloud workspace is not ready for an engine connection",
          );
        }
        await authorizeCloudWorkspaceOperation(tx, {
          organizationId: input.organizationId,
          teamId: current.team_id,
          actorUserId: input.actorUserId,
          billingOwnerUserId: current.owner_user_id,
          workosEnabled: this.workosEnabled,
          requireWorkspaceOwner: true,
        });
        const engine = await tx.query<{ id: string }>(
          `SELECT id
           FROM cloud_workspace_engine_instances
           WHERE workspace_id = $1 AND org_id = $2 AND generation = $3
             AND state = 'ready' AND revoked_at IS NULL
             AND lease_expires_at > now()
           ORDER BY registered_at DESC NULLS LAST, id DESC
           LIMIT 2`,
          [input.workspaceId, input.organizationId, current.current_generation],
        );
        if (engine.rows.length !== 1) {
          throw new CloudWorkspaceEngineClientAdmissionError(
            "engine_client_admission_ineligible",
            "A unique live cloud engine is not available",
          );
        }
        const grant = await issueCloudWorkspaceGrant(tx, {
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          generation: current.current_generation,
          accountUserId: input.actorUserId,
          purpose: "engine-connect",
          engineInstanceId: engine.rows[0]!.id,
          audience: this.endpoint,
          ttlSeconds: this.ttlSeconds,
          issuedBy: input.actorUserId,
          workosEnabled: this.workosEnabled,
        });
        const authorityEpoch = Number(current.authority_epoch);
        if (
          !Number.isSafeInteger(authorityEpoch) ||
          authorityEpoch < 1 ||
          grant.authorityEpoch !== authorityEpoch
        ) {
          throw new CloudWorkspaceEngineClientAdmissionError(
            "engine_client_admission_ineligible",
            "Cloud workspace authority changed during admission",
          );
        }
        return {
          version: 1,
          audience: CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_AUDIENCE,
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          generation: grant.generation,
          authorityEpoch,
          engineInstanceId: engine.rows[0]!.id,
          remotePort: this.enginePort,
          grantToken: grant.token,
          expiresAt: grant.expiresAt.toISOString(),
        };
      });
    } catch (error) {
      if (error instanceof CloudWorkspaceEngineClientAdmissionError)
        throw error;
      if (error instanceof CloudWorkspaceGrantError) {
        throw new CloudWorkspaceEngineClientAdmissionError(
          "engine_client_admission_ineligible",
          "Cloud engine connection capability could not be issued",
        );
      }
      throw error;
    }
  }

  async consume(input: {
    token: string;
    heartbeatToken: string;
    organizationId: string;
    workspaceId: string;
    generation: number;
    engineInstanceId: string;
  }): Promise<{
    version: 1;
    audience: typeof CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_AUDIENCE;
    admitted: true;
    authorityEpoch: number;
    accountUserId: string;
  }> {
    if (
      !GRANT_TOKEN_PATTERN.test(input.token) ||
      !HEARTBEAT_TOKEN_PATTERN.test(input.heartbeatToken) ||
      !UUID_PATTERN.test(input.organizationId) ||
      !UUID_PATTERN.test(input.workspaceId) ||
      !UUID_PATTERN.test(input.engineInstanceId) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1
    ) {
      throw new CloudWorkspaceEngineClientAdmissionError(
        "engine_client_admission_rejected",
        "Engine client admission was rejected",
      );
    }
    try {
      return await withSystemTx(this.pool, async (tx) => {
        // Workspace → endpoint grant → engine is the global revocation order.
        const workspace = await tx.query(
          `SELECT 1 FROM cloud_workspaces
           WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
           FOR UPDATE`,
          [input.workspaceId, input.organizationId],
        );
        if ((workspace.rowCount ?? 0) !== 1) {
          throw new CloudWorkspaceEngineClientAdmissionError(
            "engine_client_admission_rejected",
            "Engine client admission was rejected",
          );
        }
        const grant = await consumeCloudWorkspaceEngineConnectGrant(tx, {
          token: input.token,
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          generation: input.generation,
          engineInstanceId: input.engineInstanceId,
          audience: this.endpoint,
          workosEnabled: this.workosEnabled,
        });
        if (!grant) {
          throw new CloudWorkspaceEngineClientAdmissionError(
            "engine_client_admission_rejected",
            "Engine client admission was rejected",
          );
        }
        const authority = await assertCurrentCloudEngineAuthority(tx, {
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          generation: input.generation,
          engineInstanceId: input.engineInstanceId,
          heartbeatToken: input.heartbeatToken,
          workosEnabled: this.workosEnabled,
        });
        if (
          authority.authorityEpoch !== grant.authorityEpoch ||
          authority.engineInstanceId !== grant.engineInstanceId ||
          authority.accountUserId !== grant.accountUserId
        ) {
          throw new CloudWorkspaceEngineClientAdmissionError(
            "engine_client_admission_rejected",
            "Engine client admission was rejected",
          );
        }
        return {
          version: 1,
          audience: CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_AUDIENCE,
          admitted: true,
          authorityEpoch: authority.authorityEpoch,
          accountUserId: grant.accountUserId,
        };
      });
    } catch (error) {
      if (error instanceof CloudWorkspaceEngineClientAdmissionError)
        throw error;
      throw new CloudWorkspaceEngineClientAdmissionError(
        "engine_client_admission_rejected",
        "Engine client admission was rejected",
      );
    }
  }
}
