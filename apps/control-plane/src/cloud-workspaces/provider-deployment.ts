import type pg from "pg";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { BoatApiClient } from "./boat-client.js";
import { BoatWorkspaceProvider } from "./boat-provider.js";
import { resolveComputerTemplateFork } from "./computer-workspace-source.js";
import type { CloudProviderCreateInput } from "./provider.js";
import { BoatRuntimeAccessProvider } from "./boat-runtime-access.js";
import { BoatRuntimeEndpointResolver } from "./boat-runtime-endpoint.js";
import { BoatSetupCommandRunner } from "./boat-setup-runner.js";
import { DatabaseCloudProviderOperationStore } from "./provider-operation-store.js";
import {
  CloudWorkspaceProviderRegistry,
  type CloudWorkspaceProviderRegistration,
} from "./provider-registry.js";
import { cloudWorkspaceProvisioningProfile } from "./provisioning-profile.js";
import { CloudProviderError } from "./provider.js";

/** One composition boundary for production and headless qualification. Provider
 * selection never changes a generation's saved image, account, or credential. */
export function createCloudProviderDeployment(
  pool: pg.Pool,
  cloud: CloudWorkspaceBackendConfig,
) {
  const registrations: CloudWorkspaceProviderRegistration[] = [];
  if (!cloud.boat)
    throw new Error("Managed Boat runtime configuration is missing");
  const profile = cloudWorkspaceProvisioningProfile(cloud, "boat");
  const operations = new DatabaseCloudProviderOperationStore(
    pool,
    "boat",
    cloud.boat.accountScope,
  );
  const clientOptions = {
    apiKey: cloud.apiKey,
    timeoutMs: cloud.operationTimeoutSeconds * 1000,
    billingOrg: cloud.boat.billingOrg,
  };
  const client = new BoatApiClient(clientOptions);
  const enginePort = cloud.setupExecution?.enginePort ?? 39393;
  const access = new BoatRuntimeAccessProvider({
    pool,
    operations,
    enginePort,
    endpoint: new BoatRuntimeEndpointResolver({
      client,
      operations,
      enginePort,
    }),
  });
  const providerOptions = {
    ...clientOptions,
    operations,
    access,
    ttlSeconds: cloud.boat.ttlSeconds,
    resolveTemplate: (input: CloudProviderCreateInput) => resolveComputerTemplateFork(pool, cloud.boat!.accountScope, cloud.boat!.billingOrg, input),
  };
  const provider = new BoatWorkspaceProvider({
    ...providerOptions,
    imageRef: profile.imageRef,
    qualifiedStorageMiB: profile.storageMiB,
  });
  const commandRunner = cloud.setupExecution
    ? new BoatSetupCommandRunner({
        client,
        maxTimeoutSeconds: Math.min(
          1800,
          cloud.setupExecution.timeoutSeconds,
        ),
        maxOutputBytes: 256 * 1024,
        assertOwned: async (resourceId) => {
          const record = await operations.get(resourceId);
          if (
            !record ||
            record.resourceId !== resourceId ||
            record.deletionRequestedAt ||
            record.deletedAt
          )
            throw new CloudProviderError(
              "provider_identity_mismatch",
              "Boat bootstrap ownership is unavailable",
              false,
            );
        },
      })
    : undefined;
  const runner = commandRunner ? { commandRunner } : {};
  registrations.push({
    name: "boat",
    hosted: { provider, ...runner },
    hostedForGeneration: (saved) => ({
      provider:
        saved.imageRef === profile.imageRef &&
        saved.storageMiB === profile.storageMiB
          ? provider
          : new BoatWorkspaceProvider({
              ...providerOptions,
              imageRef: saved.imageRef,
              qualifiedStorageMiB: saved.storageMiB,
            }),
      ...runner,
    }),
  });
  const registry = new CloudWorkspaceProviderRegistry(registrations);
  return {
    registry,
    provider: registry.hosted(cloud.provider, "lifecycle").provider,
  };
}
