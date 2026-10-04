import { z } from "zod";
import type { CloudReplicaDeviceProof } from "../src/engine/cloud-replica-device";
import {
  bearer,
  boundedJson,
  CloudWorkspaceAccessClientError,
  safeBaseUrl,
} from "./cloud-workspace-access-client";

const targetSchema = z.object({
  organizationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
const requestSchema = targetSchema
  .extend({
    kind: z.enum(["ssh", "tunnel"]),
    remotePort: z.number().int().min(1024).max(65535).optional(),
    expiresInMinutes: z.number().int().min(1).max(30),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  })
  .strict();
const documentSchema = z
  .object({
    grant: z
      .object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid(),
        generation: z.number().int().safe().positive(),
        deviceId: z.string().uuid(),
        kind: z.enum(["ssh", "tunnel"]),
        remotePort: z.number().int().nullable(),
        expiresAt: z.string().datetime(),
      })
      .strict(),
    transport: z
      .object({
        version: z.literal(1),
        url: z.string().max(2048),
        capability: z.string().regex(/^zsh_[A-Za-z0-9_-]{43}$/),
        headerName: z.literal("x-zeros-runtime-service"),
        protocol: z.literal("zeros.service.v1"),
      })
      .strict(),
    ssh: z
      .object({
        username: z.literal("zeros"),
        hostKey: z.literal("stream-introduction"),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CloudRuntimeServiceRequest = z.infer<typeof requestSchema>;
export type CloudRuntimeServiceProofPayload = Omit<
  CloudRuntimeServiceRequest,
  "remotePort"
> & { remotePort: number | null };
/** Main-process-only material. Never return this document over IPC. */
export type CloudRuntimeServiceAccess = z.infer<typeof documentSchema> & {
  deviceKeyVersion: number;
};
export type CloudRuntimeServiceApi = Pick<
  CloudRuntimeServiceClient,
  "issue" | "revoke"
>;

const errors: Readonly<Record<string, string>> = {
  device_proof_rejected:
    "This device is no longer trusted. Reconnect the device before opening access.",
  forbidden: "Editing access is required for SSH and port forwarding.",
  invalid_runtime_service:
    "That cloud application port or access request is unavailable.",
  runtime_service_unavailable:
    "The cloud service is unavailable or expired. Reopen access when the workspace is ready.",
  runtime_service_limit:
    "Close an existing cloud service before opening another.",
  runtime_service_response_not_replayable:
    "Request a new cloud service connection.",
  idempotency_conflict: "Request a new cloud service connection.",
  cloud_workspace_access_unavailable:
    "Cloud access is available only while the workspace is running.",
};
function invalid(): CloudWorkspaceAccessClientError {
  return new CloudWorkspaceAccessClientError(
    0,
    "invalid_request",
    "The cloud service request is invalid.",
  );
}

/** Native admission uses the existing account/device proof authority. Legacy
 * provider access is deliberately separate; rejection never falls back to it. */
export class CloudRuntimeServiceClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly forbiddenPorts: ReadonlySet<number>;
  constructor(
    private readonly options: {
      baseUrl: string;
      sign(
        accessToken: string,
        payload: CloudRuntimeServiceProofPayload,
      ): Promise<CloudReplicaDeviceProof>;
      fetch?: typeof globalThis.fetch;
      now?: () => number;
      allowInsecureLoopback?: boolean;
      forbiddenPorts?: readonly number[];
    },
  ) {
    this.baseUrl = safeBaseUrl(
      options.baseUrl,
      options.allowInsecureLoopback === true,
    );
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    // The server additionally rejects its configured engine/service ports.
    this.forbiddenPorts = new Set([
      22222,
      39393,
      ...(options.forbiddenPorts ?? []),
    ]);
  }

  private path(target: {
    organizationId: string;
    workspaceId: string;
  }): string {
    if (!targetSchema.safeParse(target).success) throw invalid();
    return `/v1/organizations/${target.organizationId}/cloud-workspaces/${target.workspaceId}/runtime/services`;
  }

  private async request(
    accessToken: string,
    path: string,
    body?: CloudRuntimeServiceRequest,
  ): Promise<unknown> {
    const authorization = `Bearer ${bearer(accessToken)}`;
    const proof = body
      ? await this.options.sign(accessToken, {
          ...body,
          remotePort: body.remotePort ?? null,
        })
      : null;
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: body ? "POST" : "DELETE",
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization,
          accept: "application/json",
          "cache-control": "no-store",
          ...(body && proof
            ? {
                "content-type": "application/json",
                "idempotency-key": body.idempotencyKey,
                "x-zeros-device-id": proof.deviceId,
                "x-zeros-device-key-version": String(proof.keyVersion),
                "x-zeros-device-timestamp": String(proof.timestampMs),
                "x-zeros-device-nonce": proof.nonce,
                "x-zeros-device-signature": proof.signature,
              }
            : {}),
        },
        ...(body
          ? {
              body: JSON.stringify({
                kind: body.kind,
                ...(body.remotePort === undefined
                  ? {}
                  : { remotePort: body.remotePort }),
                expiresInMinutes: body.expiresInMinutes,
              }),
            }
          : {}),
      });
    } catch {
      throw new CloudWorkspaceAccessClientError(
        0,
        "control_plane_unavailable",
        "The cloud service could not reach the control plane.",
      );
    }
    if (!body && response.status === 204) {
      await response.body?.cancel();
      return null;
    }
    const result = await boundedJson(response).catch(() => null);
    if (body && response.status === 201) return { result, proof };
    const parsed = z
      .object({ error: z.object({ code: z.string() }) })
      .safeParse(result);
    const candidate = parsed.success ? parsed.data.error.code : "";
    const code = Object.hasOwn(errors, candidate)
      ? candidate
      : "request_failed";
    throw new CloudWorkspaceAccessClientError(
      response.status,
      code,
      errors[code] ?? "The cloud service request failed.",
    );
  }

  async issue(
    accessToken: string,
    input: CloudRuntimeServiceRequest,
  ): Promise<CloudRuntimeServiceAccess> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    const request = parsed.data;
    if (
      request.kind === "ssh"
        ? request.remotePort !== undefined
        : request.remotePort === undefined ||
          this.forbiddenPorts.has(request.remotePort)
    )
      throw invalid();
    const { result, proof } = (await this.request(
      accessToken,
      this.path(request),
      request,
    )) as { result: unknown; proof: CloudReplicaDeviceProof };
    const document = documentSchema.safeParse(result);
    if (document.success) {
      const { grant, transport, ssh } = document.data;
      const url = new URL(
        `${this.baseUrl}/v1/cloud-workspaces/services/${request.kind}/${grant.id}`,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const expires = Date.parse(grant.expiresAt);
      if (
        grant.workspaceId === request.workspaceId &&
        grant.kind === request.kind &&
        grant.deviceId === proof.deviceId &&
        grant.remotePort === (request.remotePort ?? null) &&
        transport.url === url.toString() &&
        expires > this.now() &&
        expires <= this.now() + request.expiresInMinutes * 60_000 + 120_000 &&
        (request.kind === "ssh" ? !!ssh : !ssh)
      ) {
        return { ...document.data, deviceKeyVersion: proof.keyVersion };
      }
    }
    // A malformed published document may still have issued authority. Retire
    // its exact ID using the authenticated account; never use response URLs.
    const identity = z
      .object({ grant: z.object({ id: z.string().uuid() }) })
      .safeParse(result);
    if (identity.success) {
      try {
        await this.revoke(accessToken, {
          ...request,
          grantId: identity.data.grant.id,
        });
      } catch {
        throw new CloudWorkspaceAccessClientError(
          503,
          "bad_response_cleanup_unverified",
          "Invalid cloud service access could not be retired.",
        );
      }
    }
    throw new CloudWorkspaceAccessClientError(
      201,
      "bad_response",
      "The control plane returned invalid cloud service access.",
    );
  }

  async revoke(
    accessToken: string,
    input: { organizationId: string; workspaceId: string; grantId: string },
  ): Promise<void> {
    if (!z.string().uuid().safeParse(input.grantId).success) throw invalid();
    await this.request(accessToken, `${this.path(input)}/${input.grantId}`);
  }
}
