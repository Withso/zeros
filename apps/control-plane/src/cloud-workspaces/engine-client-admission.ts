import type pg from "pg";
import type {AuthedUser} from "../auth.js";
import { createHash } from "node:crypto";

import { withSystemTx } from "../db.js";
import { authorizeCloudWorkspaceOperation } from "./authorization.js";
import { CLOUD_ACTOR_TOKEN_PATTERN, DatabaseCloudWorkspaceActorSessionService } from "./actor-sessions.js";
import {
  assertCurrentCloudEngineAuthority,
  CloudWorkspaceEngineAuthorityError,
} from "./engine-authority.js";
import {
  CloudWorkspaceGrantError,
  consumeCloudWorkspaceEngineConnectGrant,
  issueCloudWorkspaceGrant,
  normalizeCloudWorkspaceGrantAudience,
} from "./grants.js";
import {
  consumeCloudWorkspaceDeviceProof,
  WorkspaceReplicaError,
  type CloudWorkspaceDeviceProof,
} from "./replicas.js";

export const CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH =
  "/internal/v1/cloud-workspaces/engine/client-admission" as const;
export const CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_AUDIENCE =
  "zeros-cloud-workspace-engine-client-admission-v1" as const;
export const CLOUD_RUNTIME_BRIDGE_PATH = "/v1/cloud-workspaces/bridge";
export type CloudEngineRelayGrant = {
  workspaceId: string;
  organizationId: string;
  generation: number;
  authorityEpoch: number;
  engineInstanceId: string;
  resourceId: string;
};

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
  /** Portable WSS endpoint. Older SSH clients may ignore this additive field. */
  bridgeUrl?: string;
};

