import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type pg from "pg";
import { z } from "zod";
import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import type { Config } from "../config.js";
import { withSystemTx, type Tx } from "../db.js";
import {
  runtimeArtifactObjectKey,
  type RuntimeArtifactStore,
} from "./runtime-artifact-store.js";
import {
  createRuntimeOidcVerifier,
  type RuntimeOidcVerifier,
  type RuntimePublicationProvenance,
} from "./runtime-oidc.js";

export const RUNTIME_PUBLICATION_PATH =
  "/internal/v1/runtime-bundles/publications";
export const RUNTIME_BASE_REGISTRATION_PATH = "/internal/v1/runtime-bases";
export const RUNTIME_STAFF_PATH = "/v1/internal/cloud-runtime";

// The CP is an independently deployed package using Zod 3. These boundary
// schemas follow B1's protocol types; tests use B1's shared golden fixtures.
const sha256 = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
const commit = z
  .string()
  .length(40)
  .regex(/^[a-f0-9]{40}$/);
const runtimeId = z
  .string()
  .length(67)
  .regex(/^r1-[a-f0-9]{64}$/);
const positiveInteger = z.number().int().safe().positive();
const protocolVersion = positiveInteger.max(65_535);
const maxArchiveBytes = 2 * 1024 ** 3;
const maxExpandedBytes = 4 * 1024 ** 3;
const version = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?$/);
const agentVersion = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$/)
  .refine((value) => !/[\r\n]/.test(value));
const libcVersion = z
  .string()
  .max(32)
  .regex(/^[0-9]+\.[0-9]+$/);
const relativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <= 4096 &&
      !value.startsWith("/") &&
      !/^[A-Za-z]:/.test(value) &&
      !/[\\\x00\r\n\ud800-\udfff]/u.test(value) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
  );

const descriptorSchema = z
  .object({
    runtimeId,
    manifestSha256: sha256,
    archiveSha256: sha256,
    archiveBytes: positiveInteger.max(maxArchiveBytes),
    expandedBytes: positiveInteger.max(maxExpandedBytes),
    sourceCommit: commit,
    nodeModulesAbi: protocolVersion,
    bootstrapProtocolVersion: z.literal(1),
    engineProtocolVersion: protocolVersion,
  })
  .strict()
  .refine((value) => value.runtimeId === `r1-${value.manifestSha256}`);

const manifestHeaderSchema = z
  .object({
    agents: z
      .object({
        claude: z.object({ cli: agentVersion, sdk: agentVersion }).strict(),
        codex: z.object({ package: agentVersion }).strict(),
        cursor: z.object({ sdk: agentVersion }).strict(),
      })
      .strict(),
    entrypoints: z
      .object({
        node: relativePath,
        setup: relativePath,
        startEngine: relativePath,
        supervisor: relativePath,
        selfTest: relativePath.optional(),
      })
      .strict(),
    platform: z
      .object({
        arch: z.literal("x64"),
        libc: z.literal("glibc"),
        minGlibc: libcVersion,
        node: version,
        nodeModulesAbi: protocolVersion,
        os: z.literal("linux"),
      })
      .strict(),
    protocols: z
      .object({
        bootstrap: z.literal(1),
        engine: protocolVersion,
        setup: z.literal(2),
      })
      .strict(),
    schema: z.literal("zeros.runtime-manifest/v1"),
    source: z.object({ commit, lockfileSha256: sha256 }).strict(),
  })
  .strict()
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 32 * 1024);

export const RuntimePublicationInputSchema = z
  .object({
    descriptor: descriptorSchema,
    manifestHeader: manifestHeaderSchema,
    releaseOrder: positiveInteger,
    githubRunId: positiveInteger,
    githubRunAttempt: positiveInteger.max(2_147_483_647),
  })
  .strict();
type PublicationInput = z.infer<typeof RuntimePublicationInputSchema>;

