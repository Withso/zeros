import { ApiKeysApi, Configuration } from "@daytona/api-client";

const REQUIRED_PERMISSIONS = new Set([
  "write:sandboxes",
  "delete:sandboxes",
]);
const TARGET_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const API_KEY_PATTERN = /^[^\0\r\n]{16,65536}$/;

export class CloudProviderQualificationError extends Error {
  constructor(
    readonly code:
      | "provider_credential_invalid"
      | "provider_credential_rejected"
      | "provider_credential_permissions_insufficient"
      | "provider_credential_expiring",
    message: string,
  ) {
    super(message);
    this.name = "CloudProviderQualificationError";
  }
}

export type CloudProviderQualification = {
  capabilities: {
    qualified: true;
    qualificationVersion: 1;
    lifecycle: true;
    ssh: true;
    preview: true;
    commandExecution: true;
    daytonaTarget: string;
  };
  credentialExpiresAt: string | null;
};

export interface DaytonaProviderQualificationClient {
  currentApiKey(): Promise<{
    permissions: readonly string[];
    expiresAt: Date | string | null;
  }>;
}

type ClientFactory = (input: {
  apiKey: string;
  apiUrl: string;
  timeoutMs: number;
}) => DaytonaProviderQualificationClient;

function validApiUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.hostname.length > 0 &&
      raw.length <= 2_048
    );
  } catch {
    return false;
  }
}

function generatedClient(input: {
  apiKey: string;
  apiUrl: string;
  timeoutMs: number;
}): DaytonaProviderQualificationClient {
  const api = new ApiKeysApi(
    new Configuration({
      basePath: input.apiUrl,
      accessToken: input.apiKey,
      baseOptions: {
        headers: {
          "X-Daytona-Source": "zeros-control-plane",
          "User-Agent": "zeros-control-plane/provider-qualification-v1",
        },
      },
    }),
  );
  return {
    currentApiKey: async () => {
      const response = await api.getCurrentApiKey(undefined, {
        timeout: input.timeoutMs,
        maxRedirects: 0,
      });
      return {
        permissions: response.data.permissions,
        expiresAt: response.data.expiresAt,
      };
    },
  };
}

/** Performs a bounded, read-only authentication/scope check. It never creates a
 * sandbox and never reflects a provider response, key name, user id, or token. */
export class DaytonaProviderConnectionQualifier {
  private readonly clientFactory: ClientFactory;
  private readonly timeoutMs: number;

  constructor(
    options: { clientFactory?: ClientFactory; timeoutMs?: number } = {},
  ) {
    this.clientFactory = options.clientFactory ?? generatedClient;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > 30_000
    ) {
      throw new Error("cloud provider qualification timeout is invalid");
    }
  }

  async qualify(input: {
    apiKey: string;
    apiUrl: string;
    target: string;
  }): Promise<CloudProviderQualification> {
    if (
      !API_KEY_PATTERN.test(input.apiKey) ||
      !validApiUrl(input.apiUrl) ||
      !TARGET_PATTERN.test(input.target)
    ) {
      throw new CloudProviderQualificationError(
        "provider_credential_invalid",
        "Cloud provider credential input is invalid",
      );
    }

    let current: Awaited<
      ReturnType<DaytonaProviderQualificationClient["currentApiKey"]>
    >;
    try {
      current = await this.clientFactory({
        apiKey: input.apiKey,
        apiUrl: input.apiUrl,
        timeoutMs: this.timeoutMs,
      }).currentApiKey();
    } catch {
      throw new CloudProviderQualificationError(
        "provider_credential_rejected",
        "Cloud provider credential could not be verified",
      );
    }

    const permissions = new Set(current.permissions);
    if ([...REQUIRED_PERMISSIONS].some((value) => !permissions.has(value))) {
      throw new CloudProviderQualificationError(
        "provider_credential_permissions_insufficient",
        "Cloud provider credential needs sandbox create and delete permissions",
      );
    }
    let credentialExpiresAt: string | null = null;
    if (current.expiresAt !== null) {
      const expiresAt = new Date(current.expiresAt);
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= Date.now() + 5 * 60_000
      ) {
        throw new CloudProviderQualificationError(
          "provider_credential_expiring",
          "Cloud provider credential is expired or expires too soon",
        );
      }
      credentialExpiresAt = expiresAt.toISOString();
    }
    return {
      capabilities: {
        qualified: true,
        qualificationVersion: 1,
        lifecycle: true,
        ssh: true,
        preview: true,
        commandExecution: true,
        daytonaTarget: input.target,
      },
      credentialExpiresAt,
    };
  }
}
