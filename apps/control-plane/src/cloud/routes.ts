// Cloud workspace v2 HTTP API under /v1, so the normal authentication
// middleware always sets c.get("user"). Execution authority belongs to the persisted rollout mode.
import { CloudV2InstallScriptSchema } from "./computer.js";
import type { CloudProjects } from "./projects.js";
import { createProjectRoutes, type ProjectRouteDeps } from "./project-routes.js";
import type { CloudExecutionContexts } from "./execution/store.js";
import { CloudWorkspaceCreateSchema, CloudWorkspaceRepositoryCreateSchema, createCloudWorkspaceOperations } from "./workspace-create.js";
import { rateLimit } from "../ratelimit.js";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { CLOUD_CLIENT_ROLLOVER_FEATURE } from "./client-auth-contract.js";
import { WORKSPACE_REPOSITORIES_FEATURE } from "./contract.js";
import type { CloudWorkspaceSync } from "./workspace-sync/store.js";
import { createCloudWorkspaceSyncRoutes } from "./workspace-sync/routes.js";
import type { CloudWorkspaceGithubReadTokens } from "./workspace-sync/github-read-token.js";
import { createCloudWorkspaceGithubReadTokenRoutes } from "./workspace-sync/github-read-token-routes.js";
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
import type { RuntimeCanaryAdmission } from "./runtime-canary.js";
import type { RuntimeCapabilities } from "./runtime-capabilities.js";
import { createCloudLocalDeviceRoutes, type CloudLocalDeviceRoutes } from "./local-commands/routes.js";
import { createCloudTeamRoutes } from "./team-sharing/routes.js";
import type { CloudTeamSharing } from "./team-sharing/store.js";
import { TEAM_SHARING_HEADER, TEAM_OWNERSHIP_HEADER, teamOwnershipRequired } from "./team-sharing/contract.js";

export type CloudGithubWorkspaceDocument = CloudV2Workspace & {
  checkoutPath?: string;
  githubUnavailableReason?: CloudGithubUnavailableReason;
  github?: CloudGithubRepositoryState;
  /** A workspace of several repositories: the project folder, and each repository with its own checkout and pull request. */
  root?: string;
  repositories?: { repository: string; checkoutPath: string; branch: string; baseBranch: string; github?: CloudGithubRepositoryState }[];
  /** The project the workspace was created from, by its current name. */
  project?: { id: string; name: string };
};
export type CloudGithubRepositoryState = { repositoryId: string; branch: string | null; baseBranch: string; headSha: string | null;
  prNumber: number | null; prState: "draft" | "ready" | "merged" | "closed" | null; prUrl: string | null };

const CONNECT_TICKET_TTL_MS = 60_000;
/** A released desktop shows this as its open failure's description. */
export const CLIENT_UPDATE_REQUIRED_MESSAGE = "Update Zeros to open this workspace.";
export const CLOUD_V2_CAPABILITIES: CloudV2Capabilities = {
  design: false, browser: false, simulators: false, terminal: true, files: true, git: true,
  agents: ["codex", "claude", "cursor"],
};

const uuid = z.string().uuid();
const ORGANIZATION_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const WORKSPACE_NUMBER = /^[1-9][0-9]{0,9}$/;
const MAX_WORKSPACE_NUMBER = 2_147_483_647;
const ConnectSchema = z.object({ wake: z.boolean().default(true) }).strict();
const WarmSchema = z.object({ repository: CloudWorkspaceRepositoryCreateSchema.shape.repository }).strict();
const ChatEditSchema = z.object({ title: CloudV2SessionNameSchema.transform(value => value.trim()).optional(), archived: z.boolean().optional() })
  .strict().refine(value => value.title !== undefined || value.archived !== undefined);

