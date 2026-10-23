export * from "./cloud-workspace-contract";
import type { CloudWorkspaceDocument } from "./cloud-workspace-contract";
import { z } from "zod";
import { getSession } from "../features/auth/auth-store";
import { controlPlaneFetch } from "../features/update/control-plane-fetch";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import {
  CONTROL_PLANE_URL,
  ControlPlaneError,
} from "../features/team/control-plane";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";
import { isFeatureEnabled } from "../config/release-channel";
import { changeCloudV2Workspace, cloudV2Document, createCloudV2Workspace, getCloudV2Workspace, listCloudV2Workspaces } from "./cloud-v2";
import { getTeamStoreState } from "../features/team/team-store";

async function readCloudJson(response: Response, maxBytes = 4 * 1024 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Cloud returned an empty response");
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Cloud response exceeded its size limit");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

export async function cloudAccountRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  input?: { body: unknown; idempotencyKey: string; method?: "POST" | "DELETE" | "PUT" | "PATCH" },
  options?: { promptRecovery?: true },
): Promise<T> {
  if (!isFeatureEnabled("cloud-workspaces"))
    throw new Error("Cloud workspaces are not available in this release channel.");
  if (!CONTROL_PLANE_URL)
    throw new Error("Cloud workspaces are not configured");
  // Capture the initiating account synchronously, before token refresh or any
  // other yield can replace it with the next signed-in account.
  const epoch = getOrganizationStoreGeneration();
  const session = await getSession();
  if (epoch !== getOrganizationStoreGeneration())
    throw new Error("Your account changed while loading cloud workspaces");
  if (!session) throw new Error("Sign in to use cloud workspaces");
  const response = await controlPlaneFetch(`${CONTROL_PLANE_URL}${path}`, {
    method: input?.method ?? (input ? "POST" : "GET"),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
    headers: {
      authorization: `Bearer ${session.access_token}`,
      ...(input
        ? {
            "content-type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
          }
        : {}),
    },
    ...(input ? { body: JSON.stringify(input.body) } : {}),
  }, () => {
    if (epoch !== getOrganizationStoreGeneration()) throw new Error("Your account changed while loading cloud workspaces");
  });
  // Recovery can include the outbox's bounded attachment page. Ordinary
  // account APIs retain their smaller response budget.
  const body = await readCloudJson(response, options?.promptRecovery && /^\/v1\/cloud-v2\/workspaces\/[^/]+\/prompts\?/.test(path)
    ? 16 * 1024 * 1024 : 4 * 1024 * 1024);
  if (epoch !== getOrganizationStoreGeneration())
    throw new Error("Your account changed while loading cloud workspaces");
  if (!response.ok) {
    const error = z
      .object({ error: z.object({ code: z.string(), message: z.string() }) })
      .safeParse(body);
    throw new ControlPlaneError(
      response.status,
      error.success ? error.data.error.code : "cloud_unavailable",
      error.success
        ? error.data.error.message
        : "Cloud workspaces are temporarily unavailable",
    );
  }
  return schema.parse(body);
}


export async function listCloudWorkspaceDocuments(organizationId?: string): Promise<
  CloudWorkspaceDocument[]
> {
  return (await listCloudWorkspaceCatalogSnapshot(organizationId)).workspaces;
}

export interface CloudWorkspaceCatalogSnapshot {
  workspaces: CloudWorkspaceDocument[];
  /** A resume hint, never an event cutoff or a transaction snapshot point. */
  catalogVersion: number | null;
}
/** Cloud v2: one read per organization the account can use cloud in. */
export async function listCloudWorkspaceCatalogSnapshot(organizationId?: string): Promise<CloudWorkspaceCatalogSnapshot> {
  const organizations = organizationId !== undefined ? [organizationId]
    : (getTeamStoreState().me?.organizations ?? [])
      .filter(org => !org.isPersonal && org.workspaceCapabilities.cloud).map(org => org.id).slice(0, 16);
  const workspaces: CloudWorkspaceDocument[] = [];
  for (const id of organizations) workspaces.push(...(await listCloudV2Workspaces(id)).map(cloudV2Document));
  return { workspaces, catalogVersion: null };
}

export async function getCloudWorkspaceDocument(
  target: CloudWorkspaceTarget,
): Promise<CloudWorkspaceDocument> {
  return cloudV2Document(await getCloudV2Workspace(target));
}

export async function changeCloudWorkspaceLifecycle(
  target: CloudWorkspaceTarget,
  operation: "wake" | "stop" | "archive" | "delete",
  _idempotencyKey: string,
  _reason?: "interaction",
): Promise<CloudWorkspaceDocument> {
  // Archive stops the workspace and marks it; starting it again restores it.
  const action = operation === "wake" ? "start" : operation;
  const workspace = cloudV2Document(await changeCloudV2Workspace(target, action));
  if (workspace.id !== target.workspaceId || workspace.organizationId !== target.organizationId)
    throw new Error("Cloud lifecycle response changed identity");
  // A successful server deletion stays successful if native cleanup fails.
  return workspace;
}

export async function createCloudWorkspaceDocument(input: {
  organizationId: string;
  name?: string;
  repository: { owner: string; name: string };
  /** A plain branch name; omitted, the server uses its Cloud Computer's branch. */
  baseBranch?: string;
  idempotencyKey: string;
}): Promise<CloudWorkspaceDocument> {
  const epoch = getOrganizationStoreGeneration();
  // v2 forks the organization's live Cloud Computer, which already has the
  // repository installed; the server rejects repositories it does not have.
  const workspace = await createCloudV2Workspace({
    organizationId: input.organizationId,
    repository: `${input.repository.owner}/${input.repository.name}`,
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
    ...(input.name ? { name: input.name } : {}),
  }, input.idempotencyKey);
  if (epoch !== getOrganizationStoreGeneration())
    throw new Error("Your account changed while creating the cloud workspace");
  if (workspace.organizationId !== input.organizationId)
    throw new Error("Cloud creation returned a different organization");
  return cloudV2Document(workspace);
}
