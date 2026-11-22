export * from "./cloud-workspace-contract";
import { recordOrganizationRetention } from "./cloud-retention-state";
import type { CloudWorkspaceDocument } from "./cloud-workspace-contract";
import { z } from "zod";
import { SYNC_FIELD_HEADERS, TEAM_SHARING_HEADERS } from "./control-plane-headers";
import { getSession } from "../features/auth/auth-store";
import { CLIENT_TOKEN_ROLLOVER_FEATURE } from "@zeros/protocol/cloud-v2-relay";
import { controlPlaneFetch } from "../features/update/control-plane-fetch";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import { personalCloudOrganization } from "../features/team/personal-cloud";
import {
  CONTROL_PLANE_URL,
  ControlPlaneError,
} from "../features/team/control-plane";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";
import { isFeatureEnabled } from "../config/release-channel";
import type { WorkspaceAddress } from "@zeros/protocol/local-orchestration";
import { recordOrganizationSharing } from "./team-sharing-state";
import { reportWorkspaceReadOnly } from "./team-sharing-registry";
import { CloudWorkspaceReadOnlyError } from "./cloud-workspace-read-only";
import { changeCloudV2Workspace, cloudV2Document, createCloudV2WorkspaceReply, getCloudV2Workspace, getCloudV2WorkspaceByNumber, listCloudV2Workspaces, setCloudV2WorkspaceKeep } from "./cloud-v2";
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

const DEVICE_HEADER_NAMES = ["X-Zeros-Device-Id", "X-Zeros-Device-Registration", "X-Zeros-Device-Instance"] as const;
function pickDeviceHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers || !DEVICE_HEADER_NAMES.every(name => typeof headers[name] === "string" && /^[0-9a-f-]{36}$/i.test(headers[name]!))) return {};
  return Object.fromEntries(DEVICE_HEADER_NAMES.map(name => [name, headers[name]!]));
}

/** Expiry is an unverified scheduling hint; only the control plane authenticates the bearer. */
function bearerExpiry(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload || payload.length > 8192) return null;
    const exp = (JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isSafeInteger(exp) ? exp * 1000 : null;
  } catch { return null; }
}

const ROLLOVER_REFUSED_MS = 30 * 60_000;
const rolloverRefused = new Map<string, number>();
export function resetClientRolloverHeadersForTests(): void { rolloverRefused.clear(); }

