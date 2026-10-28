import {
  CloudGithubConnectionStatusSchema,
  CloudGithubOauthStartedSchema,
  CloudGithubRepositoryPageSchema,
  type CloudGithubConnectionStatus,
  type CloudGithubMethod,
  type CloudGithubRepositoryPage,
} from "@zeros/protocol/cloud-github-connection";
import { z } from "zod";
import { cloudAccountRequest } from "./cloud-workspaces";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import { KeyedAsyncCache } from "../shared/lib/keyed-async-cache";
import { clearCloudGithubPr } from "./cloud-github-pr";

export const cloudGithubConnectionCache =
  new KeyedAsyncCache<CloudGithubConnectionStatus>(32);
export const cloudGithubRepositoryPageCache =
  new KeyedAsyncCache<CloudGithubRepositoryPage>(64);
export const cloudGithubConnectionKey = (
  userId: string,
  organizationId: string,
) => JSON.stringify([userId, organizationId, "cloud"]);
const generations = new Map<string, string>(),
  epochs = new Map<string, number>();
let epoch = 0;
const uuid = z.string().uuid();
const changed = () =>
  new Error("Your cloud GitHub connection changed. Refresh before continuing.");
function retireRepositories(key: string, organizationId: string): void {
  for (const cached of cloudGithubRepositoryPageCache.keys())
    if (JSON.parse(cached)[0] === key)
      cloudGithubRepositoryPageCache.forget(cached);
  clearCloudGithubPr(organizationId);
}
function observe(
  key: string,
  organizationId: string,
  generation: string,
): void {
  if (generations.get(key) && generations.get(key) !== generation)
    retireRepositories(key, organizationId);
  generations.delete(key);
  generations.set(key, generation);
  if (generations.size > 64)
    generations.delete(generations.keys().next().value!);
}
export function clearCloudGithubConnections(): void {
  epoch++;
  generations.clear();
  epochs.clear();
  for (const key of cloudGithubConnectionCache.keys())
    cloudGithubConnectionCache.forget(key);
  for (const key of cloudGithubRepositoryPageCache.keys())
    cloudGithubRepositoryPageCache.forget(key);
}
function fence(key: string) {
  const account = getOrganizationStoreGeneration(),
    started = epoch,
    revision = epochs.get(key) ?? 0;
  return () => {
    if (
      account !== getOrganizationStoreGeneration() ||
      started !== epoch ||
      revision !== (epochs.get(key) ?? 0)
    )
      throw changed();
  };
}
export async function readCloudGithubConnection(
  userId: string,
  organizationId: string,
) {
  const key = cloudGithubConnectionKey(userId, organizationId),
    current = fence(key);
  const value = await cloudAccountRequest(
    `/v1/cloud-v2/github/connection?organizationId=${uuid.parse(organizationId)}`,
    CloudGithubConnectionStatusSchema,
  );
  current();
  observe(key, organizationId, value.generation);
  if (
    !value.selectedMethod ||
    !["connected", "not-installed"].includes(
      value.methods[value.selectedMethod].health,
    )
  )
    retireRepositories(key, organizationId);
  return value;
}
export async function readSelectedCloudRepositories(
  userId: string,
  organizationId: string,
  generation: string,
  page = 1,
) {
  const key = cloudGithubConnectionKey(userId, organizationId),
    current = fence(key);
  if (generations.get(key) !== generation) throw changed();
  const value = await cloudAccountRequest(
    `/v1/cloud-v2/github/repositories?organizationId=${uuid.parse(organizationId)}&page=${page}`,
    CloudGithubRepositoryPageSchema,
  );
  current();
  if (value.generation !== generation || generations.get(key) !== generation) {
    retireRepositories(key, organizationId);
    cloudGithubConnectionCache.invalidate(key);
    throw changed();
  }
  return value;
}
type Action =
  | { action: "pat"; token: string }
  | { action: "oauth" | "cancel" }
  | { action: "select" | "disconnect"; method: CloudGithubMethod };
async function mutate<T>(
  userId: string,
  organizationId: string,
  expected: string,
  action: Action,
  schema: z.ZodType<T>,
): Promise<T> {
  const key = cloudGithubConnectionKey(userId, organizationId);
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
  if (epochs.size > 64) {
    epoch++;
    epochs.clear();
  }
  retireRepositories(key, organizationId);
  cloudGithubConnectionCache.invalidate(key);
  const current = fence(key);
  const value = await cloudAccountRequest(
    "/v1/cloud-v2/github/connection",
    schema,
    {
      body: { organizationId: uuid.parse(organizationId), expected, ...action },
      idempotencyKey: crypto.randomUUID(),
    },
  );
  current();
  return value;
}
export async function changeCloudGithubConnection(
  userId: string,
  organizationId: string,
  expected: string,
  action:
    | Exclude<Action, { action: "oauth" | "cancel" }>
    | { action: "cancel" },
) {
  const value = await mutate(
    userId,
    organizationId,
    expected,
    action,
    CloudGithubConnectionStatusSchema,
  );
  const key = cloudGithubConnectionKey(userId, organizationId);
  observe(key, organizationId, value.generation);
  cloudGithubConnectionCache.setData(key, value);
  return value;
}
export async function beginCloudGithubConnection(
  userId: string,
  organizationId: string,
  expected: string,
) {
  return mutate(
    userId,
    organizationId,
    expected,
    { action: "oauth" },
    CloudGithubOauthStartedSchema,
  );
}
