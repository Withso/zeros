// Cloud workspace v2 HTTP API under /v1, so the normal authentication
// middleware always sets c.get("user"). Workspaces are creator-only.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { HttpError } from "../authz.js";
import type { CloudV2Capabilities } from "./contract.js";
import type { CloudV2Store, CloudV2Workspace } from "./store.js";
import { CloudV2RecipeSchema, type CloudV2Computers } from "./computer.js";
import { CLOUD_V2_BRIDGE_PROTOCOL } from "./relay.js";

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
  baseBranch: branchName.default("main"),
  branch: branchName.optional(),
  name: z.string().trim().min(1).max(200).optional(),
}).strict();

export type CloudV2RouteDeps = {
  store: Pick<CloudV2Store, "createWorkspace" | "get" | "list" | "transition" | "issueToken" | "listChats" | "windowMessages">;
  computers: Pick<CloudV2Computers, "requireAdmin" | "overview" | "enqueue" | "reactivate" | "log">;
  /** Boat named snapshot of the Zeros v2 base image; builds start from it. */
  baseSnapshot: string | null;
  /** Repositories the organization's active Cloud Computer has installed; null without one. */
  installedRepositories(organizationId: string): Promise<readonly string[] | null>;
  /** Public wss:// base of the realtime service, e.g. wss://realtime.example.com. */
  bridgeBaseUrl: string;
  /** Default branch names start with this, e.g. "zeros/". */
  branchPrefix?: string;
};

function document(workspace: CloudV2Workspace) {
  return { ...workspace, placement: "cloud" as const, version: 2 as const, capabilities: CLOUD_V2_CAPABILITIES };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
}

