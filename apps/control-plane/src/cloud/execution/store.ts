import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuthedUser } from "../../auth.js";
import { withSystemStatement, withSystemTx, type Tx } from "../../db.js";
import { sql, SqlFragment } from "../../sql-fragment.js";
import { HttpError } from "../../authz.js";
import { CLOUD_RECOVERY_TURN_HOLD, assertRecoveryTurnReady } from "../recovery-state.js";
import type { CloudAgentCredentialKeys, CloudAgentCredentialMaterial } from "../../agent-credentials/agent-credential-envelope.js";
import { CloudV2TurnLeaseSchema, CloudV2BootstrapLeaseSchema, CloudV2TerminalLeaseSchema, CloudV2ClientLeaseSchema, type CloudV2Agent, type CloudV2ContextReason, type CloudV2ControlFrame, type RuntimeMcpServer } from "../contract.js";
import type { CloudWorkspaceEnvironment } from "../environment-contract.js";
import type { CloudV2Prompt, CloudV2PromptState } from "../prompt-contract.js";
import { hashCloudV2Token } from "../tokens.js";
import { CLOUD_V2_LIVE_ACCESS } from "../workspace-access.js";
import { cloudV2WorkspaceFromRow } from "../store.js";
import { actorBusy, actorChanged, executionUnavailable, executionWorkerRequired, memberAccessRevoked, AgentLoginRequired, ExecutionContextRevoked, ExecutionContextEnded } from "./errors.js";
import { assertExecutionIntent, CloudExecutionAuthority, type ExecutionAdmission, type ExecutionIntentAuthority } from "./authority.js";
import { CloudExecutionLogins, type ExecutionSelection } from "./logins.js";
import { CloudExecutionClients } from "./clients.js";
import { CLEAN_EXECUTION_BOOT, CloudExecutionBoots } from "./boots.js";
import { CloudExecutionMaintenance } from "./maintenance.js";
import { CloudExecutionSync } from "./sync.js";
import { executionContextAuthority, matchesExecutionSignature, type VersionedExecutionAuthority } from "./signatures.js";
import { openExecution, sealExecution } from "./envelope.js";
import { EXECUTION_MINIMUM_LIFETIME_MS, assertExecutionLifetime, withExecutionLifetimeRetry } from "./lifetime.js";

export { EXECUTION_LEASE_MS } from "./lifetime.js";
export const BOOTSTRAP_MINIMUM_LIFETIME_MS = EXECUTION_MINIMUM_LIFETIME_MS;
export type ExecutionWorker = { token: string; bootId: string };
export type ExecutionWorkspace = { id: string; org_id: string; creator_user_id: string | null; repository: string; state: string;
  recovery_held?: boolean;
  access_epoch: string; stop_generation: string; worker_boot_id: string; worker_token_hash: Buffer; execution_mode: string;
  acting_user_boot_ids: string[]; execution_initiator_user_id: string | null; execution_intent_id: string | null; api_access: boolean };
export type ExecutionContext = { id: string; workspace_id: string; org_id: string; user_id: string | null; kind: "turn" | "terminal" | "client" | "bootstrap";
  chat_id: string | null; user_message_id: string | null; dispatch_id: string | null; generation: string | null; chat_epoch: string | null;
  client_id: string | null; terminal_id: string | null; request_id: string | null; operation: string | null; parent_context_id: string | null;
  client_token_expires_at: Date | null; request_fingerprint: Buffer | null;
  sync_device_id: string | null; sync_registration_id: string | null; sync_instance_id: string | null; sync_connected_at: Date | null;
  provider_session_id: string | null; access_epoch: string; stop_generation: string; worker_boot_id: string; worker_token_hash: Buffer;
  authority: VersionedExecutionAuthority & { signature: string }; source_fingerprint: string | null; agent: CloudV2Agent | null; selection: ExecutionSelection | null;
  state: "active" | "revoked" | "retired"; reason: CloudV2ContextReason | null; expires_at: Date; material: unknown; bootstrap_material_issued: boolean | null;
  retirement_id: string | null; retirement_hash: Buffer | null; environment_version_id: string | null; mcp_fingerprint: string | null; intent_id: string | null };
export type PromptExecutionAdmission = ExecutionAdmission & { agent: CloudV2Agent; selection: ExecutionSelection | null; parentContextId?: string };
type Config = Extract<CloudV2ControlFrame, { t: "config" }>;
type Material = { gitIdentity: Config["gitIdentity"]; environment?: CloudWorkspaceEnvironment; mcpServers?: RuntimeMcpServer[] };
export type ExecutionDeps = {
  authority: CloudExecutionAuthority; logins: CloudExecutionLogins; keys: CloudAgentCredentialKeys; apiUrl: string; proxyBase: string;
  material(context: ExecutionContext, check: (tx?: Tx) => Promise<void>, transaction?: Tx): Promise<Material>;
  agentConfig(logins: Partial<Record<CloudV2Agent, CloudAgentCredentialMaterial>>, base: string,
    proxy: () => Promise<{ token: string; expiresAt: number }>): Promise<Config["agents"]>;
  githubToken?(context: ExecutionContext, check: (tx?: Tx) => Promise<void>, purpose: "git" | "gh", failedTokenSha256?: string): Promise<{ token: string; expiresAt: number }>;
  mcpAuthorization?(context: ExecutionContext, check: (tx?: Tx) => Promise<void>, id: string, force: boolean): Promise<{ headers: Record<string, string>; expiresAt?: number }>;
};
type PromptRow = { user_message_id: string; chat_id: string; creator_user_id: string; sequence: string; epoch: string; access_epoch: string;
  state: CloudV2PromptState; cancel_requested: boolean; payload: CloudV2Prompt | null; delivery_id: string; dispatch_id: string | null;
  worker_boot_id: string; execution_context_id: string | null; execution_parent_context_id: string | null;
  sender_device_id: string | null; sender_registration_id: string | null; sender_binding_generation: string | null };
const pending = (state: string) => ["queued", "inboxed", "dispatching", "accepted"].includes(state);
const notify = (tx: Tx, id: string) => tx.query("SELECT pg_notify('zeros_cloud_v2_prompts',$1)", [id]);
const envelopeBinding = (row: ExecutionContext, kind = "material") => ({ id: row.id, workspaceId: row.workspace_id, organizationId: row.org_id, userId: row.user_id!, kind });

