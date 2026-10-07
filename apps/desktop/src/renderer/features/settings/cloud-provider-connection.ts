import { z } from "zod";
import { cloudAccountRequest } from "../../platform/cloud-workspaces";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { clearReleaseCanaryDesignations } from "./release-canary-designation";

const credential = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  displayName: z.string(),
  revision: z.number().int().positive(),
  revoked: z.boolean(),
  connectionMethod: z.enum(["api", "account"]).optional(),
});
export type CloudProviderCredential = z.infer<typeof credential>;
type CloudProviderAccess = {
  compute: { fingerprint: string; trust: "zeros-managed" | "compute-administrator" };
  delegations: { id: string; kind: string; ownerUserId: string; models: string[]; allModels?: boolean; expiresAt: string }[];
};
export const cloudProviderCredentialsCache = new KeyedAsyncCache<
  CloudProviderCredential[]
>(16);
export const cloudProviderAccessCache = new KeyedAsyncCache<
  CloudProviderAccess
>(32);
const organizationConnections = z.object({
  credentials: z.array(credential).max(100),
  connections: z
    .array(
      z.object({
        provider: z.enum(["claude", "codex", "cursor"]),
        revision: z.number().int().positive(),
        credentialId: z.string().uuid().nullable(),
        models: z.array(z.string()).max(32),
        allModels: z.boolean().optional(),
        connected: z.boolean(),
      }),
    )
    .max(3),
});
export const cloudOrganizationConnectionsCache = new KeyedAsyncCache<
  z.infer<typeof organizationConnections>
>(32);
export function clearCloudProviderConnections(): void {
  clearReleaseCanaryDesignations();
  for (const key of cloudProviderCredentialsCache.keys())
    cloudProviderCredentialsCache.forget(key);
  for (const key of cloudProviderAccessCache.keys())
    cloudProviderAccessCache.forget(key);
  for (const key of cloudOrganizationConnectionsCache.keys())
    cloudOrganizationConnectionsCache.forget(key);
}
export function saveCloudProviderCredential(input: {
  id: string;
  operationId: string;
  displayName: string;
  agentId: string;
  token: string;
  setupToken: boolean;
  organizationId?: string;
}) {
  if (
    !["claude", "codex", "cursor"].includes(input.agentId) ||
    (input.setupToken && input.agentId !== "claude")
  )
    throw new Error("Unsupported cloud credential type");
  const material = input.setupToken
    ? { kind: "claude-setup-token", accessToken: input.token }
    : { kind: `${input.agentId}-api-key`, apiKey: input.token };
  return cloudAccountRequest(
    `/v1/cloud-agent-credentials/${z.string().uuid().parse(input.id)}`,
    z.object({ credential }),
    {
      method: "PUT",
      idempotencyKey: input.operationId,
      body: {
        operationId: input.operationId,
        expectedRevision: 0,
        displayName: input.displayName,
        material,
        ...(input.organizationId
          ? { organizationId: z.string().uuid().parse(input.organizationId) }
          : {}),
      },
    },
  );
}

const organizationPath = (organizationId: string) =>
  `/v1/organizations/${z.string().uuid().parse(organizationId)}/agent-connections`;
export const readCloudOrganizationConnections = (organizationId: string) =>
  cloudAccountRequest(
    organizationPath(organizationId),
    organizationConnections,
  );
export function selectCloudOrganizationCredential(
  organizationId: string,
  provider: string,
  input: {
    expectedRevision: number;
    credentialId: string | null;
    credentialRevision?: number;
    models?: string[];
    allModels?: boolean;
    consent?: "zeros-managed";
  },
) {
  return cloudAccountRequest(
    `${organizationPath(organizationId)}/${z.enum(["claude", "codex", "cursor"]).parse(provider)}`,
    z.object({ revision: z.number().int().positive() }),
    { method: "PUT", body: input, idempotencyKey: crypto.randomUUID() },
  );
}
export const removeCloudOrganizationCredential = (
  organizationId: string,
  credentialId: string,
) =>
  cloudAccountRequest(
    `${organizationPath(organizationId)}/accounts/${z.string().uuid().parse(credentialId)}`,
    z.object({ removed: z.boolean() }),
    { method: "DELETE", body: {}, idempotencyKey: crypto.randomUUID() },
  );

export function authorizeCloudProvider(input: {
  id: string;
  credentialId: string;
  expectedRevision: number;
  workspaceId: string;
  granteeUserId: string;
  models: string[];
  allModels?: boolean;
  expiresAt: string;
  computeConsent: CloudProviderAccess["compute"];
}) {
  return cloudAccountRequest(
    "/v1/cloud-agent-credentials/delegations",
    z.object({ delegation: z.object({ id: z.string().uuid() }) }),
    {
      body: input,
      idempotencyKey: input.id,
    },
  );
}

export function disconnectCloudProvider(delegationId: string) {
  return cloudAccountRequest(
    `/v1/cloud-agent-credentials/delegations/${z.string().uuid().parse(delegationId)}`,
    z.object({ revoked: z.boolean() }),
    {
      method: "DELETE",
      body: {},
      idempotencyKey: crypto.randomUUID(),
    },
  );
}
