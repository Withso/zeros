import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import {
  sealCloudAgentCredential,
  type CloudAgentCredentialKeys,
} from "./agent-credential-envelope.js";
import {
  CODEX_AUTH_RUNTIME_VERSION,
  codexRefreshFingerprint,
  openCodexNativeCache,
  parseCodexNativeCache,
  sealCodexNativeCache,
  type CodexNativeAuthCache,
} from "./codex-auth-cache.js";
import {
  renewCodexNativeAuth,
  type CodexAuthRenewer,
} from "./codex-auth-keeper.js";

export type CodexCredentialVersion = {
  id: string;
  owner_user_id: string;
  revision: string;
  current_version: number;
};
type CacheRow = {
  credential_id: string;
  credential_revision: string;
  material_version: number;
  runtime_version: string;
  binding_sha256: Buffer;
  key_version: number;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  state: "ready" | "reserved" | "dispatched" | "uncertain";
  attempt_id: string | null;
  attempt_started_at: Date | null;
  refresh_after: Date;
  reservation_expired: boolean;
  refresh_allowed: boolean;
};
export type CodexRefreshReservation = {
  credential: CodexCredentialVersion;
  attemptId: string;
  cache?: CodexNativeAuthCache;
};
function unavailable(): never {
  throw new HttpError(
    409,
    "codex_auth_reconnect_required",
    "Reconnect the Codex account to renew its credentials",
  );
}

/** Parent credential is already locked. Serialize exact seeds across owners
 * and replicas before testing the unique keyed fingerprints. */
export async function rememberCodexRefreshSeed(
  tx: Tx,
  credentialId: string,
  seed: string,
  keys: CloudAgentCredentialKeys,
  initial: boolean,
) {
  const fingerprints = keys.refreshFingerprints;
  if (!fingerprints || !fingerprints.keys[fingerprints.currentKeyVersion])
    throw new Error("Codex refresh fingerprint keys are unavailable");
  const keyVersions = Object.keys(fingerprints.keys)
    .map(Number)
    .sort((a, b) => a - b);
  // A small registry detects unavailable or silently replaced fingerprint
  // keys without scanning the ever-growing security tombstones.
  for (const version of keyVersions)
    await tx.query(
      `INSERT INTO cloud_codex_refresh_key_versions(key_version,key_check)
    VALUES($1,$2) ON CONFLICT(key_version) DO NOTHING`,
      [
        version,
        codexRefreshFingerprint(
          "zeros-codex-fingerprint-key-check-v1",
          fingerprints.keys[version]!,
        ),
      ],
    );
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,461205))", [
    createHash("sha256").update(seed).digest("hex"),
  ]);
  // Read after acquiring the seed fence: a concurrently bootstrapping replica
  // may have registered another key version while this transaction waited.
  const registered = (
    await tx.query<{ key_version: number; key_check: Buffer }>(
      "SELECT key_version,key_check FROM cloud_codex_refresh_key_versions",
    )
  ).rows;
  for (const row of registered) {
    const key = fingerprints.keys[row.key_version];
    if (
      !key ||
      !codexRefreshFingerprint(
        "zeros-codex-fingerprint-key-check-v1",
        key,
      ).equals(row.key_check)
    )
      throw new Error("Codex refresh fingerprint keys are unavailable");
  }
  for (const keyVersion of keyVersions) {
    const fingerprint = codexRefreshFingerprint(
      seed,
      fingerprints.keys[keyVersion]!,
    );
    const existing = (
      await tx.query<{ credential_id: string | null }>(
        "SELECT credential_id FROM cloud_codex_refresh_fingerprints WHERE key_version=$1 AND fingerprint=$2",
        [keyVersion, fingerprint],
      )
    ).rows[0];
    if (existing && (initial || existing.credential_id !== credentialId))
      throw new HttpError(
        409,
        "codex_auth_seed_already_used",
        "Use a separate Codex login for this credential",
      );
  }
  const count = (
    await tx.query<{ n: number }>(
      "SELECT count(*)::integer AS n FROM cloud_codex_refresh_fingerprints WHERE credential_id=$1",
      [credentialId],
    )
  ).rows[0]!.n;
  if (count >= 10000) unavailable();
  await tx.query(
    `INSERT INTO cloud_codex_refresh_fingerprints(key_version,fingerprint,credential_id) VALUES($1,$2,$3)
    ON CONFLICT(key_version,fingerprint) DO NOTHING`,
    [
      fingerprints.currentKeyVersion,
      codexRefreshFingerprint(
        seed,
        fingerprints.keys[fingerprints.currentKeyVersion]!,
      ),
      credentialId,
    ],
  );
}

