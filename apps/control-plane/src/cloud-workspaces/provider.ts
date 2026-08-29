// Provider-neutral execution lifecycle boundary.
//
// Public API and database identity use the stable Zeros workspace id. Provider
// resource ids stay behind this interface and may change on a new generation.

export type CloudProviderObservedState =
  | "provisioning"
  | "running"
  | "stopping"
  | "stopped"
  | "archiving"
  | "archived"
  | "deleting"
  | "deleted"
  | "failed"
  | "unknown";

export type CloudProviderResource = {
  resourceId: string;
  state: CloudProviderObservedState;
  target: string | null;
  workspaceId: string;
  generation: number;
  /** Non-secret, bounded operational metadata only. */
  metadata: Readonly<Record<string, string | number | boolean | null>>;
};

export type CloudProviderIdentity = {
  workspaceId: string;
  generation: number;
};

export type CloudProviderCreateInput = CloudProviderIdentity & {
  imageRef: string;
  architecture: "linux/amd64" | "linux/arm64";
  cpuMillicores: number;
  memoryMiB: number;
  storageMiB: number;
  /** Stable intent id; providers that accept a client token should use it. */
  idempotencyKey: string;
};

export interface CloudWorkspaceProvider {
  readonly name: string;

  /** Find resources by Zeros-owned immutable labels after an unknown create. */
  find(identity: CloudProviderIdentity): Promise<CloudProviderResource[]>;
  create(input: CloudProviderCreateInput): Promise<CloudProviderResource>;
  inspect(resourceId: string): Promise<CloudProviderResource | null>;
  start(resourceId: string): Promise<CloudProviderResource>;
  stop(resourceId: string): Promise<CloudProviderResource>;
  archive(resourceId: string): Promise<CloudProviderResource>;
  /** Success means a follow-up inspection proved absence. */
  delete(resourceId: string): Promise<void>;
  /** Only resources bearing the provider adapter's managed marker. */
  listManaged(): AsyncIterable<CloudProviderResource>;
}

export class CloudProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CloudProviderError";
  }
}

export function assertSingleProviderResource(
  resources: readonly CloudProviderResource[],
  identity: CloudProviderIdentity,
): CloudProviderResource | null {
  if (resources.length === 0) return null;
  if (resources.length === 1) return resources[0]!;
  throw new CloudProviderError(
    "provider_identity_ambiguous",
    `Provider returned multiple resources for workspace ${identity.workspaceId} generation ${identity.generation}`,
    false,
  );
}
