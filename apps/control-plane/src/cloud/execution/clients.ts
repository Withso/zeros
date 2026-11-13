import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { withSystemTx, type Tx } from "../../db.js";
import { assertNoExecutionTransition } from "./activation-state.js";
import { CLOUD_V2_CLIENT_OPERATIONS } from "../contract.js";
import { CloudV2PromptIdSchema } from "../prompt-contract.js";
import { newCloudV2Token } from "../tokens.js";
import type { CloudV2AppGrant } from "../store.js";
import type { ExecutionAdmission } from "./authority.js";
import type { CloudExecutionContexts, ExecutionContext, ExecutionWorker } from "./store.js";
import { executionContextAuthority, matchesExecutionSignature, type VersionedExecutionAuthority } from "./signatures.js";
import { actorChanged, executionWorkerRequired } from "./errors.js";
import { EXECUTION_MINIMUM_LIFETIME_MS, assertExecutionLifetime, withExecutionLifetimeRetry } from "./lifetime.js";

export type ExecutionConnectAuthority = VersionedExecutionAuthority & { signature: string; stopGeneration: string; tokenEnd: number };
const record = z.object({ type: z.string(), id: CloudV2PromptIdSchema.optional(), op: z.string().optional(),
  sessionId: CloudV2PromptIdSchema.optional(), params: z.unknown().optional() }).passthrough();

export class CloudExecutionClients {
  constructor(readonly contexts: CloudExecutionContexts) {}

