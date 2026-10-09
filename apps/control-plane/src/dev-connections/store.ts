import { cloudAgentModelAllowed } from "../cloud-workspaces/agent-models.js";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type pg from "pg";
import {ConditionalRemovalRequestSchema,ConditionalRemovalResponseSchema,type ConditionalRemovalRequest} from "./client.js";
import {HttpError} from "../authz.js";
import { cloudAgentCredentialConnectionMethod } from "../cloud-workspaces/agent-credentials.js";
import type { CloudAgentCredentialKeys } from "../cloud-workspaces/agent-credential-envelope.js";
import { codexRefreshFingerprint } from "../cloud-workspaces/codex-auth-cache.js";
import {
  sealMaterial,
  openMaterial,
  type MaterialBinding,
} from "./envelope.js";
import {
  accessMaterial,
  ConnectSchema,
  ConsentSchema,
  denied,
  GenerationSchema,
  GrantScopeSchema,
  invalid,
  parse,
  parseMaterial,
  reconnect,
  refreshSeed,
  uuid,
  type ConnectionReference,
  type Context,
  type DevMaterial,
  type GenerationAuth,
  type GenerationRegistration,
  type Grant,
  type GrantScope,
} from "./types.js";

type Tx = pg.PoolClient;
type Generation = { id: string; organization: string; expires_at: Date };
type Connection = {
  id: string;
  member_id: string;
  kind: DevMaterial["kind"];
  account_id: string;
  app_scope: string;
  connection_method: "account" | "api";
  revision: number;
  current_version: number;
  revoked_at: Date | null;
};
type Consent = {
  revision: number;
  models: string[];
  all_models: boolean;
  repositories: string[];
  scopes: string[];
  revoked_at: Date | null;
};
type Binding = {
  id: string;
  connection_id: string;
  member_id: string;
  connection_revision: number;
  consent_revision: number;
  expires_at: Date;
  revoked_at: Date | null;
};
type Version = {
  version: number;
  key_version: number;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  expires_at: Date | null;
};
type Attempt = {
  id: string;
  connection_id: string;
  revision: number;
  version: number;
  state: "reserved" | "dispatched" | "published" | "uncertain" | "abandoned";
  expired: boolean;
};
export type RenewalReservation = {
  connection: Connection;
  attempt: Attempt;
  material?: DevMaterial;
};
export type Snapshot = {
  connection: Connection;
  material: DevMaterial;
  expiresAt: Date | null;
};
const digest = (value: string) => createHash("sha256").update(value).digest();
function safeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The broker is the only database principal. Disposable backends never get DB access.
 * RLS is a second fence against accidentally using an ordinary product transaction. */