export type CloudV2RouteDeps = {
  connectReady?: boolean;
  actingUserDefault?: boolean;
  activeCreateRuntime?(canary?: RuntimeCanaryAdmission): Promise<RuntimeCapabilities>;
  teamSharing?: CloudTeamSharing;
  execution?: CloudExecutionContexts;
  workspaceSync?: CloudWorkspaceSync;
  workspaceGithubReadTokens?: CloudWorkspaceGithubReadTokens;
  localDevices?: CloudLocalDeviceRoutes;
  store: Pick<CloudV2Store, "activeComputer" | "createWorkspace" | "createWorkspaceOnce" | "readCreateReceipt" | "get" | "promptContext" | "list" | "requestLifecycle" | "transition" | "issueToken" | "listChats" | "messageWindow" | "searchMessages" | "messageRange" | "messageSince" | "markActive"> & Partial<Pick<CloudV2Store, "prompts" | "getByNumber" | "chatEdits" | "requestExecutionLifecycle" | "dismissLostWork">>;
  /** Roll out only with a runtime that advertises durable prompt delivery. */
  promptOutbox?: boolean;
  computers: Pick<CloudV2Computers, "requireMember" | "requireAdmin" | "overview" | "enqueue" | "buildConfigured" | "buildSourceTargets" | "saveRecipe" | "discardRecipe" | "reactivate" | "log" | "logRepositories">
    & Partial<Pick<CloudV2Computers, "saveInstallScript">>;
  /** Projects (ready copies on): the Cloud Computer is tools only, and creates,
   * repository lists and the old recipe are answered from projects. */
  projects?: Pick<CloudProjects, "get" | "forRepository" | "oneRepositoryProjects" | "syncRecipe">;
  /** Projects on: a project create's GitHub checks as its creator (github-composition projectAccess). */
  projectAccess?(organizationId: string, userId: string, repositories: readonly { repository: string; repositoryId: string; baseBranch?: string | null }[]):
    Promise<{ repository: string; repositoryId: string; baseBranch: string; baseCommit: string }[]>;
  /** The caller's own GitHub reading a repository: its identity and default branch. */
  resolveMemberRepository?(organizationId: string, userId: string, repository: string): Promise<{ repository: string; repositoryId: string; defaultBranch: string }>;
  /** Projects' and GitHub connections' own routes. */
  projectRoutes?: ProjectRouteDeps;
  /** Present only when ready copies are on (CloudV2Config.readyCopies). */
  readyCopies?: {
    /** Per project id. */
    status(organizationId: string, viewerUserId?: string | null): Promise<ReadonlyMap<string, "ready" | "building" | null>>;
    /** Organization projects' failed copies, for the Cloud Computer page. */
    failures(organizationId: string): Promise<{ projectId: string; project: string; repository: string | null; step: string | null; generation: number;
      reason: string; detail: string | null; finishedAt: string; failures?: number; nextRetryAt?: string | null }[]>;
    /** A released desktop's recipe save rebuilds each changed project's copy alone. */
    changed?(organizationId: string, projectId: string, change: "project_created" | "repositories_changed" | "setup_changed" | "branch_changed"): Promise<void>;
  };
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
  const connections = new WeakMap<Context, Promise<Awaited<ReturnType<CloudExecutionContexts["connectionWorkspace"]>>>>();
  const activeWorkspaces = new WeakMap<Context, Promise<boolean>>();
  const activeWorkspace = (c: Context, id: string) => {
    let pending = activeWorkspaces.get(c);
    if (!pending) {
      pending = deps.execution?.active(id) ?? Promise.resolve(false);
      activeWorkspaces.set(c, pending);
    }
    return pending;
  };
  const connectionWorkspace = (c: Context, id: string) => {
    let pending = connections.get(c);
    if (!pending) {
      pending = deps.execution ? deps.execution.connectionWorkspace(id, c.get("user")) : Promise.resolve(undefined);
      connections.set(c, pending);
    }
    return pending;
  };
  if (deps.teamSharing) app.route("/",createCloudTeamRoutes(deps.teamSharing,value => workspaceDocument(value,deps.promptOutbox === true,!!chatEdits),
    async (c,id) => c.req.path.endsWith("/connect") ? Boolean(await connectionWorkspace(c,id)) : activeWorkspace(c,id)));
  if (deps.localDevices) app.route("/", createCloudLocalDeviceRoutes(deps.localDevices));
  if (deps.workspaceSync) app.route("/", createCloudWorkspaceSyncRoutes(deps.workspaceSync));
  if (deps.workspaceGithubReadTokens) app.route("/", createCloudWorkspaceGithubReadTokenRoutes(deps.workspaceGithubReadTokens));
  if (deps.environments) app.route("/", createCloudEnvironmentRoutes(deps.environments));
  if (deps.githubConnections) app.route("/",createCloudGithubConnectionRoutes(deps.githubConnections));
  if (deps.projectRoutes) app.route("/", createProjectRoutes(deps.projectRoutes));
  const documents = async (workspaces: readonly CloudV2Workspace[]) =>
    (deps.github ? await deps.github.documents(workspaces) : workspaces).map(workspace => workspaceDocument(workspace, deps.promptOutbox === true, !!chatEdits));
  const document = async (workspace: CloudV2Workspace) => {
    const value = (await documents([workspace]))[0];
    if (!value) throw new HttpError(404, "not_found", "Cloud workspace not found");
    return value;
  };
  if (deps.promptOutbox) {
    if (!deps.store.prompts) throw new Error("Cloud prompt store is required");
    app.route("/", createCloudV2PromptRoutes(deps.store.prompts, async (id, userId) => {
      await deps.store.promptContext(id, userId);
    }, activeWorkspace));
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
    try { return c.json({ workspace: await document(await deps.store.getByNumber(organization, Number(number), c.get("user").id)) }); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404)
        await deps.teamSharing?.requireOwnershipAfterHiddenRead(c.get("user"), { organization, number: Number(number) });
      throw error;
    }
  });

  app.get("/v1/cloud-v2/workspaces/:id", async c => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
    try { return c.json({ workspace: await document(await deps.store.get(id.data, c.get("user").id)) }); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404)
        await deps.teamSharing?.requireOwnershipAfterHiddenRead(c.get("user"), { id: id.data });
      throw error;
    }
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
    const acting = await connectionWorkspace(c, id.data);
    const active = Boolean(acting);
    const workspace = acting?.workspace ?? await deps.store.get(id.data, userId);
    const clientFeatures = c.req.header("X-Zeros-Client-Features")?.split(",").map(value => value.trim()) ?? [];
    // A desktop that does not declare several repositories would root at the first
    // checkout while the chats live in the project folder: refused before any wake or ticket.
    if (workspace.folder && !clientFeatures.includes(WORKSPACE_REPOSITORIES_FEATURE))
      throw new HttpError(409, "client_update_required", CLIENT_UPDATE_REQUIRED_MESSAGE);
    const explicitWake = c.req.query("wakePolicy") === "explicit";
    if (explicitWake && (workspace.archivedAt || workspace.state === "stopping" || (!wake && workspace.state === "stopped")))
      throw new HttpError(409, "cloud_workspace_not_running", "This cloud workspace is not ready for a connection");
    if (workspace.state === "deleting" || workspace.state === "failed") throw new HttpError(409, "workspace_unavailable", "This cloud workspace is unavailable");
    if (wake && workspace.state === "stopped") {
      if (acting) await deps.store.requestExecutionLifecycle!(workspace.id, userId, "start", acting.proof, c.get("user"), explicitWake);
      else if (!explicitWake) await deps.store.transition(workspace.id, ["stopped"], "starting");
      else if (!await deps.store.transition(workspace.id, ["stopped"], "starting", { unarchived: true })) {
        const current = await deps.store.get(workspace.id, userId);
        if (current.archivedAt || !["creating", "starting", "running"].includes(current.state))
          throw new HttpError(409, "cloud_workspace_not_running", "This cloud workspace is not ready for a connection");
      }
    }
    let clientInstanceId: string | undefined;
    if (active && clientFeatures.includes(CLOUD_CLIENT_ROLLOVER_FEATURE)) {
      const instance = uuid.safeParse(c.req.header("X-Zeros-Client-Instance"));
      if (!instance.success) throw new HttpError(400, "invalid_request", "Invalid cloud connection binding");
      clientInstanceId = instance.data;
    }
    const ticket = active ? await deps.execution!.clients.ticket(workspace.id, c.get("user"), wake, clientInstanceId,
      wake && workspace.state === "stopped" ? undefined : acting!.proof) : await deps.store.issueToken({ workspaceId: workspace.id, kind: "connect", userId, ttlMs: CONNECT_TICKET_TTL_MS, authority: c.get("user"), wake });
    return c.json({
      url: `${deps.bridgeBaseUrl.replace(/\/+$/, "")}/v2/cloud/workspaces/${workspace.id}/bridge`,
      protocols: [CLOUD_V2_BRIDGE_PROTOCOL, `ticket.${ticket.token}`],
      expiresAt: ticket.expiresAt.toISOString(),
      ...(active || deps.connectReady ? { features: [...(active ? ["relay-presence-v1"] : []), ...(deps.connectReady ? ["connect-ready-v1"] : [])] } : {}),
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

  /** Retention: the person has seen that a restore came back without some work (`lostWork`). */
  if (deps.store.dismissLostWork) app.post("/v1/cloud-v2/workspaces/:id/lost-work/dismiss", async c => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
    return c.json({ workspace: await document(await deps.store.dismissLostWork!(id.data, c.get("user").id)) });
  });

  /** History reads from the control plane's mirror; never wakes the VM. */
  app.post("/v1/cloud-v2/workspaces/:id/history", json, async c => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
    const workspace = await deps.store.get(id.data, c.get("user").id);
    return c.json({ result: await readCloudV2History(deps.store, workspace.id, await c.req.json().catch(() => null)) });
  });

  for (const action of ["start", "stop", "archive", "restart"] as const) {
    app.post(`/v1/cloud-v2/workspaces/:id/${action}`, async c => {
      const id = uuid.safeParse(c.req.param("id"));
      if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
      const user = c.get("user"), active = await activeWorkspace(c, id.data);
      const ownership = c.req.header(TEAM_SHARING_HEADER) === "1" && c.req.header(TEAM_OWNERSHIP_HEADER) === "1";
      const { workspace, moved } = active ? await deps.store.requestExecutionLifecycle!(id.data, user.id, action, undefined, user, false, ownership)
        : await deps.store.requestLifecycle(id.data, user.id, action);
      if (active && ownership && deps.teamSharing) return c.json({
        workspace: workspaceDocument(await deps.teamSharing.lifecycleDocument(id.data,user),deps.promptOutbox === true,!!chatEdits),
        teamSharing: 1,teamOwnership: 1,
      },moved || action === "restart" ? 202 : 200);
      if (workspace.creatorUserId === null) throw teamOwnershipRequired();
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

  /** Projects (ready copies on): what a released desktop's Create lists is each
   * one-repository project the caller may use whose repository they can read:
   * the organization's, then their own, marked. A multi-repository project is
   * never offered to it. Null without a live base, as without a Cloud Computer. */
  const projectRepositories = async (organizationId: string, userId: string) => {
    const projects = deps.projects!, computer = await deps.store.activeComputer(organizationId);
    if (!computer) {
      const error = await computerUnavailable(organizationId, userId);
      if (error.code === "cloud_computer_rebuild_required") throw error;
      return null;
    }
    const status = await deps.readyCopies?.status(organizationId, userId);
    const listed: (CloudV2InstalledRepository & { level: "shared" | "private"; projectId: string; readyCopy?: "ready" | "building" | null })[] = [];
    for (const project of await projects.oneRepositoryProjects(organizationId, userId)) {
      const entry = project.repositories[0]!;
      if (listed.some(row => row.repository === entry.repository)) continue;
      if (deps.authorizeSourceTargets) {
        try { await deps.authorizeSourceTargets(organizationId, userId, [{ repository: entry.repository, repositoryId: entry.repositoryId }]); }
        catch (error) { if (!(error instanceof HttpError) || ![403, 404].includes(error.status)) throw error; continue; }
      }
      listed.push({ repository: entry.repository, defaultBranch: entry.defaultBranch, level: project.level === "organization" ? "shared" : "private",
        projectId: project.id, ...(status ? { readyCopy: status.get(project.id) ?? null } : {}) });
    }
    return listed;
  };

  app.get("/v1/cloud-v2/organizations/:org/computer/repositories", async c => {
    const organizationId = org(c.req.param("org"));
    await deps.computers.requireMember(organizationId, c.get("user").id);
    if (deps.projects) return c.json({ repositories: await projectRepositories(organizationId, c.get("user").id) });
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
    if (deps.projects) {
      const project = await deps.projects.forRepository(organizationId, userId, parsed.data.repository);
      if (!project || !deps.authorizeSourceTargets) throw new HttpError(404, "repository_not_in_project", "Add this repository to a project first.");
      const entry = project.repositories[0]!;
      await deps.authorizeSourceTargets(organizationId, userId, [{ repository: entry.repository, repositoryId: entry.repositoryId }]);
      c.header("Cache-Control", "no-store");
      return c.json({ ok: true });
    }
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
    const overview = await deps.computers.overview(organizationId);
    if (!deps.projects) return c.json(overview);
    // Tools only: its repositories, for released desktops, are the one-repository
    // organization projects; each organization project's copy failure, a path at most.
    return c.json({ ...overview, recipe: { repositories: await projectRecipe(organizationId) },
      ...(deps.readyCopies ? { readyCopyFailures: await deps.readyCopies.failures(organizationId) } : {}) });
  });

  /** Ready copies: members read the install script; owners and admins edit it. */
  app.get("/v1/cloud-v2/organizations/:org/computer/install-script", async c => {
    const organizationId = org(c.req.param("org"));
    if (!deps.readyCopies) throw new HttpError(404, "not_found", "Not found");
    await deps.computers.requireMember(organizationId, c.get("user").id);
    const overview = await deps.computers.overview(organizationId);
    return c.json({ installScript: overview.installScript ?? null, recipeRevision: overview.recipeRevision });
  });

  app.put("/v1/cloud-v2/organizations/:org/computer/install-script", json, async c => {
    const organizationId = org(c.req.param("org"));
    if (!deps.readyCopies || !deps.computers.saveInstallScript) throw new HttpError(404, "not_found", "Not found");
    await deps.computers.requireAdmin(organizationId, c.get("user").id);
    const parsed = z.object({ installScript: CloudV2InstallScriptSchema.nullable(), revision }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid install script");
    return c.json(await deps.computers.saveInstallScript(organizationId, c.get("user").id, parsed.data.installScript, parsed.data.revision));
  });

  /** The old recipe as released desktops read it: one-repository organization projects. */
  const projectRecipe = async (organizationId: string) =>
    (await deps.projects!.oneRepositoryProjects(organizationId, null)).filter(project => project.level === "organization").map(project => {
      const entry = project.repositories[0]!;
      return { repository: entry.repository, ...(entry.defaultBranch ? { ref: entry.defaultBranch } : {}), ...(entry.setup ? { setup: entry.setup } : {}),
        ...(entry.setupScript ? { setupScript: entry.setupScript } : {}) };
    });
  /** A released desktop saved the recipe: its entries become one-repository
   * organization projects, each rebuilding its own copy; the Cloud Computer keeps none.
   * Checked against the revision the editor was shown, which every organization
   * project write moves; null (a build request without one) never removes a project. */
  const saveProjectRecipe = async (organizationId: string, userId: string, entries: readonly { repository: string; ref?: string | undefined;
    setup?: string | undefined; setupScript?: string | undefined }[], revision: number | null) => {
    if (!deps.resolveMemberRepository) throw new HttpError(503, "github_unavailable", "Repository identity could not be verified.");
    const current = await deps.projects!.oneRepositoryProjects(organizationId, null);
    const resolved = await Promise.all(entries.map(async entry => {
      const kept = current.find(project => project.level === "organization" && project.repositories[0]!.repository === entry.repository.toLowerCase());
      const repositoryId = kept?.repositories[0]!.repositoryId ?? (await deps.resolveMemberRepository!(organizationId, userId, entry.repository)).repositoryId;
      return { repository: entry.repository.toLowerCase(), repositoryId, ...(entry.ref ? { ref: entry.ref } : {}), ...(entry.setup ? { setup: entry.setup } : {}),
        ...(entry.setupScript ? { setupScript: entry.setupScript } : {}) };
    }));
    const saved = await deps.projects!.syncRecipe(organizationId, userId, resolved, revision);
    for (const { projectId, change } of saved.changed)
      await deps.readyCopies?.changed?.(organizationId, projectId, change).catch(() => undefined);
    return saved.revision;
  };

  app.post("/v1/cloud-v2/organizations/:org/computer/builds", json, async c => {
    const organizationId = org(c.req.param("org"));
    await deps.computers.requireAdmin(organizationId, c.get("user").id);
    const parsed = BuildSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid Cloud Computer build");
    if ("repositories" in parsed.data && deps.projects) await saveProjectRecipe(organizationId, c.get("user").id, parsed.data.repositories, null);
    else if ("repositories" in parsed.data && !parsed.data.repositories.length) throw new HttpError(400, "invalid_request", "Invalid Cloud Computer build");
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
    if (deps.projects) {
      const recipeRevision = await saveProjectRecipe(organizationId, c.get("user").id, parsed.data.repositories, parsed.data.revision);
      return c.json({ recipe: { repositories: await projectRecipe(organizationId) }, recipeRevision });
    }
    const saved = await deps.computers.saveRecipe(organizationId, c.get("user").id, parsed.data.repositories, parsed.data.revision);
    return c.json(saved);
  });

  /** Discards unbuilt changes: the configured repositories return to the live build's. */
  app.post("/v1/cloud-v2/organizations/:org/computer/recipe/discard", json, async c => {
    const organizationId = org(c.req.param("org"));
    await deps.computers.requireAdmin(organizationId, c.get("user").id);
    const parsed = z.object({ revision }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid Cloud Computer request");
    // Projects: saves are live at once, so there is nothing unbuilt to discard.
    if (deps.projects) {
      const overview = await deps.computers.overview(organizationId);
      return c.json({ recipe: { repositories: await projectRecipe(organizationId) }, recipeRevision: overview.recipeRevision });
    }
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