const compatibilitySchema = z
  .object({
    arch: z.literal("x64"),
    artifactHostSuffixes: z
      .array(
        z
          .string()
          .max(253)
          .regex(/^\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/),
      )
      .min(1),
    bootstrapProtocolVersion: z.literal(1),
    glibc: libcVersion,
    os: z
      .object({
        id: z
          .string()
          .max(64)
          .regex(/^[a-z0-9][a-z0-9_-]*$/),
        versionId: z
          .string()
          .max(32)
          .regex(/^[0-9]+\.[0-9]+$/),
      })
      .strict(),
    protectedFiles: z
      .array(
        z
          .object({
            mode: z.string().regex(/^0[0-7][0145][0145]$/),
            path: z
              .string()
              .refine(
                (value) =>
                  value.startsWith("/") &&
                  relativePath.safeParse(value.slice(1)).success,
              ),
            sha256,
          })
          .strict(),
      )
      .min(1),
    schema: z.literal("zeros.base-compatibility/v1"),
    supportedManifestSchemas: z
      .array(z.literal("zeros.runtime-manifest/v1"))
      .min(1),
    systemdMin: positiveInteger,
    uids: z
      .object({
        agent: z.literal(10001),
        capture: z.literal(10002),
        coordinator: z.literal(10004),
        engine: z.literal(10003),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.artifactHostSuffixes).size ===
        value.artifactHostSuffixes.length &&
      new Set(value.supportedManifestSchemas).size ===
        value.supportedManifestSchemas.length &&
      new Set(value.protectedFiles.map((file) => file.path)).size ===
        value.protectedFiles.length &&
      !value.protectedFiles.some(
        (file) => file.path === "/opt/zeros-bootstrap/compatibility.json",
      ),
  );

export const RuntimeBaseRegistrationInputSchema = z
  .object({
    baseImageId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    imageRef: z
      .string()
      .regex(/^boat:[a-z0-9][a-z0-9-]{0,62}@sha256:[a-f0-9]{64}$/),
    sourceCommit: commit,
    imageBuildSha256: sha256,
    storageMib: positiveInteger.max(2_147_483_647),
    compatibilityRawB64: z.string().min(4).max(87_384),
    compatibilitySha256: sha256,
    // Raw bytes are authoritative. A caller may also include the parsed object
    // described by §14, but it must agree exactly with the verified raw JSON.
    compatibility: compatibilitySchema.optional(),
  })
  .strict();
type BaseInput = z.infer<typeof RuntimeBaseRegistrationInputSchema>;
type BaseCompatibility = z.infer<typeof compatibilitySchema>;

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new HttpError(
      422,
      "invalid_runtime_publication",
      "Invalid runtime publication request",
    );
  return parsed.data;
}

function identityConflict(): never {
  throw new HttpError(
    409,
    "runtime_identity_conflict",
    "Runtime publication identity conflicts",
  );
}

function validatePublication(
  value: unknown,
  provenance: RuntimePublicationProvenance,
): PublicationInput {
  const body = input(RuntimePublicationInputSchema, value);
  const { descriptor: runtime, manifestHeader: header } = body;
  if (
    body.releaseOrder !== provenance.runNumber ||
    body.githubRunId !== provenance.runId ||
    body.githubRunAttempt !== provenance.runAttempt ||
    runtime.sourceCommit !== provenance.sha ||
    header.source.commit !== runtime.sourceCommit ||
    header.platform.nodeModulesAbi !== runtime.nodeModulesAbi ||
    header.protocols.bootstrap !== runtime.bootstrapProtocolVersion ||
    header.protocols.engine !== runtime.engineProtocolVersion
  )
    identityConflict();
  return {
    ...body,
    releaseOrder: provenance.runNumber,
    githubRunId: provenance.runId,
    githubRunAttempt: provenance.runAttempt,
  };
}

function parseBase(
  value: unknown,
  provenance: RuntimePublicationProvenance,
): {
  body: BaseInput;
  compatibility: BaseCompatibility;
  baseCompatibilityId: string;
} {
  const body = input(RuntimeBaseRegistrationInputSchema, value);
  if (
    body.sourceCommit !== provenance.sha ||
    !body.imageRef.endsWith(`@sha256:${body.imageBuildSha256}`)
  )
    identityConflict();
  const bytes = Buffer.from(body.compatibilityRawB64, "base64");
  if (
    bytes.length > 65_536 ||
    bytes.toString("base64") !== body.compatibilityRawB64
  ) {
    throw new HttpError(
      422,
      "invalid_base_compatibility",
      "Invalid base compatibility bytes",
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== body.compatibilitySha256) {
    throw new HttpError(
      422,
      "base_compatibility_digest_mismatch",
      "Base compatibility digest mismatch",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(
      422,
      "invalid_base_compatibility",
      "Invalid base compatibility JSON",
    );
  }
  const compatibility = input(compatibilitySchema, raw);
  if (
    body.compatibility &&
    !isDeepStrictEqual(body.compatibility, compatibility)
  )
    identityConflict();
  return { body, compatibility, baseCompatibilityId: `bc1-${digest}` };
}

type BundleRow = {
  runtime_id: string;
  manifest_sha256: string;
  archive_sha256: string;
  archive_bytes: string;
  expanded_bytes: string;
  object_key: string;
  source_commit: string;
  architecture: string;
  node_version: string;
  node_modules_abi: number;
  bootstrap_protocol_version: 1;
  setup_protocol_version: 2;
  engine_protocol_version: number;
  manifest_header: PublicationInput["manifestHeader"];
  registered_at: Date;
  revoked_at: Date | null;
};
const bundleColumns = `runtime_id, manifest_sha256, archive_sha256, archive_bytes, expanded_bytes, object_key,
  source_commit, architecture, node_version, node_modules_abi, bootstrap_protocol_version, setup_protocol_version,
  engine_protocol_version, manifest_header, registered_at, revoked_at`;
type ReleaseRow = {
  channel: string;
  release_order: string;
  runtime_id: string;
  github_release_run_id: string;
  github_release_run_attempt: number;
  confirmed_at: Date | null;
  revoked_at: Date | null;
};
type BaseRow = {
  base_image_id: string;
  provider: "boat";
  image_ref: string;
  base_compatibility_id: string;
  source_commit: string;
  image_build_sha256: string;
  architecture: "linux/amd64";
  storage_mib: string;
  approved_at: Date;
  revoked_at: Date | null;
  contract_revoked_at: Date | null;
};
const baseColumns = `base.base_image_id, base.provider, base.image_ref, base.base_compatibility_id, base.source_commit,
  base.image_build_sha256, base.architecture, base.storage_mib, base.approved_at, base.revoked_at,
  contract.revoked_at AS contract_revoked_at`;

function descriptor(row: BundleRow): PublicationInput["descriptor"] {
  return {
    runtimeId: row.runtime_id,
    manifestSha256: row.manifest_sha256,
    archiveSha256: row.archive_sha256,
    archiveBytes: Number(row.archive_bytes),
    expandedBytes: Number(row.expanded_bytes),
    sourceCommit: row.source_commit,
    nodeModulesAbi: row.node_modules_abi,
    bootstrapProtocolVersion: row.bootstrap_protocol_version,
    engineProtocolVersion: row.engine_protocol_version,
  };
}

async function checkBundle(
  tx: Tx,
  body: PublicationInput,
  lock = false,
): Promise<BundleRow | null> {
  const row = (
    await tx.query<BundleRow>(
      `SELECT ${bundleColumns} FROM cloud_runtime_bundles WHERE runtime_id=$1${lock ? " FOR UPDATE" : ""}`,
      [body.descriptor.runtimeId],
    )
  ).rows[0];
  if (
    row &&
    (row.revoked_at ||
      row.object_key !==
        runtimeArtifactObjectKey(
          body.descriptor.runtimeId,
          body.descriptor.archiveSha256,
        ) ||
      row.architecture !== "linux/amd64" ||
      row.setup_protocol_version !== 2 ||
      !isDeepStrictEqual(descriptor(row), body.descriptor) ||
      !isDeepStrictEqual(row.manifest_header, body.manifestHeader))
  )
    identityConflict();
  return row ?? null;
}

async function checkRelease(tx: Tx, body: PublicationInput): Promise<void> {
  const rows = (
    await tx.query<ReleaseRow>(
      `SELECT channel,release_order,runtime_id,github_release_run_id,github_release_run_attempt,confirmed_at,revoked_at
    FROM cloud_runtime_channel_releases WHERE channel='alpha' AND (release_order=$1 OR github_release_run_id=$2)`,
      [body.releaseOrder, body.githubRunId],
    )
  ).rows;
  if (
    rows.some(
      (row) =>
        row.revoked_at ||
        Number(row.release_order) !== body.releaseOrder ||
        row.runtime_id !== body.descriptor.runtimeId ||
        Number(row.github_release_run_id) !== body.githubRunId ||
        row.github_release_run_attempt !== body.githubRunAttempt,
    )
  )
    identityConflict();
}

/** B7 replaces this hook with durable smoke scheduling. Registration is
 * deliberately independent of qualification and never implies eligibility. */
export async function enqueueRuntimeSmokeQualification(
  _runtimeId: string,
): Promise<"not_configured"> {
  return "not_configured";
}

export class DatabaseRuntimePublicationService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly artifacts: RuntimeArtifactStore,
    private readonly enqueueSmoke: (
      runtimeId: string,
    ) => Promise<unknown> = enqueueRuntimeSmokeQualification,
  ) {}

  private async objectState(
    objectKey: string,
  ): Promise<{ exists: boolean; bytes: number | null }> {
    try {
      return await this.artifacts.head(objectKey);
    } catch {
      throw new HttpError(
        503,
        "runtime_artifact_unavailable",
        "Runtime artifact unavailable",
      );
    }
  }

  async publication(value: unknown, provenance: RuntimePublicationProvenance) {
    const body = validatePublication(value, provenance);
    await withSystemTx(
      this.pool,
      async (tx) => {
        await checkBundle(tx, body);
        await checkRelease(tx, body);
      },
      { consistentRead: true },
    );
    const objectKey = runtimeArtifactObjectKey(
      body.descriptor.runtimeId,
      body.descriptor.archiveSha256,
    );
    const state = await this.objectState(objectKey);
    if (state.exists && state.bytes !== body.descriptor.archiveBytes) {
      throw new HttpError(
        409,
        "runtime_artifact_size_conflict",
        "Runtime artifact byte length conflicts",
      );
    }
    if (state.exists) return { objectKey, upload: null };
    try {
      return {
        objectKey,
        upload: await this.artifacts.presignCreatePut(
          objectKey,
          body.descriptor.archiveBytes,
        ),
      };
    } catch {
      throw new HttpError(
        503,
        "runtime_artifact_unavailable",
        "Runtime artifact unavailable",
      );
    }
  }

  async complete(value: unknown, provenance: RuntimePublicationProvenance) {
    const body = validatePublication(value, provenance);
    const runtime = body.descriptor;
    const objectKey = runtimeArtifactObjectKey(
      runtime.runtimeId,
      runtime.archiveSha256,
    );
    const state = await this.objectState(objectKey);
    if (!state.exists)
      throw new HttpError(
        409,
        "runtime_artifact_missing",
        "Runtime artifact is missing",
      );
    if (state.bytes !== runtime.archiveBytes)
      throw new HttpError(
        409,
        "runtime_artifact_size_conflict",
        "Runtime artifact byte length conflicts",
      );
    // No database transaction spans provider I/O. Exact immutable equality
    // makes retries (including another replica or CI attempt) deterministic.
    await withSystemTx(this.pool, async (tx) => {
      await tx.query(
        `INSERT INTO cloud_runtime_bundles(runtime_id,manifest_sha256,archive_sha256,archive_bytes,expanded_bytes,object_key,
        source_commit,architecture,node_version,node_modules_abi,bootstrap_protocol_version,setup_protocol_version,engine_protocol_version,manifest_header)
        VALUES($1,$2,$3,$4,$5,$6,$7,'linux/amd64',$8,$9,1,2,$10,$11::jsonb) ON CONFLICT DO NOTHING`,
        [
          runtime.runtimeId,
          runtime.manifestSha256,
          runtime.archiveSha256,
          runtime.archiveBytes,
          runtime.expandedBytes,
          objectKey,
          runtime.sourceCommit,
          body.manifestHeader.platform.node,
          runtime.nodeModulesAbi,
          runtime.engineProtocolVersion,
          JSON.stringify(body.manifestHeader),
        ],
      );
      if (!(await checkBundle(tx, body, true))) identityConflict();
      await tx.query(
        `INSERT INTO cloud_runtime_channel_releases(channel,release_order,runtime_id,github_release_run_id,github_release_run_attempt,confirmed_at)
        VALUES('alpha',$1,$2,$3,$4,now()) ON CONFLICT DO NOTHING`,
        [
          body.releaseOrder,
          runtime.runtimeId,
          body.githubRunId,
          body.githubRunAttempt,
        ],
      );
      await checkRelease(tx, body);
      await tx.query(
        `UPDATE cloud_runtime_channel_releases SET confirmed_at=now()
        WHERE channel='alpha' AND release_order=$1 AND confirmed_at IS NULL AND revoked_at IS NULL`,
        [body.releaseOrder],
      );
    });
    // Idempotent enqueue belongs to B7. A scheduling failure must not reflect
    // a provider error or signed URL, and CI can retry after the commit.
    try {
      await this.enqueueSmoke(runtime.runtimeId);
    } catch {
      throw new HttpError(
        503,
        "runtime_smoke_scheduling_failed",
        "Runtime smoke scheduling unavailable",
      );
    }
    return { runtimeId: runtime.runtimeId, registered: true as const };
  }

  async registerBase(value: unknown, provenance: RuntimePublicationProvenance) {
    const { body, compatibility, baseCompatibilityId } = parseBase(
      value,
      provenance,
    );
    await withSystemTx(this.pool, async (tx) => {
      await tx.query(
        `INSERT INTO cloud_runtime_base_contracts(base_compatibility_id,contract_sha256,contract)
        SELECT $1,$2,$3::jsonb WHERE octet_length(($3::jsonb)::text)<=65536 ON CONFLICT DO NOTHING`,
        [
          baseCompatibilityId,
          body.compatibilitySha256,
          JSON.stringify(compatibility),
        ],
      );
      const contract = (
        await tx.query<{
          contract_sha256: string;
          contract: BaseCompatibility;
          revoked_at: Date | null;
        }>(
          "SELECT contract_sha256,contract,revoked_at FROM cloud_runtime_base_contracts WHERE base_compatibility_id=$1 FOR UPDATE",
          [baseCompatibilityId],
        )
      ).rows[0];
      if (!contract)
        throw new HttpError(
          422,
          "invalid_base_compatibility",
          "Invalid base compatibility JSON",
        );
      if (
        contract.revoked_at ||
        contract.contract_sha256 !== body.compatibilitySha256 ||
        !isDeepStrictEqual(contract.contract, compatibility)
      )
        identityConflict();
      await tx.query(
        `INSERT INTO cloud_runtime_base_images(base_image_id,provider,image_ref,base_compatibility_id,source_commit,image_build_sha256,architecture,storage_mib,approved_at)
        VALUES($1,'boat',$2,$3,$4,$5,'linux/amd64',$6,now()) ON CONFLICT DO NOTHING`,
        [
          body.baseImageId,
          body.imageRef,
          baseCompatibilityId,
          body.sourceCommit,
          body.imageBuildSha256,
          body.storageMib,
        ],
      );
      const row = (
        await tx.query<BaseRow>(
          `SELECT ${baseColumns} FROM cloud_runtime_base_images base
        JOIN cloud_runtime_base_contracts contract USING(base_compatibility_id) WHERE base.base_image_id=$1`,
          [body.baseImageId],
        )
      ).rows[0];
      if (
        !row ||
        row.revoked_at ||
        row.provider !== "boat" ||
        row.image_ref !== body.imageRef ||
        row.base_compatibility_id !== baseCompatibilityId ||
        row.source_commit !== body.sourceCommit ||
        row.image_build_sha256 !== body.imageBuildSha256 ||
        row.architecture !== "linux/amd64" ||
        Number(row.storage_mib) !== body.storageMib
      )
        identityConflict();
    });
    return { baseImageId: body.baseImageId, baseCompatibilityId };
  }
}

export type RuntimePublicationDependencies = {
  artifacts?: RuntimeArtifactStore | null;
  verifyOidc?: RuntimeOidcVerifier;
  enqueueSmoke?: (runtimeId: string) => Promise<unknown>;
};

export function createRuntimePublicationRoutes(
  config: Config,
  pool: pg.Pool,
  dependencies: RuntimePublicationDependencies = {},
): Hono {
  const routes = new Hono();
  const publication = config.cloudRuntimePublication;
  const enabled =
    publication?.enabled === true && config.deploymentChannel === "alpha";
  const artifacts = enabled ? (dependencies.artifacts ?? null) : null;
  const service = artifacts
    ? new DatabaseRuntimePublicationService(
        pool,
        artifacts,
        dependencies.enqueueSmoke,
      )
    : null;
  const verify = enabled
    ? (dependencies.verifyOidc ?? createRuntimeOidcVerifier(publication!))
    : null;
  for (const path of [
    RUNTIME_PUBLICATION_PATH,
    `${RUNTIME_PUBLICATION_PATH}/complete`,
    RUNTIME_BASE_REGISTRATION_PATH,
  ]) {
    routes.use(path, async (c, next) => {
      c.header("Cache-Control", "no-store");
      c.header("Pragma", "no-cache");
      if (!enabled) return c.json({ error: { code: "not_found" } }, 404);
      await next();
    });
    routes.use(
      path,
      bodyLimit({
        maxSize: 192 * 1024,
        onError: (c) => c.json({ error: { code: "body_too_large" } }, 413),
      }),
    );
  }
  async function provenance(
    c: Context,
    purpose: "publication" | "base_registration",
  ) {
    const auth = c.req.header("Authorization") ?? "";
    if (!auth.startsWith("Bearer ") || !verify)
      throw new HttpError(
        401,
        "runtime_oidc_rejected",
        "Runtime publication authentication rejected",
      );
    try {
      return await verify(auth.slice(7), purpose);
    } catch {
      throw new HttpError(
        401,
        "runtime_oidc_rejected",
        "Runtime publication authentication rejected",
      );
    }
  }
  function configuredService(): DatabaseRuntimePublicationService {
    if (!service)
      throw new HttpError(
        503,
        "runtime_artifact_unavailable",
        "Runtime artifact unavailable",
      );
    return service;
  }
  routes.post(RUNTIME_PUBLICATION_PATH, async (c) => {
    const identity = await provenance(c, "publication");
    return c.json(
      await configuredService().publication(
        await c.req.json().catch(() => null),
        identity,
      ),
    );
  });
  routes.post(`${RUNTIME_PUBLICATION_PATH}/complete`, async (c) => {
    const identity = await provenance(c, "publication");
    return c.json(
      await configuredService().complete(
        await c.req.json().catch(() => null),
        identity,
      ),
    );
  });
  routes.post(RUNTIME_BASE_REGISTRATION_PATH, async (c) => {
    const identity = await provenance(c, "base_registration");
    return c.json(
      await configuredService().registerBase(
        await c.req.json().catch(() => null),
        identity,
      ),
    );
  });
  return routes;
}

function publicBase(row: BaseRow) {
  return {
    baseImageId: row.base_image_id,
    baseCompatibilityId: row.base_compatibility_id,
    provider: row.provider,
    imageRef: row.image_ref,
    sourceCommit: row.source_commit,
    imageBuildSha256: row.image_build_sha256,
    architecture: row.architecture,
    storageMib: Number(row.storage_mib),
    approvedAt: row.approved_at,
    revokedAt: row.revoked_at,
    contractRevokedAt: row.contract_revoked_at,
  };
}

export async function readRuntimeStatus(
  pool: pg.Pool,
  channel: Config["deploymentChannel"],
) {
  return withSystemTx(
    pool,
    async (tx) => {
      const bases = (
        await tx.query<BaseRow>(`SELECT ${baseColumns} FROM cloud_runtime_base_images base
      JOIN cloud_runtime_base_contracts contract USING(base_compatibility_id) ORDER BY base.approved_at DESC,base.base_image_id LIMIT 100`)
      ).rows;
      const runtimes = (
        await tx.query<BundleRow>(
          `SELECT ${bundleColumns} FROM cloud_runtime_bundles ORDER BY registered_at DESC,runtime_id LIMIT 20`,
        )
      ).rows;
      const qualifications = (
        await tx.query<{
          runtime_id: string;
          base_compatibility_id: string;
          credential_kind: string;
          profile: string;
          enabled: boolean;
          mcp_qualified: boolean;
          evidence_mode: string | null;
          qualified_at: Date;
          revoked_at: Date | null;
        }>(
          `SELECT runtime_id,base_compatibility_id,credential_kind,profile,enabled,mcp_qualified,evidence->>'mode' AS evidence_mode,qualified_at,revoked_at
       FROM cloud_runtime_qualifications WHERE runtime_id=ANY($1::text[]) ORDER BY runtime_id,base_compatibility_id,credential_kind`,
          [runtimes.map((row) => row.runtime_id)],
        )
      ).rows;
      const releases = (
        await tx.query<ReleaseRow>(
          `SELECT channel,release_order,runtime_id,github_release_run_id,github_release_run_attempt,confirmed_at,revoked_at
      FROM cloud_runtime_channel_releases WHERE channel=$1 ORDER BY release_order DESC LIMIT 20`,
          [channel],
        )
      ).rows;
      return {
        channel,
        bases: bases.map(publicBase),
        runtimes: runtimes.map((row) => ({
          ...descriptor(row),
          nodeVersion: row.node_version,
          registeredAt: row.registered_at,
          revokedAt: row.revoked_at,
        })),
        qualifications: qualifications.map((row) => ({
          runtimeId: row.runtime_id,
          baseCompatibilityId: row.base_compatibility_id,
          credentialKind: row.credential_kind,
          profile: row.profile,
          enabled: row.enabled,
          mcpQualified: row.mcp_qualified,
          evidenceMode:
            row.evidence_mode === "smoke" || row.evidence_mode === "full"
              ? row.evidence_mode
              : null,
          qualifiedAt: row.qualified_at,
          revokedAt: row.revoked_at,
        })),
        // B5b owns channel-head selection. Releases alone cannot claim eligibility.
        channelReleases: releases.map((row) => ({
          channel: row.channel,
          releaseOrder: Number(row.release_order),
          runtimeId: row.runtime_id,
          githubRunId: Number(row.github_release_run_id),
          githubRunAttempt: row.github_release_run_attempt,
          confirmedAt: row.confirmed_at,
          revokedAt: row.revoked_at,
        })),
      };
    },
    { consistentRead: true },
  );
}

/** Public release metadata stays bounded and contains only immutable IDs,
 * source SHAs, and counts. It never controls the v1 readiness predicate. */
export async function readRuntimeReleaseIdentity(
  pool: pg.Pool,
  newWorkspaceProfile: "legacy" | "v4",
) {
  return withSystemTx(
    pool,
    async (tx) => {
      const base = (
        await tx.query<BaseRow>(`SELECT ${baseColumns} FROM cloud_runtime_base_images base
      JOIN cloud_runtime_base_contracts contract USING(base_compatibility_id)
      WHERE base.revoked_at IS NULL AND contract.revoked_at IS NULL ORDER BY base.approved_at DESC,base.base_image_id LIMIT 1`)
      ).rows[0];
      const runtime = (
        await tx.query<BundleRow>(
          `SELECT ${bundleColumns} FROM cloud_runtime_bundles ORDER BY registered_at DESC,runtime_id LIMIT 1`,
        )
      ).rows[0];
      const qualifications =
        base && runtime
          ? (
              await tx.query<{
                enabled_kinds: number;
                mcp_qualified_kinds: number;
                smoke_kinds: number;
              }>(
                `SELECT count(*) FILTER(WHERE enabled)::int AS enabled_kinds,
        count(*) FILTER(WHERE enabled AND mcp_qualified)::int AS mcp_qualified_kinds,
        count(*) FILTER(WHERE enabled AND evidence->>'mode'='smoke')::int AS smoke_kinds
       FROM cloud_runtime_qualifications WHERE runtime_id=$1 AND base_compatibility_id=$2
         AND profile='zeros-cloud-worker-v4' AND revoked_at IS NULL`,
                [runtime.runtime_id, base.base_compatibility_id],
              )
            ).rows[0]
          : undefined;
      return {
        newWorkspaceProfile,
        newestApprovedBase: base
          ? {
              baseImageId: base.base_image_id,
              baseCompatibilityId: base.base_compatibility_id,
              sourceCommit: base.source_commit,
            }
          : null,
        newestRegisteredRuntime: runtime
          ? {
              runtimeId: runtime.runtime_id,
              sourceCommit: runtime.source_commit,
              revoked: !!runtime.revoked_at,
            }
          : null,
        qualificationSummary: {
          enabledKinds: qualifications?.enabled_kinds ?? 0,
          mcpQualifiedKinds: qualifications?.mcp_qualified_kinds ?? 0,
          smokeKinds: qualifications?.smoke_kinds ?? 0,
        },
      };
    },
    { consistentRead: true },
  );
}

export function createRuntimeStaffRoutes(config: Config, pool: pg.Pool): Hono {
  const routes = new Hono();
  routes.use(`${RUNTIME_STAFF_PATH}/*`, async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const user = c.get("user") as AuthedUser | undefined;
    if (!user)
      throw new HttpError(401, "unauthorized", "Authentication required");
    if (user.staffRole !== "developer" && user.staffRole !== "platform_owner")
      throw new HttpError(404, "not_found", "Not found");
    await next();
  });
  routes.get(`${RUNTIME_STAFF_PATH}/status`, async (c) =>
    c.json(await readRuntimeStatus(pool, config.deploymentChannel)),
  );
  routes.post(`${RUNTIME_STAFF_PATH}/runtimes/:runtimeId/revoke`, async (c) => {
    const id = input(runtimeId, c.req.param("runtimeId"));
    await withSystemTx(pool, async (tx) => {
      const revoked = await tx.query(
        `UPDATE cloud_runtime_bundles SET revoked_at=COALESCE(revoked_at,now()) WHERE runtime_id=$1 RETURNING runtime_id`,
        [id],
      );
      if (!revoked.rowCount) throw new HttpError(404, "not_found", "Not found");
      await tx.query(
        `UPDATE cloud_runtime_qualifications SET revoked_at=COALESCE(revoked_at,now()),enabled=false,mcp_qualified=false WHERE runtime_id=$1`,
        [id],
      );
    });
    console.info("[cloud-runtime] runtime_revoked", {
      runtimeId: id,
      staffRole: (c.get("user") as AuthedUser).staffRole,
    });
    return c.json({ runtimeId: id, revoked: true });
  });
  return routes;
}
