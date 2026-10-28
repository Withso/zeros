// Cloud workspace v2 HTTP API under /v1, so the normal authentication
// middleware always sets c.get("user"). Workspaces are creator-only.
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../authz.js";
import type { CloudV2Capabilities } from "./contract.js";
import type { CloudV2InstalledRepository, CloudV2Store, CloudV2Workspace } from "./store.js";
import { CloudV2DraftSchema, CloudV2RecipeSchema, type CloudV2Computers } from "./computer.js";
import { readCloudV2History } from "./history.js";
import { CLOUD_V2_BRIDGE_PROTOCOL } from "./relay.js";
import { createCloudV2PromptRoutes } from "./prompt-routes.js";
import { CloudSourceTargetSchema, type CloudSourceTarget } from "./source-authority.js";
import { CloudGithubPrService } from "./github-pr-service.js";
import type { CloudGithubConnections } from "./github-connections.js";
import { createCloudGithubConnectionRoutes } from "./github-connection-routes.js";
import type { CloudGithubUnavailableReason } from "./github-connection-contract.js";

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
const branchName = z.string().min(1).max(255).regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]+$/);
const CreateSchema = z.object({
  organizationId: uuid,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),
  baseBranch: branchName.optional(),
  branch: branchName.optional(),
  name: z.string().trim().min(1).max(200).optional(),
}).strict();
const ConnectSchema = z.object({ wake: z.boolean().default(true) }).strict();

export type CloudV2RouteDeps = {
  store: Pick<CloudV2Store, "activeComputer" | "createWorkspace" | "createWorkspaceOnce" | "readCreateReceipt" | "get" | "list" | "requestLifecycle" | "transition" | "issueToken" | "listChats" | "messageWindow"> & Partial<Pick<CloudV2Store, "prompts">>;
  /** Roll out only with a runtime that advertises durable prompt delivery. */
  promptOutbox?: boolean;
  computers: Pick<CloudV2Computers, "requireMember" | "requireAdmin" | "overview" | "enqueue" | "buildConfigured" | "saveRecipe" | "discardRecipe" | "reactivate" | "log" | "logRepositories">;
  /** Repositories the organization's active Cloud Computer has installed; null without one. */
  installedRepositories(organizationId: string): Promise<readonly CloudV2InstalledRepository[] | null>;
  authorizeRepository?(organizationId: string, userId: string, repository: string): Promise<void>;
  authorizeRepositories?(organizationId: string, userId: string, repositories: readonly string[]): Promise<void>;
  authorizeSourceTargets?(organizationId: string, userId: string, targets: readonly CloudSourceTarget[]): Promise<void>;
  authorizeBuildRepository?(organizationId: string, userId: string, buildId: string, repository: string): Promise<CloudSourceTarget>;
  authorizeSource?(workspace: CloudV2Workspace): Promise<void>;
  /** Public wss:// base of the realtime service, e.g. wss://realtime.example.com. */
  bridgeBaseUrl: string;
  /** Default branch names start with this, e.g. "zeros/". */
  branchPrefix?: string;
  github?: { service: Pick<CloudGithubPrService, "execute">; documents(workspaces: readonly CloudV2Workspace[]): Promise<CloudGithubWorkspaceDocument[]> };
  githubConnections?: CloudGithubConnections;
};

function workspaceDocument(workspace: CloudGithubWorkspaceDocument, promptOutbox: boolean) {
  return { ...workspace, placement: "cloud" as const, version: 2 as const,
    capabilities: { ...CLOUD_V2_CAPABILITIES, ...(promptOutbox ? { promptOutbox: 1 as const } : {}), ...(workspace.github ? { githubPullRequests: 1 as const } : {}) } };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
}

