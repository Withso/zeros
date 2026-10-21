export * from "./cloud-workspace-contract";
import { CloudWorkspaceDocumentSchema, OptionsSchema, AgentGrantsSchema, CloudAgentBootAvailabilitySchema,
  type CloudWorkspaceDocument, type CloudWorkspaceCreateOptions, type CloudAgentBootAvailability } from "./cloud-workspace-contract";
import { CloudAgentAdmissionError } from "./bridge/cloud-agent-errors";
import { z } from "zod";
import { CloudRuntimeUpgradeAvailabilitySchema, type CloudRuntimeUpgradeAvailability } from "@zeros/protocol/cloud-runtime-lifecycle";
import { getSession } from "../features/auth/auth-store";
import { controlPlaneFetch } from "../features/update/control-plane-fetch";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import {
  CONTROL_PLANE_URL,
  ControlPlaneError,
} from "../features/team/control-plane";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";
import { getActiveBridge } from "./bridge/active-bridge";
import { WorkspaceRuntimeClient, type CloudResourceUsageConnection } from "./bridge/workspace-runtime-client";
import { bridgeWorkspaceResourceUsage } from "./bridge/workspace-bridge";
import { forgetCloudWorkspacePortForwarding } from "./cloud-workspace-access";
import { isFeatureEnabled } from "../config/release-channel";
import { changeCloudV2Workspace, cloudV2Document, createCloudV2Workspace, getCloudV2Workspace, listCloudV2Workspaces } from "./cloud-v2";
import { getTeamStoreState } from "../features/team/team-store";
import { CloudAcceptedLifecycleReceiptSchema, CloudRestartInputSchema,
  type CloudAcceptedLifecycleReceipt } from "@zeros/protocol/cloud-final-save";