export class DevConnectionStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly keys: CloudAgentCredentialKeys,
  ) {
    if (!keys.refreshFingerprints || !keys.keys[keys.currentKeyVersion])
      throw new Error("Dev connection keys unavailable");
  }
  private async tx<T>(fn: (tx: Tx) => Promise<T>, outboxWriter = false): Promise<T> {
    const tx = await this.pool.connect();
    let lost = false;
    const onLost = () => {
      lost = true;
    };
    tx.on("error", onLost);
    try {
      await tx.query(
        "BEGIN; SET LOCAL ROLE zeros_app; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'; SELECT set_config('dev_connections.authority','broker',true)",
      );
      // Sequence allocation alone is not commit ordered. Every event writer
      // takes this common lock BEFORE any identity/row locks and retains it
      // through COMMIT. This also orders multi-generation revocations without
      // acquiring generation locks in conflicting orders. No provider I/O runs
      // under it; grant/restore readers do not need the writer lock.
      if (outboxWriter) await tx.query("SELECT pg_advisory_xact_lock(730318513)");
      const result = await fn(tx);
      if (lost) throw new Error("Dev connection database unavailable");
      await tx.query("COMMIT");
      if (lost) throw new Error("Dev connection database unavailable");
      return result;
    } catch (error) {
      if (!lost)
        await tx.query("ROLLBACK").catch(() => {
          lost = true;
        });
      throw error;
    } finally {
      tx.removeListener("error", onLost);
      tx.release(lost);
    }
  }
  async registerGeneration(value: unknown) {
    const input = parse(GenerationSchema, value),
      expires = Date.parse(input.expiresAt);
    if (expires <= Date.now() || expires > Date.now() + 7 * 86400000) invalid();
    return this.tx(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,730318512))",
        [input.id],
      );
      if (
        (
          await tx.query(
            "SELECT id FROM dev_connections.generation_revocations WHERE id=$1",
            [input.id],
          )
        ).rowCount
      )
        denied();
      await tx.query(
        `INSERT INTO dev_connections.generations(id,owner,organization,audience,credential_hash,key_revision,expires_at,source)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
        [
          input.id,
          input.owner,
          input.organization,
          input.audience,
          digest(input.credential),
          input.keyRevision,
          input.expiresAt,
          input.source,
        ],
      );
      const row = (
        await tx.query<
          GenerationRegistration & {
            credential_hash: Buffer;
            key_revision: number;
            revoked_at: Date | null;
            expires_at: Date;
          }
        >("SELECT * FROM dev_connections.generations WHERE id=$1 FOR UPDATE", [
          input.id,
        ])
      ).rows[0]!;
      if (
        row.revoked_at ||
        row.owner !== input.owner ||
        row.organization !== input.organization ||
        row.audience !== input.audience ||
        row.key_revision !== input.keyRevision ||
        row.expires_at.getTime() !== expires ||
        !safeEqual(row.credential_hash, digest(input.credential))
      )
        denied();
      return { id: input.id, expiresAt: input.expiresAt };
    });
  }
  /** Provisioner-only explicit rotation. Old generation credentials stop immediately. */
  async rotateGeneration(value: unknown) {
    const input = parse(GenerationSchema, value);
    if (
      Date.parse(input.expiresAt) <= Date.now() ||
      Date.parse(input.expiresAt) > Date.now() + 7 * 86400000
    )
      invalid();
    await this.tx(async (tx) => {
      const row = (
        await tx.query<{
          owner: string;
          organization: string;
          audience: string;
          key_revision: number;
          credential_hash: Buffer;
          expires_at: Date;
          revoked_at: Date | null;
        }>("SELECT * FROM dev_connections.generations WHERE id=$1 FOR UPDATE", [
          input.id,
        ])
      ).rows[0];
      if (
        !row ||
        row.revoked_at ||
        row.owner !== input.owner ||
        row.organization !== input.organization ||
        row.audience !== input.audience
      )
        denied();
      if (
        row.key_revision === input.keyRevision &&
        safeEqual(row.credential_hash, digest(input.credential)) &&
        row.expires_at.getTime() === Date.parse(input.expiresAt)
      )
        return;
      if (
        input.keyRevision !== row.key_revision + 1 ||
        safeEqual(row.credential_hash, digest(input.credential))
      )
        denied();
      await tx.query(
        "UPDATE dev_connections.generations SET credential_hash=$2,key_revision=$3,expires_at=$4 WHERE id=$1",
        [
          input.id,
          digest(input.credential),
          input.keyRevision,
          input.expiresAt,
        ],
      );
      await tx.query(
        "UPDATE dev_connections.bindings SET revoked_at=clock_timestamp() WHERE generation_id=$1",
        [input.id],
      );
      await tx.query(
        "INSERT INTO dev_connections.revocation_outbox(generation_id,reason) VALUES($1,'generation-key')",
        [input.id],
      );
    }, true);
  }
  private async generation(tx: Tx, auth: GenerationAuth): Promise<Generation> {
    if (
      !uuid.safeParse(auth.id).success ||
      !/^[A-Za-z0-9_-]{43}$/.test(auth.credential)
    )
      denied();
    const row = (
      await tx.query<
        Generation & { credential_hash: Buffer; audience: string }
      >(
        `SELECT * FROM dev_connections.generations
      WHERE id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
        [auth.id],
      )
    ).rows[0];
    if (
      !row ||
      row.audience !== auth.audience ||
      !safeEqual(row.credential_hash, digest(auth.credential))
    )
      denied();
    return row;
  }
  async authenticateGeneration(auth: GenerationAuth) {
    return this.tx((tx) => this.generation(tx, auth));
  }
  private async identity(tx: Tx, ctx: Context) {
    const generation = await this.generation(tx, ctx.generation);
    if (
      ctx.member.organization !== generation.organization ||
      ctx.member.expiresAt <= Date.now()
    )
      denied();
    await tx.query(
      "INSERT INTO dev_connections.members(id,issuer,subject) VALUES($1,$2,$3) ON CONFLICT(issuer,subject) DO NOTHING",
      [randomUUID(), ctx.member.issuer, ctx.member.subject],
    );
    const member = (
      await tx.query<{ id: string; revoked_at: Date | null }>(
        "SELECT id,revoked_at FROM dev_connections.members WHERE issuer=$1 AND subject=$2 FOR UPDATE",
        [ctx.member.issuer, ctx.member.subject],
      )
    ).rows[0]!;
    if (member.revoked_at) denied();
    return { generation, memberId: member.id };
  }
  private envelopeBinding(
    c: Connection,
    version: number,
    keyVersion: number,
  ): MaterialBinding {
    return {
      id: c.id,
      memberId: c.member_id,
      revision: c.revision,
      version,
      keyVersion,
      kind: c.kind,
      accountId: c.account_id,
      appScope: c.app_scope,
    };
  }
  private async material(tx: Tx, c: Connection): Promise<Snapshot> {
    const v = (
      await tx.query<Version>(
        "SELECT * FROM dev_connections.connection_versions WHERE connection_id=$1",
        [c.id],
      )
    ).rows[0];
    if (!v || v.version !== c.current_version) reconnect();
    const material = openMaterial(
      { nonce: v.nonce, ciphertext: v.ciphertext, authTag: v.auth_tag },
      this.envelopeBinding(c, v.version, v.key_version),
      this.keys,
    );
    if (material.kind !== c.kind) reconnect();
    return { connection: c, material, expiresAt: v.expires_at };
  }
  private async saveMaterial(
    tx: Tx,
    c: Connection,
    material: DevMaterial,
    version: number,
  ) {
    const keyVersion = this.keys.currentKeyVersion,
      sealed = sealMaterial(
        material,
        this.envelopeBinding(c, version, keyVersion),
        this.keys,
      ),
      access = accessMaterial(material);
    await tx.query(
      `INSERT INTO dev_connections.connection_versions(connection_id,version,key_version,nonce,ciphertext,auth_tag,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7::bigint)) ON CONFLICT(connection_id) DO UPDATE SET
      version=excluded.version,key_version=excluded.key_version,nonce=excluded.nonce,ciphertext=excluded.ciphertext,auth_tag=excluded.auth_tag,expires_at=excluded.expires_at`,
      [
        c.id,
        version,
        keyVersion,
        sealed.nonce,
        sealed.ciphertext,
        sealed.authTag,
        "expiresAt" in access ? (access.expiresAt ?? null) : null,
      ],
    );
  }
  private async rememberSeed(
    tx: Tx,
    id: string,
    material: DevMaterial,
    initial: boolean,
  ) {
    const seed = refreshSeed(material);
    if (!seed) return;
    const keys = this.keys.refreshFingerprints!,
      versions = Object.keys(keys.keys)
        .map(Number)
        .sort((a, b) => a - b);
    // Serialize both registry changes and all seed checks, including key rotation.
    await tx.query("SELECT pg_advisory_xact_lock(730318511)");
    for (const version of versions)
      await tx.query(
        "INSERT INTO dev_connections.fingerprint_keys VALUES($1,$2) ON CONFLICT DO NOTHING",
        [
          version,
          codexRefreshFingerprint(
            "zeros-dev-fingerprint-key-check-v1",
            keys.keys[version]!,
          ),
        ],
      );
    for (const row of (
      await tx.query<{ key_version: number; key_check: Buffer }>(
        "SELECT * FROM dev_connections.fingerprint_keys",
      )
    ).rows) {
      if (
        !keys.keys[row.key_version] ||
        !safeEqual(
          row.key_check,
          codexRefreshFingerprint(
            "zeros-dev-fingerprint-key-check-v1",
            keys.keys[row.key_version]!,
          ),
        )
      )
        reconnect();
    }
    for (const version of versions) {
      const fingerprint = codexRefreshFingerprint(seed, keys.keys[version]!);
      const row = (
        await tx.query<{ connection_id: string }>(
          "SELECT connection_id FROM dev_connections.refresh_fingerprints WHERE key_version=$1 AND fingerprint=$2",
          [version, fingerprint],
        )
      ).rows[0];
      if (row && (initial || row.connection_id !== id)) reconnect();
    }
    const count = (
      await tx.query<{ n: number }>(
        "SELECT count(*)::int n FROM dev_connections.refresh_fingerprints WHERE connection_id=$1",
        [id],
      )
    ).rows[0]!.n;
    if (count >= 10000) reconnect();
    await tx.query(
      "INSERT INTO dev_connections.refresh_fingerprints VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [
        keys.currentKeyVersion,
        codexRefreshFingerprint(seed, keys.keys[keys.currentKeyVersion]!),
        id,
      ],
    );
  }
  async connect(ctx: Context, value: unknown) {
    const input = parse(ConnectSchema, value),
      material = parseMaterial(input.material);
    if (
      material.kind === "codex-chatgpt" &&
      (input.accountId !== material.nativeCache.tokens.account_id ||
        input.appScope !== "chatgpt")
    )
      invalid();
    if (
      material.kind === "github-app" &&
      (input.accountId !== material.accountId ||
        input.appScope !== `${material.appId}:${material.clientId}`)
    )
      invalid();
    const requestHash = createHmac(
      "sha256",
      Buffer.from(
        this.keys.refreshFingerprints!.keys[
          this.keys.refreshFingerprints!.currentKeyVersion
        ]!,
        "base64url",
      ),
    )
      .update(JSON.stringify(input))
      .digest();
    return this.tx(async (tx) => {
      const { memberId } = await this.identity(tx, ctx);
      const previous = (
        await tx.query<Connection & { request_hash: Buffer }>(
          "SELECT * FROM dev_connections.connections WHERE id=$1 FOR UPDATE",
          [input.id],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.member_id !== memberId ||
          previous.revoked_at ||
          !safeEqual(previous.request_hash, requestHash)
        )
          denied();
        return { connectionId: previous.id };
      }
      // The member lock serializes this uniqueness check. Never surface a SQL
      // conflict (which can contain identity data) as a provider failure.
      const duplicate = await tx.query<{id:string}>(
        "SELECT id FROM dev_connections.connections WHERE member_id=$1 AND kind=$2 AND account_id=$3 AND app_scope=$4 AND revoked_at IS NULL",
        [memberId, material.kind, input.accountId, input.appScope],
      );
      if (duplicate.rowCount) {
        if (!input.replaceExisting) reconnect();
        // Explicit fresh authorization replaces only this authenticated member's
        // matching account. A reused seed rejects below and rolls back revocation.
        await this.revokeOwnedConnection(tx, duplicate.rows[0]!.id, memberId);
      }
      const method =
        material.kind === "github-app"
          ? "account"
          : cloudAgentCredentialConnectionMethod(
              accessMaterial(material) as Exclude<
                ReturnType<typeof accessMaterial>,
                { kind: "github-app" }
              >,
            );
      const c = (
        await tx.query<Connection>(
          `INSERT INTO dev_connections.connections(id,member_id,kind,account_id,app_scope,connection_method,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            input.id,
            memberId,
            material.kind,
            input.accountId,
            input.appScope,
            method,
            requestHash,
          ],
        )
      ).rows[0]!;
      await this.rememberSeed(tx, c.id, material, true);
      await this.saveMaterial(tx, c, material, 1);
      await tx.query(
        "INSERT INTO dev_connections.organization_consents(connection_id,organization,models,repositories,scopes,all_models) VALUES($1,$2,$3,$4,$5,$6)",
        [
          c.id,
          ctx.member.organization,
          input.consent.models,
          input.consent.repositories,
          input.consent.scopes,
          input.consent.allModels === true,
        ],
      );
      return { connectionId: c.id };
    }, input.replaceExisting === true);
  }
  async restore(ctx: Context): Promise<ConnectionReference[]> {
    return this.tx(async (tx) => {
      const { memberId, generation } = await this.identity(tx, ctx);
      const rows = (
        await tx.query<
          Connection & {
            consent_revision: number;
            models: string[];
            all_models: boolean;
            repositories: string[];
            scopes: ConnectionReference["consent"]["scopes"];
          }
        >(
          `SELECT c.*,s.revision AS consent_revision,s.models,s.repositories,s.scopes,s.all_models FROM dev_connections.connections c
        JOIN dev_connections.organization_consents s ON s.connection_id=c.id WHERE c.member_id=$1 AND s.organization=$2
        AND c.revoked_at IS NULL AND s.revoked_at IS NULL ORDER BY c.id LIMIT 101 FOR SHARE OF c,s`,
          [memberId, ctx.member.organization],
        )
      ).rows;
      if (rows.length > 100) denied();
      const refs: ConnectionReference[] = [];
      for (const c of rows) {
        const b = (
          await tx.query<Binding>(
            `INSERT INTO dev_connections.bindings(id,generation_id,member_id,connection_id,connection_revision,consent_revision,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(generation_id,connection_id) DO UPDATE SET
          connection_revision=excluded.connection_revision,consent_revision=excluded.consent_revision,expires_at=excluded.expires_at,revoked_at=NULL RETURNING *`,
            [
              randomUUID(),
              generation.id,
              memberId,
              c.id,
              c.revision,
              c.consent_revision,
              generation.expires_at,
            ],
          )
        ).rows[0]!;
        refs.push({
          mode: "dev-reference",
          bindingId: b.id,
          connectionId: c.id,
          generationId: generation.id,
          organization: ctx.member.organization,
          kind: c.kind,
          accountId: c.account_id,
          appScope: c.app_scope,
          revision: c.revision,
          consentRevision: c.consent_revision,
          consent: {
            models: c.models,
            ...(c.all_models ? { allModels: true } : {}),
            repositories: c.repositories,
            scopes: c.scopes,
          },
          connectionMethod: c.connection_method,
          expiresAt: b.expires_at.toISOString(),
        });
      }
      return refs;
    });
  }
  private async authorize(
    tx: Tx,
    ctx: Context,
    bindingId: string,
    scope: GrantScope,
  ) {
    const { memberId, generation } = await this.identity(tx, ctx);
    if (!uuid.safeParse(bindingId).success) denied();
    const b = (
      await tx.query<Binding>(
        "SELECT * FROM dev_connections.bindings WHERE id=$1 AND generation_id=$2 AND member_id=$3",
        [bindingId, generation.id, memberId],
      )
    ).rows[0];
    if (!b || b.revoked_at || b.expires_at.getTime() <= Date.now()) denied();
    const c = (
      await tx.query<Connection>(
        "SELECT * FROM dev_connections.connections WHERE id=$1 AND member_id=$2 FOR UPDATE",
        [b.connection_id, memberId],
      )
    ).rows[0];
    const s = (
      await tx.query<Consent>(
        "SELECT * FROM dev_connections.organization_consents WHERE connection_id=$1 AND organization=$2 FOR SHARE",
        [b.connection_id, ctx.member.organization],
      )
    ).rows[0];
    if (
      !c ||
      c.revoked_at ||
      !s ||
      s.revoked_at ||
      c.revision !== b.connection_revision ||
      s.revision !== b.consent_revision ||
      !s.scopes.includes(scope.action === "github:catalog" ? "github:read" : scope.action)
    )
      denied();
    if (
      scope.action === "agent"
        ? c.kind === "github-app" || !cloudAgentModelAllowed(c.kind, scope.model, s.models, s.all_models)
        : c.kind !== "github-app" || (scope.action !== "github:catalog" && !s.repositories.includes(scope.repository))
    )
      denied();
    return { connection: c, binding: b, generation };
  }
  async snapshot(
    ctx: Context,
    bindingId: string,
    value: unknown,
  ): Promise<Snapshot> {
    const scope = parse(GrantScopeSchema, value);
    return this.tx(async (tx) =>
      this.material(
        tx,
        (await this.authorize(tx, ctx, bindingId, scope)).connection,
      ),
    );
  }
  async reserve(
    ctx: Context,
    bindingId: string,
    scope: GrantScope,
    expectedVersion?: number,
  ): Promise<RenewalReservation | null> {
    return this.tx(async (tx) => {
      const { connection: c } = await this.authorize(tx, ctx, bindingId, scope),
        snapshot = await this.material(tx, c);
      let attempt = (
        await tx.query<Attempt>(
          `SELECT *,started_at<clock_timestamp()-interval '15 seconds' AS expired
        FROM dev_connections.refresh_attempts WHERE connection_id=$1 AND state IN ('reserved','dispatched','uncertain') FOR UPDATE`,
          [c.id],
        )
      ).rows[0];
      if (attempt?.state === "dispatched" && attempt.expired) {
        await tx.query(
          "UPDATE dev_connections.refresh_attempts SET state='uncertain' WHERE id=$1",
          [attempt.id],
        );
        return { connection: c, attempt: { ...attempt, state: "uncertain" } };
      }
      if (attempt?.state === "reserved" && attempt.expired) {
        await tx.query(
          "UPDATE dev_connections.refresh_attempts SET state='abandoned' WHERE id=$1",
          [attempt.id],
        );
        attempt = undefined;
      }
      if (attempt) return { connection: c, attempt };
      if (
        expectedVersion === undefined
          ? !snapshot.expiresAt || snapshot.expiresAt.getTime() > Date.now() + 60000
          : c.current_version !== expectedVersion
      )
        return null;
      const cooldown = await tx.query<{ ready: boolean }>(
        "SELECT clock_timestamp()>=refresh_after AS ready FROM dev_connections.connections WHERE id=$1",
        [c.id],
      );
      if (!cooldown.rows[0]!.ready) return null;
      if (!refreshSeed(snapshot.material)) reconnect();
      attempt = (
        await tx.query<Attempt>(
          "INSERT INTO dev_connections.refresh_attempts(id,connection_id,revision,version,state) VALUES($1,$2,$3,$4,'reserved') RETURNING *,false AS expired",
          [randomUUID(), c.id, c.revision, c.current_version],
        )
      ).rows[0]!;
      return { connection: c, attempt, material: snapshot.material };
    });
  }
  async dispatch(
    ctx: Context,
    bindingId: string,
    scope: GrantScope,
    reservation: RenewalReservation,
  ) {
    await this.tx(async (tx) => {
      const { connection: c } = await this.authorize(tx, ctx, bindingId, scope);
      if (
        c.id !== reservation.connection.id ||
        c.revision !== reservation.attempt.revision ||
        c.current_version !== reservation.attempt.version
      )
        reconnect();
      const changed = await tx.query(
        `UPDATE dev_connections.refresh_attempts SET state='dispatched',started_at=clock_timestamp()
        WHERE id=$1 AND connection_id=$2 AND state='reserved' AND started_at>clock_timestamp()-interval '15 seconds'`,
        [reservation.attempt.id, c.id],
      );
      if (changed.rowCount !== 1) reconnect();
    });
  }
  async publish(reservation: RenewalReservation, material: DevMaterial) {
    await this.tx(async (tx) => {
      const c = (
        await tx.query<Connection>(
          "SELECT * FROM dev_connections.connections WHERE id=$1 FOR UPDATE",
          [reservation.connection.id],
        )
      ).rows[0];
      const a = (
        await tx.query<Attempt>(
          "SELECT * FROM dev_connections.refresh_attempts WHERE id=$1 FOR UPDATE",
          [reservation.attempt.id],
        )
      ).rows[0];
      if (
        !c ||
        c.revoked_at ||
        c.revision !== reservation.attempt.revision ||
        !a
      )
        denied();
      if (
        a.state === "published" &&
        c.current_version > reservation.attempt.version
      )
        return;
      if (
        !["dispatched", "uncertain"].includes(a.state) ||
        c.current_version !== reservation.attempt.version ||
        material.kind !== c.kind
      )
        reconnect();
      if (c.current_version >= 2147483646) reconnect();
      await this.rememberSeed(tx, c.id, material, false);
      await this.saveMaterial(tx, c, material, c.current_version + 1);
      await tx.query(
        "UPDATE dev_connections.connections SET current_version=current_version+1,refresh_after=clock_timestamp()+interval '1 minute' WHERE id=$1",
        [c.id],
      );
      await tx.query(
        "UPDATE dev_connections.refresh_attempts SET state='published',published_version=$2 WHERE id=$1",
        [a.id, c.current_version + 1],
      );
    });
  }
  async settle(reservation: RenewalReservation) {
    return this.tx(async (tx) => {
      await tx.query(
        "SELECT id FROM dev_connections.connections WHERE id=$1 FOR UPDATE",
        [reservation.connection.id],
      );
      const row = (
        await tx.query<{ state: string }>(
          `UPDATE dev_connections.refresh_attempts SET state=CASE
        WHEN state='reserved' THEN 'abandoned' WHEN state='dispatched' THEN 'uncertain' ELSE state END WHERE id=$1 RETURNING state`,
          [reservation.attempt.id],
        )
      ).rows[0];
      return row?.state === "published";
    });
  }
  async renewalState(reservation: RenewalReservation) {
    return this.tx(
      async (tx) =>
        (
          await tx.query<{ state: string }>(
            "SELECT state FROM dev_connections.refresh_attempts WHERE id=$1",
            [reservation.attempt.id],
          )
        ).rows[0]?.state,
    );
  }
  async issue(
    ctx: Context,
    bindingId: string,
    scope: GrantScope,
    expectedVersion: number,
  ): Promise<Grant> {
    return this.tx(async (tx) => {
      const {
        connection: c,
        binding: b,
        generation: g,
      } = await this.authorize(tx, ctx, bindingId, scope);
      if (c.current_version !== expectedVersion) reconnect();
      const snapshot = await this.material(tx, c),
        now = Date.now();
      const uncertain = (
        await tx.query(
          "SELECT id FROM dev_connections.refresh_attempts WHERE connection_id=$1 AND state IN ('dispatched','uncertain')",
          [c.id],
        )
      ).rowCount;
      if (
        uncertain ||
        (snapshot.expiresAt && snapshot.expiresAt.getTime() <= now + 5000)
      )
        reconnect();
      const expires = new Date(
        Math.min(
          now + 300000,
          ctx.member.expiresAt,
          b.expires_at.getTime(),
          g.expires_at.getTime(),
          snapshot.expiresAt?.getTime() ?? Infinity,
        ),
      );
      if (expires.getTime() <= now) denied();
      const id = randomUUID();
      await tx.query(
        "INSERT INTO dev_connections.grant_audit(id,binding_id,member_id,connection_revision,consent_revision,scope,expires_at,provider_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          b.id,
          c.member_id,
          c.revision,
          b.consent_revision,
          JSON.stringify(scope),
          expires,
          snapshot.expiresAt,
        ],
      );
      return {
        id,
        bindingId: b.id,
        audience: ctx.generation.audience,
        scope,
        expiresAt: expires.toISOString(),
        providerExpiresAt: snapshot.expiresAt?.toISOString() ?? null,
        materialVersion: c.current_version,
        material: accessMaterial(snapshot.material),
      };
    });
  }
  async revokeGeneration(id: string) {
    id = parse(uuid, id);
    await this.tx(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,730318512))",
        [id],
      );
      await tx.query(
        "INSERT INTO dev_connections.generation_revocations(id) VALUES($1) ON CONFLICT(id) DO NOTHING",
        [id],
      );
      const changed = await tx.query(
        "UPDATE dev_connections.generations SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL RETURNING id",
        [id],
      );
      if (!changed.rowCount) return;
      await tx.query(
        "UPDATE dev_connections.bindings SET revoked_at=clock_timestamp() WHERE generation_id=$1",
        [id],
      );
      await tx.query(
        "INSERT INTO dev_connections.revocation_outbox(generation_id,reason) VALUES($1,'archive')",
        [id],
      );
    }, true);
  }
  async revokeConnection(ctx: Context, id: string) {
    parse(uuid, id);
    await this.tx(async (tx) => {
      const { memberId } = await this.identity(tx, ctx);
      await this.revokeOwnedConnection(tx, id, memberId);
    }, true);
  }
  async removeConditionally(ctx:Context,value:ConditionalRemovalRequest){
    const input=parse(ConditionalRemovalRequestSchema,value),requestHash=digest(JSON.stringify(input));
    return this.tx(async tx=>{
      const {memberId}=await this.identity(tx,ctx);
      const prior=(await tx.query<{request_sha256:Buffer;response:unknown}>(`SELECT request_sha256,response FROM dev_connections.removal_receipts
        WHERE generation_id=$1 AND member_id=$2 AND organization=$3 AND operation_id=$4`,[ctx.generation.id,memberId,ctx.member.organization,input.operationId])).rows[0];
      if(prior){if(!safeEqual(prior.request_sha256,requestHash))throw new HttpError(409,"dev_connection_conflict","dev_connection_conflict");
        return parse(ConditionalRemovalResponseSchema,prior.response);}
      const current=(await tx.query<{revision:number;consent_revision:number;binding_revision:number;binding_consent_revision:number;connection_revoked:Date|null;consent_revoked:Date|null;binding_revoked:Date|null}>(
        `SELECT connection.revision,consent.revision AS consent_revision,binding.connection_revision AS binding_revision,binding.consent_revision AS binding_consent_revision,
          connection.revoked_at AS connection_revoked,consent.revoked_at AS consent_revoked,binding.revoked_at AS binding_revoked
        FROM dev_connections.connections connection JOIN dev_connections.organization_consents consent ON consent.connection_id=connection.id AND consent.organization=$4
        JOIN dev_connections.bindings binding ON binding.connection_id=connection.id AND binding.member_id=connection.member_id
        WHERE connection.id=$1 AND connection.member_id=$2 AND binding.id=$3 AND binding.generation_id=$5
        FOR UPDATE OF connection,consent,binding`,[input.connectionId,memberId,input.bindingId,ctx.member.organization,ctx.generation.id])).rows[0];
      if(!current)denied();
      if(current.connection_revoked||current.consent_revoked||current.binding_revoked||current.revision!==input.expectedRevision||
        current.binding_revision!==input.expectedRevision||current.consent_revision!==input.expectedConsentRevision||current.binding_consent_revision!==input.expectedConsentRevision)
        throw new HttpError(409,"dev_connection_conflict","dev_connection_conflict");
      const count=(await tx.query<{n:number}>("SELECT count(*)::int AS n FROM dev_connections.removal_receipts WHERE generation_id=$1 AND member_id=$2",[ctx.generation.id,memberId])).rows[0]!.n;
      if(count>=128)throw new HttpError(429,"dev_connection_limit","dev_connection_limit");
      if(input.scope==="global")await this.revokeOwnedConnection(tx,input.connectionId,memberId);
      else {
        await tx.query("UPDATE dev_connections.organization_consents SET revoked_at=clock_timestamp(),revision=revision+1 WHERE connection_id=$1 AND organization=$2",[input.connectionId,ctx.member.organization]);
        await tx.query(`WITH revoked AS (UPDATE dev_connections.bindings binding SET revoked_at=clock_timestamp() FROM dev_connections.generations generation
          WHERE binding.connection_id=$1 AND generation.id=binding.generation_id AND generation.organization=$2 RETURNING binding.id,binding.generation_id)
          INSERT INTO dev_connections.revocation_outbox(generation_id,binding_id,reason) SELECT generation_id,id,'consent' FROM revoked`,[input.connectionId,ctx.member.organization]);
      }
      const response=parse(ConditionalRemovalResponseSchema,{version:1,operationId:input.operationId,connectionId:input.connectionId,scope:input.scope,removed:true});
      await tx.query("INSERT INTO dev_connections.removal_receipts(generation_id,member_id,organization,operation_id,request_sha256,response) VALUES($1,$2,$3,$4,$5,$6)",
        [ctx.generation.id,memberId,ctx.member.organization,input.operationId,requestHash,response]);
      return response;
    },true);
  }
  /** Caller holds the common outbox writer lock before member/connection locks. */
  private async revokeOwnedConnection(tx:Tx,id:string,memberId:string) {
      const changed = await tx.query(
        "UPDATE dev_connections.connections SET revoked_at=clock_timestamp(),revision=revision+1 WHERE id=$1 AND member_id=$2 AND revoked_at IS NULL RETURNING id",
        [id, memberId],
      );
      if (!changed.rowCount) denied();
      await tx.query("UPDATE dev_connections.refresh_attempts SET state='abandoned' WHERE connection_id=$1 AND state IN ('reserved','dispatched','uncertain')",[id]);
      await tx.query(
        "DELETE FROM dev_connections.connection_versions WHERE connection_id=$1",
        [id],
      );
      await tx.query(
        "UPDATE dev_connections.organization_consents SET revoked_at=clock_timestamp(),revision=revision+1 WHERE connection_id=$1",
        [id],
      );
      await tx.query(
        `WITH revoked AS (UPDATE dev_connections.bindings SET revoked_at=clock_timestamp() WHERE connection_id=$1 RETURNING id,generation_id)
        INSERT INTO dev_connections.revocation_outbox(generation_id,binding_id,reason) SELECT generation_id,id,'disconnect' FROM revoked`,
        [id],
      );
  }
  async consent(ctx: Context, id: string, value: unknown | null) {
    parse(uuid, id);
    const consent = value === null ? null : parse(ConsentSchema, value);
    await this.tx(async (tx) => {
      const { memberId } = await this.identity(tx, ctx);
      const c = (
        await tx.query(
          "SELECT id,kind FROM dev_connections.connections WHERE id=$1 AND member_id=$2 AND revoked_at IS NULL FOR UPDATE",
          [id, memberId],
        )
      ).rows[0];
      if (!c) denied();
      if(consent?.scopes.includes('agent')&&consent.models.length&&c.kind!=='github-app'){
        // The identity lock serializes selections across generations. Preserve
        // other connections for later selection, but only one provider consent
        // may automatically become the selected local organization credential.
        await tx.query(`WITH unselected AS (
          UPDATE dev_connections.organization_consents s SET models='{}',all_models=false,revision=s.revision+1
          FROM dev_connections.connections c WHERE s.connection_id=c.id AND c.member_id=$1 AND c.id<>$2
            AND split_part(c.kind,'-',1)=$4 AND s.organization=$3 AND s.revoked_at IS NULL AND cardinality(s.models)>0 RETURNING s.connection_id
        ), invalidated AS (
          UPDATE dev_connections.bindings b SET revoked_at=clock_timestamp() FROM dev_connections.generations g
          WHERE b.connection_id IN(SELECT connection_id FROM unselected) AND b.generation_id=g.id AND g.organization=$3 RETURNING b.id,b.generation_id
        ) INSERT INTO dev_connections.revocation_outbox(generation_id,binding_id,reason) SELECT generation_id,id,'consent' FROM invalidated`,
        [memberId,id,ctx.member.organization,c.kind.split('-')[0]]);
      }
      if(consent&&(await tx.query(`SELECT 1 FROM dev_connections.organization_consents WHERE connection_id=$1 AND organization=$2
        AND revoked_at IS NULL AND models=$3 AND repositories=$4 AND scopes=$5 AND all_models=$6`,[id,ctx.member.organization,consent.models,consent.repositories,consent.scopes,consent.allModels===true])).rowCount)return;
      if (consent)
        await tx.query(
          `INSERT INTO dev_connections.organization_consents(connection_id,organization,models,repositories,scopes,all_models) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(connection_id,organization) DO UPDATE SET revision=dev_connections.organization_consents.revision+1,models=excluded.models,all_models=excluded.all_models,repositories=excluded.repositories,scopes=excluded.scopes,revoked_at=NULL`,
          [
            id,
            ctx.member.organization,
            consent.models,
            consent.repositories,
            consent.scopes,
            consent.allModels === true,
          ],
        );
      else
        await tx.query(
          "UPDATE dev_connections.organization_consents SET revoked_at=clock_timestamp(),revision=revision+1 WHERE connection_id=$1 AND organization=$2",
          [id, ctx.member.organization],
        );
      await tx.query(
        `WITH revoked AS (UPDATE dev_connections.bindings b SET revoked_at=clock_timestamp() FROM dev_connections.generations g
        WHERE b.connection_id=$1 AND g.id=b.generation_id AND g.organization=$2 RETURNING b.id,b.generation_id)
        INSERT INTO dev_connections.revocation_outbox(generation_id,binding_id,reason) SELECT generation_id,id,'consent' FROM revoked`,
        [id, ctx.member.organization],
      );
    }, true);
  }
  async revocations(auth: GenerationAuth, after: string) {
    if (!/^[0-9]{1,18}$/.test(after)) invalid();
    return this.tx(async (tx) => {
      await this.generation(tx, auth);
      return (
        await tx.query(
          "SELECT sequence::text,binding_id,reason FROM dev_connections.revocation_outbox WHERE generation_id=$1 AND sequence>$2::bigint ORDER BY sequence LIMIT 100",
          [auth.id, after],
        )
      ).rows;
    });
  }
  async pruneAudit() {
    await this.tx(async (tx) => {
      await tx.query(
        "DELETE FROM dev_connections.grant_audit WHERE issued_at<clock_timestamp()-interval '30 days'",
      );
    });
  }
}