export function createCloudV2Routes(deps: CloudV2RouteDeps): Hono {
  const app = new Hono();
  if (deps.githubConnections) app.route("/",createCloudGithubConnectionRoutes(deps.githubConnections));
  const documents = async (workspaces: readonly CloudV2Workspace[]) =>
    (deps.github ? await deps.github.documents(workspaces) : workspaces).map(workspace => workspaceDocument(workspace, deps.promptOutbox === true));
  const document = async (workspace: CloudV2Workspace) => (await documents([workspace]))[0]!;
  const authorizeReceipt = async (response: Record<string, unknown>, userId: string) => {
    const original = z.object({ workspace: z.object({ id: uuid }) }).safeParse(response);
    if (!original.success || !deps.authorizeSource) throw new HttpError(503, "github_unavailable", "Original source access could not be verified.");
    await deps.authorizeSource(await deps.store.get(original.data.workspace.id, userId));
  };
  if (deps.promptOutbox) {
    if (!deps.store.prompts) throw new Error("Cloud prompt store is required");
    app.route("/", createCloudV2PromptRoutes(deps.store.prompts, async (id, userId) => {
      await deps.authorizeSource?.(await deps.store.get(id, userId));
    }));
  }
  const prefix = deps.branchPrefix ?? "zeros/";
  const json = bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: { code: "payload_too_large", message: "Request is too large" } }, 413) });
  const buildRepository = async (organizationId: string, userId: string, buildId: string, entry: CloudV2InstalledRepository) => {
    if (!deps.authorizeBuildRepository) throw new HttpError(503, "github_unavailable", "Original source access could not be verified.");
    const target = CloudSourceTargetSchema.safeParse(await deps.authorizeBuildRepository(organizationId, userId, buildId, entry.repository));
    if (!target.success) throw new HttpError(409, "cloud_source_review_required", "The original repository identity needs verification.");
    return { entry, target: target.data };
  };

  app.post("/v1/cloud-v2/workspaces/:id/github", bodyLimit({ maxSize: 72 * 1024 }), async c => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success || !deps.github) throw new HttpError(404, "not_found", "Cloud pull requests are not available.");
    c.header("Cache-Control", "no-store");
    return c.json(await deps.github.service.execute(id.data, c.get("user").id, await c.req.json().catch(() => null)));
  });

  app.post("/v1/cloud-v2/workspaces", json, async c => {
    const parsed = CreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid cloud workspace request");
    const input = parsed.data;
    await deps.computers.requireMember(input.organizationId, c.get("user").id);
    const key = c.req.header("Idempotency-Key");
    if (key !== undefined && !/^[\x21-\x7e]{1,200}$/.test(key)) throw new HttpError(400, "invalid_request", "Invalid creation key");
    const hash = createHash("sha256").update(JSON.stringify({ ...input, repository: input.repository.toLowerCase() })).digest("hex");
    if (key) {
      const previous = await deps.store.readCreateReceipt(c.get("user").id, key, hash);
      if (previous) {
        await authorizeReceipt(previous.response, c.get("user").id);
        return c.json(previous.response, previous.status);
      }
    }
    const computer = await deps.store.activeComputer(input.organizationId);
    if (!computer) throw new HttpError(409, "cloud_computer_build_required", "Build this organization's Cloud Computer first");
    // Display names can move. Select among the build's authorized ID bindings,
    // retaining the original recipe entry for checkout, setup and branch pins.
    const candidates: Awaited<ReturnType<typeof buildRepository>>[] = [];
    let originalError: HttpError | undefined;
    for (const entry of computer.repositories) {
      try { candidates.push(await buildRepository(input.organizationId, c.get("user").id, computer.buildId, entry)); }
      catch (error) {
        if (!(error instanceof HttpError) || ![403, 404].includes(error.status)) throw error;
        if (entry.repository.toLowerCase() === input.repository.toLowerCase()) originalError = error;
      }
    }
    const selected = candidates.find(({ target }) => target.repository.toLowerCase() === input.repository.toLowerCase())
      ?? candidates.find(({ entry }) => entry.repository.toLowerCase() === input.repository.toLowerCase());
    if (!selected) {
      if (originalError) throw originalError;
      throw new HttpError(409, "repository_not_installed", "Add this repository to the Cloud Computer first");
    }
    const { entry: repository, target } = selected;
    const baseBranch = input.baseBranch ?? repository.defaultBranch;
    if (!baseBranch) throw new HttpError(409, "repository_branch_required", "Select a branch or rebuild the Cloud Computer to record its default branch");
    const id = randomUUID();
    const name = input.name ?? input.repository.split("/")[1]!;
    const create = {
      id, organizationId: input.organizationId, creatorUserId: c.get("user").id, name,
      repository: repository.repository, branch: input.branch ?? `${prefix}${slug(name)}-${id.slice(0, 8)}`,
      baseBranch, computerBuildId: computer.buildId,
      sourceRepositoryId: target.repositoryId,
    };
    if (key) {
      const receipt = await deps.store.createWorkspaceOnce(create, key, hash, workspace => ({ workspace: workspaceDocument(workspace, deps.promptOutbox === true) }));
      // Another request may have committed this key after our initial read.
      await authorizeReceipt(receipt.response, c.get("user").id);
      return c.json(receipt.response, receipt.status);
    }
    const workspace = await deps.store.createWorkspace(create);
    return c.json({ workspace: await document(workspace) }, 201);
  });

  app.get("/v1/cloud-v2/workspaces", async c => {
    const organizationId = uuid.safeParse(c.req.query("organizationId"));
    if (!organizationId.success) throw new HttpError(400, "invalid_request", "organizationId is required");
    const workspaces = await deps.store.list(organizationId.data, c.get("user").id);
    return c.json({ workspaces: await documents(workspaces) });
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
    await deps.authorizeSource?.(workspace);
    if (workspace.state === "deleting" || workspace.state === "failed") throw new HttpError(409, "workspace_unavailable", "This cloud workspace is unavailable");
    if (wake && workspace.state === "stopped") await deps.store.transition(workspace.id, ["stopped"], "starting");
    const ticket = await deps.store.issueToken({ workspaceId: workspace.id, kind: "connect", userId, ttlMs: CONNECT_TICKET_TTL_MS, authority: c.get("user"), wake });
    return c.json({
      url: `${deps.bridgeBaseUrl.replace(/\/+$/, "")}/v2/cloud/workspaces/${workspace.id}/bridge`,
      protocols: [CLOUD_V2_BRIDGE_PROTOCOL, `ticket.${ticket.token}`],
      expiresAt: ticket.expiresAt.toISOString(),
    });
  });

  /** History reads from the control plane's mirror; never wakes the VM. */
  app.post("/v1/cloud-v2/workspaces/:id/history", json, async c => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
    const workspace = await deps.store.get(id.data, c.get("user").id);
    await deps.authorizeSource?.(workspace);
    return c.json({ result: await readCloudV2History(deps.store, workspace.id, await c.req.json().catch(() => null)) });
  });

  for (const action of ["start", "stop", "archive"] as const) {
    app.post(`/v1/cloud-v2/workspaces/:id/${action}`, async c => {
      const id = uuid.safeParse(c.req.param("id"));
      if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
      if (action === "start") await deps.authorizeSource?.(await deps.store.get(id.data, c.get("user").id));
      const { workspace, moved } = await deps.store.requestLifecycle(id.data, c.get("user").id, action);
      return c.json({ workspace: await document(workspace) }, moved ? 202 : 200);
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