async function readCloudJson(response: Response): Promise<unknown> {
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
      if (size > 4 * 1024 * 1024) {
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
  const body = await readCloudJson(response);
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

const request = cloudAccountRequest;

export const CloudWorkspaceRenameInputSchema = z.object({
  // Reject controls before whitespace normalization.
  // eslint-disable-next-line no-control-regex
  name: z.string().refine(value => !/[\u0000-\u001f\u007f]/.test(value), "Name contains unsupported characters")
    .transform(value => value.trim()).pipe(z.string().min(1).max(120)),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const CloudWorkspaceDetectedPortsSchema = z.object({
  version: z.literal(1), organizationId: z.string().uuid(), workspaceId: z.string().uuid(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), status: z.string().min(1).max(64),
  observedAt: z.string().datetime().nullable(),
  ports: z.array(z.object({
    port: z.number().int().min(1024).max(65535), protocol: z.literal("tcp"),
    processLabel: z.string().max(120).nullable(), health: z.enum(["observed", "healthy", "unhealthy", "closed"]),
    observedAt: z.string().datetime(), closedAt: z.string().datetime().nullable(),
  }).strict()).max(128).nullable(),
}).strict().refine(value => (value.ports === null) === (value.observedAt === null), "Port observation state needs its timestamp");
export type CloudWorkspaceDetectedPorts = z.infer<typeof CloudWorkspaceDetectedPortsSchema>;

export async function getCloudWorkspaceDetectedPorts(target: CloudWorkspaceTarget, generation: number): Promise<CloudWorkspaceDetectedPorts> {
  const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(generation);
  const result = await request(`${organizationPath(target.organizationId)}/${z.string().uuid().parse(target.workspaceId)}/detected-ports?generation=${number}`,
    CloudWorkspaceDetectedPortsSchema);
  if (result.organizationId !== target.organizationId || result.workspaceId !== target.workspaceId || result.generation !== number)
    throw new Error("Cloud port observations changed identity");
  return result;
}

export async function renameCloudWorkspace(
  target: CloudWorkspaceTarget,
  input: z.infer<typeof CloudWorkspaceRenameInputSchema>,
  idempotencyKey: string,
): Promise<CloudWorkspaceDocument> {
  const body = CloudWorkspaceRenameInputSchema.parse(input);
  const key = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/).parse(idempotencyKey);
  const { workspace } = await request(`${organizationPath(target.organizationId)}/${z.string().uuid().parse(target.workspaceId)}`,
    z.object({ workspace: CloudWorkspaceDocumentSchema }), { body, idempotencyKey: key, method: "PATCH" });
  if (workspace.organizationId !== target.organizationId || workspace.id !== target.workspaceId)
    throw new Error("Cloud workspace rename changed identity");
  return workspace;
}

export async function getCloudWorkspaceResourceUsage(target: CloudWorkspaceTarget, connection: CloudResourceUsageConnection) {
  const bridge = getActiveBridge();
  if (!(bridge instanceof WorkspaceRuntimeClient)) throw new Error("Cloud workspace is disconnected");
  return bridgeWorkspaceResourceUsage(bridge, target, connection);
}

function runtimeUpgradePath(target: CloudWorkspaceTarget): string {
  return `${organizationPath(target.organizationId)}/${z.string().uuid().parse(target.workspaceId)}/runtime-upgrade`;
}

export async function getCloudRuntimeUpgradeAvailability(target: CloudWorkspaceTarget): Promise<CloudRuntimeUpgradeAvailability> {
  const result = await request(runtimeUpgradePath(target), CloudRuntimeUpgradeAvailabilitySchema);
  if (result.organizationId !== target.organizationId || result.workspaceId !== target.workspaceId)
    throw new Error("Cloud runtime details changed workspace identity");
  return result;
}

/** Metadata only. Device credentials never become implicit cloud grants. */
export async function cloudAgentGrant(
  target: CloudWorkspaceTarget,
  agentId: string,
  model: string,
  selection?: { delegationId: string },
): Promise<string> {
  // Local Personal and organization-local use native credentials. Validate
  // this cloud target before touching session refresh or the control plane.
  z.string().uuid().parse(target.organizationId);
  z.string().uuid().parse(target.workspaceId);
  if (selection) z.string().uuid().parse(selection.delegationId);
  const epoch = getOrganizationStoreGeneration();
  const sender = await getSession();
  if (epoch !== getOrganizationStoreGeneration()) throw new Error("Your account changed while loading cloud workspaces");
  if (!sender) throw new Error("Sign in to use cloud workspaces");
  // WorkOS/Auth0 sub is the provider subject, never the CP account UUID.
  // Legacy sessions lack accountId; resolve it through the same epoch-bound
  // authenticated request instead of consulting a stale shared /me cache.
  const senderAccountId = sender.user.accountId !== undefined
    ? z.string().uuid().parse(sender.user.accountId)
    : (await request("/v1/me", z.object({ user: z.object({ id: z.string().uuid() }) }))).user.id;
  if (epoch !== getOrganizationStoreGeneration()) throw new Error("Your account changed while loading cloud workspaces");
  const delegations = await cloudAgentDelegations(target);
  if (epoch !== getOrganizationStoreGeneration()) throw new Error("Your account changed while loading cloud workspaces");
  // CP has authorized every row for this actor, but explicit delegation is
  // not consent to silently replace the actor's own selected connection.
  const selected = delegations.filter(row => selection
    ? row.id === selection.delegationId : row.ownerUserId === senderAccountId);
  const candidates = selected.filter(
    (row) => row.kind.startsWith(`${agentId}-`) && row.models.includes(model),
  );
  const grant = candidates.find((row) => row.runtimeQualified === true) ?? candidates.find((row) => row.runtimeQualified !== false);
  if (!candidates.length)
    throw new CloudAgentAdmissionError(selected.some(row => row.kind.startsWith(`${agentId}-`))
      ? "cloud_agent_model_not_authorized" : "cloud_agent_credential_required");
  if (!grant) {
    if (candidates.some(row => row.runtimeUpgradeRequired)) throw new CloudAgentAdmissionError("cloud_runtime_upgrade_required");
    throw new Error("This workspace's agent runtime needs an update before this agent can run. Your account connection is saved.");
  }
  return grant.id;
}

/** Passive composer discovery for an activated workspace boot: the funding
 * owner's provider slots this actor may run. Null when the server predates
 * it, so the caller keeps the per-actor legacy discovery. */
export async function cloudAgentBootAvailability(target: CloudWorkspaceTarget): Promise<CloudAgentBootAvailability | null> {
  try {
    return await request(
      `/v1/cloud-workspaces/${z.string().uuid().parse(target.workspaceId)}/agent-availability`,
      CloudAgentBootAvailabilitySchema,
    );
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 404 && error.code === "not_found") return null;
    throw error;
  }
}

export async function cloudAgentDelegations(target: CloudWorkspaceTarget) {
  const result = await request(
    `/v1/cloud-workspaces/${z.string().uuid().parse(target.workspaceId)}/agent-credentials/prepare`,
    AgentGrantsSchema,
    { body: {}, idempotencyKey: crypto.randomUUID() },
  );
  return result.delegations.filter(
    (row) => Date.parse(row.expiresAt) > Date.now(),
  );
}

function organizationPath(organizationId: string): string {
  return `/v1/organizations/${z.string().uuid().parse(organizationId)}/cloud-workspaces`;
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
  // v2 has no archive: a stopped workspace already keeps its disk.
  const action = operation === "wake" ? "start" : operation === "delete" ? "delete" : "stop";
  const workspace = cloudV2Document(await changeCloudV2Workspace(target, action));
  if (workspace.id !== target.workspaceId || workspace.organizationId !== target.organizationId)
    throw new Error("Cloud lifecycle response changed identity");
  // A successful server deletion stays successful if native cleanup fails.
  if (operation === "delete") await forgetCloudWorkspacePortForwarding(target).catch(() => undefined);
  return workspace;
}

export type CloudLifecycleAcceptance = {
  workspace: CloudWorkspaceDocument;
  operation: CloudAcceptedLifecycleReceipt;
};
const LifecycleAcceptanceSchema = z.object({
  workspace: CloudWorkspaceDocumentSchema,
  operation: CloudAcceptedLifecycleReceiptSchema,
});

function validateLifecycleAcceptance(target: CloudWorkspaceTarget,
  kind: CloudAcceptedLifecycleReceipt["kind"], result: CloudLifecycleAcceptance): CloudLifecycleAcceptance {
  if (result.workspace.id !== target.workspaceId || result.workspace.organizationId !== target.organizationId ||
      result.operation.kind !== kind) throw new Error("Cloud lifecycle response changed identity");
  return result;
}

/** Discovery is chosen before sending. An uncertain v1 send never falls back
 * to the legacy path, including when a retry reaches an older CP instance. */
export async function changeCloudWorkspaceLifecycleWithReceipt(
  target: CloudWorkspaceTarget, operation: "stop" | "archive" | "delete", idempotencyKey: string,
): Promise<CloudLifecycleAcceptance> {
  target = Object.freeze({ ...target });
  return validateLifecycleAcceptance(target, operation, await request(
    `${organizationPath(target.organizationId)}/${z.string().uuid().parse(target.workspaceId)}${operation === "delete" ? "" : `/${operation}`}`,
    LifecycleAcceptanceSchema, { body: {}, idempotencyKey, method: operation === "delete" ? "DELETE" : "POST" },
  ));
}

export async function restartCloudWorkspaceLifecycle(target: CloudWorkspaceTarget,
  input: z.infer<typeof CloudRestartInputSchema>, idempotencyKey: string,
): Promise<CloudLifecycleAcceptance> {
  target = Object.freeze({ ...target });
  const body = Object.freeze(CloudRestartInputSchema.parse(input));
  const result = validateLifecycleAcceptance(target, "restart", await request(
    `${organizationPath(target.organizationId)}/${z.string().uuid().parse(target.workspaceId)}/restart`,
    LifecycleAcceptanceSchema, { body, idempotencyKey },
  ));
  if (result.operation.sourceGeneration !== body.expectedGeneration)
    throw new Error("Cloud Restart receipt changed its original generation");
  return result;
}

export const CloudWorkspaceRecoveryInputSchema = z.object({
  sourceGeneration: z.number().int().positive(),
  checkpointId: z.string().uuid(),
  allowDataLoss: z.boolean().optional(),
}).strict();
export type CloudWorkspaceRecoveryInput = z.infer<typeof CloudWorkspaceRecoveryInputSchema>;

export async function recoverCloudWorkspace(target: CloudWorkspaceTarget, input: CloudWorkspaceRecoveryInput, idempotencyKey: string): Promise<CloudWorkspaceDocument> {
  const { workspace } = await request(
    `${organizationPath(target.organizationId)}/${z.string().uuid().parse(target.workspaceId)}/generations`,
    z.object({ workspace: CloudWorkspaceDocumentSchema }),
    { body: { operation: "recover", ...CloudWorkspaceRecoveryInputSchema.parse(input) }, idempotencyKey },
  );
  if (workspace.id !== target.workspaceId || workspace.organizationId !== target.organizationId)
    throw new Error("Cloud recovery response changed identity");
  return workspace;
}

export async function getCloudWorkspaceCreateOptions(
  organizationId: string,
  owner: string,
  repository?: string,
): Promise<CloudWorkspaceCreateOptions> {
  return request(
    `${organizationPath(organizationId)}/create-options?owner=${encodeURIComponent(owner)}${repository ? `&repository=${encodeURIComponent(repository)}` : ""}&cloudComputerV2=true`,
    OptionsSchema,
  );
}

export async function createCloudWorkspaceDocument(input: {
  organizationId: string;
  name?: string;
  teamId?: string;
  cloudComputerBuild?: { id: string; version: number };
  repository: {
    forge: "github.com";
    owner: string;
    name: string;
    revision: string;
    githubInstallationId: string;
  };
  idempotencyKey: string;
}): Promise<CloudWorkspaceDocument> {
  const epoch = getOrganizationStoreGeneration();
  // v2 forks the organization's live Cloud Computer, which already has the
  // repository installed; the server rejects repositories it does not have.
  const workspace = await createCloudV2Workspace({
    organizationId: input.organizationId,
    repository: `${input.repository.owner}/${input.repository.name}`,
    baseBranch: input.repository.revision,
    ...(input.name ? { name: input.name } : {}),
  });
  if (epoch !== getOrganizationStoreGeneration())
    throw new Error("Your account changed while creating the cloud workspace");
  if (workspace.organizationId !== input.organizationId)
    throw new Error("Cloud creation returned a different organization");
  return cloudV2Document(workspace);
}
