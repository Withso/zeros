import { HttpError } from "../authz.js";
import type {
  CloudWorkspaceBackendConfig,
  CloudWorkspaceProvisioningProfile,
} from "../config.js";
import {
  CLOUD_WORKSPACE_PROVIDER_NAMES,
  isCloudWorkspaceProviderName,
  type CloudWorkspaceProviderName,
} from "./provider.js";

export function configuredCloudWorkspaceProviders(
  config: CloudWorkspaceBackendConfig,
): CloudWorkspaceProviderName[] {
  return CLOUD_WORKSPACE_PROVIDER_NAMES.filter(
    (name) =>
      name === config.provider || config.providerProfiles?.[name] !== undefined,
  );
}

/** Select the qualified image/resources of the requested provider. In
 * particular, a managed-default change cannot repoint a BYO connection. */
export function cloudWorkspaceProvisioningProfile(
  config: CloudWorkspaceBackendConfig,
  provider: unknown,
): CloudWorkspaceProvisioningProfile {
  const candidate = isCloudWorkspaceProviderName(provider)
    ? (config.providerProfiles?.[provider] ??
      (config.provider === provider ? config : null))
    : null;
  if (
    !candidate ||
    candidate.provider !== provider ||
    (candidate.sandboxClass!==undefined&&(provider!=="daytona"||!["container","linux-vm"].includes(candidate.sandboxClass))) ||
    typeof candidate.imageRef !== "string" ||
    candidate.imageRef.length === 0 ||
    candidate.imageRef.length > 1024 ||
    /[\x00-\x1f\x7f]/.test(candidate.imageRef) ||
    !["linux/amd64", "linux/arm64"].includes(candidate.architecture) ||
    ![candidate.cpuMillicores, candidate.memoryMiB, candidate.storageMiB].every(
      (value) =>
        Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647,
    ) ||
    (candidate.sourceCommit !== null &&
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidate.sourceCommit))
  ) {
    throw new HttpError(
      503,
      "cloud_provider_not_configured",
      "The selected cloud provider has no valid provisioning profile",
    );
  }
  return {
    provider: candidate.provider,
    ...(candidate.sandboxClass?{sandboxClass:candidate.sandboxClass}:{}),
    imageRef: candidate.imageRef,
    architecture: candidate.architecture,
    cpuMillicores: candidate.cpuMillicores,
    memoryMiB: candidate.memoryMiB,
    storageMiB: candidate.storageMiB,
    sourceCommit: candidate.sourceCommit,
  };
}