/** Dispatch is durable before native code can rotate a token. A lost dispatched
 * attempt is never reclaimed by a timeout; only pre-dispatch reservations are. */
export class DatabaseCodexAuthRenewal {
  constructor(
    private readonly pool: pg.Pool,
    private readonly keys: CloudAgentCredentialKeys,
    private readonly renew: CodexAuthRenewer = renewCodexNativeAuth,
  ) {}

  async reserve(
    tx: Tx,
    credential: CodexCredentialVersion,
    force = false,
  ): Promise<CodexRefreshReservation | null> {
    let row = (
      await tx.query<CacheRow>(
        `SELECT *,attempt_started_at<now()-interval '15 seconds' AS reservation_expired,
      refresh_after<=now() AS refresh_allowed FROM cloud_codex_auth_caches WHERE credential_id=$1 FOR UPDATE`,
        [credential.id],
      )
    ).rows[0];
    if (!row) {
      if (force) unavailable();
      return null;
    }
    if (
      row.credential_revision !== credential.revision ||
      row.material_version !== credential.current_version ||
      row.runtime_version !== CODEX_AUTH_RUNTIME_VERSION
    )
      unavailable();
    if (row.state === "uncertain") unavailable();
    if (row.state === "dispatched" && row.reservation_expired) {
      await tx.query(
        "UPDATE cloud_codex_auth_caches SET state='uncertain',updated_at=now() WHERE credential_id=$1",
        [credential.id],
      );
      // Return an unavailable reservation rather than throwing away the durable
      // uncertain transition with a transaction rollback.
      return { credential, attemptId: row.attempt_id! };
    }
    if (row.state === "reserved" && row.reservation_expired) {
      await tx.query(
        "UPDATE cloud_codex_auth_caches SET state='ready',attempt_id=NULL,attempt_started_at=NULL WHERE credential_id=$1",
        [credential.id],
      );
      row = {
        ...row,
        state: "ready",
        attempt_id: null,
        attempt_started_at: null,
      };
    }
    if (row.state !== "ready")
      return { credential, attemptId: row.attempt_id! };
    if (!row.refresh_allowed) {
      if (force) unavailable();
      return null;
    }
    const cache = openCodexNativeCache(
      { nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag },
      {
        credentialId: credential.id,
        ownerUserId: credential.owner_user_id,
        revision: Number(credential.revision),
        version: credential.current_version,
        keyVersion: row.key_version,
      },
      this.keys.keys,
    );
    if (!cache.bindingSha256.equals(row.binding_sha256)) unavailable();
    const attemptId = randomUUID();
    await tx.query(
      "UPDATE cloud_codex_auth_caches SET state='reserved',attempt_id=$2,attempt_started_at=now(),updated_at=now() WHERE credential_id=$1",
      [credential.id, attemptId],
    );
    return { credential, attemptId, cache: cache.cache };
  }

