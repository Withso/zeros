import { z } from "zod";
import { getSession } from "../features/auth/auth-store";
import {
  CONTROL_PLANE_URL,
  ControlPlaneError,
} from "../features/team/control-plane";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";

export const CloudWorkspaceDocumentSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  teamId: z.string().uuid(),
  name: z.string().min(1).max(120),
  createdBy: z.string().uuid(),
  placement: z.literal("cloud"),
  status: z.string().min(1).max(64),
  capabilities: z.object({
    canWrite: z.boolean(),
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
  input?: { body: unknown; idempotencyKey: string; method?: "POST" | "DELETE" | "PUT" },
): Promise<T> {
  if (!CONTROL_PLANE_URL)
    throw new Error("Cloud workspaces are not configured");
  // Catalog consumers do not need to initialize the React auth/team tree.
  const { getOrganizationStoreGeneration } =
    await import("../features/team/team-store");
  const epoch = getOrganizationStoreGeneration();
  const session = await getSession();
  if (epoch !== getOrganizationStoreGeneration())
    throw new Error("Your account changed while loading cloud workspaces");
  if (!session) throw new Error("Sign in to use cloud workspaces");
  const response = await fetch(`${CONTROL_PLANE_URL}${path}`, {
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

const AgentGrantsSchema = z.object({
  delegations: z
    .array(
      z.object({
        id: z.string().uuid(),
        kind: z.string(),
        models: z.array(z.string()),
        expiresAt: z.string().datetime(),
      }),
    )
    .max(100),
});

/** Metadata only. Device credentials never become implicit cloud grants. */
export async function cloudAgentGrant(
  target: CloudWorkspaceTarget,
  agentId: string,
  model: string,
): Promise<string> {
  const delegations = await cloudAgentDelegations(target);
  const grant = delegations.find(
    (row) => row.kind.startsWith(`${agentId}-`) && row.models.includes(model),
  );
  if (!grant)
    throw new Error(
      "This agent and model need a cloud credential authorized for this workspace. Configure that authorization before sending.",
    );
  return grant.id;
}

export async function cloudAgentDelegations(target: CloudWorkspaceTarget) {
  const result = await request(
    `/v1/cloud-workspaces/${z.string().uuid().parse(target.workspaceId)}/agent-credentials`,
    AgentGrantsSchema,
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
): Promise<CloudWorkspaceDocument> {
  const { workspace } = await request(
    `${organizationPath(target.organizationId)}/${z.string().uuid().parse(target.workspaceId)}${operation === "delete" ? "" : `/${operation}`}`,
    z.object({ workspace: CloudWorkspaceDocumentSchema }),
    {
      body: {},
      idempotencyKey,
      method: operation === "delete" ? "DELETE" : "POST",
    },
  );
  if (
    workspace.id !== target.workspaceId ||
    workspace.organizationId !== target.organizationId
  )
    throw new Error("Cloud lifecycle response changed identity");
  return workspace;
}

export function getCloudWorkspaceCreateOptions(
  organizationId: string,
  owner: string,
  repository?: string,
): Promise<CloudWorkspaceCreateOptions> {
  return request(
    `${organizationPath(organizationId)}/create-options?owner=${encodeURIComponent(owner)}${repository ? `&repository=${encodeURIComponent(repository)}` : ""}`,
    OptionsSchema,
  );
}

export async function createCloudWorkspaceDocument(input: {
  organizationId: string;
  name?: string;
  teamId?: string;
  repository: {
    forge: "github.com";
    owner: string;
    name: string;
    revision: string;
    githubInstallationId: string;
  };
  idempotencyKey: string;
}): Promise<CloudWorkspaceDocument> {
  const { organizationId, idempotencyKey, ...body } = input;
  const result = await request(
    organizationPath(organizationId),
    z.object({ workspace: CloudWorkspaceDocumentSchema }),
    { body, idempotencyKey },
  );
  if (result.workspace.organizationId !== organizationId)
    throw new Error("Cloud creation returned a different organization");
  return result.workspace;
}