  async ticket(workspaceId: string, user: AuthedUser, wake: boolean) {
    const proof = await this.contexts.deps.authority.admit(workspaceId, user.id, { user, minimumSourceMs: EXECUTION_MINIMUM_LIFETIME_MS });
    const tokenEnd = user.authentication.tokenExpiresAt ? user.authentication.tokenExpiresAt * 1000 : proof.until;
    const expiresAt = new Date(Math.min(Date.now() + 60_000, tokenEnd));
    const token = newCloudV2Token("connect");
    await withSystemTx(this.contexts.pool, async tx => {
      await tx.query("SELECT id FROM users WHERE id=$1 FOR KEY SHARE", [user.id]);
      await tx.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [workspaceId]);
      await assertNoExecutionTransition(tx, workspaceId);
      await this.contexts.deps.authority.assert(proof, tx);
      const authority: ExecutionConnectAuthority = { signatureVersion: 2, signature: proof.person.personSignature, stopGeneration: proof.person.stopGeneration, tokenEnd };
      await tx.query(`INSERT INTO cloud_v2_tokens(token_hash,workspace_id,kind,user_id,expires_at,wake_on_connect,provider_session_id,execution_authority)
        VALUES($1,$2,'connect',$3,$4,$5,$6,$7)`, [token.hash, workspaceId, user.id, expiresAt, wake, user.authentication.sessionId, authority]);
      await this.contexts.deps.authority.assert(proof, tx);
    });
    return { token: token.token, expiresAt };
  }

  async validateGrant(workspaceId: string, grant: CloudV2AppGrant) {
    if (!grant.execution || grant.execution.tokenEnd <= Date.now()) throw actorChanged();
    const proof = await this.contexts.deps.authority.admit(workspaceId, grant.userId, { continuation: true });
    if (!matchesExecutionSignature(grant.execution, grant.execution.signature, proof.person, "personSignature") || proof.person.accessEpoch !== grant.accessEpoch) throw actorChanged();
    await withSystemTx(this.contexts.pool, async tx => {
      if (grant.sessionId) await this.session(tx, grant.userId, grant.sessionId);
      await this.contexts.deps.authority.assert(proof, tx);
    });
    return proof;
  }

  async open(workspaceId: string, clientId: string, grant: CloudV2AppGrant) {
    if (!grant.execution || grant.execution.tokenEnd <= Date.now()) throw actorChanged();
    const execution = grant.execution;
    return withExecutionLifetimeRetry(async () => {
      const proof = await this.contexts.deps.authority.admit(workspaceId, grant.userId, { minimumSourceMs: EXECUTION_MINIMUM_LIFETIME_MS });
      if (!matchesExecutionSignature(execution, execution.signature, proof.person, "personSignature") || proof.person.accessEpoch !== grant.accessEpoch) throw actorChanged();
      return withSystemTx(this.contexts.pool, async tx => {
        await tx.query("SELECT id FROM users WHERE id=$1 FOR KEY SHARE", [proof.person.userId]);
        await tx.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [workspaceId]);
        await this.contexts.deps.authority.assert(proof, tx);
        if (!(await tx.query(`SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 AND state='running' AND archived_at IS NULL
          AND worker_boot_id=$2 AND worker_boot_id=ANY(acting_user_boot_ids)`, [workspaceId, proof.person.bootId])).rowCount) throw executionWorkerRequired();
        await this.contexts.boots.assertClean(tx, { id: workspaceId, worker_boot_id: proof.person.bootId!,
          access_epoch: proof.person.accessEpoch, stop_generation: proof.person.stopGeneration, worker_token_hash: Buffer.from(proof.person.workerTokenHash!, "hex") });
        if (grant.sessionId) await this.session(tx, grant.userId, grant.sessionId);
        const context = await this.insert(tx, proof, { kind: "client", clientId, sessionId: grant.sessionId, tokenEnd: grant.execution!.tokenEnd });
        await this.contexts.assertContext(tx, context, proof);
        assertExecutionLifetime(context.expires_at.getTime());
        return { contextId: context.id, userId: grant.userId, expiresAt: context.expires_at.getTime() };
      });
    });
  }

  private async session(tx: Tx, userId: string, sessionId: string) {
    if (!(await tx.query(`SELECT 1 FROM auth_sessions s WHERE s.provider='workos' AND s.provider_session_id=$1 AND s.user_id=$2
      AND s.status='active' AND s.revoked_at IS NULL AND (s.provider_session_expires_at IS NULL OR s.provider_session_expires_at>clock_timestamp())
      AND EXISTS(SELECT 1 FROM user_identities i WHERE i.user_id=s.user_id AND i.provider=s.provider AND i.provider_sub=s.provider_sub AND i.status='active')`, [sessionId, userId])).rowCount)
      throw new HttpError(401, "session_revoked", "Authentication is no longer current");
  }

  private async insert(tx: Tx, proof: ExecutionAdmission, input: { kind: "client" | "terminal"; clientId: string; sessionId: string | null;
    tokenEnd?: number; operation?: string; requestId?: string; terminalId?: string; parentId?: string; fingerprint?: Buffer }) {
    const person = proof.person;
    const until = Math.min(proof.until, input.tokenEnd ?? Infinity);
    assertExecutionLifetime(until);
    const row = (await tx.query<ExecutionContext>(`INSERT INTO cloud_v2_execution_contexts(id,workspace_id,org_id,user_id,kind,client_id,
      provider_session_id,client_token_expires_at,operation,request_id,terminal_id,parent_context_id,request_fingerprint,
      access_epoch,stop_generation,worker_boot_id,worker_token_hash,authority,source_fingerprint,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,decode($17,'hex'),$18,$19,$20) RETURNING *`,
    [randomUUID(), person.workspaceId, person.organizationId, person.userId, input.kind, input.clientId, input.sessionId,
      input.tokenEnd ? new Date(input.tokenEnd) : null, input.operation ?? null, input.requestId ?? null, input.terminalId ?? null, input.parentId ?? null,
      input.fingerprint ?? null, person.accessEpoch, person.stopGeneration, person.bootId, person.workerTokenHash, executionContextAuthority(person), proof.source.fingerprint,
      new Date(until)])).rows[0]!;
    assertExecutionLifetime(until);
    return row;
  }

  async current(workspaceId: string, id: string, minimumSourceMs = 0) {
    const context = await withSystemTx(this.contexts.pool, tx => this.contexts.context(tx, id, workspaceId));
    const proof = await this.contexts.admission(context, minimumSourceMs);
    return { context, proof };
  }

  async forward(workspaceId: string, id: string, frame: unknown): Promise<void> {
    const parsed = record.safeParse(frame);
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid client frame");
    const request = parsed.data;
    const terminal = request.type === "PTY_CREATE";
    const operation = terminal ? "terminal.create" : request.type === "WORKSPACE_REQUEST" &&
      CLOUD_V2_CLIENT_OPERATIONS.some(op => op === request.op) && (request.op !== "git.repoBranchCatalog" ||
        (request.params as { fetch?: unknown } | undefined)?.fetch === true) ? request.op : null;
    return withExecutionLifetimeRetry(async () => {
      const { context: handle, proof } = await this.current(workspaceId, id, operation ? EXECUTION_MINIMUM_LIFETIME_MS : 0);
      if (handle.kind !== "client" || handle.operation || handle.sync_device_id) throw actorChanged();
      if (request.type === "AGENT_PROMPT" || request.type === "AGENT_STEER") throw new HttpError(409, "client_update_required", "Update the desktop before sending in a shared workspace");
      const fingerprint = createHash("sha256").update(JSON.stringify([request.type, request.op, request.params, request.sessionId])).digest();
      await withSystemTx(this.contexts.pool, async tx => {
        let issued: ExecutionContext | undefined;
        await tx.query("SELECT id FROM users WHERE id=$1 FOR KEY SHARE", [proof.person.userId]);
        await tx.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [workspaceId]);
        await this.contexts.assertContext(tx, handle, proof);
        if (["PTY_CREATE", "PTY_WRITE", "PTY_RESIZE", "PTY_KILL"].includes(request.type)) {
          if (!request.sessionId) throw actorChanged();
          const owner = (await tx.query<ExecutionContext>(`SELECT * FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND worker_boot_id=$2
            AND kind='terminal' AND terminal_id=$3 AND state<>'retired'`, [workspaceId, handle.worker_boot_id, request.sessionId])).rows[0];
          if (owner && owner.user_id !== handle.user_id || !terminal && !owner) throw actorChanged();
          if (owner) await this.contexts.assertContext(tx, owner, proof);
        }
        if (operation) {
          if (!request.id) throw actorChanged();
          const prior = (await tx.query<ExecutionContext>(`SELECT * FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND client_id=$2 AND request_id=$3 AND kind='client'`,
            [workspaceId, handle.client_id, request.id])).rows[0];
          if (prior) {
            if (prior.operation !== operation || !prior.request_fingerprint?.equals(fingerprint)) throw actorChanged();
            await this.contexts.assertContext(tx, prior, proof);
          } else {
            const count = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM cloud_v2_execution_contexts WHERE parent_context_id=$1 AND state='active'", [id])).rows[0]!.n;
            if (count >= 128) throw new HttpError(429, "execution_limited", "Too many client operations");
            issued = await this.insert(tx, proof, { kind: "client", clientId: handle.client_id!, sessionId: handle.provider_session_id, parentId: id,
              requestId: request.id, operation, fingerprint, ...(terminal ? { terminalId: request.sessionId! } : {}),
              ...(handle.client_token_expires_at ? { tokenEnd: handle.client_token_expires_at.getTime() } : {}) });
          }
        }
        await this.contexts.assertContext(tx, handle, proof);
        if (issued) assertExecutionLifetime(issued.expires_at.getTime());
      });
    });
  }

  private async request(identity: ExecutionWorker, clientId: string, requestId: string, operation: string) {
    const context = await withSystemTx(this.contexts.pool, async tx => {
      const workspace = await this.contexts.worker(tx, identity);
      const row = (await tx.query<ExecutionContext>(`SELECT * FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND client_id=$2
        AND request_id=$3 AND kind='client' AND operation=$4 AND worker_boot_id=$5`, [workspace.id, clientId, requestId, operation, identity.bootId])).rows[0];
      if (!row) throw actorChanged();
      return row;
    });
    return context;
  }

  async operationLease(identity: ExecutionWorker, input: { clientId: string; requestId: string; operation: string }) {
    const context = await this.request(identity, input.clientId, input.requestId, input.operation);
    return this.contexts.identityLease(identity, context.id, "client");
  }

  async terminalLease(identity: ExecutionWorker, input: { clientId: string; requestId: string; terminalId: string }) {
    const request = await this.request(identity, input.clientId, input.requestId, "terminal.create");
    if (request.terminal_id !== input.terminalId) throw actorChanged();
    const id = await withExecutionLifetimeRetry(async () => {
      const proof = await this.contexts.admission(request, EXECUTION_MINIMUM_LIFETIME_MS);
      return withSystemTx(this.contexts.pool, async tx => {
        await tx.query("SELECT id FROM users WHERE id=$1 FOR KEY SHARE", [proof.person.userId]);
        const workspace = await this.contexts.worker(tx, identity, true);
        await this.contexts.assertContext(tx, request, proof);
        const prior = (await tx.query<ExecutionContext>(`SELECT * FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND worker_boot_id=$2 AND kind='terminal'
          AND ((client_id=$3 AND request_id=$4) OR (terminal_id=$5 AND state<>'retired')) ORDER BY created_at LIMIT 1`,
        [workspace.id, identity.bootId, input.clientId, input.requestId, input.terminalId])).rows[0];
        if (prior) { if (prior.user_id !== request.user_id) throw actorChanged(); await this.contexts.assertContext(tx, prior, proof); return prior.id; }
        const row = await this.insert(tx, proof, { kind: "terminal", clientId: input.clientId, sessionId: request.provider_session_id, requestId: input.requestId, terminalId: input.terminalId });
        await this.contexts.assertContext(tx, request, proof);
        assertExecutionLifetime(row.expires_at.getTime());
        return row.id;
      });
    });
    return this.contexts.identityLease(identity, id, "terminal");
  }

  async close(workspaceId: string, clientId: string) {
    await withSystemTx(this.contexts.pool, async tx => {
      await tx.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [workspaceId]);
      const rows = (await tx.query<{ id: string }>(`SELECT id FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND client_id=$2 AND kind='client' AND state<>'retired' ORDER BY id`, [workspaceId, clientId])).rows;
      for (const row of rows) await this.contexts.revoke(tx, row.id, "client_closed");
      await this.retireHandles(tx, workspaceId, rows.map(row => row.id));
    });
  }

  async retireHandles(tx: Tx, workspaceId: string, ids: readonly string[]) {
    // Handles and terminal-create receipts own no processes. The terminal's
    // separate context and ordinary RPC contexts still need worker retirement.
    await tx.query(`WITH target AS MATERIALIZED (SELECT id FROM cloud_v2_execution_contexts
      WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND kind='client' AND (operation IS NULL OR operation='terminal.create')
        AND state='revoked' ORDER BY id FOR UPDATE)
      UPDATE cloud_v2_execution_contexts SET state='retired',retired_at=clock_timestamp() WHERE id IN (SELECT id FROM target)`, [workspaceId, ids]);
  }
}
