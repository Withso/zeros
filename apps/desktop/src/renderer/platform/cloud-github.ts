import {
  cloudGithubCatalogSchema,
  cloudGithubConnectedSchema,
  cloudGithubDisconnectedSchema,
  cloudGithubRepositoriesSchema,
  cloudGithubSourceSchema,
  cloudGithubWriteGrantSchema,
  isCloudGithubWriteOperation,
} from "@zeros/protocol/github-auth";
import { z } from "zod";
import { nativeInvoke } from "./runtime";
import { KeyedAsyncCache } from "../shared/lib/keyed-async-cache";
import { getOrganizationStoreGeneration } from "../features/team/team-store";

export type CloudGithubCatalog = z.infer<typeof cloudGithubCatalogSchema>;
export type CloudGithubRepositoryPage = z.infer<
  typeof cloudGithubRepositoriesSchema
>;
export const cloudGithubCatalogCache = new KeyedAsyncCache<CloudGithubCatalog>(
  32,
);
export const cloudGithubRepositoriesCache =
  new KeyedAsyncCache<CloudGithubRepositoryPage>(64);
export const cloudGithubScopeKey = (userId: string, organizationId: string) =>
  JSON.stringify([userId, organizationId]);
export function clearCloudGithub(): void {
  for (const key of cloudGithubCatalogCache.keys())
    cloudGithubCatalogCache.forget(key);
  for (const key of cloudGithubRepositoriesCache.keys())
    cloudGithubRepositoriesCache.forget(key);
}
async function invoke<T>(
  input: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const epoch = getOrganizationStoreGeneration();
  const value = await nativeInvoke("gh_cloud", input);
  if (getOrganizationStoreGeneration() !== epoch)
    throw new Error("Your account changed. Try again.");
  return schema.parse(value);
}
export const readCloudGithubCatalog = (organizationId: string) =>
  invoke({ action: "catalog", organizationId }, cloudGithubCatalogSchema);
export const readCloudGithubRepositories = (
  organizationId: string,
  installationId: string,
  page = 1,
) =>
  invoke(
    { action: "repositories", organizationId, installationId, page },
    cloudGithubRepositoriesSchema,
  );
export const connectCloudGithub = (
  organizationId: string,
  installationId: string,
) =>
  invoke(
    { action: "connect", organizationId, installationId },
    cloudGithubConnectedSchema,
  );
export const disconnectCloudGithub = (
  organizationId: string,
  installationId: string,
) =>
  invoke(
    { action: "disconnect", organizationId, installationId },
    cloudGithubDisconnectedSchema,
  );
export const authorizeCloudGithubSource = (
  organizationId: string,
  owner: string,
  repository: string,
  installationId?: string,
) =>
  invoke(
    {
      action: "source",
      organizationId,
      owner,
      repository,
      ...(installationId ? { installationId } : {}),
    },
    cloudGithubSourceSchema,
  );

export async function prepareCloudGithubWrite(target: { organizationId: string; workspaceId: string }, operation: string, params: Record<string, unknown>): Promise<string> {
  if (!isCloudGithubWriteOperation(operation)) throw new Error("Unsupported GitHub write.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([operation, params])));
  const paramsSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return (await invoke({ action: "prepareWrite", organizationId: target.organizationId, workspaceId: target.workspaceId, operation, ...(params.prNumber !== undefined ? { prNumber: params.prNumber } : {}), paramsSha256 }, cloudGithubWriteGrantSchema)).grant;
}
