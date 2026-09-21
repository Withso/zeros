// Provider-neutral execution lifecycle boundary.
//
// Public API and database identity use the stable Zeros workspace id. Provider
// resource ids stay behind this interface and may change on a new generation.

export const CLOUD_WORKSPACE_PROVIDER_NAMES = ["daytona", "boat"] as const;
export type CloudWorkspaceProviderName =
  (typeof CLOUD_WORKSPACE_PROVIDER_NAMES)[number];

export function isCloudWorkspaceProviderName(
  value: unknown,
): value is CloudWorkspaceProviderName {
  return value === "daytona" || value === "boat";
}

/** Fixed image-owned bootstrap commands. Credentials are data in the bounded
 * environment document, never interpolated into the command. */
export interface CloudWorkspaceCommandRunner {
  execute(
    input: {
      resourceId: string;
      command: string;
      cwd?: string;
      env?: Readonly<Record<string, string>>;
      timeoutSeconds: number;
    },
    signal: AbortSignal,
  ): Promise<{
    exitCode: number;
    output: string;
    outputTruncated: boolean;
  }>;
}

export type CloudProviderObservedState =
  | "provisioning"
  | "running"
  | "stopping"
  | "stopped"
  | "paused"
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
  /** Independent provider evidence that allocated compute has ceased. Storage
   * archival may still be pending or failed; this never proves durability. */
  computeStopped?: boolean;
  /** Provider proves a cold-stopped filesystem is offloaded. It may satisfy
   * portable archive; preserved VM memory never does. Storage can still bill. */
  storageOffloaded?: boolean;
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

  /** Find resources using provider labels or durable coordinator ownership. */
  find(identity: CloudProviderIdentity): Promise<CloudProviderResource[]>;
  /** Providers with finite idempotency windows or hidden asynchronous deletes
   * must reject absence while an allocation/deletion outcome remains unknown. */
  verifyAbsence?(identity: CloudProviderIdentity): Promise<boolean>;
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
  /** Exact durable allocation receipt, independent of mutable provider labels.
   * Without this proof, unbound inventory is quarantined, never adopted or
   * deleted by the orphan sweep. Normal bound lifecycle operations are separate. */
  verifyManagedResourceOwnership?(resource: CloudProviderResource): Promise<boolean>;
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
  /** Provider-validated HTTPS origin; paths and client query strings are proxied. */
  url: string;
  headerName: `x-${string}`;
  /** Coordinator-only credential. It must never be returned to a client. */
  headerValue: string;
};

export type CloudProviderPreviewAccess = {
  /** Existing Zeros grant, already authorized by the access coordinator. */
  grantId: string;
  credential: string;
};
export type CloudProviderEngineEndpoint =
  | CloudProviderPreviewEndpoint
  | {
      url: string;
      headerName?: never;
      headerValue?: never;
    };

/** Provider adapters own the hostname allowlist. This common boundary also
 * rejects credential-bearing URLs and header/forwarding overrides before any
 * endpoint can enter the preview proxy cache. */
export function assertProviderPreviewEndpoint(
  endpoint: CloudProviderPreviewEndpoint,
): void {
  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch {
    throw new CloudProviderError(
      "provider_access_response_invalid",
      "Provider returned an invalid preview endpoint",
      false,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.port !== "" && url.port !== "443") ||
    !/^x-[a-z0-9][a-z0-9-]{0,95}$/.test(endpoint.headerName) ||
    endpoint.headerName.startsWith("x-forwarded-") ||
    ["x-real-ip", "x-zeros-preview-capability"].includes(endpoint.headerName) ||
    typeof endpoint.headerValue !== "string" ||
    !/^[\x21-\x7e]{1,4096}$/.test(endpoint.headerValue)
  ) {
    throw new CloudProviderError(
      "provider_access_response_invalid",
      "Provider returned an invalid preview endpoint",
      false,
    );
  }
}

/** Optional provider surface used by the access coordinator. Keeping it
 * separate lets lifecycle-only test providers remain intentionally small. */
export interface CloudWorkspaceAccessProvider {
  /** Provider routing for the authenticated engine bridge. Credentials, when
   * needed by an outer provider proxy, remain on the control-plane relay. */
  getEngineEndpoint?(
    resourceId: string,
    port: number,
  ): Promise<CloudProviderEngineEndpoint>;
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
    access?: CloudProviderPreviewAccess,
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

export async function assertProviderAbsence(
  provider: CloudWorkspaceProvider,
  identity: CloudProviderIdentity,
): Promise<void> {
  if (provider.verifyAbsence && !(await provider.verifyAbsence(identity))) {
    throw new CloudProviderError(
      "provider_absence_unconfirmed",
      "An allocation or deletion outcome still requires reconciliation",
      true,
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