export type DatabaseCloudWorkspaceEngineClientAdmissionServiceOptions = {
  pool: pg.Pool;
  endpoint: string;
  enginePort: number;
  ttlSeconds?: number;
  workosEnabled?: boolean;
  relayEnabled?: boolean;
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
  private readonly bridgeUrl: string | null;
  private readonly actors: DatabaseCloudWorkspaceActorSessionService | null;

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
    this.bridgeUrl = options.relayEnabled
      ? new URL(CLOUD_RUNTIME_BRIDGE_PATH, this.endpoint)
          .toString()
          .replace(/^https:/, "wss:")
      : null;
    this.actors = this.bridgeUrl ? new DatabaseCloudWorkspaceActorSessionService({
      pool:this.pool,enginePort:this.enginePort,bridgeUrl:this.bridgeUrl,workosEnabled:this.workosEnabled,
    }) : null;
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

  async issueActor(input:{organizationId:string;workspaceId:string;actorUserId:string;proof?:CloudWorkspaceDeviceProof;authenticatedUser:AuthedUser}) {
    if (!this.actors || !input.proof) throw new CloudWorkspaceEngineClientAdmissionError("engine_client_admission_invalid","A trusted device is required for actor admission");
    return this.actors.issue({...input,proof:input.proof});
  }

  async consumeActor(input:Parameters<DatabaseCloudWorkspaceActorSessionService["consume"]>[0]) {
    if (!this.actors) throw new CloudWorkspaceEngineClientAdmissionError("engine_client_admission_rejected","Actor admission is unavailable");
    return this.actors.consume(input);
  }

  async revokeActor(input:Parameters<DatabaseCloudWorkspaceActorSessionService["revoke"]>[0]) {
    if (!this.actors) throw new CloudWorkspaceEngineClientAdmissionError("engine_client_admission_rejected","Actor admission is unavailable");
    await this.actors.revoke(input);
  }

  async issue(input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    proof?: CloudWorkspaceDeviceProof;
  }): Promise<CloudWorkspaceEngineClientAdmission> {
    if (
      !UUID_PATTERN.test(input.organizationId) ||
      !UUID_PATTERN.test(input.workspaceId) ||
      !UUID_PATTERN.test(input.actorUserId) ||
      (this.bridgeUrl !== null && !input.proof)
    ) {
      throw new CloudWorkspaceEngineClientAdmissionError(
        "engine_client_admission_invalid",
        "Engine client admission input is invalid",
      );
    }
    try {
      return await withSystemTx(this.pool, async (tx) => {
        // Match lifecycle/access ordering: organization, workspace, then
        // device/grant. Holding workspace while waiting for its organization
        // deadlocks a concurrent renewal that already holds the organization.
        await tx.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [input.organizationId]);
        const workspace = await tx.query<{
          team_id: string;
          owner_user_id: string;
          current_generation: number;
          authority_epoch: string | number;
          desired_state: string;
          status: string;
          single_member_mode: boolean;
          sharing_mode: string;
        }>(
          `SELECT team_id, owner_user_id, current_generation, authority_epoch,
                  desired_state, status, single_member_mode, sharing_mode
           FROM cloud_workspaces
           WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
           FOR UPDATE`,
          [input.workspaceId, input.organizationId],
        );
        const current = workspace.rows[0];
        if (
          !current ||
          !current.single_member_mode || current.sharing_mode !== "private" ||
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
        const device = input.proof
          ? await consumeCloudWorkspaceDeviceProof(tx, {
              accountUserId: input.actorUserId,
              action: "engine.connect",
              payload: {
                organizationId: input.organizationId,
                workspaceId: input.workspaceId,
              },
              proof: input.proof,
            })
          : null;
        const engine = await tx.query<{ id: string }>(
          `SELECT id
           FROM cloud_workspace_engine_instances
           WHERE workspace_id = $1 AND org_id = $2 AND generation = $3
             AND state = 'ready' AND revoked_at IS NULL
             AND actor_protocol_version = 1
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
          ...(device
            ? {
                device: {
                  id: device.id,
                  keyVersion: Number(device.key_version),
                },
              }
            : {}),
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
          ...(this.bridgeUrl ? { bridgeUrl: this.bridgeUrl } : {}),
        };
      });
    } catch (error) {
      if (error instanceof CloudWorkspaceEngineClientAdmissionError)
        throw error;
      if (error instanceof WorkspaceReplicaError) {
        throw new CloudWorkspaceEngineClientAdmissionError(
          "engine_client_admission_rejected",
          "Device admission was rejected",
        );
      }
      if (
        error instanceof CloudWorkspaceGrantError ||
        error instanceof CloudWorkspaceEngineAuthorityError
      ) {
        throw new CloudWorkspaceEngineClientAdmissionError(
          "engine_client_admission_ineligible",
          "Cloud engine connection capability could not be issued",
        );
      }
      throw error;
    }
  }

  /** Lookup does not consume admission: the exact engine still redeems the
   * one-use proof. Connected relays recheck current authority independently of
   * the original admission deadline; revoked grants never renew a stream. */
  async authorizeRelay(
    token: string,
    options: { connected?: boolean } = {},
  ): Promise<CloudEngineRelayGrant | null> {
    if (CLOUD_ACTOR_TOKEN_PATTERN.test(token)) return this.actors?.authorizeRelay(token,options) ?? null;
    if (!GRANT_TOKEN_PATTERN.test(token)) return null;
    return withSystemTx(this.pool, async (tx) => {
      const result = await tx.query<{
        workspace_id: string;
        org_id: string;
        generation: number;
        authority_epoch: string | number;
        engine_instance_id: string;
        provider_resource_id: string;
      }>(
        `SELECT capability.workspace_id, capability.org_id, capability.generation, capability.authority_epoch,
           capability.engine_instance_id, binding.provider_resource_id
         FROM cloud_workspace_endpoint_grants capability
         JOIN cloud_workspaces workspace ON workspace.id = capability.workspace_id AND workspace.org_id = capability.org_id
           AND workspace.current_generation = capability.generation AND workspace.authority_epoch = capability.authority_epoch
         JOIN cloud_workspace_engine_instances engine ON engine.id = capability.engine_instance_id
           AND engine.workspace_id = capability.workspace_id AND engine.org_id = capability.org_id AND engine.generation = capability.generation
           AND engine.account_user_id = capability.account_user_id AND engine.state = 'ready'
           AND engine.revoked_at IS NULL AND engine.lease_expires_at > now() AND engine.actor_protocol_version = 1
         JOIN users account ON account.id = capability.account_user_id AND account.deleted_at IS NULL
           AND account.auth_status = 'active' AND account.auth_revision = capability.account_revision
         JOIN organization_members member ON member.org_id = capability.org_id AND member.user_id = capability.account_user_id
           AND member.authorization_revision = capability.authorization_revision
         JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id = capability.workspace_id
           AND binding.org_id = capability.org_id AND binding.generation = capability.generation AND binding.observed_state = 'running'
         JOIN cloud_workspace_generations generation ON generation.workspace_id = capability.workspace_id
           AND generation.org_id = capability.org_id AND generation.generation = capability.generation AND generation.retired_at IS NULL
         JOIN provider_connections connection ON connection.id = generation.provider_connection_id
           AND connection.org_id = capability.org_id AND connection.state = 'active'
         WHERE capability.token_hash = $1 AND capability.purpose = 'engine-connect' AND capability.audience = $2
           AND ((NOT $5::boolean AND capability.device_id IS NULL) OR EXISTS (
             SELECT 1 FROM devices device WHERE device.id = capability.device_id
               AND device.user_id = capability.account_user_id AND device.key_version = capability.device_key_version
               AND device.trust_state = 'trusted' AND device.revoked_at IS NULL
           ))
           AND capability.revoked_at IS NULL AND capability.setup_run_id IS NULL AND capability.setup_execution_fence IS NULL
           AND (($3 AND capability.consumed_at IS NOT NULL) OR (NOT $3 AND capability.consumed_at IS NULL AND capability.expires_at > now()))
           AND workspace.deleted_at IS NULL AND workspace.desired_state = 'running'
           AND workspace.status IN ('ready', 'busy') AND workspace.single_member_mode AND workspace.sharing_mode = 'private'
           AND workspace.owner_user_id = capability.account_user_id
           AND cloud_workspace_generation_policy_current(workspace.id, capability.generation, capability.org_id)
           AND cloud_workspace_runtime_authority_live(workspace.id, capability.generation, capability.account_user_id, $4)`,
        [
          createHash("sha256").update(token).digest(),
          this.endpoint,
          options.connected === true,
          this.workosEnabled,
          this.bridgeUrl !== null,
        ],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row) return null;
      const authorityEpoch = Number(row.authority_epoch);
      if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch < 1)
        return null;
      return {
        workspaceId: row.workspace_id,
        organizationId: row.org_id,
        generation: row.generation,
        authorityEpoch,
        engineInstanceId: row.engine_instance_id,
        resourceId: row.provider_resource_id,
      };
    });
  }

  async consume(input: {
    token: string;
    heartbeatToken: string;
    organizationId: string;
    workspaceId: string;
    generation: number;
    engineInstanceId: string;
    renew?: boolean;
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
        // Organization → workspace → endpoint grant → engine.
        await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [input.organizationId]);
        const workspace = await tx.query(
          `SELECT 1 FROM cloud_workspaces
           WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL AND single_member_mode AND sharing_mode = 'private'
             AND EXISTS (SELECT 1 FROM cloud_workspace_engine_instances WHERE id=$3 AND actor_protocol_version=1)
           FOR UPDATE`,
          [input.workspaceId, input.organizationId, input.engineInstanceId],
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
          renew: input.renew === true,
          requireDevice: this.bridgeUrl !== null,
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
      if (
        error instanceof CloudWorkspaceGrantError ||
        error instanceof CloudWorkspaceEngineAuthorityError
      ) {
        throw new CloudWorkspaceEngineClientAdmissionError(
          "engine_client_admission_rejected",
          "Engine client admission was rejected",
        );
      }
      throw error;
    }
  }
}
