import {
  CloudProviderError,
  isCloudWorkspaceProviderName,
  type CloudWorkspaceAccessProvider,
  type CloudWorkspaceCommandRunner,
  type CloudWorkspaceProvider,
  type CloudWorkspaceProviderName,
} from "./provider.js";

export type CloudWorkspaceProviderPurpose =
  | "lifecycle"
  | "ssh"
  | "preview"
  | "setup"
  | "cleanup";

export type CloudWorkspaceProviderRuntime = {
  provider: CloudWorkspaceProvider & CloudWorkspaceAccessProvider;
  commandRunner?: CloudWorkspaceCommandRunner;
};

export type CloudWorkspaceDelegatedProviderInput = {
  apiKey: string;
  apiUrl: string;
  region: string | null;
  capabilities: Readonly<Record<string, unknown>>;
  imageRef: string;
  sandboxClass?: "container" | "linux-vm";
  architecture: "linux/amd64" | "linux/arm64";
  cpuMillicores: number;
  memoryMiB: number;
  storageMiB: number;
  purpose: CloudWorkspaceProviderPurpose;
};

export type CloudWorkspaceProviderRegistration = {
  name: CloudWorkspaceProviderName;
  /** Keep historical hosted accounts registered while allocations need cleanup.
   * The managed default is deliberately not part of this registry. */
  hosted?: CloudWorkspaceProviderRuntime;
  /** Image/resource inputs belong to the accepted generation. A deployment
   * default change must not repoint queued or recovering allocations. */
  hostedForGeneration?: (
    profile: CloudWorkspaceProviderGenerationProfile,
  ) => CloudWorkspaceProviderRuntime;
  delegated?: (
    input: CloudWorkspaceDelegatedProviderInput,
  ) => CloudWorkspaceProviderRuntime;
};

export type CloudWorkspaceProviderGenerationProfile = Pick<
  CloudWorkspaceDelegatedProviderInput,
  "imageRef" | "architecture" | "cpuMillicores" | "memoryMiB" | "storageMiB" | "sandboxClass"
>;

function unavailable(): CloudProviderError {
  return new CloudProviderError(
    "provider_connection_unavailable",
    "The exact cloud provider account is not configured",
    false,
  );
}

/** Dispatch only after connection/version/tenant authorization. Never fall back
 * from a missing customer account to the deployment's managed credentials. */
export class CloudWorkspaceProviderRegistry {
  private readonly registrations = new Map<
    CloudWorkspaceProviderName,
    CloudWorkspaceProviderRegistration
  >();

  constructor(registrations: readonly CloudWorkspaceProviderRegistration[]) {
    for (const registration of registrations) {
      if (
        !isCloudWorkspaceProviderName(registration.name) ||
        this.registrations.has(registration.name) ||
        (!registration.hosted && !registration.delegated)
      ) {
        throw new Error("Cloud provider registration is invalid or duplicated");
      }
      if (registration.hosted) {
        this.validateRuntime(registration.name, registration.hosted, "cleanup");
      }
      this.registrations.set(registration.name, {
        ...registration,
        ...(registration.hosted ? { hosted: { ...registration.hosted } } : {}),
      });
    }
  }

  names(): CloudWorkspaceProviderName[] {
    return [...this.registrations.keys()];
  }

  supports(name: unknown): name is CloudWorkspaceProviderName {
    return isCloudWorkspaceProviderName(name) && this.registrations.has(name);
  }

  hosted(
    name: CloudWorkspaceProviderName,
    purpose: CloudWorkspaceProviderPurpose,
    profile?: CloudWorkspaceProviderGenerationProfile,
  ): CloudWorkspaceProviderRuntime {
    const registration = this.registrations.get(name);
    const runtime = registration?.hosted;
    if (!runtime) throw unavailable();
    return this.validateRuntime(
      name,
      profile && registration.hostedForGeneration
        ? registration.hostedForGeneration(profile)
        : runtime,
      purpose,
    );
  }

  delegated(
    name: CloudWorkspaceProviderName,
    input: CloudWorkspaceDelegatedProviderInput,
  ): CloudWorkspaceProviderRuntime {
    const factory = this.registrations.get(name)?.delegated;
    if (!factory) throw unavailable();
    return this.validateRuntime(name, factory(input), input.purpose);
  }

  hostedScopes(): CloudWorkspaceProviderRuntime[] {
    return [...this.registrations.values()].flatMap((registration) =>
      registration.hosted ? [{ ...registration.hosted }] : [],
    );
  }

  private validateRuntime(
    name: CloudWorkspaceProviderName,
    runtime: CloudWorkspaceProviderRuntime,
    purpose: CloudWorkspaceProviderPurpose,
  ): CloudWorkspaceProviderRuntime {
    if (runtime.provider.name !== name) {
      throw new CloudProviderError(
        "provider_identity_mismatch",
        "Cloud provider registration returned a different provider",
        false,
      );
    }
    if (purpose === "setup" && !runtime.commandRunner) {
      throw new CloudProviderError(
        "provider_command_not_configured",
        "Cloud provider command execution is unavailable",
        false,
      );
    }
    return {
      provider: runtime.provider,
      ...(purpose === "setup" && runtime.commandRunner
        ? { commandRunner: runtime.commandRunner }
        : {}),
    };
  }
}
