import { createHash } from "node:crypto";
import { Agent as HttpsAgent } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { parseDatabaseTarget } from "./database-target.js";
import { createMigrationPool } from "./db.js";
import {
  CheckpointVerificationError,
  loadStoppedCheckpointSnapshot,
  verifyStoppedWorkspaceCheckpoint,
} from "./cloud-workspaces/checkpoint-retention-verification.js";
import { DatabaseCloudWorkspaceBlobService, FileCloudWorkspaceObjectStore } from "./cloud-workspaces/object-store.js";
import { S3CloudWorkspaceObjectStore } from "./cloud-workspaces/s3-object-store.js";

class VerificationInputError extends Error {}
function fail(message: string): never { throw new VerificationInputError(message); }

export function validateCheckpointVerification(input: {
  databaseUrl: string; channel?: string | undefined; railwayEnvironmentName?: string | undefined;
  organizationId?: string | undefined; expectedOrganizationSlug?: string | undefined; actorUserId?: string | undefined;
  workspaceId?: string | undefined; verify: boolean;
}) {
  if (input.channel?.trim().toLowerCase() !== "alpha" || input.railwayEnvironmentName?.trim().toLowerCase() !== "alpha")
    fail("Checkpoint verification is limited to Alpha and requires the matching Alpha deployment");
  const uuid = z.string().uuid();
  if ([input.organizationId, input.actorUserId, input.workspaceId].some(id => !uuid.safeParse(id).success))
    fail("Organization, actor and workspace must be exact UUIDs");
  const slug = z.string().trim().min(1).max(255).safeParse(input.expectedOrganizationSlug);
  if (!slug.success) fail("The exact Organization slug is required");
  let target: URL;
  try { target = parseDatabaseTarget(input.databaseUrl); }
  catch { return fail("DATABASE_URL must identify one explicit PostgreSQL target without routing overrides"); }
  const targetFingerprint = createHash("sha256").update(JSON.stringify([
    "zeros.stopped-checkpoint-verification/v1", "alpha", target.hostname, target.port,
    target.pathname, decodeURIComponent(target.username),
  ])).digest("hex").slice(0, 16);
  return { channel: "alpha" as const, verify: input.verify, targetFingerprint,
    organizationId: input.organizationId!.toLowerCase(), actorUserId: input.actorUserId!.toLowerCase(),
    workspaceId: input.workspaceId!.toLowerCase(), expectedOrganizationSlug: slug.data.toLowerCase() };
}

export function checkpointVerificationMessage(error: unknown): string {
  if (error instanceof VerificationInputError) return error.message;
  if (error instanceof CheckpointVerificationError) return `Checkpoint verification refused (${error.code})`;
  return "Checkpoint verification failed; no database or provider details are printed";
}

async function runCli() {
  const { values } = parseArgs({ options: { verify: { type: "boolean", default: false } }, strict: true, allowPositionals: false });
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required");
  const prefix = "CONTROL_PLANE_CHECKPOINT_VERIFICATION_";
  const request = validateCheckpointVerification({ databaseUrl, verify: values.verify,
    channel: process.env[`${prefix}CHANNEL`], railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
    organizationId: process.env[`${prefix}ORGANIZATION_ID`], actorUserId: process.env[`${prefix}ACTOR_USER_ID`],
    workspaceId: process.env[`${prefix}WORKSPACE_ID`], expectedOrganizationSlug: process.env[`${prefix}EXPECTED_ORGANIZATION_SLUG`] });
  const pool = createMigrationPool(databaseUrl, { maxConnections: 2, applicationName: "zeros-checkpoint-verification" });
  let s3: S3Client | undefined;
  let blobs: DatabaseCloudWorkspaceBlobService | undefined;
  try {
    const result = await verifyStoppedWorkspaceCheckpoint({
      readSnapshot: () => loadStoppedCheckpointSnapshot(pool, request),
      readBlob: async blobId => {
        // A default metadata plan neither loads object credentials nor constructs
        // a provider/object client. Payload reads use the deployed encryption
        // and immutable-object integrity checks, without starting any workers.
        if (!blobs) {
          const config = loadConfig(process.env, { error() {}, warn() {} });
          const durability = config.cloudWorkspaces?.durability;
          if (config.deploymentChannel !== "alpha" || !durability) fail("Alpha cloud checkpoint storage is not configured");
          let objectStore;
          if (durability.s3) {
            s3 = new S3Client({ endpoint: durability.s3.endpoint, region: durability.s3.region,
              credentials: { accessKeyId: durability.s3.accessKeyId, secretAccessKey: durability.s3.secretAccessKey },
              forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED",
              requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000,
                httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 1 }) } });
            objectStore = new S3CloudWorkspaceObjectStore(s3, durability.s3.bucket, durability.s3.prefix);
          } else objectStore = new FileCloudWorkspaceObjectStore(durability.objectStoreDirectory);
          blobs = new DatabaseCloudWorkspaceBlobService({ pool, objectStore,
            encryptionKeys: durability.objectEncryptionKeys, keyVersion: durability.currentObjectEncryptionKeyVersion,
            restoreWindowMs: durability.objectRestoreWindowMs, workosEnabled: config.auth.provider === "workos" });
        }
        return blobs.getSystem({ blobId, organizationId: request.organizationId });
      },
    }, { verify: request.verify });
    console.log(JSON.stringify({ channel: request.channel, target: request.targetFingerprint, ...result }));
  } finally { s3?.destroy(); await pool.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli().catch(error => { console.error(checkpointVerificationMessage(error)); process.exitCode = 1; });
}
