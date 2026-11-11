// Cloud workspace v2 HTTP API under /v1, so the normal authentication
// middleware always sets c.get("user"). Workspaces are creator-only.
import { CloudWorkspaceCreateSchema, createCloudWorkspaceOperations } from "./workspace-create.js";
import { rateLimit } from "../ratelimit.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { CloudWorkspaceSync } from "./workspace-sync/store.js";
import { createCloudWorkspaceSyncRoutes } from "./workspace-sync/routes.js";
import { HttpError } from "../authz.js";
import { securityStreamAuthority } from "../security-events.js";
import type { CloudV2Capabilities } from "./contract.js";
import type { CloudV2InstalledRepository, CloudV2Store, CloudV2Workspace } from "./store.js";
import { CloudV2DraftSchema, CloudV2RecipeSchema, type CloudV2Computers } from "./computer.js";
import { readCloudV2History } from "./history.js";
import { CLOUD_V2_BRIDGE_PROTOCOL } from "./relay.js";
import { createCloudV2PromptRoutes } from "./prompt-routes.js";
import { CloudV2PromptIdSchema, CloudV2SessionNameSchema } from "./prompt-contract.js";
import { type CloudSourceTarget, type CloudSourceContinuation, type CloudSourceProof } from "./source-authority.js";
import { CloudGithubPrService } from "./github-pr-service.js";
import type { CloudGithubConnections } from "./github-connections.js";
import { createCloudGithubConnectionRoutes } from "./github-connection-routes.js";
import type { CloudGithubUnavailableReason } from "./github-connection-contract.js";
import type { CloudEnvironments } from "./environment-store.js";
import { createCloudEnvironmentRoutes } from "./environment-routes.js";
import { RUNTIME_CANARY_HEADER, type RuntimeCanaryAuthority, type RuntimeCanaryStatus } from "./runtime-canary.js";
import { createCloudLocalDeviceRoutes, type CloudLocalDeviceRoutes } from "./local-commands/routes.js";

export type CloudGithubWorkspaceDocument = CloudV2Workspace & {
  checkoutPath?: string;
  githubUnavailableReason?: CloudGithubUnavailableReason;
  github?: { repositoryId: string; branch: string | null; baseBranch: string; headSha: string | null;
    prNumber: number | null; prState: "draft" | "ready" | "merged" | "closed" | null; prUrl: string | null };
};

const CONNECT_TICKET_TTL_MS = 60_000;
export const CLOUD_V2_CAPABILITIES: CloudV2Capabilities = {
  design: false, browser: false, simulators: false, terminal: true, files: true, git: true,
  agents: ["codex", "claude", "cursor"],
};

const uuid = z.string().uuid();
const ORGANIZATION_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const WORKSPACE_NUMBER = /^[1-9][0-9]{0,9}$/;
const MAX_WORKSPACE_NUMBER = 2_147_483_647;
const ConnectSchema = z.object({ wake: z.boolean().default(true) }).strict();
const WarmSchema = z.object({ repository: CloudWorkspaceCreateSchema.shape.repository }).strict();
const ChatEditSchema = z.object({ title: CloudV2SessionNameSchema.transform(value => value.trim()).optional(), archived: z.boolean().optional() })
  .strict().refine(value => value.title !== undefined || value.archived !== undefined);

