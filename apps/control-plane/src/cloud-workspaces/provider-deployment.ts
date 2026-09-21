import type pg from "pg";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { BoatApiClient } from "./boat-client.js";
import { BoatWorkspaceProvider } from "./boat-provider.js";
import { BoatRuntimeAccessProvider } from "./boat-runtime-access.js";
import { BoatRuntimeEndpointResolver } from "./boat-runtime-endpoint.js";
import { BoatSetupCommandRunner } from "./boat-setup-runner.js";
import { DaytonaSandboxCommandRunner } from "./daytona-command-runner.js";
import { DaytonaWorkspaceProvider } from "./daytona-provider.js";
import { DatabaseCloudProviderOperationStore } from "./provider-operation-store.js";
import {
  CloudWorkspaceProviderRegistry,
  type CloudWorkspaceProviderRegistration,
} from "./provider-registry.js";
import { createDaytonaProviderRegistration } from "./provider-resolver.js";
import { cloudWorkspaceProvisioningProfile } from "./provisioning-profile.js";
import { CloudProviderError } from "./provider.js";

/** One composition boundary for production and headless qualification. Provider
 * selection never changes a generation's saved image, account, or credential. */
export function createCloudProviderDeployment(
  pool: pg.Pool,
  cloud: CloudWorkspaceBackendConfig,
) {
  const registrations: CloudWorkspaceProviderRegistration[] = [];
  const daytonaPolicy = {
    operationTimeoutSeconds: cloud.operationTimeoutSeconds,
    autoStopMinutes: 0,
    autoArchiveMinutes: cloud.autoArchiveMinutes,
    autoDeleteMinutes: -1,
    allowedSshHosts: cloud.access.allowedSshHosts,
    allowedPreviewHostSuffixes: cloud.access.allowedPreviewHostSuffixes,
  } as const;
  const daytonaRunner = cloud.setupExecution
    ? (connection: { apiKey: string; apiUrl: string }) =>
        new DaytonaSandboxCommandRunner({
          ...connection,
          allowedToolboxOrigins: cloud.setupExecution!.allowedToolboxOrigins,
          lookupTimeoutMs: 15000,
          maxCommandTimeoutSeconds: cloud.setupExecution!.timeoutSeconds,
          maxOutputBytes: 256 * 1024,
        })
    : undefined;
  if (cloud.provider === "daytona") {
    const profile = cloudWorkspaceProvisioningProfile(cloud, "daytona");
    const hostedConfig = {
      ...daytonaPolicy,
      ...profile,
      apiKey: cloud.apiKey,
      apiUrl: cloud.apiUrl,
      target: cloud.target,
      snapshotId: profile.imageRef,
    };
    registrations.push(
      createDaytonaProviderRegistration({
        hostedConfig,
        hostedProvider: new DaytonaWorkspaceProvider(hostedConfig),
        ...(daytonaRunner
          ? {
              hostedCommandRunner: daytonaRunner(hostedConfig),
              commandRunnerFactory: daytonaRunner,
            }
          : {}),
      }),
    );
  } else if (cloud.providerProfiles?.daytona) {
    registrations.push(
      createDaytonaProviderRegistration({
        runtimePolicy: daytonaPolicy,
        ...(daytonaRunner ? { commandRunnerFactory: daytonaRunner } : {}),
      }),
    );
  }
  if (cloud.provider === "boat") {
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
  }
  const registry = new CloudWorkspaceProviderRegistry(registrations);
  return {
    registry,
    provider: registry.hosted(cloud.provider, "lifecycle").provider,
  };
}
