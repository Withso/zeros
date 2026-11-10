import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../../authz.js";
import { cloudAgentCatalog } from "../../agent-credentials/agent-models.js";
import type { CloudV2RouteDeps } from "../routes.js";
import type { CloudV2Store, CloudV2Workspace } from "../store.js";
import type { CloudApiPrompt } from "../prompt-outbox.js";
import { CloudV2PromptIdSchema } from "../prompt-contract.js";
import { createCloudWorkspaceOperations } from "../workspace-create.js";
import type { ApiChatRow } from "./reads.js";
import { readApiRepositories } from "./repositories.js";
import type { CloudApiCredential, CloudApiCredentials } from "./credentials.js";
import { apiInput, apiPage, ApiPageSchema, ApiWorkspaceListSchema, ApiWorkspaceCreateSchema, ApiSessionCreateSchema,
  ApiSessionListSchema, ApiMessageListSchema, ApiMessageSendSchema, ApiRenameSchema, ApiSessionRenameSchema } from "./contract.js";

type Dependencies = { store: CloudV2Store; routes: CloudV2RouteDeps; credentials: CloudApiCredentials; appBaseUrl: string };
const notFound = () => new HttpError(404, "not_found", "Not found");
const timestamp = (value: unknown, fallback: string): string => {
  const parsed = typeof value === "number" || typeof value === "string" ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
};
function workspaceStatus(workspace: CloudV2Workspace) {
  if (workspace.archivedAt) return "archived";
  switch (workspace.state) {
    case "creating": case "starting": return "initializing";
    case "running": return "ready";
    case "stopping": case "stopped": return "sleeping";
    case "failed": return "failed";
    case "deleted": case "deleting": return "deleting";
  }
}

/** HTTP and remote tools share these operations and the stores' admission rules. */
export class CloudApiService {
  private readonly operations;
  constructor(private readonly deps: Dependencies) { this.operations = createCloudWorkspaceOperations(deps.routes); }

  me(credential: CloudApiCredential) {
    return { userId: credential.userId, email: credential.email, ...(credential.name ? { name: credential.name } : {}),
      organizationId: credential.organizationId, organizationName: credential.organizationName, credential: credential.kind,
      ...(credential.workspaceId ? { workspaceId: credential.workspaceId } : {}) };
  }
  models() { return { data: cloudAgentCatalog() }; }

  private link(credential: CloudApiCredential, workspace: CloudV2Workspace): string | null {
    return workspace.number ? `${this.deps.appBaseUrl.replace(/\/$/, "")}/${credential.organizationSlug}/w/${workspace.number}` : null;
  }
  private workspaceDocument(credential: CloudApiCredential, workspace: CloudV2Workspace) {
    return { id: workspace.id, number: workspace.number ?? null, name: workspace.name, title: workspace.title ?? null,
      state: workspace.state, status: workspaceStatus(workspace), repository: workspace.repository, branch: workspace.branch,
      baseBranch: workspace.baseBranch, archived: workspace.archivedAt !== null, createdAt: workspace.createdAt,
      lastActivityAt: workspace.activeAt, creatorId: workspace.creatorUserId, creatorName: credential.name, link: this.link(credential, workspace) };
  }
  private sessionDocument(credential: CloudApiCredential, saved: ApiChatRow, workspace: CloudV2Workspace) {
    const row = saved.row, link = this.link(credential, workspace);
    return { id: saved.id, workspaceId: saved.workspaceId, name: typeof row.title === "string" ? row.title : "",
      agent: typeof row.agentId === "string" ? row.agentId : null, model: typeof row.model === "string" && row.model ? row.model : null,
      effort: typeof row.effort === "string" && row.effort ? row.effort : null, archived: row.archived === true,
      createdAt: timestamp(row.createdAt, saved.updatedAt), updatedAt: timestamp(row.updatedAt, saved.updatedAt),
      link: link ? `${link}?session=${encodeURIComponent(saved.id)}` : null };
  }
  private async owned(credential: CloudApiCredential, id: string): Promise<CloudV2Workspace> {
    if (!z.string().uuid().safeParse(id).success) throw notFound();
    const workspace = await this.deps.store.get(id, credential.userId);
    if (workspace.organizationId !== credential.organizationId) throw notFound();
    return workspace;
  }
  private async session(credential: CloudApiCredential, id: string) {
    if (!CloudV2PromptIdSchema.safeParse(id).success) throw notFound();
    const saved = await this.deps.store.api.resolve(credential, id);
    return { saved, workspace: await this.owned(credential, saved.workspaceId) };
  }
  private requirePrompts(): void {
    if (!this.deps.routes.promptOutbox) throw new HttpError(503, "api_prompts_unavailable", "Cloud prompt delivery is not available");
  }
  private async authorizePrompt(credential: CloudApiCredential, workspaceId: string): Promise<void> {
    const { workspace, proof } = await this.deps.store.promptContext(workspaceId, credential.userId);
    if (workspace.organizationId !== credential.organizationId) throw notFound();
    if (workspace.archivedAt) throw new HttpError(409, "workspace_archived", "Unarchive the workspace before sending a message");
    if (!workspace.sourcePending) {
      if (workspace.state === "running" && this.deps.routes.continueSource) await this.deps.routes.continueSource(workspace, proof);
      else await this.deps.routes.authorizeSource?.(workspace);
    }
    await this.deps.credentials.assertCurrent(credential);
  }

