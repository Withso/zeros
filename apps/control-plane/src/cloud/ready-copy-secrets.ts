// Build secrets an admin sets for a shared repository's ready copy. Sealed at
// rest under the environment keys with their own purpose, opened only by the
// ready copy builder, and handed to its setup on standard input: never in the
// machine's definition, a command line, the build log or a stopped disk.
import { hkdfSync } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { withSystemTx } from "../db.js";
import { HttpError } from "../authz.js";
import { openCredentialBytes, sealCredentialBytes, type CloudAgentCredentialKeys } from "../agent-credentials/agent-credential-envelope.js";

const purpose = "zeros-cloud-ready-copy-build-secrets-v1";
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Names the builder, Git or the login shell own. */
const RESERVED = /^(?:PATH|HOME|USER|SHELL|PWD|OLDPWD|IFS|LANG|LC_[A-Z_]+|TERM|GIT_.*|SSH_.*|ZEROS_.*|CLOUD_V2_.*|BASH_.*|LD_.*)$/;
export const READY_COPY_SECRET_LIMITS = { count: 64, valueBytes: 16 * 1024 } as const;

export const ReadyCopySecretsSchema = z.record(z.string().regex(NAME).refine(name => !RESERVED.test(name), "Reserved name"),
  z.string().max(READY_COPY_SECRET_LIMITS.valueBytes)).refine(value => Object.keys(value).length <= READY_COPY_SECRET_LIMITS.count, "Too many secrets");
export type ReadyCopySecrets = z.infer<typeof ReadyCopySecretsSchema>;
const Envelope = z.object({ version: z.literal(1), keyVersion: z.number().int().positive(), nonce: z.string().max(32),
  ciphertext: z.string().max(400_000), authTag: z.string().max(32) }).strict();
const repositoryKey = (repository: string) => repository.toLowerCase();

function associated(organizationId: string, repository: string, keyVersion: number): Buffer {
  if (!z.string().uuid().safeParse(organizationId).success) throw new Error("Invalid build secret binding");
  return Buffer.from(JSON.stringify([purpose, organizationId.toLowerCase(), repositoryKey(repository), keyVersion]));
}
function derive(keys: CloudAgentCredentialKeys, version: number): Buffer {
  const encoded = keys.keys[version];
  if (!encoded) throw new Error("Build secret key unavailable");
  const root = Buffer.from(encoded, "base64url");
  try {
    if (root.length !== 32 || root.toString("base64url") !== encoded) throw new Error("Invalid build secret key");
    return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), purpose, 32));
  } finally { root.fill(0); }
}

export class CloudV2ReadyCopySecrets {
  constructor(private readonly pool: pg.Pool, private readonly keys: CloudAgentCredentialKeys | null) {}

  /** The names an admin set; values never leave the server. */
  async names(organizationId: string, repository: string): Promise<string[]> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ names: string[] }>(
      "SELECT names FROM cloud_v2_ready_copy_secrets WHERE org_id=$1 AND repository=$2", [organizationId, repositoryKey(repository)]));
    return rows[0]?.names ?? [];
  }

  async save(organizationId: string, repository: string, userId: string, secrets: ReadyCopySecrets): Promise<string[]> {
    const parsed = ReadyCopySecretsSchema.parse(secrets);
    const names = Object.keys(parsed).sort();
    if (!names.length) { await this.clear(organizationId, repository); return []; }
    if (!this.keys) throw new HttpError(503, "build_secrets_unavailable", "Build secrets are not available on this server.");
    const version = this.keys.currentKeyVersion, key = derive(this.keys, version), bytes = Buffer.from(JSON.stringify(parsed));
    try {
      const sealed = sealCredentialBytes(bytes, associated(organizationId, repository, version), key);
      const envelope = { version: 1, keyVersion: version, nonce: sealed.nonce.toString("base64url"),
        ciphertext: sealed.ciphertext.toString("base64url"), authTag: sealed.authTag.toString("base64url") };
      await withSystemTx(this.pool, tx => tx.query(
        `INSERT INTO cloud_v2_ready_copy_secrets (org_id, repository, envelope, names, updated_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_id, repository) DO UPDATE SET envelope=EXCLUDED.envelope, names=EXCLUDED.names,
           updated_by=EXCLUDED.updated_by, updated_at=clock_timestamp()`,
        [organizationId, repositoryKey(repository), JSON.stringify(envelope), names, userId]));
      return names;
    } finally { key.fill(0); bytes.fill(0); }
  }

  /** Sets and removes single names, keeping the rest; values never leave the server. */
  async update(organizationId: string, repository: string, userId: string, change: { set?: ReadyCopySecrets | undefined; remove?: readonly string[] | undefined }): Promise<string[]> {
    const next = { ...await this.open(organizationId, repository), ...ReadyCopySecretsSchema.parse(change.set ?? {}) };
    for (const name of change.remove ?? []) delete next[name];
    return this.save(organizationId, repository, userId, next);
  }

  async clear(organizationId: string, repository: string): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query("DELETE FROM cloud_v2_ready_copy_secrets WHERE org_id=$1 AND repository=$2",
      [organizationId, repositoryKey(repository)]));
  }

  /** For the builder only. Empty when none are set or the keys are absent. */
  async open(organizationId: string, repository: string): Promise<ReadyCopySecrets> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ envelope: unknown }>(
      "SELECT envelope FROM cloud_v2_ready_copy_secrets WHERE org_id=$1 AND repository=$2", [organizationId, repositoryKey(repository)]));
    if (!rows[0] || !this.keys) return {};
    const envelope = Envelope.parse(rows[0].envelope), key = derive(this.keys, envelope.keyVersion);
    try {
      const bytes = openCredentialBytes({ nonce: Buffer.from(envelope.nonce, "base64url"), ciphertext: Buffer.from(envelope.ciphertext, "base64url"),
        authTag: Buffer.from(envelope.authTag, "base64url") }, associated(organizationId, repository, envelope.keyVersion), key);
      try { return ReadyCopySecretsSchema.parse(JSON.parse(bytes.toString("utf8"))); } finally { bytes.fill(0); }
    } finally { key.fill(0); }
  }
}