export class CloudExecutionContexts {
  readonly clients = new CloudExecutionClients(this);
  readonly boots = new CloudExecutionBoots(this);
  readonly maintenance = new CloudExecutionMaintenance(this);
  readonly sync = new CloudExecutionSync(this);
  constructor(readonly pool: pg.Pool, readonly deps: ExecutionDeps) {}

  async active(id: string, transaction?: Tx): Promise<boolean> {
    const result = transaction
      ? await transaction.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND execution_mode='active'", [id])
      : await withSystemStatement(this.pool, sql`SELECT 1 FROM cloud_v2_workspaces WHERE id=${SqlFragment.uuid(id.toLowerCase())} AND execution_mode='active'`);
    return result.rowCount === 1;
  }

  async workspace(id: string, userId: string, user?: AuthedUser, transaction?: Tx) {
    const read = async (tx: Tx) => {
      const proof = await this.deps.authority.admit(id, userId, { user, transaction: tx });
      const row = (await tx.query<Parameters<typeof cloudV2WorkspaceFromRow>[0]>("SELECT * FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0];
      if (!row) throw actorChanged();
      await this.deps.authority.assert(proof, tx);
      return { workspace: cloudV2WorkspaceFromRow(row), proof };
    };
    return transaction ? read(transaction) : withSystemTx(this.pool, read);
  }

  async connectionWorkspace(id: string, user: AuthedUser) {
    return withSystemTx(this.pool, async tx => {
      if (!await this.active(id, tx)) return undefined;
      return this.workspace(id, user.id, user, tx);
    });
  }

  async authorizedContext(identity: ExecutionWorker, id: string | undefined, kinds?: readonly ExecutionContext["kind"][]) {
    if (!id) throw actorChanged();
    const context = await withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx, identity), row = await this.context(tx, id, workspace.id);
      if (kinds && !kinds.includes(row.kind)) throw actorChanged();
      return row;
    });
    const proof = await this.admission(context);
    const check = async (tx?: Tx) => { await (tx ? this.assertContext(tx, context, proof) : withSystemTx(this.pool, value => this.assertContext(value, context, proof))); };
    return { context, proof, check };
  }

  async githubToken(identity: ExecutionWorker, id: string | undefined, purpose: "git" | "gh", failedTokenSha256?: string) {
    const { context, check } = await this.authorizedContext(identity, id);
    if (context.kind === "client" && !context.operation || !this.deps.githubToken) throw actorChanged();
    if (context.kind === "bootstrap" && context.material === null) throw actorChanged();
    try {
      const result = await this.deps.githubToken(context, check, purpose, failedTokenSha256);
      await check();
      return { ...result, expiresAt: Math.min(result.expiresAt, context.expires_at.getTime()) };
    } catch (error) { await check(); throw error; }
  }

  async mcpAuthorization(identity: ExecutionWorker, contextId: string | undefined, id: string, force: boolean) {
    const { context, check } = await this.authorizedContext(identity, contextId, ["turn"]);
    const material = context.material ? openExecution(context.material, envelopeBinding(context), this.deps.keys) as { mcpServers?: RuntimeMcpServer[] } : null;
    if (!material?.mcpServers?.some(server => server.id === id) || !this.deps.mcpAuthorization) throw actorChanged();
    try { const result = await this.deps.mcpAuthorization(context, check, id, force); await check(); return result; }
    catch (error) { await check(); throw error; }
  }

  async tokenContext(kind: "api" | "proxy", value: { token: string } | { id: string }, transaction?: Tx) {
    const read = async (tx: Tx) => {
      const result = await tx.query<ExecutionContext & { token_id: string }>(`SELECT c.*,t.id AS token_id FROM cloud_v2_execution_tokens t
        JOIN cloud_v2_execution_contexts c ON c.id=t.context_id AND c.workspace_id=t.workspace_id
        JOIN cloud_v2_workspaces w ON w.id=c.workspace_id
        WHERE t.kind=$1 AND ($2::bytea IS NULL OR t.token_hash=$2) AND ($3::uuid IS NULL OR t.id=$3)
          AND c.state='active' AND c.expires_at>clock_timestamp() AND w.execution_mode='active'
          AND w.state IN ('creating','starting','running') AND w.archived_at IS NULL
          AND c.access_epoch=w.access_epoch AND c.stop_generation=w.stop_generation AND c.worker_boot_id=w.worker_boot_id
          AND c.worker_token_hash=w.worker_token_hash AND c.worker_boot_id=ANY(w.acting_user_boot_ids) AND ${CLOUD_V2_LIVE_ACCESS}
          AND ($1<>'api' OR (w.api_access AND coalesce((SELECT workspace_api_access FROM cloud_api_access_settings
            WHERE org_id=c.org_id AND user_id=c.user_id),true)))`, [kind, "token" in value ? hashCloudV2Token(value.token) : null, "id" in value ? value.id : null]);
      const context = result.rows[0];
      if (!context) throw new HttpError(401, "unauthorized", "Execution credential expired or was revoked");
      return context;
    };
    const context = transaction ? await read(transaction) : await withSystemTx(this.pool, read);
    try {
      const proof = await this.admission(context);
      if (context.agent && context.selection) await this.deps.logins.select(context.org_id, context.user_id!, context.agent, context.selection, transaction);
      if (transaction) await this.assertContext(transaction, context, proof);
      else await withSystemTx(this.pool, tx => this.assertContext(tx, context, proof));
      return { context, proof };
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) throw new HttpError(401, "unauthorized", "Execution credential expired or was revoked");
      throw error;
    }
  }

  async proxyAccess(token: string) {
    let { context } = await this.tokenContext("proxy", { token });
    if (context.kind !== "turn" || context.agent !== "codex" || !context.selection) throw actorChanged();
    const selected = () => this.deps.logins.select(context.org_id, context.user_id!, "codex", context.selection!);
    let { material: login } = await selected();
    const check = async () => {
      const current = await this.tokenContext("proxy", { token });
      if (current.context.id !== context.id) throw actorChanged();
      context = current.context;
      return context.expires_at.getTime();
    };
    await check();
    if (login.kind === "codex-chatgpt" && login.expiresAt * 1000 <= Date.now() + 300_000) {
      await this.deps.logins.refreshCodex(context.org_id, context.user_id!, context.selection!, check);
      login = (await selected()).material;
      await check();
    }
    if (login.kind === "codex-chatgpt" && login.expiresAt * 1000 <= Date.now() + 30_000)
      throw new AgentLoginRequired("codex", context.selection.version === 2 && context.selection.payer.userId !== context.user_id ? "creator" : "self");
    return { login, check };
  }

  async assertToken(tx: Tx, tokenId: string, contextId: string, kind: "api" | "proxy", proof: ExecutionAdmission) {
    try {
      const found = await tx.query(`SELECT 1 FROM cloud_v2_execution_tokens t JOIN cloud_v2_workspaces w ON w.id=t.workspace_id
        WHERE t.id=$1 AND t.context_id=$2 AND t.kind=$3 AND w.execution_mode='active' AND w.state IN ('creating','starting','running')
          AND w.archived_at IS NULL AND ($3<>'api' OR (w.api_access AND coalesce((SELECT workspace_api_access FROM cloud_api_access_settings
            WHERE org_id=w.org_id AND user_id=$4),true)))`, [tokenId, contextId, kind, proof.person.userId]);
      if (!found.rowCount) throw actorChanged();
      const context = await this.context(tx, contextId, proof.person.workspaceId);
      await this.assertContext(tx, context, proof);
      if (context.agent && context.selection) await this.deps.logins.select(context.org_id, context.user_id!, context.agent, context.selection, tx);
      await this.assertContext(tx, context, proof);
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) throw new HttpError(401, "unauthorized", "Execution credential expired or was revoked");
      throw error;
    }
  }

  async worker(tx: Tx, identity: ExecutionWorker, lock = false, cleanup = false): Promise<ExecutionWorkspace> {
    const read = () => tx.query<ExecutionWorkspace & { clean: boolean }>(`SELECT w.id,w.org_id,w.creator_user_id,w.repository,w.state,w.access_epoch::text,w.stop_generation::text,
        w.worker_boot_id,w.worker_token_hash,w.execution_mode,w.acting_user_boot_ids,w.execution_initiator_user_id,w.execution_intent_id,w.api_access,
        (${CLOUD_RECOVERY_TURN_HOLD}) AS recovery_held,${cleanup ? "true" : CLEAN_EXECUTION_BOOT} AS clean
      FROM cloud_v2_workspaces w WHERE worker_token_hash=$1 AND worker_boot_id=$2
        AND state IN ('creating','starting','running','stopping') AND ${CLOUD_V2_LIVE_ACCESS} ${lock ? "FOR UPDATE OF w" : ""}`,
      [hashCloudV2Token(identity.token), identity.bootId]);
    let row = (await read()).rows[0];
    if (lock) row = (await read()).rows[0];
    if (!row) throw new HttpError(401, "worker_unauthorized", "Worker authorization is no longer current");
    if (row.execution_mode !== "active" || !row.acting_user_boot_ids.includes(identity.bootId)) throw executionWorkerRequired();
    if (!cleanup && row.state === "stopping") throw new HttpError(409, "workspace_stopping", "The workspace is stopping");
    if (!row.clean) throw actorBusy();
    return row;
  }

  async advertise(identity: ExecutionWorker, capable: boolean) {
    return withSystemTx(this.pool, async tx => {
      const result = await tx.query(`UPDATE cloud_v2_workspaces w SET acting_user_boot_ids=CASE WHEN $3 THEN ARRAY[$2::uuid] ELSE '{}'::uuid[] END
        WHERE worker_token_hash=$1 AND worker_boot_id=$2 AND ${CLOUD_V2_LIVE_ACCESS} RETURNING execution_mode`, [hashCloudV2Token(identity.token), identity.bootId, capable]);
      if (!result.rowCount) throw actorChanged();
      if (result.rows[0].execution_mode === "active" && !capable) throw executionWorkerRequired();
    });
  }

  private async agent(tx: Tx, id: string, chatId: string, requested: CloudV2Agent): Promise<CloudV2Agent> {
    const row = (await tx.query<{ agent: string | null; deleted_at: Date | null }>(
      "SELECT row->>'agentId' AS agent,deleted_at FROM cloud_v2_chats WHERE workspace_id=$1 AND chat_id=$2", [id, chatId])).rows[0];
    if (row?.deleted_at) throw new HttpError(409, "conversation_deleted", "This conversation was deleted");
    if (row?.agent && row.agent !== requested) throw actorChanged();
    return requested;
  }

  async preflightPrompt(id: string, userId: string, input: CloudV2Prompt, user?: AuthedUser): Promise<PromptExecutionAdmission | undefined> {
    if (!await this.active(id)) return undefined;
    const proof = await this.deps.authority.admit(id, userId, { user });
    const agent = await withSystemTx(this.pool, tx => this.agent(tx, id, input.chatId, input.agentId));
    await this.deps.authority.assert(proof);
    const existing = await withSystemTx(this.pool, tx => tx.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2 AND creator_user_id=$3", [id, input.userMessageId, userId]));
    const parent = !existing.rowCount && input.mode === "steer" ? await withSystemTx(this.pool, async tx => {
      const context = (await tx.query<ExecutionContext>(`SELECT c.* FROM cloud_v2_prompt_chats chat JOIN cloud_v2_execution_contexts c
        ON c.id=chat.active_context_id AND c.workspace_id=chat.workspace_id WHERE chat.workspace_id=$1 AND chat.chat_id=$2
          AND c.user_id=$3 AND c.kind='turn' AND c.state='active' AND c.agent=$4`, [id, input.chatId, userId, agent])).rows[0];
      if (context) await this.assertContext(tx, context, proof);
      return context;
    }) : undefined;
    const selection = existing.rowCount ? null : parent
      ? (await this.deps.logins.select(proof.person.organizationId, userId, agent, parent.selection!)).selection
      : (await this.deps.logins.forWorkspace(id, userId, agent)).selection;
    await this.deps.authority.assert(proof);
    return { ...proof, runBound: false, agent, selection, ...(parent ? { parentContextId: parent.id } : {}) };
  }

  async creationPrompt(tx: Tx, proof: ExecutionAdmission, input: Pick<CloudV2Prompt, "chatId" | "agentId">): Promise<PromptExecutionAdmission> {
    await this.deps.authority.assert(proof, tx);
    const agent = await this.agent(tx, proof.person.workspaceId, input.chatId, input.agentId);
    const { selection } = await this.deps.logins.forWorkspace(proof.person.workspaceId, proof.person.userId, agent, undefined, tx);
    await this.deps.authority.assert(proof, tx);
    return { ...proof, runBound: false, agent, selection };
  }

  async assertPrompt(tx: Tx, proof: PromptExecutionAdmission, input: CloudV2Prompt) {
    await this.deps.authority.assert(proof, tx);
    await this.agent(tx, proof.person.workspaceId, input.chatId, input.agentId);
    if (proof.parentContextId) {
      await this.assertContext(tx, await this.context(tx, proof.parentContextId, proof.person.workspaceId), proof);
      await this.deps.logins.select(proof.person.organizationId, proof.person.userId, proof.agent, proof.selection!, tx);
    } else if (proof.selection) await this.deps.logins.forWorkspace(proof.person.workspaceId, proof.person.userId, proof.agent, proof.selection, tx);
    await this.deps.authority.assert(proof, tx);
  }

  private async prompt(tx: Tx, id: string, messageId: string): Promise<PromptRow> {
    const row = (await tx.query<PromptRow>("SELECT * FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2", [id, messageId])).rows[0];
    if (!row) throw new HttpError(404, "prompt_not_found", "Saved message not found");
    return row;
  }

  async begin(identity: ExecutionWorker, input: { userMessageId: string; deliveryId: string; dispatchId: string }) {
    const initial = await withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx, identity, true);
      assertRecoveryTurnReady(workspace.recovery_held);
      await this.maintenance.cancelQueued(tx, workspace.id);
      return { workspace, prompt: await this.prompt(tx, workspace.id, input.userMessageId) };
    });
    if (!pending(initial.prompt.state)) return { dispatch: false as const, state: initial.prompt.state };
    return withExecutionLifetimeRetry(async () => {
      const proof = await this.deps.authority.admit(initial.workspace.id, initial.prompt.creator_user_id, { minimumSourceMs: EXECUTION_MINIMUM_LIFETIME_MS });
      assertExecutionLifetime(proof.until);
      const agent = await withSystemTx(this.pool, tx => this.agent(tx, initial.workspace.id, initial.prompt.chat_id, initial.prompt.payload!.agentId));
      await this.deps.authority.assert(proof);
      const result = await withSystemTx(this.pool, async tx => {
        await tx.query("SELECT id FROM users WHERE id=$1 FOR KEY SHARE", [proof.person.userId]);
        const workspace = await this.worker(tx, identity, true);
        assertRecoveryTurnReady(workspace.recovery_held);
        await this.maintenance.cancelQueued(tx, workspace.id);
        const row = await this.prompt(tx, workspace.id, input.userMessageId);
        const chat = (await tx.query<{ epoch: string; acting_user_id: string | null; acting_generation: string; active_context_id: string | null }>(
          "SELECT epoch::text,acting_user_id,acting_generation::text,active_context_id FROM cloud_v2_prompt_chats WHERE workspace_id=$1 AND chat_id=$2 FOR UPDATE", [workspace.id, row.chat_id])).rows[0];
        await this.deps.authority.assert(proof, tx);
        if (!pending(row.state)) return { dispatch: false as const, state: row.state };
        if (!chat || row.cancel_requested || row.epoch !== chat.epoch || row.access_epoch !== workspace.access_epoch || workspace.state !== "running")
          return { dispatch: false as const, state: "cancelled" as const };
        if (row.worker_boot_id !== identity.bootId || row.delivery_id !== input.deliveryId) throw new HttpError(409, "prompt_conflict", "This dispatch is no longer current");
        if (row.dispatch_id) {
          if (row.dispatch_id !== input.dispatchId || !row.execution_context_id) throw new HttpError(409, "prompt_conflict", "This dispatch is no longer current");
          const context = await this.context(tx, row.execution_context_id, workspace.id);
          await this.assertContext(tx, context, proof);
          return this.begun(context, row.state, row.execution_parent_context_id !== null);
        }
        if (row.state !== "inboxed") throw new HttpError(409, "prompt_inbox_required", "Persist the message before dispatch");
        let active = chat.active_context_id ? await this.context(tx, chat.active_context_id, workspace.id) : null;
        if (active?.state === "retired") {
          const parent = await this.prompt(tx, workspace.id, active.user_message_id!);
          if (pending(parent.state)) throw actorBusy();
          active = null;
        }
        const steer = row.payload?.mode === "steer" && active?.user_id === row.creator_user_id;
        if (active && !steer) throw actorBusy();
        const older = (await tx.query(`SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND chat_id=$2 AND sequence<$3
          AND state IN ('queued','inboxed','dispatching','accepted') AND ($4::text IS NULL OR user_message_id<>$4) LIMIT 1`,
        [workspace.id, row.chat_id, row.sequence, steer ? active!.user_message_id : null])).rowCount;
        if (older) throw actorBusy();
        if (steer) {
          await this.assertContext(tx, active!, proof);
          await this.deps.logins.select(workspace.org_id, row.creator_user_id, active!.agent!, active!.selection!, tx);
          active = await this.issueLease(tx, active!, proof);
          await tx.query(`UPDATE cloud_v2_prompt_outbox SET state='dispatching',dispatch_id=$3,execution_context_id=$4,execution_parent_context_id=$4,updated_at=clock_timestamp()
            WHERE workspace_id=$1 AND user_message_id=$2`, [workspace.id, row.user_message_id, input.dispatchId, active!.id]);
          await this.deps.authority.assert(proof, tx);
          assertExecutionLifetime(active.expires_at.getTime());
          return this.begun(active!, "dispatching", true);
        }
        let selection: ExecutionSelection;
        try { selection = (await this.deps.logins.forWorkspace(workspace.id, row.creator_user_id, agent, undefined, tx)).selection; }
        catch (error) {
          if (!(error instanceof HttpError) || !["agent_login_required", "workspace_creator_required"].includes(error.code)) throw error;
          await this.deps.authority.assert(proof, tx);
          await tx.query("UPDATE cloud_v2_prompt_outbox SET state='failed',terminal_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND user_message_id=$2", [workspace.id, row.user_message_id]);
          await notify(tx, workspace.id);
          return { refusal: error };
        }
        const generation = (BigInt(chat.acting_generation) + (chat.acting_user_id === row.creator_user_id ? 0n : 1n)).toString();
        if (BigInt(generation) < 1n || BigInt(generation) > 9223372036854775806n) throw actorChanged();
        const contextId = randomUUID();
        assertExecutionLifetime(proof.until);
        const context = (await tx.query<ExecutionContext>(`INSERT INTO cloud_v2_execution_contexts(id,workspace_id,org_id,user_id,kind,chat_id,user_message_id,dispatch_id,
          generation,chat_epoch,access_epoch,stop_generation,worker_boot_id,worker_token_hash,authority,source_fingerprint,agent,selection,credential_id,
          sender_device_id,sender_registration_id,sender_binding_generation,expires_at)
          VALUES($1,$2,$3,$4,'turn',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
        [contextId, workspace.id, workspace.org_id, row.creator_user_id, row.chat_id, row.user_message_id, input.dispatchId, generation, chat.epoch,
          workspace.access_epoch, workspace.stop_generation, identity.bootId, workspace.worker_token_hash, executionContextAuthority(proof.person), proof.source?.fingerprint ?? null,
          agent, selection, selection.source === "personal" ? selection.credentialId : null, row.sender_device_id, row.sender_registration_id, row.sender_binding_generation, new Date(proof.until)])).rows[0]!;
        await tx.query("UPDATE cloud_v2_prompt_chats SET acting_user_id=$3,acting_generation=$4,active_context_id=$5 WHERE workspace_id=$1 AND chat_id=$2",
          [workspace.id, row.chat_id, row.creator_user_id, generation, contextId]);
        await tx.query(`UPDATE cloud_v2_prompt_outbox SET state='dispatching',dispatch_id=$3,execution_context_id=$4,updated_at=clock_timestamp()
          WHERE workspace_id=$1 AND user_message_id=$2`, [workspace.id, row.user_message_id, input.dispatchId, contextId]);
        await this.deps.logins.forWorkspace(workspace.id, row.creator_user_id, agent, selection, tx);
        await this.deps.authority.assert(proof, tx);
        assertExecutionLifetime(context.expires_at.getTime());
        return this.begun(context, "dispatching", false);
      });
      // Keep the failed receipt even when dispatch loses its payer while queued.
      if ("refusal" in result) throw result.refusal;
      return result;
    });
  }

  private begun(context: ExecutionContext, state: CloudV2PromptState, steer: boolean) {
    return { dispatch: true as const, state, contextId: context.id, mode: steer ? "steer" as const : "prompt" as const,
      actingUser: { userId: context.user_id!, generation: context.generation!, userMessageId: context.user_message_id! },
      ...(steer ? { parentContextId: context.id } : {}) };
  }

  async context(tx: Tx, id: string, workspaceId: string, lock = false): Promise<ExecutionContext> {
    const context = (await tx.query<ExecutionContext>(`SELECT * FROM cloud_v2_execution_contexts WHERE id=$1 AND workspace_id=$2 ${lock ? "FOR UPDATE" : ""}`, [id, workspaceId])).rows[0];
    if (!context) throw actorChanged();
    return context;
  }

  async assertContext(tx: Tx, context: ExecutionContext, proof: ExecutionAdmission): Promise<ExecutionContext> {
    const row = await this.context(tx, context.id, context.workspace_id);
    if (row.state !== "active" && row.reason === "access_revoked") throw new ExecutionContextRevoked();
    if (row.state !== "active") throw new ExecutionContextEnded(row.reason ?? "actor_changed");
    if (row.expires_at.getTime() <= Date.now() || row.client_token_expires_at && row.client_token_expires_at.getTime() <= Date.now())
      throw new ExecutionContextEnded("expired");
    if (!row.user_id || row.user_id !== proof.person.userId ||
        !matchesExecutionSignature(row.authority, row.authority.signature, proof.person, "signature")) throw actorChanged();
    if (row.access_epoch !== proof.person.accessEpoch || row.stop_generation !== proof.person.stopGeneration || row.worker_boot_id !== proof.person.bootId ||
        row.worker_token_hash.toString("hex") !== proof.person.workerTokenHash) throw actorChanged();
    if (row.selection) await this.deps.logins.assertPayer(tx, row.org_id, row.selection);
    await this.deps.authority.assert(proof, tx, false, row.id);
    return row;
  }

  async admission(context: ExecutionContext, minimumSourceMs = 0, transaction?: Tx): Promise<ExecutionAdmission> {
    if (context.state !== "active" && context.reason === "access_revoked") throw new ExecutionContextRevoked();
    if (!context.user_id || context.state !== "active" || context.expires_at.getTime() <= Date.now()) throw actorChanged();
    const proof = await this.deps.authority.admit(context.workspace_id, context.user_id, { continuation: true, minimumSourceMs,
      ...(transaction ? { transaction } : {}) });
    await (transaction ? this.assertContext(transaction, context, proof) : withSystemTx(this.pool, tx => this.assertContext(tx, context, proof)));
    return proof;
  }

  /** A live context may renew under this newly checked proof before delivery;
   * an expired or revoked context never reaches the deadline update. */
  async issueLease(tx: Tx, context: ExecutionContext, proof: ExecutionAdmission): Promise<ExecutionContext> {
    const current = await this.assertContext(tx, context, proof);
    const ceiling = Math.min(proof.until, current.client_token_expires_at?.getTime() ?? Infinity);
    assertExecutionLifetime(proof.until);
    assertExecutionLifetime(ceiling, current.client_token_expires_at?.getTime());
    let until = Math.min(current.expires_at.getTime(), proof.source?.until ?? Infinity, current.client_token_expires_at?.getTime() ?? Infinity);
    if (until - Date.now() < EXECUTION_MINIMUM_LIFETIME_MS) until = ceiling;
    const update = async () => {
      await tx.query("UPDATE cloud_v2_execution_contexts SET expires_at=$2,authority=$3,source_fingerprint=$4 WHERE id=$1",
        [current.id, new Date(until), executionContextAuthority(proof.person), proof.source?.fingerprint ?? null]);
      await this.assertContext(tx, current, proof);
    };
    if (until !== current.expires_at.getTime()) await update();
    // Reconsider an older delivery deadline after the final reads; the newly
    // observed proof can still cover the floor without sliding either proof.
    if (until !== ceiling && until - Date.now() < EXECUTION_MINIMUM_LIFETIME_MS) { until = ceiling; await update(); }
    assertExecutionLifetime(until, current.client_token_expires_at?.getTime());
    return { ...current, expires_at: new Date(until) };
  }

  private async token(tx: Tx, context: ExecutionContext, kind: "api" | "proxy") {
    const current = (await tx.query<{ envelope: unknown }>("SELECT envelope FROM cloud_v2_execution_tokens WHERE context_id=$1 AND kind=$2", [context.id, kind])).rows[0];
    if (current) return openExecution(current.envelope, envelopeBinding(context, kind), this.deps.keys) as string;
    const token = `${kind === "api" ? "zw2x_" : "zw2q_"}${randomBytes(32).toString("base64url")}`;
    await tx.query("INSERT INTO cloud_v2_execution_tokens(id,token_hash,context_id,workspace_id,org_id,kind,envelope) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [randomUUID(), hashCloudV2Token(token), context.id, context.workspace_id, context.org_id, kind, sealExecution(token, envelopeBinding(context, kind), this.deps.keys)]);
    return token;
  }

  async turnLease(identity: ExecutionWorker, input: { chatId: string; userMessageId: string; dispatchId: string; generation: string; contextId: string }) {
    // A steer's own dispatch may end while its parent context is still live.
    const dispatch = async (tx: Tx, current: ExecutionContext) => {
      const row = await this.prompt(tx, current.workspace_id, input.userMessageId);
      if (current.kind !== "turn" || current.chat_id !== input.chatId || current.generation !== input.generation || row.dispatch_id !== input.dispatchId ||
          row.chat_id !== input.chatId || row.epoch !== current.chat_epoch || row.access_epoch !== current.access_epoch || row.cancel_requested ||
          row.execution_context_id !== current.id || row.creator_user_id !== current.user_id || row.worker_boot_id !== identity.bootId ||
          !["dispatching", "accepted"].includes(row.state)) throw actorChanged();
    };
    const context = await withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx, identity);
      const current = await this.context(tx, input.contextId, workspace.id);
      await dispatch(tx, current);
      return current;
    });
    return withExecutionLifetimeRetry(async () => {
      const proof = await this.admission(context, EXECUTION_MINIMUM_LIFETIME_MS);
      assertExecutionLifetime(proof.until);
      const check = async (tx?: Tx) => {
        const read = async (value: Tx) => { await this.assertContext(value, context, proof); await dispatch(value, context); };
        await (tx ? read(tx) : withSystemTx(this.pool, read));
      };
      const login = await this.deps.logins.select(context.org_id, context.user_id!, context.agent!, context.selection!);
      const material = context.material ? null : await this.deps.material(context, check);
      return withSystemTx(this.pool, async tx => {
        const workspace = await this.worker(tx, identity, true);
        let current = await this.context(tx, context.id, workspace.id, true);
        await check(tx);
        let value: Record<string, unknown>;
        if (current.material) value = openExecution(current.material, envelopeBinding(current), this.deps.keys) as Record<string, unknown>;
        else {
          const agents = await this.deps.agentConfig({ [current.agent!]: login.material }, this.deps.proxyBase,
            async () => ({ token: await this.token(tx, current, "proxy"), expiresAt: current.expires_at.getTime() }));
          const apiAllowed = workspace.api_access && (await tx.query<{ allowed: boolean }>(`SELECT coalesce((SELECT workspace_api_access
            FROM cloud_api_access_settings WHERE org_id=$1 AND user_id=$2),true) AS allowed`, [current.org_id, current.user_id])).rows[0]!.allowed;
          value = { contextId: current.id, userId: current.user_id, generation: current.generation, ...material, agents,
            ...(apiAllowed ? { api: { url: this.deps.apiUrl, token: await this.token(tx, current, "api") } } : {}) };
          await tx.query("UPDATE cloud_v2_execution_contexts SET material=$2 WHERE id=$1", [current.id, sealExecution(value, envelopeBinding(current), this.deps.keys)]);
        }
        await this.deps.logins.select(current.org_id, current.user_id!, current.agent!, current.selection!, tx);
        current = await this.issueLease(tx, current, proof);
        await dispatch(tx, current);
        assertExecutionLifetime(current.expires_at.getTime());
        return CloudV2TurnLeaseSchema.parse({ ...value, expiresAt: current.expires_at.getTime() });
      });
    });
  }

  async bootstrap(workspaceId: string, transaction?: Tx): Promise<string | undefined> {
    const bootstrap = async (tx: Tx) => {
      const current = (await tx.query<{ execution_initiator_user_id: string | null; execution_intent_id: string | null;
        execution_intent_authority: ExecutionIntentAuthority | null; worker_boot_id: string | null; acting_user_boot_ids: string[] }>(
        `SELECT execution_initiator_user_id,execution_intent_id,execution_intent_authority,worker_boot_id,acting_user_boot_ids
          FROM cloud_v2_workspaces WHERE id=$1 AND execution_mode='active'`, [workspaceId])).rows[0];
      const initial = current && (await tx.query<ExecutionContext>(`SELECT * FROM cloud_v2_execution_contexts
        WHERE workspace_id=$1 AND intent_id=$2 AND worker_boot_id=$3 AND kind='bootstrap'`,
        [workspaceId, current.execution_intent_id, current.worker_boot_id])).rows[0];
      if (!current?.execution_intent_id || !current.worker_boot_id || !current.acting_user_boot_ids.includes(current.worker_boot_id)) throw executionWorkerRequired();
      // Delivery is a one-way boundary even if the reply was lost. A new worker
      // process gets credential-free config, not an already-spent bootstrap id.
      const done = (row: ExecutionContext | undefined) => row && (row.state === "retired" || row.bootstrap_material_issued === true || row.material !== null);
      if (done(initial)) return undefined;
      if (!current.execution_initiator_user_id) throw executionWorkerRequired();
      const pending = initial?.state === "active" && initial.expires_at.getTime() > Date.now();
      await tx.query("SELECT id FROM users WHERE id=$1 FOR KEY SHARE", [current.execution_initiator_user_id]);
      if (!(await tx.query(`SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND execution_intent_id=$2
        AND execution_initiator_user_id=$3 AND worker_boot_id=$4 FOR UPDATE`,
        [workspaceId, current.execution_intent_id, current.execution_initiator_user_id, current.worker_boot_id])).rowCount) throw actorChanged();
      const proof = await this.deps.authority.admit(workspaceId, current.execution_initiator_user_id!,
        { minimumSourceMs: pending ? 0 : EXECUTION_MINIMUM_LIFETIME_MS, transaction: tx });
      assertExecutionIntent(current.execution_intent_authority, proof);
      const existing = (await tx.query<ExecutionContext>(`SELECT * FROM cloud_v2_execution_contexts
        WHERE workspace_id=$1 AND intent_id=$2 AND worker_boot_id=$3 AND kind='bootstrap' FOR UPDATE`,
        [workspaceId, current.execution_intent_id, current.worker_boot_id])).rows[0];
      if (done(existing)) return undefined;
      if (existing?.state === "active" && existing.expires_at.getTime() > Date.now()) {
        await this.assertContext(tx, existing, proof); return existing.id;
      }
      if (existing && (existing.bootstrap_material_issued !== false || existing.retirement_id || existing.material !== null ||
        existing.expires_at.getTime() > Date.now() || existing.state !== "active" && existing.reason !== "expired" ||
        !matchesExecutionSignature(existing.authority, existing.authority.signature, proof.person, "signature"))) throw actorChanged();
      assertExecutionLifetime(proof.until);
      if (existing) {
        const deleted = await tx.query(`DELETE FROM cloud_v2_execution_contexts c WHERE c.id=$1
          AND NOT EXISTS(SELECT 1 FROM cloud_v2_execution_contexts child WHERE child.parent_context_id=c.id)
          AND NOT EXISTS(SELECT 1 FROM cloud_v2_execution_tokens t WHERE t.context_id=c.id)`, [existing.id]);
        if (deleted.rowCount !== 1) throw actorChanged();
      }
      const id = randomUUID();
      await tx.query(`INSERT INTO cloud_v2_execution_contexts(id,workspace_id,org_id,user_id,kind,intent_id,access_epoch,stop_generation,worker_boot_id,worker_token_hash,authority,source_fingerprint,expires_at,bootstrap_material_issued)
        VALUES($1,$2,$3,$4,'bootstrap',$5,$6,$7,$8,decode($9,'hex'),$10,$11,$12,false)`,
      [id, workspaceId, proof.person.organizationId, proof.person.userId, current.execution_intent_id, proof.person.accessEpoch, proof.person.stopGeneration,
        proof.person.bootId, proof.person.workerTokenHash, executionContextAuthority(proof.person), proof.source?.fingerprint ?? null, new Date(proof.until)]);
      await this.deps.authority.assert(proof, tx);
      assertExecutionLifetime(proof.until);
      return id;
    };
    return transaction ? bootstrap(transaction) : withExecutionLifetimeRetry(() => withSystemTx(this.pool, bootstrap));
  }

  async bootstrapLease(identity: ExecutionWorker, id: string) { return this.identityLease(identity, id, "bootstrap"); }

  async identityLease(identity: ExecutionWorker, id: string, kind: "bootstrap" | "terminal" | "client") {
    return withExecutionLifetimeRetry(async () => {
      const { context, proof, material } = await withSystemTx(this.pool, async tx => {
        const workspace = await this.worker(tx, identity), context = await this.context(tx, id, workspace.id);
        if (context.kind !== kind || kind === "client" && (!context.operation || context.operation === "terminal.create")) throw actorChanged();
        if (context.state !== "active" && context.reason === "access_revoked") throw new ExecutionContextRevoked();
        if (!context.user_id || context.state !== "active" || context.expires_at.getTime() <= Date.now()) throw actorChanged();
        const proof = await this.deps.authority.admit(workspace.id, context.user_id, { continuation: true, minimumSourceMs: EXECUTION_MINIMUM_LIFETIME_MS, transaction: tx });
        const check = async (value?: Tx) => { await this.assertContext(value ?? tx, context, proof); };
        // No workspace/context lock precedes material preparation. A concurrent
        // Stop or expired-bootstrap replacement must still be able to win.
        const material = context.material ? null : await this.deps.material(context, check, tx).catch(async error => {
          await check(tx);
          throw error;
        });
        return { context, proof, material };
      });
      assertExecutionLifetime(proof.until);
      return withSystemTx(this.pool, async tx => {
        const workspace = await this.worker(tx, identity, true);
        let current = await this.context(tx, id, workspace.id, true);
        if (!current.material && !material) throw actorChanged();
        const value = current.material ? openExecution(current.material, envelopeBinding(current), this.deps.keys) as Record<string, unknown> :
          { contextId: current.id, userId: current.user_id, gitIdentity: material!.gitIdentity,
            ...(kind !== "client" && material!.environment ? { environment: material!.environment } : {}),
            ...(kind === "terminal" && workspace.api_access && (await tx.query<{ allowed: boolean }>(`SELECT coalesce((SELECT workspace_api_access
              FROM cloud_api_access_settings WHERE org_id=$1 AND user_id=$2),true) AS allowed`, [context.org_id, context.user_id])).rows[0]!.allowed
              ? { api: { url: this.deps.apiUrl, token: await this.token(tx, current, "api") } } : {}) };
        if (!current.material) await tx.query("UPDATE cloud_v2_execution_contexts SET material=$2 WHERE id=$1", [id, sealExecution(value, envelopeBinding(current), this.deps.keys)]);
        current = await this.issueLease(tx, current, proof);
        return (kind === "bootstrap" ? CloudV2BootstrapLeaseSchema : kind === "terminal" ? CloudV2TerminalLeaseSchema : CloudV2ClientLeaseSchema).parse({ ...value, expiresAt: current.expires_at.getTime() });
      });
    });
  }

  async revoke(tx: Tx, id: string, reason: CloudV2ContextReason) {
    await tx.query(`UPDATE cloud_v2_execution_contexts SET state='revoked',reason=coalesce(reason,$2),revoked_at=coalesce(revoked_at,clock_timestamp())
      WHERE id=$1 AND state='active'`, [id, reason]);
  }

  async ended(tx: Tx, workspaceId: string, chatId: string, messageId?: string) {
    const rows = await tx.query<{ id: string }>(`SELECT id FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND chat_id=$2
      AND ($3::text IS NULL OR user_message_id=$3) AND state='active' AND kind='turn'`, [workspaceId, chatId, messageId ?? null]);
    for (const row of rows.rows) await this.revoke(tx, row.id, messageId ? "completed" : "cancelled");
  }

  async retired(identity: ExecutionWorker, id: string, input: { retirementId: string; reason: string; processes: number }) {
    if (input.processes !== 0) throw new HttpError(409, "execution_not_retired", "Execution processes are still running");
    const digest = createHash("sha256").update(JSON.stringify([input.retirementId, input.reason, input.processes])).digest();
    return withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx, identity, true, true), context = await this.context(tx, id, workspace.id, true);
      if (context.worker_boot_id !== identity.bootId) throw actorChanged();
      if (context.retirement_id) {
        if (context.retirement_id !== input.retirementId || !context.retirement_hash?.equals(digest)) throw actorChanged();
        return { retired: true as const };
      }
      await this.revoke(tx, id, input.reason === "outcome" || input.reason === "setup_done" || input.reason === "operation_done" ? "completed" :
        input.reason === "expired" ? "expired" : input.reason === "stop" ? "cancelled" : "actor_changed");
      await tx.query(`UPDATE cloud_v2_execution_contexts SET state='retired',retired_at=clock_timestamp(),retirement_id=$2,retirement_hash=$3,
        material=NULL,environment_version_id=NULL WHERE id=$1`, [id, input.retirementId, digest]);
      await notify(tx, workspace.id);
      return { retired: true as const };
    });
  }

  async renew(identity: ExecutionWorker, ids: readonly string[]) {
    const initial = await withSystemTx(this.pool, async tx => {
      const workspace = await this.worker(tx, identity, false, true);
      if (workspace.state !== "stopping") await this.boots.assertClean(tx, workspace);
      return { workspace, contexts: (await tx.query<ExecutionContext>("SELECT * FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND id=ANY($2::uuid[])", [workspace.id, ids])).rows };
    });
    const contexts = new Map(initial.contexts.map(row => [row.id, row]));
    return withExecutionLifetimeRetry(async () => {
      const proofs = new Map<string, ExecutionAdmission>();
      const people = new Map<string, ExecutionAdmission>();
      const refused = new Map<string, CloudV2ContextReason>();
      for (const id of ids) {
        const row = contexts.get(id);
        if (!row || row.state !== "active") { refused.set(id, row?.reason ?? "actor_changed"); continue; }
        if (row.worker_boot_id !== identity.bootId) { refused.set(id, "worker_changed"); continue; }
        if (row.expires_at.getTime() <= Date.now() || row.client_token_expires_at && row.client_token_expires_at.getTime() <= Date.now()) { refused.set(id, "expired"); continue; }
        if (initial.workspace.state === "stopping") { refused.set(id, "cancelled"); continue; }
        try {
          if (!row.user_id) throw memberAccessRevoked();
          let proof = people.get(row.user_id);
          if (!proof) {
            proof = await this.deps.authority.admit(row.workspace_id, row.user_id,
              { continuation: true, minimumSourceMs: EXECUTION_MINIMUM_LIFETIME_MS });
            people.set(row.user_id, proof);
          }
          assertExecutionLifetime(proof.until);
          proofs.set(id, proof);
        } catch (error) {
          if (!(error instanceof HttpError) || error.status >= 500) throw error;
          refused.set(id, error instanceof ExecutionContextRevoked || error.code === "member_access_revoked" ? "access_revoked" : "actor_changed");
        }
      }
      return withSystemTx(this.pool, async tx => {
        const workspace = await this.worker(tx, identity, true, true);
        const leases: Array<{ contextId: string; expiresAt: number } | { contextId: string; refused: CloudV2ContextReason }> = [];
        // Authority triggers take context locks in UUID order too.
        for (const id of [...ids].sort()) {
          const proof = proofs.get(id);
          if (proof && !refused.has(id)) {
            try {
              const row = await this.context(tx, id, workspace.id, true);
              if (row.state !== "active") refused.set(id, row.reason ?? "actor_changed");
              else if (row.expires_at.getTime() <= Date.now() || row.client_token_expires_at && row.client_token_expires_at.getTime() <= Date.now()) refused.set(id, "expired");
              else if (workspace.state === "stopping") refused.set(id, "cancelled");
              else {
                await this.assertContext(tx, row, proof);
                if (row.agent && row.selection) await this.deps.logins.select(row.org_id, row.user_id!, row.agent, row.selection, tx);
                const until = Math.min(proof.until, row.client_token_expires_at?.getTime() ?? Infinity);
                assertExecutionLifetime(until, row.client_token_expires_at?.getTime());
                await tx.query("UPDATE cloud_v2_execution_contexts SET expires_at=$2,authority=$3,source_fingerprint=$4 WHERE id=$1",
                  [id, new Date(until), executionContextAuthority(proof.person), proof.source?.fingerprint ?? null]);
                await this.assertContext(tx, row, proof);
                assertExecutionLifetime(until, row.client_token_expires_at?.getTime());
                leases.push({ contextId: id, expiresAt: until });
                continue;
              }
            } catch (error) {
              if (!(error instanceof HttpError) || error.status >= 500) throw error;
              refused.set(id, error instanceof ExecutionContextRevoked || error.code === "member_access_revoked" ? "access_revoked" :
                error instanceof ExecutionContextEnded ? error.reason : "actor_changed");
            }
          }
          if (contexts.has(id)) await this.revoke(tx, id, refused.get(id) ?? "actor_changed");
          leases.push({ contextId: id, refused: refused.get(id) ?? "actor_changed" });
        }
        const byId = new Map(leases.map(lease => [lease.contextId, lease]));
        return { leases: ids.map(id => byId.get(id)!) };
      });
    });
  }
}
