import { z } from "zod";
import { cloudAccountRequest } from "../../platform/cloud-workspaces";
import { readCloudGithubCatalog, readCloudGithubRepositories } from "../../platform/cloud-github";
import { CONTROL_PLANE_URL } from "../team/control-plane";
import { getOrganizationStoreGeneration, getTeamStoreState } from "../team/team-store";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import type { RawServer } from "./mcp-server-model";
import type { McpSecretChanges } from "./mcp-form-save";

const uuid = z.string().uuid();
const extensionSchema = z.object({
  id: uuid, kind: z.literal("mcp"), owner: z.enum(["organization", "user"]), repository: z.string().nullable(),
  revision: z.number().int().positive(), config: z.record(z.string(), z.unknown()),
  secrets: z.object({ env: z.array(z.string()), headers: z.array(z.string()), oauthClientSecret: z.boolean() }),
  canEdit: z.boolean(), updatedAt: z.string(), oauth: z.object({ status: z.enum(["connected", "needs-auth"]) }).optional(),
});
export type CloudMcpExtension = z.infer<typeof extensionSchema>;
export const cloudMcpCache = new KeyedAsyncCache<CloudMcpExtension[]>(24);
export const cloudMcpKey = (organizationId: string) => JSON.stringify([CONTROL_PLANE_URL, getTeamStoreState().me?.user.id, getOrganizationStoreGeneration(), organizationId]);
export function assertMcpOwnerKey(key: string): string {
  const parts = JSON.parse(key) as unknown[];
  const organizationId = uuid.parse(parts[3]);
  if (key !== cloudMcpKey(organizationId)) throw new Error("Your account changed. Reopen this organization’s MCP servers.");
  return organizationId;
}
const base = (organizationId: string) => `/v1/organizations/${uuid.parse(organizationId)}/extensions`;
export async function readCloudMcp(key: string): Promise<CloudMcpExtension[]> {
  const organizationId = assertMcpOwnerKey(key);
  const result = await cloudAccountRequest(`${base(organizationId)}?kind=mcp`, z.object({ extensions: z.array(extensionSchema).max(256) }));
  assertMcpOwnerKey(key);
  return result.extensions;
}
function cloudConfig(config: RawServer): RawServer {
  if (config.oauth_client_mode !== "metadata") return config;
  const origin = CONTROL_PLANE_URL ? new URL(CONTROL_PLANE_URL) : null;
  if (origin?.protocol !== "https:") throw new Error("Published identity requires an HTTPS service. Choose Automatic for local development.");
  return { ...config, oauth_client_id: new URL("/.well-known/mcp-client.json", origin).href };
}
export async function saveCloudMcp(key: string, input: { id: string; owner: "organization" | "user"; repository: string | null; expectedRevision: number | null; config: RawServer; secrets?: McpSecretChanges }): Promise<CloudMcpExtension> {
  const organizationId = assertMcpOwnerKey(key);
  const { id, ...body } = input;
  const result = await cloudAccountRequest(`${base(organizationId)}/${uuid.parse(id)}`, z.object({ extension: extensionSchema }), {
    method: "PUT", idempotencyKey: crypto.randomUUID(), body: { ...body, kind: "mcp", config: cloudConfig(body.config) },
  });
  assertMcpOwnerKey(key);
  if (result.extension.id !== id) throw new Error("MCP response changed identity.");
  cloudMcpCache.invalidate(key);
  return result.extension;
}
export async function removeCloudMcp(key: string, extension: CloudMcpExtension): Promise<void> {
  const organizationId = assertMcpOwnerKey(key);
  await cloudAccountRequest(`${base(organizationId)}/${uuid.parse(extension.id)}`, z.object({ ok: z.literal(true) }), {
    method: "DELETE", idempotencyKey: crypto.randomUUID(), body: { expectedRevision: extension.revision },
  });
  assertMcpOwnerKey(key); cloudMcpCache.invalidate(key);
}
const probeSchema = z.object({ status: z.enum(["connected", "needs-auth", "failed"]), stages: z.array(z.object({ stage: z.enum(["validation", "transport", "initialize", "tools"]), status: z.enum(["passed", "failed", "needs-auth"]) })), toolCount: z.number().optional(), tools: z.array(z.string()).max(1024).optional(), message: z.string().optional() });
export function probeCloudMcp(key: string, config: RawServer, secrets: McpSecretChanges, initial: CloudMcpExtension | null, signal: AbortSignal) {
  const organizationId = assertMcpOwnerKey(key);
  return cloudAccountRequest(`${base(organizationId)}/mcp/probe`, probeSchema, { body: {
    config: cloudConfig(config), secrets, ...(initial ? { extensionId: initial.id, expectedRevision: initial.revision } : {}),
  }, idempotencyKey: crypto.randomUUID() }, { signal });
}
export function startCloudMcpAuth(key: string, initial: CloudMcpExtension, signal: AbortSignal) {
  const organizationId = assertMcpOwnerKey(key);
  return cloudAccountRequest(`${base(organizationId)}/mcp/oauth/start`, z.object({ attemptId: uuid, authorizationUrl: z.string().url(), expiresAt: z.number().int().positive() }), {
    body: { config: initial.config, extensionId: initial.id, expectedRevision: initial.revision }, idempotencyKey: crypto.randomUUID(),
  }, { signal });
}
export function cloudMcpAuthStatus(key: string, attemptId: string, signal: AbortSignal) {
  return cloudAccountRequest(`${base(assertMcpOwnerKey(key))}/mcp/oauth/${uuid.parse(attemptId)}`, z.object({ status: z.enum(["pending", "connected", "failed"]), message: z.string().optional() }), undefined, { signal });
}
export async function cancelCloudMcpAuth(key: string, attemptId: string) {
  await cloudAccountRequest(`${base(assertMcpOwnerKey(key))}/mcp/oauth/${uuid.parse(attemptId)}`, z.object({ ok: z.literal(true) }), { method: "DELETE", body: {}, idempotencyKey: crypto.randomUUID() });
}

export async function readCloudMcpRepositories(key: string) {
  const organizationId = assertMcpOwnerKey(key);
  // The API only lists recent, actor-bound repository admission. Refresh it
  // through the native human/App intersection; a Cloud Computer or an App's
  // installation-wide token cannot establish the person's repository access.
  const catalog = await readCloudGithubCatalog(organizationId);
  assertMcpOwnerKey(key);
  const catalogError = () => new Error("The repository catalog could not be loaded completely. Check the connected GitHub installations in Settings and try again.");
  if (!catalog.complete) throw catalogError();
  let pagesRemaining = 100;
  for (const installation of catalog.installations) {
    if (!installation.connected || installation.suspendedAt) continue;
    let page: number | null = 1;
    while (page !== null) {
      if (pagesRemaining-- <= 0) throw catalogError();
      const result = await readCloudGithubRepositories(organizationId, installation.id, page);
      assertMcpOwnerKey(key);
      if (result.nextPage !== null && result.nextPage <= page) throw catalogError();
      page = result.nextPage;
    }
  }
  const result = await cloudAccountRequest(`${base(organizationId)}/mcp/repositories`, z.object({ repositories: z.array(z.object({ repository: z.string(), defaultBranch: z.string().optional() })).max(10000) }));
  assertMcpOwnerKey(key);
  return result.repositories.map(row => ({ value: row.repository, label: row.repository })).sort((a, b) => a.label.localeCompare(b.label));
}
