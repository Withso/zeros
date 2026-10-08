import { CloudAgentAdmissionError } from "./bridge/cloud-agent-errors";
import { z } from "zod";
import { CloudComputerAdminWorkspaceSchema } from "@zeros/protocol/cloud-computer-v2";
import { CloudNativeCapabilitiesSchema } from "@zeros/protocol/cloud-agent-execution";
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

export const CloudWorkspaceActorRoleSchema = z.enum(["viewer", "prompter", "developer", "manager", "owner"]);
export type CloudWorkspaceActorRole = z.infer<typeof CloudWorkspaceActorRoleSchema>;

export const CloudWorkspaceDocumentSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  teamId: z.string().uuid(),
  name: z.string().min(1).max(120),
  createdBy: z.string().uuid(),
  createdByDisplayName: z.string().min(1).max(120).nullable().optional(),
  ownerUserId: z.string().uuid().optional(),
  adminWorkspace: CloudComputerAdminWorkspaceSchema.optional(),
  actorRole: CloudWorkspaceActorRoleSchema.nullable().optional(),
  sharingMode: z.enum(["private", "organization"]).optional(),
  accessRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  recovery: z.object({
    state: z.string().nullable(),
    checkpointId: z.string().uuid().nullable(),
    checkpointAt: z.string().nullable(),
    sourceGeneration: z.number().int().positive(),
    needsAcknowledgement: z.boolean(),
  }).nullable().optional(),
  placement: z.literal("cloud"),
  status: z.string().min(1).max(64),
  capabilities: z.object({
    canWrite: z.boolean(),
    // Older servers do not project edit authority. Consumers must fail closed.
    canEdit: z.boolean().optional(),
    canManage: z.boolean(),
    canStart: z.boolean(),
    startUnavailableReason: z.string().nullable(),
  }),
  repository: z.object({
    forge: z.string(),
    owner: z.string(),
    name: z.string(),
    revision: z.string(),
  }),
  generation: z.object({
    number: z.number().int().positive(),
    architecture: z.string(),
    resources: z.object({
      cpuMillicores: z.number().int().positive(),
      memoryMiB: z.number().int().positive(),
      storageMiB: z.number().int().positive(),
    }),
    observedState: z.string(),
    lastObservedAt: z.string().nullable(),
  }),
  version: z.number().int().nonnegative(),
  setupFailure: z.object({ code: z.string().min(1).max(128), hasLog: z.boolean() }).nullable().optional(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});
export type CloudWorkspaceDocument = z.infer<
  typeof CloudWorkspaceDocumentSchema
>;
const OptionsSchema = z.object({
  configured: z.boolean(),
  repository: z.object({ owner: z.string(), name: z.string(), defaultBranch: z.string() }).optional(),
  installations: z
    .array(z.object({ id: z.string().uuid(), accountLogin: z.string() }))
    .max(100),
});
export type CloudWorkspaceCreateOptions = z.infer<typeof OptionsSchema>;

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

const AgentGrantsSchema = z.object({
  delegations: z
    .array(
      z.object({
        id: z.string().uuid(),
        ownerUserId: z.string().uuid(),
        kind: z.string(),
        models: z.array(z.string()),
        allModels: z.boolean().optional(),
        expiresAt: z.string().datetime(),
        runtimeQualified: z.boolean().optional(),
        runtimeUpgradeRequired: z.boolean().optional(),
        mcpQualified: z.boolean().optional(),
        nativeCapabilities: CloudNativeCapabilitiesSchema.optional(),
      }),
    )
    .max(100),
});

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

export async function listCloudWorkspaceDocuments(): Promise<
  CloudWorkspaceDocument[]
> {
  const rows: CloudWorkspaceDocument[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page: {
      workspaces: CloudWorkspaceDocument[];
      nextCursor: string | null;
    } = await request(
      `/v1/cloud-workspaces?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      z.object({
        workspaces: z.array(CloudWorkspaceDocumentSchema).max(100),
        nextCursor: z.string().nullable(),
      }),
    );
    rows.push(...page.workspaces);
    cursor = page.nextCursor;
    if (cursor && (seen.has(cursor) || rows.length >= 2_000))
      throw new Error("Cloud workspace list exceeded its page limit");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return rows;
}

export async function getCloudWorkspaceDocument(
  target: CloudWorkspaceTarget,
): Promise<CloudWorkspaceDocument> {
  const { workspace } = await request(
    `/v1/cloud-workspaces/${z.string().uuid().parse(target.workspaceId)}`,
    z.object({ workspace: CloudWorkspaceDocumentSchema }),
  );
  if (
    workspace.id !== target.workspaceId ||
    workspace.organizationId !== target.organizationId
  )
    throw new Error("Cloud workspace response changed identity");
  return workspace;
}

export async function changeCloudWorkspaceLifecycle(
  target: CloudWorkspaceTarget,
  operation: "wake" | "stop" | "archive" | "delete",
  idempotencyKey: string,
  reason?: "interaction",
): Promise<CloudWorkspaceDocument> {
  const { workspace } = await request(
    `${organizationPath(target.organizationId)}/${z.string().uuid().parse(target.workspaceId)}${operation === "delete" ? "" : `/${operation}`}`,
    z.object({ workspace: CloudWorkspaceDocumentSchema }),
    {
      // Additive hint on the existing wake path; server-side cross-device
      // interaction backoff can use it later without changing clients.
      body: operation === "wake" && reason ? { reason } : {},
      idempotencyKey,
      method: operation === "delete" ? "DELETE" : "POST",
    },
  );
  if (
    workspace.id !== target.workspaceId ||
    workspace.organizationId !== target.organizationId
  )
    throw new Error("Cloud lifecycle response changed identity");
  if (operation === "delete") {
    // A successful server deletion remains successful if native cleanup is
    // already retired; runtime authority independently fences new tunnels.
    await forgetCloudWorkspacePortForwarding(target).catch(() => undefined);
  }
  return workspace;
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
  const { organizationId, idempotencyKey, ...body } = input;
  const assertAccount = () => {
    if (epoch !== getOrganizationStoreGeneration())
      throw new Error("Your account changed while creating the cloud workspace");
  };
  const create = () => {
    assertAccount();
    return request(
      organizationPath(organizationId),
      z.object({ workspace: CloudWorkspaceDocumentSchema }),
      { body, idempotencyKey },
    );
  };
  const result = await create();
  assertAccount();
  if (result.workspace.organizationId !== organizationId)
    throw new Error("Cloud creation returned a different organization");
  return result.workspace;
}
