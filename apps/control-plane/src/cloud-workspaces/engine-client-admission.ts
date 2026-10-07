import type pg from "pg";
import type {AuthedUser} from "../auth.js";
import { CLOUD_ACTOR_TOKEN_PATTERN, DatabaseCloudWorkspaceActorSessionService } from "./actor-sessions.js";
import { normalizeCloudWorkspaceGrantAudience } from "./grants.js";
import type { CloudWorkspaceDeviceProof } from "./replicas.js";

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
  /** A Read-only actor. The relay counts these apart from writers, so
   * unlimited Read-only guests cannot take a workspace's writer capacity. A
   * role change revokes the actor's session, so it is stable for the life of
   * a relay connection. */
  readOnly: boolean;
};

export class CloudWorkspaceEngineClientAdmissionError extends Error {
  constructor(
    public readonly code:
      | "engine_client_admission_invalid"
      | "engine_client_admission_ineligible"
      | "engine_client_admission_rejected"
      | "cloud_workspace_client_update_required",
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
  /** Historical response shape, retained by the refusal-only endpoint. */
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

/** Actor protocol 2 is the sole executable desktop admission. Historical v1
 * endpoints remain explicit update refusals and never mint or redeem grants. */
export class DatabaseCloudWorkspaceEngineClientAdmissionService {
  private readonly actors: DatabaseCloudWorkspaceActorSessionService | null;

  constructor(options: DatabaseCloudWorkspaceEngineClientAdmissionServiceOptions) {
    const endpoint = normalizeCloudWorkspaceGrantAudience(options.endpoint);
    if (new URL(endpoint).pathname !== CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH)
      throw new Error("engine client admission endpoint is invalid");
    const ttlSeconds = options.ttlSeconds ?? 120;
    if (!Number.isSafeInteger(options.enginePort) || options.enginePort < 1 || options.enginePort > 65535 ||
      options.enginePort === 22222 || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 15 || ttlSeconds > 900)
      throw new Error("engine client admission configuration is invalid");
    const bridgeUrl = options.relayEnabled
      ? new URL(CLOUD_RUNTIME_BRIDGE_PATH, endpoint).toString().replace(/^https:/, "wss:")
      : null;
    this.actors = bridgeUrl ? new DatabaseCloudWorkspaceActorSessionService({
      pool: options.pool, enginePort: options.enginePort, bridgeUrl, workosEnabled: options.workosEnabled === true,
    }) : null;
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

  async issue(_input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    proof?: CloudWorkspaceDeviceProof;
  }): Promise<CloudWorkspaceEngineClientAdmission> {
    throw new CloudWorkspaceEngineClientAdmissionError(
      "cloud_workspace_client_update_required", "Update Zeros to connect to cloud workspaces.",
    );
  }

  async authorizeRelay(token: string, options: { connected?: boolean } = {}): Promise<CloudEngineRelayGrant | null> {
    return CLOUD_ACTOR_TOKEN_PATTERN.test(token) ? this.actors?.authorizeRelay(token, options) ?? null : null;
  }

  async consume(_input: {
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
    throw new CloudWorkspaceEngineClientAdmissionError(
      "cloud_workspace_client_update_required", "Update Zeros to connect to cloud workspaces.",
    );
  }
}
