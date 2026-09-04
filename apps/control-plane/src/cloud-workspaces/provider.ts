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
  /** Must revoke every provider-issued client access credential before return. */
  stop(resourceId: string): Promise<CloudProviderResource>;
  /** Must revoke every provider-issued client access credential before return. */
  archive(resourceId: string): Promise<CloudProviderResource>;
  /** Must revoke client access; success also means inspection proved absence. */
  delete(resourceId: string): Promise<void>;
  /** Only resources bearing the provider adapter's managed marker. */
  listManaged(): AsyncIterable<CloudProviderResource>;
}

export type CloudProviderSshAccess = {
  /** Provider identifier is audit metadata only; it is never a bearer. */
  providerAccessId: string;
  /** Returned once to the authorized caller and never persisted by Zeros. */
  credential: string;
  host: string;
  command: string;
  expiresAt: Date;
};

export type CloudProviderPreviewEndpoint = {
  url: string;
  headerName: "x-daytona-preview-token";
  /** Coordinator-only credential. It must never be returned to a client. */
  headerValue: string;
};

/** Optional provider surface used by the access coordinator. Keeping it
 * separate lets lifecycle-only test providers remain intentionally small. */
export interface CloudWorkspaceAccessProvider {
  createSshAccess(
    resourceId: string,
    expiresInMinutes: number,
  ): Promise<CloudProviderSshAccess>;
  /** Revoke every provider SSH token for the resource without putting a bearer in a URL. */
  revokeSshAccess(resourceId: string): Promise<void>;
  /** Standard private-preview endpoint for server-side proxying only. */
  getPreviewEndpoint(
    resourceId: string,
    port: number,
  ): Promise<CloudProviderPreviewEndpoint>;
}

export class CloudProviderError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions & { retryAfterMs?: number | undefined },
  ) {
    super(message, options);
    this.name = "CloudProviderError";
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export function assertProviderResourceIdentity(
  resource: CloudProviderResource,
  identity: CloudProviderIdentity,
): void {
  if (
    resource.workspaceId !== identity.workspaceId ||
    resource.generation !== identity.generation
  ) {
    throw new CloudProviderError(
      "provider_identity_mismatch",
      "Provider resource identity does not match the requested workspace generation",
      false,
    );
  }
}

export function assertSingleProviderResource(
  resources: readonly CloudProviderResource[],
  identity: CloudProviderIdentity,
): CloudProviderResource | null {
  if (resources.length === 0) return null;
  if (resources.length === 1) {
    const resource = resources[0]!;
    assertProviderResourceIdentity(resource, identity);
    return resource;
  }
  throw new CloudProviderError(
    "provider_identity_ambiguous",
    `Provider returned multiple resources for workspace ${identity.workspaceId} generation ${identity.generation}`,
    false,
  );
}