export type CloudV2RouteDeps = {
  workspaceSync?: CloudWorkspaceSync;
  localDevices?: CloudLocalDeviceRoutes;
  store: Pick<CloudV2Store, "activeComputer" | "createWorkspace" | "createWorkspaceOnce" | "readCreateReceipt" | "get" | "promptContext" | "list" | "requestLifecycle" | "transition" | "issueToken" | "listChats" | "messageWindow" | "searchMessages" | "markActive"> & Partial<Pick<CloudV2Store, "prompts" | "getByNumber" | "chatEdits">>;
  /** Roll out only with a runtime that advertises durable prompt delivery. */
  promptOutbox?: boolean;
  computers: Pick<CloudV2Computers, "requireMember" | "requireAdmin" | "overview" | "enqueue" | "buildConfigured" | "buildSourceTargets" | "saveRecipe" | "discardRecipe" | "reactivate" | "log" | "logRepositories">;
  /** Repositories the organization's active Cloud Computer has installed; null without one. */
  installedRepositories(organizationId: string): Promise<readonly CloudV2InstalledRepository[] | null>;
  authorizeRepository?(organizationId: string, userId: string, repository: string): Promise<void>;
  authorizeRepositories?(organizationId: string, userId: string, repositories: readonly string[]): Promise<void>;
  authorizeSourceTargets?(organizationId: string, userId: string, targets: readonly CloudSourceTarget[]): Promise<void>;
  /** `fresh` skips the reuse of a recently resolved identity. */
  /** fresh reads the identity live; renew renews a verification near expiry. */
  authorizeBuildRepository?(organizationId: string, userId: string, buildId: string, repository: string, options?: { fresh?: boolean; renew?: boolean }): Promise<CloudSourceTarget>;
  remoteHead(organizationId: string, userId: string, target: CloudSourceTarget, branch: string): Promise<string | null>;
  authorizeSource?(workspace: CloudV2Workspace): Promise<void>;
  continueSource?(workspace: CloudV2Workspace, proof?: CloudSourceProof): Promise<CloudSourceContinuation>;
  /** Whether a create may return before its GitHub checks, which the
   * lifecycle then runs before any VM exists (a deploy gate, as for #903). */
  asyncCreate?(): boolean;
  /** Public wss:// base of the realtime service, e.g. wss://realtime.example.com. */
  bridgeBaseUrl: string;
  /** Default branch names start with this, e.g. "zeros/". */
  branchPrefix?: string;
  github?: { service: Pick<CloudGithubPrService, "execute">; documents(workspaces: readonly CloudV2Workspace[]): Promise<CloudGithubWorkspaceDocument[]> };
  githubConnections?: CloudGithubConnections;
  environments?: CloudEnvironments;
  runtimeCanary?: RuntimeCanaryAuthority;
  runtimeCanaryStatus?(userId: string, grantId: string): Promise<RuntimeCanaryStatus | null>;
};

function workspaceDocument(workspace: CloudGithubWorkspaceDocument, promptOutbox: boolean, chatEdits: boolean) {
  return { ...workspace, placement: "cloud" as const, version: 2 as const,
    ...(chatEdits ? { chatEdits: 1 as const } : {}),
    capabilities: { ...CLOUD_V2_CAPABILITIES, ...(promptOutbox ? { promptOutbox: 1 as const } : {}), ...(workspace.github ? { githubPullRequests: 1 as const } : {}) } };
}

