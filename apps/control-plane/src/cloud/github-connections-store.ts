import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import type { CloudAgentCredentialKeys } from "../agent-credentials/agent-credential-envelope.js";
import {
  openGithubCredential,
  sealGithubCredential,
  type CloudGithubCredential,
  type CloudGithubCredentialBinding,
  type CloudGithubMethod,
} from "./github-credential-envelope.js";

export type CloudGithubConnectionScope = {
  organizationId: string;
  userId: string;
};
export type CloudGithubAccount = { id: string; login: string };
export interface CloudGithubCredentialSnapshot {
  material: CloudGithubCredential;
  identity: CloudGithubAccount;
  generation: string;
  assertCurrent(): Promise<void>;
}
export type CloudGithubConnectionStatus = {
  generation: string;
  selectedMethod: CloudGithubMethod | null;
  methods: Record<
    CloudGithubMethod,
    {
      configured: boolean;
      login?: string;
      expiresAt?: number | null;
      health: "connected" | "not-connected" | "expired";
    }
  >;
};
type Actor = {
  user_revision: string;
  org_revision: string;
  member_revision: string;
  member_created: string;
  selected_method: CloudGithubMethod | null;
  selection_generation: string | null;
};
type Row = {
  id: string;
  org_id: string;
  owner_user_id: string;
  method: CloudGithubMethod;
  generation: string;
  github_user_id: string;
  github_login: string;
  version: number;
  key_version: number;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  expires_at: Date | null;
  refresh_lease: string | null;
  refresh_lease_until: Date | null;
};
type Snapshot = { actor: Actor; generation: string; rows: Row[] };
const changed = () =>
  new HttpError(
    409,
    "github_authorization_changed",
    "Your cloud GitHub connection changed. Refresh before continuing.",
  );
const required = () =>
  new HttpError(
    409,
    "github_connection_required",
    "Connect GitHub in this organization's cloud settings.",
  );
const expired = () =>
  new HttpError(
    409,
    "github_authorization_expired",
    "Reconnect your cloud GitHub account to continue.",
  );
const binding = (row: Row): CloudGithubCredentialBinding => ({
  id: row.id,
  organizationId: row.org_id,
  userId: row.owner_user_id,
  method: row.method,
  generation: row.generation,
  version: row.version,
  keyVersion: row.key_version,
});
type AppCredential = Extract<CloudGithubCredential, { method: "github-app" }>;
export type RefreshCloudGithub = (
  credential: AppCredential,
  identity: CloudGithubAccount,
) => Promise<AppCredential>;

/** Secrets and explicit method selection belong to one human and organization.
 * Reads never borrow Local credentials or another member's installation. */
export class CloudGithubConnectionStore {
  private readonly refreshes = new Map<string, Promise<void>>();
  constructor(
    private readonly pool: pg.Pool,
    private readonly keys: CloudAgentCredentialKeys,
  ) {}