export function createCloudV2Routes(deps: CloudV2RouteDeps): Hono {
  const app = new Hono();
  const prefix = deps.branchPrefix ?? "zeros/";
  const json = bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: { code: "payload_too_large", message: "Request is too large" } }, 413) });

  app.post("/v1/cloud-v2/workspaces", json, async c => {
    const parsed = CreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid cloud workspace request");
    const input = parsed.data;
    const installed = await deps.installedRepositories(input.organizationId);
    if (!installed) throw new HttpError(409, "cloud_computer_build_required", "Build this organization's Cloud Computer first");
    if (!installed.some(repo => repo.toLowerCase() === input.repository.toLowerCase()))
      throw new HttpError(409, "repository_not_installed", "Add this repository to the Cloud Computer first");
    const id = randomUUID();
    const name = input.name ?? input.repository.split("/")[1]!;
    const workspace = await deps.store.createWorkspace({
      id, organizationId: input.organizationId, creatorUserId: c.get("user").id, name,
      repository: input.repository, branch: input.branch ?? `${prefix}${slug(name)}-${id.slice(0, 8)}`,
      baseBranch: input.baseBranch, computerBuildId: null,
    });
    return c.json({ workspace: document(workspace) }, 201);
  });

  app.get("/v1/cloud-v2/workspaces", async c => {
    const organizationId = uuid.safeParse(c.req.query("organizationId"));
    if (!organizationId.success) throw new HttpError(400, "invalid_request", "organizationId is required");
    const workspaces = await deps.store.list(organizationId.data, c.get("user").id);
    return c.json({ workspaces: workspaces.map(document) });
  });

  app.get("/v1/cloud-v2/workspaces/:id", async c => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
    return c.json({ workspace: document(await deps.store.get(id.data, c.get("user").id)) });
  });

  /** A one-use, one-minute ticket for the bridge socket. Opening a stopped
   * workspace starts it, so the VM boots while the app connects. */
  app.post("/v1/cloud-v2/workspaces/:id/connect", async c => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
    const userId = c.get("user").id;
    const workspace = await deps.store.get(id.data, userId);
    if (workspace.state === "deleting" || workspace.state === "failed") throw new HttpError(409, "workspace_unavailable", "This cloud workspace is unavailable");
    if (workspace.state === "stopped") await deps.store.transition(workspace.id, ["stopped"], "starting");
    const ticket = await deps.store.issueToken({ workspaceId: workspace.id, kind: "connect", userId, ttlMs: CONNECT_TICKET_TTL_MS });
    return c.json({
      url: `${deps.bridgeBaseUrl.replace(/\/+$/, "")}/v2/cloud/workspaces/${workspace.id}/bridge`,
      protocols: [CLOUD_V2_BRIDGE_PROTOCOL, `ticket.${ticket.token}`],
      expiresAt: ticket.expiresAt.toISOString(),
    });
  });

  /** History reads from the control plane's mirror; never wakes the VM. */
  const HistorySchema = z.object({ op: z.enum(["chats.list", "messages.window"]), params: z.record(z.string(), z.unknown()).default({}) }).strict();
  app.post("/v1/cloud-v2/workspaces/:id/history", json, async c => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
    const workspace = await deps.store.get(id.data, c.get("user").id);
    const parsed = HistorySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Unsupported history read");
    if (parsed.data.op === "chats.list") return c.json({ result: await deps.store.listChats(workspace.id) });
    const chatId = z.string().min(1).max(256).safeParse(parsed.data.params.chatId);
    if (!chatId.success) throw new HttpError(400, "invalid_request", "chatId is required");
    const limit = z.number().int().min(1).max(1000).catch(200).parse(parsed.data.params.limit);
    return c.json({ result: { messages: await deps.store.windowMessages(workspace.id, chatId.data, limit) } });
  });

  for (const [action, from, to] of [
    // A failed wake keeps its VM and checkout, so it can be started again.
    ["start", ["stopped", "failed"], "starting"],
    ["stop", ["running", "starting"], "stopping"],
  ] as const) {
    app.post(`/v1/cloud-v2/workspaces/:id/${action}`, async c => {
      const id = uuid.safeParse(c.req.param("id"));
      if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
      const workspace = await deps.store.get(id.data, c.get("user").id);
      const moved = await deps.store.transition(workspace.id, from, to);
      return c.json({ workspace: document(moved ?? workspace) }, moved ? 202 : 200);
    });
  }

  app.delete("/v1/cloud-v2/workspaces/:id", async c => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) throw new HttpError(404, "not_found", "Cloud workspace not found");
    const workspace = await deps.store.get(id.data, c.get("user").id);
    const moved = await deps.store.transition(workspace.id,
      ["creating", "running", "stopping", "stopped", "starting", "failed"], "deleting");
    return c.json({ workspace: document(moved ?? workspace) }, 202);
  });

  const BuildSchema = z.object({ repositories: CloudV2RecipeSchema.shape.repositories }).strict();
  const org = (value: string | undefined) => {
    const parsed = uuid.safeParse(value);
    if (!parsed.success) throw new HttpError(404, "not_found", "Organization not found");
    return parsed.data;
  };

  app.get("/v1/cloud-v2/organizations/:org/computer", async c => {
    const organizationId = org(c.req.param("org"));
    await deps.computers.requireAdmin(organizationId, c.get("user").id);
    return c.json(await deps.computers.overview(organizationId));
  });

  app.post("/v1/cloud-v2/organizations/:org/computer/builds", json, async c => {
    const organizationId = org(c.req.param("org"));
    await deps.computers.requireAdmin(organizationId, c.get("user").id);
    if (!deps.baseSnapshot) throw new HttpError(409, "computer_base_unavailable", "Cloud Computer builds are not configured");
    const parsed = BuildSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid Cloud Computer build");
    const build = await deps.computers.enqueue(organizationId, c.get("user").id,
      { base: deps.baseSnapshot, repositories: parsed.data.repositories });
    return c.json({ build }, 202);
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
    return c.text(await deps.computers.log(organizationId, build.data));
  });

  return app;
}