  async complete(reservation: CodexRefreshReservation): Promise<void> {
    if (!reservation.cache) {
      await this.wait(reservation);
      return;
    }
    const { credential, attemptId, cache } = reservation;
    try {
      const updated = await this.renew(cache, async () => {
        await withSystemTx(this.pool, async (tx) => {
          const parent = await this.parent(tx, credential);
          if (!parent) unavailable();
          const result = await tx.query(
            `UPDATE cloud_codex_auth_caches SET state='dispatched',attempt_started_at=now(),updated_at=now()
            WHERE credential_id=$1 AND credential_revision=$2 AND material_version=$3 AND attempt_id=$4 AND state='reserved'
              AND attempt_started_at>now()-interval '15 seconds'`,
            [
              credential.id,
              credential.revision,
              credential.current_version,
              attemptId,
            ],
          );
          if (result.rowCount !== 1) unavailable();
        });
      });
      const parsed = parseCodexNativeCache(updated),
        original = parseCodexNativeCache(cache);
      if (
        !parsed.bindingSha256.equals(original.bindingSha256) ||
        JSON.stringify(parsed.cache) === JSON.stringify(original.cache)
      )
        unavailable();
      // Only the database publication is retryable. Retain this known native
      // result while resolving a rolled-back or ambiguously committed write;
      // never run the external refresh a second time with its consumed seed.
      for (let publicationAttempt = 0; ; publicationAttempt++) {
        try {
          await withSystemTx(this.pool, async (tx) => {
            await tx.query(
              "SET LOCAL lock_timeout='250ms'; SET LOCAL statement_timeout='2s'",
            );
            const parent = (
              await tx.query<{
                revision: string;
                current_version: number;
                revoked_at: Date | null;
              }>(
                "SELECT revision,current_version,revoked_at FROM cloud_agent_credentials WHERE id=$1 AND owner_user_id=$2 FOR UPDATE",
                [credential.id, credential.owner_user_id],
              )
            ).rows[0];
            if (
              !parent ||
              parent.revoked_at ||
              parent.revision !== credential.revision
            )
              unavailable();
            // Read back before any write, including after a lost COMMIT response.
            if (parent.current_version > credential.current_version) return;
            if (parent.current_version !== credential.current_version)
              unavailable();
            const row = (
              await tx.query<CacheRow>(
                "SELECT * FROM cloud_codex_auth_caches WHERE credential_id=$1 FOR UPDATE",
                [credential.id],
              )
            ).rows[0];
            if (
              !row ||
              row.credential_revision !== credential.revision ||
              row.material_version !== credential.current_version ||
              !["dispatched", "uncertain"].includes(row.state) ||
              row.attempt_id !== attemptId
            )
              unavailable();
            // An uncertain attempt cannot be reclaimed, but its original fenced
            // owner may still publish a proven late native cache. Discarding that
            // sole rotated seed would unnecessarily destroy a usable login.
            const version = credential.current_version + 1,
              keyVersion = this.keys.currentKeyVersion,
              key = this.keys.keys[keyVersion]!;
            if (version >= 2_147_483_647) unavailable();
            await rememberCodexRefreshSeed(
              tx,
              credential.id,
              parsed.cache.tokens.refresh_token,
              this.keys,
              false,
            );
            const auth = sealCodexNativeCache(
              parsed.cache,
              {
                credentialId: credential.id,
                ownerUserId: credential.owner_user_id,
                revision: Number(credential.revision),
                version,
                keyVersion,
              },
              key,
            );
            const access = sealCloudAgentCredential(
              parsed.material,
              {
                credentialId: credential.id,
                ownerUserId: credential.owner_user_id,
                kind: "codex-chatgpt",
                version,
                keyVersion,
              },
              key,
            );
            await tx.query(
              `INSERT INTO cloud_agent_credential_versions(credential_id,version,key_version,nonce,ciphertext,auth_tag,material_expires_at)
          VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7::bigint))`,
              [
                credential.id,
                version,
                keyVersion,
                access.nonce,
                access.ciphertext,
                access.authTag,
                parsed.material.expiresAt,
              ],
            );
            await tx.query(
              "UPDATE cloud_agent_credentials SET current_version=$2,updated_at=now() WHERE id=$1",
              [credential.id, version],
            );
            await tx.query(
              `UPDATE cloud_codex_auth_caches SET material_version=$2,key_version=$3,nonce=$4,ciphertext=$5,auth_tag=$6,
          state='ready',attempt_id=NULL,attempt_started_at=NULL,refresh_after=now()+interval '1 minute',updated_at=now() WHERE credential_id=$1`,
              [
                credential.id,
                version,
                keyVersion,
                auth.nonce,
                auth.ciphertext,
                auth.authTag,
              ],
            );
            await tx.query(
              "DELETE FROM cloud_agent_credential_versions WHERE credential_id=$1 AND version<>$2",
              [credential.id, version],
            );
            // Deliberately preserve consent, delegation revisions and owner PUT
            // receipts. Delivery gets a separate full workspace authorization pass.
          });
          break;
        } catch (error) {
          if (error instanceof HttpError || publicationAttempt >= 2)
            throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, 50 * (publicationAttempt + 1)),
          );
        }
      }
    } catch {
      // Resolve a potentially lost commit acknowledgement before considering
      // this attempt uncertain. Never issue a second OAuth call from its seed.
      const state = await withSystemTx(this.pool, async (tx) => {
        const parent = (
          await tx.query<{
            current_version: number;
            revision: string;
            revoked_at: Date | null;
          }>(
            "SELECT current_version,revision,revoked_at FROM cloud_agent_credentials WHERE id=$1 FOR UPDATE",
            [credential.id],
          )
        ).rows[0];
        if (
          !parent ||
          parent.revoked_at ||
          parent.revision !== credential.revision
        )
          return "revoked";
        if (parent.current_version > credential.current_version)
          return "committed";
        await tx.query(
          `UPDATE cloud_codex_auth_caches SET state=CASE WHEN state='reserved' THEN 'ready' ELSE 'uncertain' END,
          attempt_id=CASE WHEN state='reserved' THEN NULL ELSE attempt_id END,
          attempt_started_at=CASE WHEN state='reserved' THEN NULL ELSE attempt_started_at END,updated_at=now()
          WHERE credential_id=$1 AND credential_revision=$2 AND material_version=$3 AND attempt_id=$4`,
          [
            credential.id,
            credential.revision,
            credential.current_version,
            attemptId,
          ],
        );
        return "uncertain";
      });
      if (state !== "committed") unavailable();
    }
  }
  private async parent(tx: Tx, credential: CodexCredentialVersion) {
    return (
      (
        await tx.query(
          `SELECT id FROM cloud_agent_credentials WHERE id=$1 AND owner_user_id=$2 AND revision=$3 AND current_version=$4
      AND revoked_at IS NULL FOR UPDATE`,
          [
            credential.id,
            credential.owner_user_id,
            credential.revision,
            credential.current_version,
          ],
        )
      ).rowCount === 1
    );
  }
  private async wait({ credential, attemptId }: CodexRefreshReservation) {
    const deadline = performance.now() + 6500;
    while (performance.now() < deadline) {
      const row = await withSystemTx(
        this.pool,
        async (tx) =>
          (
            await tx.query<{
              current_version: number;
              revision: string;
              revoked_at: Date | null;
              state: string;
              attempt_id: string | null;
            }>(
              `
        SELECT credential.current_version,credential.revision,credential.revoked_at,cache.state,cache.attempt_id
        FROM cloud_agent_credentials credential JOIN cloud_codex_auth_caches cache ON cache.credential_id=credential.id WHERE credential.id=$1`,
              [credential.id],
            )
          ).rows[0],
      );
      if (!row || row.revoked_at || row.revision !== credential.revision)
        unavailable();
      if (row.current_version > credential.current_version) return;
      if (row.state === "uncertain" || row.attempt_id !== attemptId)
        unavailable();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    unavailable();
  }
}