  private async snapshot(
    tx: Tx,
    scope: CloudGithubConnectionScope,
  ): Promise<Snapshot> {
    const actor = (
      await tx.query<Actor>(
        `SELECT u.auth_revision::text AS user_revision,o.authorization_revision::text AS org_revision,
      m.authorization_revision::text AS member_revision,m.created_at::text AS member_created,
      s.selected_method,s.generation::text AS selection_generation
      FROM organization_members m JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=m.org_id
      LEFT JOIN cloud_github_selections s ON s.org_id=m.org_id AND s.owner_user_id=m.user_id
      WHERE m.org_id=$1 AND m.user_id=$2 AND u.auth_status='active' AND u.deleted_at IS NULL
        AND o.deleted_at IS NULL AND NOT o.is_personal AND o.cloud_workspaces_allowed`,
        [scope.organizationId, scope.userId],
      )
    ).rows[0];
    if (!actor)
      throw new HttpError(404, "not_found", "Organization not found.");
    const rows = (
      await tx.query<Row>(
        "SELECT * FROM cloud_github_credentials WHERE org_id=$1 AND owner_user_id=$2 ORDER BY method",
        [scope.organizationId, scope.userId],
      )
    ).rows;
    const generation = createHash("sha256")
      .update(
        JSON.stringify([
          scope.organizationId,
          scope.userId,
          actor,
          rows.map((row) => [
            row.id,
            row.method,
            row.generation,
            row.github_user_id,
          ]),
        ]),
      )
      .digest("hex");
    return { actor, generation, rows };
  }
  private read(scope: CloudGithubConnectionScope) {
    return withSystemTx(this.pool, (tx) => this.snapshot(tx, scope));
  }
  async fingerprint(scope: CloudGithubConnectionScope): Promise<string> {
    return (await this.read(scope)).generation;
  }
  async assertCurrent(
    scope: CloudGithubConnectionScope,
    generation: string,
  ): Promise<void> {
    if ((await this.fingerprint(scope)) !== generation) throw changed();
  }
  async lockCurrent(
    tx: Tx,
    scope: CloudGithubConnectionScope,
    generation: string,
  ): Promise<void> {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0)) /* lock_purpose='cloud-github-connection' */",
      [JSON.stringify([scope.organizationId, scope.userId])],
    );
    if ((await this.snapshot(tx, scope)).generation !== generation)
      throw changed();
  }
  async status(
    scope: CloudGithubConnectionScope,
  ): Promise<CloudGithubConnectionStatus> {
    const value = await this.read(scope);
    const method = (kind: CloudGithubMethod) => {
      const row = value.rows.find((row) => row.method === kind);
      return row
        ? {
            configured: true,
            login: row.github_login,
            expiresAt: row.expires_at?.getTime() ?? null,
            health:
              row.method === "pat" &&
              row.expires_at &&
              row.expires_at.getTime() <= Date.now()
                ? ("expired" as const)
                : ("connected" as const),
          }
        : { configured: false, health: "not-connected" as const };
    };
    return {
      generation: value.generation,
      selectedMethod: value.actor.selected_method,
      methods: { "github-app": method("github-app"), pat: method("pat") },
    };
  }
  private async edit<T>(
    scope: CloudGithubConnectionScope,
    expected: string,
    action: (tx: Tx, value: Snapshot) => Promise<T>,
  ): Promise<T> {
    return withSystemTx(this.pool, async (tx) => {
      // Short mutation-only lock; no provider I/O occurs while it is held.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0)) /* lock_purpose='cloud-github-connection' */",
        [JSON.stringify([scope.organizationId, scope.userId])],
      );
      const value = await this.snapshot(tx, scope);
      if (value.generation !== expected) throw changed();
      return action(tx, value);
    });
  }
  private async selection(
    tx: Tx,
    scope: CloudGithubConnectionScope,
    method: CloudGithubMethod | null,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO cloud_github_selections(org_id,owner_user_id,selected_method,generation) VALUES($1,$2,$3,gen_random_uuid())
      ON CONFLICT(org_id,owner_user_id) DO UPDATE SET selected_method=EXCLUDED.selected_method,generation=EXCLUDED.generation`,
      [scope.organizationId, scope.userId, method],
    );
    await tx.query(
      `UPDATE cloud_v2_workspaces SET login_revision=login_revision+1
      WHERE org_id=$1 AND creator_user_id=$2 AND state<>'deleted'`,
      [scope.organizationId, scope.userId],
    );
    await tx.query("SELECT pg_notify('zeros_cloud_v2_logins',$1)", [
      JSON.stringify({
        organizationId: scope.organizationId,
        ownerUserId: scope.userId,
      }),
    ]);
  }
  async save(
    scope: CloudGithubConnectionScope,
    expected: string,
    identity: CloudGithubAccount,
    material: CloudGithubCredential,
  ): Promise<void> {
    if (
      !/^[1-9][0-9]{0,15}$/.test(identity.id) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(identity.login)
    )
      throw expired();
    const seal = {
      id: randomUUID(),
      generation: randomUUID(),
      organizationId: scope.organizationId,
      userId: scope.userId,
      method: material.method,
      version: 1,
      keyVersion: this.keys.currentKeyVersion,
    };
    const envelope = sealGithubCredential(material, seal, this.keys);
    await this.edit(scope, expected, async (tx) => {
      await this.selection(tx, scope, material.method);
      await tx.query(
        `INSERT INTO cloud_github_credentials(id,org_id,owner_user_id,method,generation,github_user_id,github_login,
        version,key_version,nonce,ciphertext,auth_tag,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12)
        ON CONFLICT(org_id,owner_user_id,method) DO UPDATE SET id=EXCLUDED.id,generation=EXCLUDED.generation,
        github_user_id=EXCLUDED.github_user_id,github_login=EXCLUDED.github_login,version=1,key_version=EXCLUDED.key_version,
        nonce=EXCLUDED.nonce,ciphertext=EXCLUDED.ciphertext,auth_tag=EXCLUDED.auth_tag,expires_at=EXCLUDED.expires_at,
        refresh_lease=NULL,refresh_lease_until=NULL,updated_at=now()`,
        [
          seal.id,
          scope.organizationId,
          scope.userId,
          material.method,
          seal.generation,
          identity.id,
          identity.login,
          seal.keyVersion,
          envelope.nonce,
          envelope.ciphertext,
          envelope.authTag,
          material.expiresAt === null ? null : new Date(material.expiresAt),
        ],
      );
    });
  }
  async select(
    scope: CloudGithubConnectionScope,
    expected: string,
    method: CloudGithubMethod,
  ): Promise<void> {
    await this.edit(scope, expected, async (tx, value) => {
      if (!value.rows.some((row) => row.method === method)) throw required();
      await this.selection(tx, scope, method);
    });
  }
  async disconnect(
    scope: CloudGithubConnectionScope,
    expected: string,
    method: CloudGithubMethod,
  ): Promise<void> {
    await this.edit(scope, expected, async (tx, value) => {
      await tx.query(
        "DELETE FROM cloud_github_credentials WHERE org_id=$1 AND owner_user_id=$2 AND method=$3",
        [scope.organizationId, scope.userId, method],
      );
      await this.selection(
        tx,
        scope,
        value.actor.selected_method === method
          ? null
          : value.actor.selected_method,
      );
    });
  }
  async beginOauth(
    scope: CloudGithubConnectionScope,
    expected: string,
    state: string,
    verifier: string,
  ): Promise<string> {
    return this.edit(scope, expected, async (tx, value) => {
      // Starting a new attempt invalidates older callbacks without changing the
      // selected method or discarding its usable credential.
      await this.selection(tx, scope, value.actor.selected_method);
      const generation = (await this.snapshot(tx, scope)).generation;
      await tx.query(
        "DELETE FROM cloud_github_oauth_states WHERE org_id=$1 AND owner_user_id=$2",
        [scope.organizationId, scope.userId],
      );
      await tx.query(
        `INSERT INTO cloud_github_oauth_states(state_hash,org_id,owner_user_id,expected_generation,pkce_verifier,expires_at)
        VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')`,
        [
          createHash("sha256").update(state).digest(),
          scope.organizationId,
          scope.userId,
          generation,
          verifier,
        ],
      );
      return generation;
    });
  }
  async consumeOauth(
    state: string,
  ): Promise<{
    scope: CloudGithubConnectionScope;
    expected: string;
    verifier: string;
  }> {
    const row = await withSystemTx(
      this.pool,
      async (tx) =>
        (
          await tx.query<{
            org_id: string;
            owner_user_id: string;
            expected_generation: string;
            pkce_verifier: string;
          }>(
            `DELETE FROM cloud_github_oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING *`,
            [createHash("sha256").update(state).digest()],
          )
        ).rows[0],
    );
    if (!row)
      throw new HttpError(
        422,
        "oauth_state_expired",
        "This GitHub sign-in expired. Start again from Zeros.",
      );
    const scope = { organizationId: row.org_id, userId: row.owner_user_id };
    await this.assertCurrent(scope, row.expected_generation);
    return {
      scope,
      expected: row.expected_generation,
      verifier: row.pkce_verifier,
    };
  }
  async cancelOauth(
    scope: CloudGithubConnectionScope,
    expected: string,
  ): Promise<void> {
    await this.edit(scope, expected, async (tx, value) => {
      await this.selection(tx, scope, value.actor.selected_method);
      await tx.query(
        "DELETE FROM cloud_github_oauth_states WHERE org_id=$1 AND owner_user_id=$2",
        [scope.organizationId, scope.userId],
      );
    });
  }
  async credential(
    scope: CloudGithubConnectionScope,
    refresh?: RefreshCloudGithub,
  ): Promise<CloudGithubCredentialSnapshot> {
    const value = await this.read(scope),
      row = value.rows.find(
        (row) => row.method === value.actor.selected_method,
      );
    if (!row) throw required();
    let material: CloudGithubCredential;
    try {
      material = openGithubCredential(
        { nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag },
        binding(row),
        this.keys,
      );
    } catch {
      throw expired();
    }
    if (
      material.expiresAt !== null &&
      material.expiresAt <= Date.now() + 60_000
    ) {
      if (
        material.method !== "github-app" ||
        !refresh ||
        material.refreshExpiresAt <= Date.now() + 60_000
      )
        throw expired();
      await this.renew(scope, value.generation, row, material, refresh);
      await this.assertCurrent(scope, value.generation);
      return this.credential(scope);
    }
    await this.assertCurrent(scope, value.generation);
    return {
      material,
      identity: { id: row.github_user_id, login: row.github_login },
      generation: value.generation,
      assertCurrent: () => this.assertCurrent(scope, value.generation),
    };
  }
  private renew(
    scope: CloudGithubConnectionScope,
    generation: string,
    row: Row,
    material: AppCredential,
    refresh: RefreshCloudGithub,
  ): Promise<void> {
    const existing = this.refreshes.get(row.id);
    if (existing) return existing;
    const pending = this.refresh(
      scope,
      generation,
      row,
      material,
      refresh,
    ).finally(() => {
      if (this.refreshes.get(row.id) === pending) this.refreshes.delete(row.id);
    });
    this.refreshes.set(row.id, pending);
    return pending;
  }
  private async refresh(
    scope: CloudGithubConnectionScope,
    generation: string,
    row: Row,
    material: AppCredential,
    refresh: RefreshCloudGithub,
  ): Promise<void> {
    const lease = randomUUID();
    const claimed = await this.edit(
      scope,
      generation,
      async (tx) =>
        (
          await tx.query(
            `UPDATE cloud_github_credentials
      SET refresh_lease=$3,refresh_lease_until=now()+interval '45 seconds' WHERE id=$1 AND version=$2 AND refresh_lease IS NULL RETURNING id`,
            [row.id, row.version, lease],
          )
        ).rowCount,
    );
    if (!claimed) {
      const live = (await this.read(scope)).rows.find(
        (value) => value.id === row.id,
      );
      if (live && live.version > row.version) return;
      // A timed-out refresh may already have consumed its rotating token. Do
      // not replay it merely because a process died or a lease expired.
      if (
        live?.refresh_lease_until &&
        live.refresh_lease_until.getTime() <= Date.now()
      )
        throw expired();
      throw new HttpError(
        503,
        "github_refresh_pending",
        "GitHub is refreshing this connection. Try again shortly.",
      );
    }
    const next = await refresh(material, {
      id: row.github_user_id,
      login: row.github_login,
    });
    if (next.expiresAt <= Date.now() + 60_000) throw expired();
    const nextBinding = {
      ...binding(row),
      version: row.version + 1,
      keyVersion: this.keys.currentKeyVersion,
    };
    const sealed = sealGithubCredential(next, nextBinding, this.keys);
    await this.edit(scope, generation, async (tx) => {
      const saved = await tx.query(
        `UPDATE cloud_github_credentials SET version=$3,key_version=$4,nonce=$5,ciphertext=$6,auth_tag=$7,
        expires_at=$8,refresh_lease=NULL,refresh_lease_until=NULL,updated_at=now() WHERE id=$1 AND version=$2 AND refresh_lease=$9 RETURNING id`,
        [
          row.id,
          row.version,
          nextBinding.version,
          nextBinding.keyVersion,
          sealed.nonce,
          sealed.ciphertext,
          sealed.authTag,
          new Date(next.expiresAt),
          lease,
        ],
      );
      if (!saved.rowCount) throw changed();
    });
  }
}