export async function cloudAccountRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  input?: { body: unknown; idempotencyKey: string; method?: "POST" | "DELETE" | "PUT" | "PATCH" },
  options?: { promptRecovery?: true; signal?: AbortSignal; githubPullRequest?: true; mutationReceipt?: true;
    /** The control plane requires all three local-command device headers or none. */
    deviceHeaders?: Record<string, string>;
    /** Opt in to extra Mac fields so older strict decoders never receive them. */
    syncField?: true;
    teamSharing?: true;
    /** Bind rollover tickets to this open peer's in-memory instance. */
    clientInstance?: string;
    /** Features this desktop declares on the request (X-Zeros-Client-Features), beside rollover's. */
    clientFeatures?: readonly string[];
    /** Renewal requires a bearer that outlives the previous one's expiry. */
    notExpiringBefore?: number;
    /** Report only expiry so a retry can request a newer bearer without seeing the token. */
    presentedTokenExpiry?: (expiresAt: number | null) => void },
): Promise<T> {
  if (!isFeatureEnabled("cloud-workspaces"))
    throw new Error("Cloud workspaces are not available in this release channel.");
  if (!CONTROL_PLANE_URL)
    throw new Error("Cloud workspaces are not configured");
  // Capture the account before token refresh can yield to a different sign-in.
  const epoch = getOrganizationStoreGeneration();
  const session = await getSession(options?.notExpiringBefore ? { notExpiringBefore: options.notExpiringBefore } : undefined);
  if (epoch !== getOrganizationStoreGeneration())
    throw new Error("Your account changed while loading cloud workspaces");
  if (!session) throw new Error("Sign in to use cloud workspaces");
  options?.presentedTokenExpiry?.(bearerExpiry(session.access_token));
  // Older control planes can reject the client-feature headers (rollover's or declared
  // features) during CORS preflight; cache a successful headerless fallback briefly.
  const refused = (rolloverRefused.get(CONTROL_PLANE_URL) ?? -Infinity) > Date.now();
  const rollover = !!options?.clientInstance && /^[0-9a-f-]{36}$/i.test(options.clientInstance) && !refused;
  const features = refused ? [] : options?.clientFeatures ?? [];
  const offered = rollover || features.length > 0;
  const send = (withHeaders: boolean) => controlPlaneFetch(`${CONTROL_PLANE_URL}${path}`, {
    method: input?.method ?? (input ? "POST" : "GET"),
    redirect: "error",
    cache: "no-store",
    signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.githubPullRequest ? 60_000 : 20_000)]) : AbortSignal.timeout(options?.githubPullRequest ? 60_000 : 20_000),
    headers: {
      authorization: `Bearer ${session.access_token}`,
      ...pickDeviceHeaders(options?.deviceHeaders),
      // Released Mac decoders need separate opt-ins for syncing and syncWanted.
      ...(options?.syncField ? SYNC_FIELD_HEADERS : {}),
      // Ask for team ownership with sharing so creatorless workspaces can be decoded.
      ...(options?.teamSharing ? TEAM_SHARING_HEADERS : {}),
      ...(withHeaders && offered
        ? { "X-Zeros-Client-Features": [...features, ...(rollover ? [CLIENT_TOKEN_ROLLOVER_FEATURE] : [])].join(",") } : {}),
      ...(withHeaders && rollover ? { "X-Zeros-Client-Instance": options!.clientInstance! } : {}),
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
  let response: Response;
  try { response = await send(offered); }
  catch (error) {
    // A preflight refusal is indistinguishable from other fetch TypeErrors.
    if (!offered || !(error instanceof TypeError) || options?.signal?.aborted) throw error;
    response = await send(false);
    rolloverRefused.set(CONTROL_PLANE_URL, Date.now() + ROLLOVER_REFUSED_MS);
  }
  // Only prompt recovery needs the larger budget for bounded attachment pages.
  const body = await readCloudJson(response, options?.promptRecovery && /^\/v1\/cloud-v2\/workspaces\/[^/]+\/prompts\?/.test(path)
    ? 16 * 1024 * 1024 : 4 * 1024 * 1024);
  if (epoch !== getOrganizationStoreGeneration() && !(response.ok && options?.mutationReceipt))
    throw new Error("Your account changed while loading cloud workspaces");
  if (!response.ok) {
    // Refresh the workspace document when execution reveals that access is read-only.
    if (response.status === 409 && (body as { error?: { code?: unknown } } | null)?.error?.code === "workspace_read_only") {
      const workspaceId = /^\/v1\/cloud-v2\/workspaces\/([0-9a-f-]{36})(?:[/?]|$)/i.exec(path)?.[1];
      if (workspaceId) reportWorkspaceReadOnly(workspaceId);
      throw new CloudWorkspaceReadOnlyError();
    }
    const error = z
      .object({ error: z.object({ code: z.string(), message: z.string(), agent: z.enum(["claude", "codex", "cursor"]).optional().catch(undefined),
        loginRequiredFrom: z.enum(["self", "creator"]).optional().catch(undefined) }) })
      .safeParse(body);
    throw new ControlPlaneError(
      response.status,
      error.success ? error.data.error.code : "cloud_unavailable",
      error.success
        ? error.data.error.message
        : "Cloud workspaces are temporarily unavailable",
      error.success ? error.data.error.agent : undefined,
      error.success ? error.data.error.loginRequiredFrom : undefined,
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
  /** A capped or dependency-incomplete observation cannot prove omission. */
  complete?: boolean;
}
export async function listCloudWorkspaceCatalogSnapshot(organizationId?: string): Promise<CloudWorkspaceCatalogSnapshot> {
  const me = getTeamStoreState().me;
  const generation = getOrganizationStoreGeneration();
  if (organizationId === undefined && !me) throw new Error("Cloud organization memberships have not loaded");
  const personal = personalCloudOrganization(me);
  const organizations = organizationId !== undefined ? [organizationId]
    : [...(me?.organizations ?? me?.teams ?? [])
      .filter(org => !org.isPersonal && org.workspaceCapabilities.cloud).map(org => org.id), ...(personal ? [personal.id] : [])];
  const workspaces: CloudWorkspaceDocument[] = [];
  let complete = true;
  for (const id of organizations) {
    const page = await listCloudV2Workspaces(id);
    if (generation !== getOrganizationStoreGeneration() || organizationId === undefined && me !== getTeamStoreState().me)
      throw new Error("Cloud organization memberships changed while loading");
    // Keep omitted rows on incomplete reads, including creator-only replies after shared rows were confirmed.
    if (!page.complete || recordOrganizationSharing(id, page.teamSharing).keepShared) complete = false;
    recordOrganizationRetention(id, page.retention);
    workspaces.push(...page.workspaces.map(cloudV2Document));
  }
  return { workspaces, catalogVersion: null, complete };
}

export async function setCloudWorkspaceKeep(target: CloudWorkspaceTarget, keep: boolean): Promise<CloudWorkspaceDocument> {
  return cloudV2Document(await setCloudV2WorkspaceKeep(target, keep));
}

export async function getCloudWorkspaceDocument(
  target: CloudWorkspaceTarget,
): Promise<CloudWorkspaceDocument> {
  return cloudV2Document(await getCloudV2Workspace(target));
}

export async function getCloudWorkspaceDocumentByNumber(
  address: WorkspaceAddress,
): Promise<CloudWorkspaceDocument> {
  return cloudV2Document(await getCloudV2WorkspaceByNumber(address));
}

export async function changeCloudWorkspaceLifecycle(
  target: CloudWorkspaceTarget,
  operation: "wake" | "stop" | "restart" | "archive" | "delete",
  _idempotencyKey: string,
  _reason?: "interaction",
): Promise<CloudWorkspaceDocument> {
  // Archive stops the workspace and marks it; starting it again restores it.
  const action = operation === "wake" ? "start" : operation;
  const workspace = cloudV2Document(await changeCloudV2Workspace(target, action));
  if (workspace.id !== target.workspaceId || workspace.organizationId !== target.organizationId)
    throw new Error("Cloud lifecycle response changed identity");
  return workspace;
}

export async function createCloudWorkspaceDocument(input: {
  organizationId: string;
  name?: string;
  repository: { owner: string; name: string };
  /** A plain branch name; omitted, the server uses its Cloud Computer's branch. */
  baseBranch?: string;
  /** Projects: the project to create from, and a base branch for any of its other repositories. */
  projectId?: string;
  repositories?: readonly { repository: string; baseBranch: string }[];
  /** Client-only: the project holds several repositories, so its pending row is grouped under the project. Never sent. */
  severalRepositories?: boolean;
  idempotencyKey: string;
  /** Client-only: the create's one message for the person (submodules it skipped). Never sent. */
  onNotice?(text: string): void;
}): Promise<CloudWorkspaceDocument> {
  const epoch = getOrganizationStoreGeneration();
  // Creation forks the organization's Cloud Computer and requires the repository to be installed there.
  const { workspace, submoduleNotice } = await createCloudV2WorkspaceReply({
    organizationId: input.organizationId,
    repository: `${input.repository.owner}/${input.repository.name}`,
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.repositories?.length ? { repositories: input.repositories } : {}),
    ...(input.name ? { name: input.name } : {}),
  }, input.idempotencyKey);
  if (epoch !== getOrganizationStoreGeneration())
    throw new Error("Your account changed while creating the cloud workspace");
  if (workspace.organizationId !== input.organizationId)
    throw new Error("Cloud creation returned a different organization");
  if (submoduleNotice) input.onNotice?.(submoduleNotice);
  return cloudV2Document(workspace);
}