  async repositories(credential: CloudApiCredential, query: unknown = {}) {
    const page = apiInput(ApiPageSchema.strict(), query);
    const allowed = await readApiRepositories(credential, this.deps.store, this.deps.routes.computers, this.deps.routes.githubConnections);
    await this.deps.credentials.assertCurrent(credential);
    return apiPage(allowed.slice(page.offset, page.offset + page.limit + 1), page);
  }

  async workspaces(credential: CloudApiCredential, query: unknown = {}) {
    const page = apiInput(ApiWorkspaceListSchema, query);
    const rows = await this.deps.store.listApiWorkspaces(credential.organizationId, credential.userId, page);
    return apiPage(rows.map(workspace => this.workspaceDocument(credential, workspace)), page);
  }
  async workspace(credential: CloudApiCredential, id: string) { return this.workspaceDocument(credential, await this.owned(credential, id)); }
  async workspaceStatus(credential: CloudApiCredential, id: string) {
    const workspace = await this.owned(credential, id);
    return { workspaceId: id, status: workspaceStatus(workspace), state: workspace.state, updatedAt: workspace.updatedAt };
  }

  async createWorkspace(credential: CloudApiCredential, raw: unknown, key?: string) {
    const input = apiInput(ApiWorkspaceCreateSchema, raw);
    let initialPrompt: CloudApiPrompt | undefined;
    if (input.message !== undefined) {
      this.requirePrompts();
      initialPrompt = { chatId: randomUUID(), userMessageId: input.messageId ?? randomUUID(), agentId: input.agent!,
        message: input.message, model: input.model, effort: input.effort, sessionName: input.sessionName, startedAt: Date.now() };
    }
    const requestHash = createHash("sha256").update(JSON.stringify({ api: "v0", organizationId: credential.organizationId,
      ...input, repository: input.repository.toLowerCase() })).digest("hex");
    const document = (workspace: CloudV2Workspace) => ({ workspace: this.workspaceDocument(credential, workspace),
      ...(initialPrompt ? { session: this.sessionDocument(credential, { workspaceId: workspace.id, id: initialPrompt.chatId,
        row: { title: initialPrompt.sessionName ?? "", agentId: initialPrompt.agentId, model: initialPrompt.model,
          effort: initialPrompt.effort, createdAt: initialPrompt.startedAt, updatedAt: initialPrompt.startedAt }, updatedAt: workspace.createdAt }, workspace) } : {}) });
    const result = await this.operations.create(credential.userId, { organizationId: credential.organizationId,
      repository: input.repository, ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.branch === undefined ? {} : { branch: input.branch }), ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }) },
    { key, requestHash, initialPrompt, ...(credential.kind === "workspace_token" ? { workspaceTokenCreate: true as const } : {}),
      authorize: () => this.deps.credentials.assertCurrent(credential), receiptDocument: document, document });
    return result.response;
  }
  async renameWorkspace(credential: CloudApiCredential, id: string, raw: unknown) {
    await this.owned(credential, id);
    const { name } = apiInput(ApiRenameSchema, raw);
    await this.deps.credentials.assertCurrent(credential);
    return this.workspaceDocument(credential, await this.deps.store.rename(id, credential.userId, name));
  }
  async lifecycle(credential: CloudApiCredential, id: string, action: "archive" | "unarchive" | "sleep" | "wake") {
    const workspace = await this.owned(credential, id);
    const operation = action === "archive" ? "archive" : action === "sleep" ? "stop" : "start";
    if (operation === "start") await this.deps.routes.authorizeSource?.(workspace);
    await this.deps.credentials.assertCurrent(credential);
    const result = await this.deps.store.requestLifecycle(id, credential.userId, operation);
    return this.workspaceDocument(credential, result.workspace);
  }

  async sessions(credential: CloudApiCredential, id: string, query: unknown = {}) {
    const workspace = await this.owned(credential, id), page = apiInput(ApiSessionListSchema, query);
    return apiPage((await this.deps.store.api.sessions(credential, id, page)).map(saved => this.sessionDocument(credential, saved, workspace)), page);
  }
  async getSession(credential: CloudApiCredential, id: string) {
    const { saved, workspace } = await this.session(credential, id);
    return this.sessionDocument(credential, saved, workspace);
  }
  async sessionStatus(credential: CloudApiCredential, id: string) {
    const { workspace } = await this.session(credential, id);
    const result = await this.deps.store.api.status(credential, workspace.id, id);
    return { workspaceId: workspace.id, sessionId: id, status: result.status, updatedAt: result.updatedAt };
  }
  async createSession(credential: CloudApiCredential, raw: unknown) {
    const input = apiInput(ApiSessionCreateSchema, raw);
    this.requirePrompts();
    await this.owned(credential, input.workspaceId);
    await this.authorizePrompt(credential, input.workspaceId);
    const chatId = input.sessionId ?? randomUUID(), userMessageId = input.messageId ?? randomUUID();
    await this.deps.store.prompts.enqueueApi(input.workspaceId, credential.userId,
      { chatId, userMessageId, agentId: input.agent, message: input.message, model: input.model, effort: input.effort, sessionName: input.name });
    return { session: await this.getSession(credential, chatId), message: { id: userMessageId } };
  }
  async cancelSession(credential: CloudApiCredential, id: string) {
    const { workspace } = await this.session(credential, id);
    const { epoch } = await this.deps.store.api.status(credential, workspace.id, id);
    await this.deps.credentials.assertCurrent(credential);
    await this.deps.store.prompts.stop(workspace.id, credential.userId, id, epoch);
    return this.sessionStatus(credential, id);
  }
  private async editSession(credential: CloudApiCredential, id: string, patch: { title?: string; archived?: boolean }) {
    const { workspace } = await this.session(credential, id);
    await this.deps.store.chatEdits.apply(credential, workspace.id, id, patch, tx => this.deps.credentials.assertCurrent(credential, tx));
    return this.getSession(credential, id);
  }
  renameSession(credential: CloudApiCredential, id: string, raw: unknown) {
    const { name } = apiInput(ApiSessionRenameSchema, raw);
    return this.editSession(credential, id, { title: name });
  }
  archiveSession(credential: CloudApiCredential, id: string, archived: boolean) {
    return this.editSession(credential, id, { archived });
  }
  async sendMessage(credential: CloudApiCredential, id: string, raw: unknown) {
    const { saved, workspace } = await this.session(credential, id);
    const input = apiInput(ApiMessageSendSchema, raw);
    this.requirePrompts();
    const agent = z.enum(["codex", "claude", "cursor"]).safeParse(saved.row.agentId);
    if (!agent.success) throw new HttpError(409, "session_unavailable", "This session has no supported agent");
    await this.authorizePrompt(credential, workspace.id);
    const userMessageId = input.messageId ?? randomUUID();
    const result = await this.deps.store.prompts.enqueueApi(workspace.id, credential.userId, { chatId: id, userMessageId,
      agentId: agent.data, message: input.message,
      ...(typeof saved.row.model === "string" && saved.row.model ? { model: saved.row.model } : {}),
      ...(typeof saved.row.effort === "string" && saved.row.effort ? { effort: saved.row.effort } : {}) });
    return { replay: result.replay, message: { id: userMessageId } };
  }
  async messages(credential: CloudApiCredential, id: string, query: unknown = {}) {
    const { workspace } = await this.session(credential, id);
    return this.deps.store.api.messages(credential, workspace.id, id, apiInput(ApiMessageListSchema, query));
  }
  async message(credential: CloudApiCredential, id: string, messageId: string) {
    const { workspace } = await this.session(credential, id);
    if (!CloudV2PromptIdSchema.safeParse(messageId).success) throw notFound();
    return this.deps.store.api.message(credential, workspace.id, id, messageId);
  }
}
