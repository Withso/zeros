import type { BoatApiClient } from "./boat-client.js";
import type { CloudProviderOperationStore } from "./provider-operation-store.js";
import {
  CloudProviderError,
  type CloudProviderPreviewAccess,
  type CloudProviderPreviewEndpoint,
} from "./provider.js";

function invalid(): CloudProviderError {
  return new CloudProviderError(
    "provider_access_response_invalid",
    "Boat runtime endpoint could not be verified",
    false,
  );
}

/** Boat supplies TLS routing to ONE Zeros-authenticated runtime listener.
 * Application listeners are never exposed by the provider. Private preview
 * credentials remain Zeros grants and are revalidated by the runtime, including
 * requests that reach the public provider hostname or raw VM address directly. */
export class BoatRuntimeEndpointResolver {
  constructor(
    private readonly options: {
      client: BoatApiClient;
      operations: CloudProviderOperationStore;
      enginePort: number;
    },
  ) {
    if (
      !Number.isSafeInteger(options.enginePort) ||
      options.enginePort < 1024 ||
      options.enginePort > 65535 ||
      options.enginePort === 22222
    )
      throw invalid();
  }

  async bridge(resourceId: string): Promise<{ url: string }> {
    if (!/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(resourceId))
      throw invalid();
    const owned = await this.options.operations.get(resourceId);
    if (
      !owned ||
      owned.resourceId !== resourceId ||
      owned.deletedAt ||
      owned.deletionRequestedAt
    )
      throw invalid();
    const info = await this.options.client.request(`/sandboxes/${resourceId}`);
    const sandbox = info.sandbox as Record<string, unknown> | undefined;
    if (
      !sandbox ||
      sandbox.id !== resourceId ||
      !["ready", "running", "idle"].includes(String(sandbox.state)) ||
      typeof sandbox.subdomain !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,51}[a-z0-9])?$/.test(sandbox.subdomain)
    )
      throw invalid();
    const port = this.options.enginePort;
    const route = await this.options.client.request(
      `/sandboxes/${resourceId}/host`,
      {
        method: "POST",
        body: { port, public: true },
      },
    );
    let url: URL;
    try {
      url = new URL(String(route.url));
    } catch {
      throw invalid();
    }
    if (
      route.success !== true ||
      route.port !== port ||
      route.isProtected !== false ||
      route.access !== "public" ||
      url.protocol !== "https:" ||
      url.hostname !== `${sandbox.subdomain}-${port}.on.boat.dev` ||
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw invalid();
    return { url: url.origin + "/" };
  }

  async preview(
    resourceId: string,
    port: number,
    access?: CloudProviderPreviewAccess,
  ): Promise<CloudProviderPreviewEndpoint> {
    if (
      !Number.isSafeInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      port === 22222 ||
      port === this.options.enginePort ||
      !access ||
      !/^zwp_[A-Za-z0-9_-]{43}$/.test(access.credential)
    )
      throw invalid();
    const endpoint = await this.bridge(resourceId);
    return {
      ...endpoint,
      headerName: "x-zeros-runtime-access",
      headerValue: access.credential,
    };
  }
}
