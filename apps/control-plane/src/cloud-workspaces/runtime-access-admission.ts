import { createHash } from "node:crypto";
import type pg from "pg";
import { withSystemTx } from "../db.js";
import {authorizeCloudWorkspaceActor} from "./actors.js";
import {HttpError} from "../authz.js";
import {
  assertCurrentCloudEngineAuthority,
  CloudWorkspaceEngineAuthorityError,
} from "./engine-authority.js";

export const CLOUD_RUNTIME_ACCESS_ADMISSION_PATH =
  "/internal/v1/cloud-workspaces/engine/access-admission";
export const CLOUD_RUNTIME_ACCESS_ADMISSION_AUDIENCE =
  "zeros-cloud-runtime-access-admission-v1";
const TOKEN = /^(?:zwp|zsh)_[A-Za-z0-9_-]{43}$/;

export class CloudRuntimeAccessAdmissionError extends Error {
  readonly code = "runtime_access_rejected";
  constructor() {
    super("Runtime access is unavailable or expired");
    this.name = "CloudRuntimeAccessAdmissionError";
  }
}
export type CloudRuntimeAccessAdmissionInput = {
  workspaceId: string;
  organizationId: string;
  generation: number;
  engineInstanceId: string;
  heartbeatToken: string;
  token: string;
  relativeLease?: boolean;
};
export type CloudRuntimeAccessAdmission = {
  version: 1;
  audience: typeof CLOUD_RUNTIME_ACCESS_ADMISSION_AUDIENCE;
  admitted: true;
  grantId: string;
  accountUserId: string;
  authorityEpoch: number;
  kind: "preview" | "ssh" | "tunnel";
  remotePort: number | null;
  expiresAtMs: number;
  leaseDurationMs?: number;
};

/** The runtime verifies its own current engine lease AND the caller's existing
 * revocable Zeros access grant. No provider key or new reusable service secret
 * enters the VM. Preview requests revalidate each time; long-lived consumers
 * must revalidate within the returned short lease and close on any failure. */
export class DatabaseCloudRuntimeAccessAdmissionService {
  constructor(
    private readonly options: { pool: pg.Pool; workosEnabled: boolean },
  ) {}

  async admit(
    input: CloudRuntimeAccessAdmissionInput,
  ): Promise<CloudRuntimeAccessAdmission> {
    if (!TOKEN.test(input.token)) throw new CloudRuntimeAccessAdmissionError();
    try {
      return await withSystemTx(this.options.pool, async (tx) => {
        const authority = await assertCurrentCloudEngineAuthority(tx, {
          ...input,
          workosEnabled: this.options.workosEnabled,
        });
        type AccessRow = {
          id: string;
          account_user_id: string;
          kind: "preview" | "ssh" | "tunnel";
          remote_port: number | null;
          expires_at: Date;
          actor_fingerprint:string|null;
        };
        const result = input.token.startsWith("zsh_") ? await tx.query<AccessRow>(
          `SELECT access.id, access.account_user_id, access.kind, access.remote_port, access.expires_at,access.actor_fingerprint
           FROM cloud_workspace_runtime_service_grants access
           JOIN devices device ON device.id = access.device_id AND device.user_id = access.account_user_id
             AND device.key_version = access.device_key_version AND device.trust_state = 'trusted' AND device.revoked_at IS NULL
           JOIN cloud_workspace_provider_bindings binding
             ON binding.workspace_id = access.workspace_id AND binding.org_id = access.org_id AND binding.generation = access.generation
             AND binding.provider_resource_id = access.provider_resource_id AND binding.observed_state = 'running'
           WHERE access.workspace_id = $1 AND access.org_id = $2 AND access.generation = $3
             AND access.token_hash = $4 AND access.engine_instance_id = $5
             AND access.authority_epoch = $6 AND access.revoked_at IS NULL AND access.expires_at > now()`,
          [input.workspaceId, input.organizationId, input.generation,
            createHash("sha256").update(input.token).digest(), input.engineInstanceId, authority.authorityEpoch],
        ) : await tx.query<AccessRow>(
          `SELECT access.id, access.account_user_id, access.kind, access.remote_port, access.expires_at,access.actor_fingerprint
          FROM cloud_workspace_client_access_grants access
          JOIN cloud_workspace_provider_bindings binding
            ON binding.workspace_id = access.workspace_id AND binding.org_id = access.org_id
           AND binding.generation = access.generation AND binding.provider_resource_id = access.provider_resource_id
           AND binding.observed_state = 'running'
          JOIN cloud_workspace_generations generation
            ON generation.workspace_id = access.workspace_id AND generation.org_id = access.org_id
           AND generation.generation = access.generation AND generation.retired_at IS NULL
          JOIN provider_connections connection
            ON connection.id = generation.provider_connection_id AND connection.org_id = access.org_id
           AND connection.state = 'active'
          WHERE access.workspace_id = $1 AND access.org_id = $2 AND access.generation = $3
            AND access.token_hash = $4
            AND access.state = 'active' AND access.expires_at > now()
            AND (access.kind <> 'tunnel' OR EXISTS (
              SELECT 1 FROM port_forward_sessions session JOIN devices device
                ON device.id = session.device_id AND device.user_id = session.user_id
               AND device.trust_state = 'trusted' AND device.revoked_at IS NULL
              WHERE session.access_grant_id = access.id AND session.workspace_id = access.workspace_id
                AND session.org_id = access.org_id AND session.generation = access.generation
                AND session.user_id = access.account_user_id AND session.remote_port = access.remote_port
                AND session.state IN ('starting', 'active') AND session.expires_at > now()
            ))`,
          [
            input.workspaceId,
            input.organizationId,
            input.generation,
            createHash("sha256").update(input.token).digest(),
          ],
        );
        const grant = result.rows[0];
        if (
          !grant ||
          (grant.kind === "preview") !== input.token.startsWith("zwp_")
        )
          throw new CloudRuntimeAccessAdmissionError();
        const actor=await authorizeCloudWorkspaceActor(tx,{...input,actorUserId:grant.account_user_id,capability:"edit"});
        if(!grant.actor_fingerprint||actor.fingerprint!==grant.actor_fingerprint)throw new CloudRuntimeAccessAdmissionError();
        const protocol=await tx.query(`SELECT 1 FROM cloud_workspaces workspace JOIN cloud_workspace_engine_instances engine ON engine.id=$2
          WHERE workspace.id=$1 AND (workspace.single_member_mode OR engine.actor_protocol_version=2)`,[input.workspaceId,input.engineInstanceId]);
        if(!protocol.rowCount)throw new CloudRuntimeAccessAdmissionError();
        const leaseDurationMs = Math.min(10_000, grant.expires_at.getTime() - Date.now());
        if (leaseDurationMs <= 0) throw new CloudRuntimeAccessAdmissionError();
        return {
          version: 1,
          audience: CLOUD_RUNTIME_ACCESS_ADMISSION_AUDIENCE,
          admitted: true,
          grantId: grant.id,
          accountUserId: grant.account_user_id,
          authorityEpoch: authority.authorityEpoch,
          kind: grant.kind,
          remotePort: grant.remote_port,
          expiresAtMs: Math.min(
            grant.expires_at.getTime(),
            Date.now() + 10_000,
          ),
          ...(input.relativeLease ? { leaseDurationMs } : {}),
        };
      });
    } catch (error) {
      if (error instanceof CloudWorkspaceEngineAuthorityError || error instanceof HttpError)
        throw new CloudRuntimeAccessAdmissionError();
      throw error;
    }
  }
}