export function createCloudV2Routes(deps: CloudV2RouteDeps): Hono {
  const app = new Hono();
  const chatEdits = deps.store.chatEdits;
  if (deps.localDevices) app.route("/", createCloudLocalDeviceRoutes(deps.localDevices));
  if (deps.workspaceSync) app.route("/", createCloudWorkspaceSyncRoutes(deps.workspaceSync));
  if (deps.environments) app.route("/", createCloudEnvironmentRoutes(deps.environments));
  if (deps.githubConnections) app.route("/",createCloudGithubConnectionRoutes(deps.githubConnections));
  const documents = async (workspaces: readonly CloudV2Workspace[]) =>
    (deps.github ? await deps.github.documents(workspaces) : workspaces).map(workspace => workspaceDocument(workspace, deps.promptOutbox === true, !!chatEdits));
  const document = async (workspace: CloudV2Workspace) => (await documents([workspace]))[0]!;
  // A pending create holds only its creator's own request: no VM, worker,
  // token or repository metadata exists before the lifecycle verifies it.
  const continueWorkspace = async (workspace: CloudV2Workspace, proof?: CloudSourceProof) => {
    if (workspace.sourcePending) return;
    if (workspace.state === "running" && deps.continueSource) await deps.continueSource(workspace, proof);
    else await deps.authorizeSource?.(workspace);
  };
  if (deps.promptOutbox) {
    if (!deps.store.prompts) throw new Error("Cloud prompt store is required");
    app.route("/", createCloudV2PromptRoutes(deps.store.prompts, async (id, userId) => {
      const { workspace, proof } = await deps.store.promptContext(id, userId);
      await continueWorkspace(workspace, proof);
    }));
  }
  const json = bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: { code: "payload_too_large", message: "Request is too large" } }, 413) });
  const { create: createWorkspace, buildRepository, computerUnavailable } = createCloudWorkspaceOperations(deps);

  if (chatEdits) app.post("/v1/cloud-v2/workspaces/:id/chats/:chatId/edit", json, async c => {
    c.header("Cache-Control", "no-store");
    const id = uuid.safeParse(c.req.param("id")), chatId = CloudV2PromptIdSchema.safeParse(c.req.param("chatId"));
    if (!id.success || !chatId.success) throw new HttpError(404, "not_found", "Session not found");
    const parsed = ChatEditSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid session edit");
    const user = c.get("user"), workspace = await deps.store.get(id.data, user.id);
    const { title, archived } = parsed.data;
    const patch = { ...(title === undefined ? {} : { title }), ...(archived === undefined ? {} : { archived }) };
    const chat = await chatEdits.apply({ organizationId: workspace.organizationId, userId: user.id }, id.data, chatId.data, patch, async tx => {
      if (user.authentication && !await securityStreamAuthority(tx, user))
        throw new HttpError(401, "session_revoked", "Authentication is no longer current");
    });
    return c.json({ chat });
  });

  app.post("/v1/cloud-v2/workspaces/:id/github", bodyLimit({ maxSize: 72 * 1024 }), async c => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success || !deps.github) throw new HttpError(404, "not_found", "Cloud pull requests are not available.");
    c.header("Cache-Control", "no-store");
    return c.json(await deps.github.service.execute(id.data, c.get("user").id, await c.req.json().catch(() => null)));
  });

  app.get("/v1/cloud-v2/runtime-canaries/:grantId", async c => {
    c.header("Cache-Control", "no-store");
    const id = uuid.safeParse(c.req.param("grantId"));
    const status = id.success && deps.runtimeCanary && deps.runtimeCanaryStatus
      ? await deps.runtimeCanaryStatus(c.get("user").id, id.data) : null;
    if (!status) throw new HttpError(404, "not_found", "Runtime canary not found");
    return c.json(status);
  });

  app.post("/v1/cloud-v2/workspaces", json, async c => {
    const parsed = CloudWorkspaceCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid cloud workspace request");
    const result = await createWorkspace(c.get("user").id, parsed.data, {
      key: c.req.header("Idempotency-Key"), canary: c.req.header(RUNTIME_CANARY_HEADER),
      receiptDocument: workspace => ({ workspace: workspaceDocument(workspace, deps.promptOutbox === true, !!chatEdits) }),
      document: async workspace => ({ workspace: await document(workspace) }),
    });
    return c.json(result.response, result.status);
  });

  app.get("/v1/cloud-v2/workspaces", async c => {
    const organizationId = uuid.safeParse(c.req.query("organizationId"));
    if (!organizationId.success) throw new HttpError(400, "invalid_request", "organizationId is required");
    const workspaces = await deps.store.list(organizationId.data, c.get("user").id);
    return c.json({ workspaces: await documents(workspaces) });
  });

  /** The workspace page's read by its shareable address, `<slug>/w/<n>`. */
  app.get("/v1/cloud-v2/workspaces/by-number/:organization/:number", async c => {
    const organization = c.req.param("organization").toLowerCase(), number = c.req.param("number");
    if (!deps.store.getByNumber || !ORGANIZATION_SLUG.test(organization) || !WORKSPACE_NUMBER.test(number) || Number(number) > MAX_WORKSPACE_NUMBER)
      throw new HttpError(404, "not_found", "Cloud workspace not found");
    return c.json({ workspace: await document(await deps.store.getByNumber(organization, Number(number), c.get("user").id)) });
  });

  app.get("/v1/cloud-v2/workspaces/:id", async c => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
    return c.json({ workspace: await document(await deps.store.get(id.data, c.get("user").id)) });
  });

  /** A one-use, one-minute ticket. Passive reconnects keep stopped VMs stopped;
   * older callers that omit wake retain explicit-open behavior. */
  app.post("/v1/cloud-v2/workspaces/:id/connect", json, async c => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
    const body = await c.req.text();
    const parsed = ConnectSchema.safeParse(body ? await c.req.json().catch(() => null) : {});
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid cloud workspace connection request");
    const { wake } = parsed.data;
    const userId = c.get("user").id;
    const workspace = await deps.store.get(id.data, userId);
    if (!workspace.sourcePending) await deps.authorizeSource?.(workspace);
    const explicitWake = c.req.query("wakePolicy") === "explicit";
    if (explicitWake && (workspace.archivedAt || workspace.state === "stopping" || (!wake && workspace.state === "stopped")))
      throw new HttpError(409, "cloud_workspace_not_running", "This cloud workspace is not ready for a connection");
    if (workspace.state === "deleting" || workspace.state === "failed") throw new HttpError(409, "workspace_unavailable", "This cloud workspace is unavailable");
    if (wake && workspace.state === "stopped") {
      if (!explicitWake) await deps.store.transition(workspace.id, ["stopped"], "starting");
      else if (!await deps.store.transition(workspace.id, ["stopped"], "starting", { unarchived: true })) {
        const current = await deps.store.get(workspace.id, userId);
        if (current.archivedAt || !["creating", "starting", "running"].includes(current.state))
          throw new HttpError(409, "cloud_workspace_not_running", "This cloud workspace is not ready for a connection");
      }
    }
    const ticket = await deps.store.issueToken({ workspaceId: workspace.id, kind: "connect", userId, ttlMs: CONNECT_TICKET_TTL_MS, authority: c.get("user"), wake });
    return c.json({
      url: `${deps.bridgeBaseUrl.replace(/\/+$/, "")}/v2/cloud/workspaces/${workspace.id}/bridge`,
      protocols: [CLOUD_V2_BRIDGE_PROTOCOL, `ticket.${ticket.token}`],
      expiresAt: ticket.expiresAt.toISOString(),
    });
  });

  /** A focused app window counts as activity, like the worker's reports.
   * It keeps a running VM awake and never wakes a stopped one; the store
   * writes at most every 30 seconds per workspace. */
  app.post("/v1/cloud-v2/workspaces/:id/activity", rateLimit("cloud-workspace-activity", 12, 60_000), async c => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
    const workspace = await deps.store.get(id.data, c.get("user").id);
    const running = workspace.state === "running";
    if (running) await deps.store.markActive(workspace.id);
    return c.json({ running });
  });

  /** History reads from the control plane's mirror; never wakes the VM. */
  app.post("/v1/cloud-v2/workspaces/:id/history", json, async c => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
    const workspace = await deps.store.get(id.data, c.get("user").id);
    await continueWorkspace(workspace);
    return c.json({ result: await readCloudV2History(deps.store, workspace.id, await c.req.json().catch(() => null)) });
  });

  for (const action of ["start", "stop", "archive", "restart"] as const) {
    app.post(`/v1/cloud-v2/workspaces/:id/${action}`, async c => {
      const id = uuid.safeParse(c.req.param("id"));
      if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
      if (action === "start" || action === "restart") await deps.authorizeSource?.(await deps.store.get(id.data, c.get("user").id));
      const { workspace, moved } = await deps.store.requestLifecycle(id.data, c.get("user").id, action);
      return c.json({ workspace: await document(workspace) }, moved || action === "restart" ? 202 : 200);
    });
  }

  app.delete("/v1/cloud-v2/workspaces/:id", async c => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
    const workspace = await deps.store.get(id.data, c.get("user").id);
    const moved = await deps.store.transition(workspace.id,
      ["creating", "running", "stopping", "stopped", "starting", "failed"], "deleting");
    return c.json({ workspace: await document(moved ?? workspace) }, 202);
  });

  const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  // Current apps build the configured recipe at the revision they show; older
  // apps send the repositories, which also become the configured recipe.
  const BuildSchema = z.union([
    z.object({ revision }).strict(),
    z.object({ repositories: CloudV2RecipeSchema.shape.repositories }).strict(),
  ]);
  const RecipeSchema = z.object({ repositories: CloudV2DraftSchema, revision }).strict();
  const org = (value: string | undefined) => {
    const parsed = uuid.safeParse(value);
    if (!parsed.success) throw new HttpError(404, "not_found", "Organization not found");
    return parsed.data;
  };

  app.get("/v1/cloud-v2/organizations/:org/computer/repositories", async c => {
    const organizationId = org(c.req.param("org"));
    await deps.computers.requireMember(organizationId, c.get("user").id);
    const computer = await deps.store.activeComputer(organizationId);
    if (!computer) {
      const error = await computerUnavailable(organizationId, c.get("user").id);
      if (error.code === "cloud_computer_rebuild_required") throw error;
    }
    const repositories = computer?.repositories ?? null;
    const allowed: CloudV2InstalledRepository[] = [];
    for (const entry of repositories ?? []) {
      try {
        const { target } = await buildRepository(organizationId, c.get("user").id, computer!.buildId, entry);
        allowed.push({ ...entry, repository: target.repository });
      }
      catch (error) { if (!(error instanceof HttpError) || ![403,404].includes(error.status)) throw error; }
    }
    return c.json({ repositories: repositories === null ? null : allowed });
  });

  // The Create page calls this on intent for its selected repository, so the
  // create request seconds later reuses a fresh GitHub verification.
  app.post("/v1/cloud-v2/organizations/:org/computer/repositories/warm", json, async c => {
    const organizationId = org(c.req.param("org")), userId = c.get("user").id;
    const parsed = WarmSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid repository");
    await deps.computers.requireMember(organizationId, userId);
    const computer = await deps.store.activeComputer(organizationId);
    const entry = computer?.repositories.find(value => value.repository.toLowerCase() === parsed.data.repository.toLowerCase());
    if (!computer || !entry) throw new HttpError(404, "repository_not_installed", "Add this repository to the Cloud Computer first");
    await buildRepository(organizationId, userId, computer.buildId, entry, { renew: true });
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true });
  });

  app.get("/v1/cloud-v2/organizations/:org/computer", async c => {
    const organizationId = org(c.req.param("org"));
    await deps.computers.requireAdmin(organizationId, c.get("user").id);
    return c.json(await deps.computers.overview(organizationId));
  });

  app.post("/v1/cloud-v2/organizations/:org/computer/builds", json, async c => {
    const organizationId = org(c.req.param("org"));
    await deps.computers.requireAdmin(organizationId, c.get("user").id);
    const parsed = BuildSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid Cloud Computer build");
    const build = "revision" in parsed.data
      ? await deps.computers.buildConfigured(organizationId, c.get("user").id, parsed.data.revision)
      : await deps.computers.enqueue(organizationId, c.get("user").id, { repositories: parsed.data.repositories }, { configure: true });
    return c.json({ build }, 202);
  });

  /** Saves the configured repositories; a build makes them live. */
  app.put("/v1/cloud-v2/organizations/:org/computer/recipe", json, async c => {
    const organizationId = org(c.req.param("org"));
    await deps.computers.requireAdmin(organizationId, c.get("user").id);
    const parsed = RecipeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid Cloud Computer repositories");
    return c.json(await deps.computers.saveRecipe(organizationId, c.get("user").id, parsed.data.repositories, parsed.data.revision));
  });

  /** Discards unbuilt changes: the configured repositories return to the live build's. */
  app.post("/v1/cloud-v2/organizations/:org/computer/recipe/discard", json, async c => {
    const organizationId = org(c.req.param("org"));
    await deps.computers.requireAdmin(organizationId, c.get("user").id);
    const parsed = z.object({ revision }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid Cloud Computer request");
    return c.json(await deps.computers.discardRecipe(organizationId, c.get("user").id, parsed.data.revision));
  });

  app.post("/v1/cloud-v2/organizations/:org/computer/builds/:build/activate", async c => {
    const organizationId = org(c.req.param("org"));
    await deps.computers.requireAdmin(organizationId, c.get("user").id);
    const build = uuid.safeParse(c.req.param("build"));
    if (!build.success) throw new HttpError(404, "not_found", "Cloud Computer build not found");
    return c.json({ build: await deps.computers.reactivate(organizationId, c.get("user").id, build.data) }, 202);
  });

  app.get("/v1/cloud-v2/organizations/:org/computer/builds/:build/log", async c => {
    const organizationId = org(c.req.param("org"));
    await deps.computers.requireAdmin(organizationId, c.get("user").id);
    const build = uuid.safeParse(c.req.param("build"));
    if (!build.success) throw new HttpError(404, "not_found", "Cloud Computer build not found");
    const sources = await deps.computers.logRepositories(organizationId, build.data);
    if (!deps.authorizeSourceTargets) throw new HttpError(503, "github_unavailable", "Repository access could not be verified.");
    await deps.authorizeSourceTargets(organizationId, c.get("user").id, sources);
    const log = await deps.computers.log(organizationId, build.data);
    await deps.computers.requireAdmin(organizationId, c.get("user").id);
    // Database reads may wait, too. Revalidate the whole source set before
    // releasing source-bearing output, retaining the original lease deadlines.
    await deps.authorizeSourceTargets(organizationId, c.get("user").id, sources);
    return c.text(log);
  });

  return app;
}
