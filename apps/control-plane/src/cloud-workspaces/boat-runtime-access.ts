import type pg from "pg";
import { withSystemTx } from "../db.js";
import type { BoatRuntimeEndpointResolver } from "./boat-runtime-endpoint.js";
import type { CloudProviderOperationStore } from "./provider-operation-store.js";
import {
  CloudProviderError,
  type CloudProviderPreviewAccess,
  type CloudProviderSshAccess,
  type CloudWorkspaceAccessProvider,
} from "./provider.js";

/** Client access terminates at the Zeros runtime. The provider's bootstrap
 * login has VM administrator authority and must never become human access. */
export class BoatRuntimeAccessProvider implements CloudWorkspaceAccessProvider {
  constructor(
    private readonly options: {
      pool: pg.Pool;
      operations: CloudProviderOperationStore;
      endpoint: BoatRuntimeEndpointResolver;
      enginePort: number;
    },
  ) {}

  async createSshAccess(): Promise<CloudProviderSshAccess> {
    throw new CloudProviderError(
      "runtime_ssh_unavailable",
      "Runtime SSH is not qualified for this image",
      false,
    );
  }

  async revokeSshAccess(resourceId: string): Promise<void> {
    const owned = await this.options.operations.get(resourceId);
    if (!owned || owned.resourceId !== resourceId)
      throw new CloudProviderError(
        "provider_identity_mismatch",
        "Runtime access ownership could not be verified",
        false,
      );
    // Each stream renews its Zeros grant within ten seconds. This transaction
    // fences renewal before a provider stop/delete can begin. Resource ids
    // alone are not a tenant boundary; the journal supplies workspace identity.
    await withSystemTx(this.options.pool, (tx) =>
      tx.query(
        `UPDATE cloud_workspace_client_access_grants
       SET state = 'revoked', revoked_at = coalesce(revoked_at, now()),
           revocation_reason = coalesce(revocation_reason, 'runtime_access_revoked'),
           revocation_lease_owner = NULL, revocation_lease_expires_at = NULL, updated_at = now()
       WHERE workspace_id = $1 AND generation = $2 AND provider_resource_id = $3
         AND kind IN ('ssh', 'tunnel') AND state IN ('issuing', 'active', 'revocation_pending')`,
        [owned.workspaceId, owned.generation, resourceId],
      ),
    );
  }

  async getEngineEndpoint(resourceId: string, port: number) {
    if (port !== this.options.enginePort)
      throw new CloudProviderError(
        "provider_access_response_invalid",
        "Runtime listener does not match the configured image",
        false,
      );
    return this.options.endpoint.bridge(resourceId);
  }

  getPreviewEndpoint(
    resourceId: string,
    port: number,
    access?: CloudProviderPreviewAccess,
  ) {
    return this.options.endpoint.preview(resourceId, port, access);
  }
}
