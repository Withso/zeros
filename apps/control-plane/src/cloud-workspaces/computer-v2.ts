import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import {
  HttpError,
  requireOrganizationCreationCapability,
  type StaffRole,
} from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx, type Tx } from "../db.js";
import {
  ensureCloudComputerIdentity,
  lockCloudComputerOrganization,
  requireCloudComputerAuthority,
} from "./computer.js";
import { assertCloudGithubSource } from "./github-user-access.js";
import {
  cloudWorkspaceSecretValueVerifier,
  sealCloudWorkspaceSecretBinding,
} from "./settings.js";
import { sanitizeCloudWorkspaceSetupLog } from "./setup-log.js";
import {
  CLOUD_COMPUTER_V2_MAX_LOG_BYTES,
  CLOUD_COMPUTER_V2_MAX_LOG_ROW_BYTES,
  CLOUD_COMPUTER_V2_MAX_REQUEST_BYTES,
  CloudComputerV2BuildErrorSchema,
  CloudComputerV2BuildRequestSchema,
  CloudComputerV2BuildStageSchema,
  CloudComputerV2RepositoryManifestSchema,
  CloudComputerV2RevisionSchema,
  CloudComputerV2SaveDraftSchema,
  CloudComputerV2VersionRequestSchema,
  type CloudComputerV2ActivateResult,
  type CloudComputerV2BuildError,
  type CloudComputerV2BuildLogs,
  type CloudComputerV2BuildResult,
  type CloudComputerV2BuildStage,
  type CloudComputerV2BuildState,
  type CloudComputerV2BuildSummary,
  type CloudComputerV2CancelResult,
  type CloudComputerV2DraftInput,
  type CloudComputerV2DraftResult,
  type CloudComputerV2Repository,
  type CloudComputerV2RepositoryManifest,
  type CloudComputerV2State,
  type CloudComputerV2TemplateState,
} from "./computer-v2-contract.js";

const empty: CloudComputerV2DraftInput = {
  repositories: [],
  installScript: "",
  timeoutSeconds: 900,
};
const TRUNCATION_MARKER = "[earlier build log output truncated]";
const positive = z.number().int().positive().safe();
const identifier = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_.:/-]+$/);
const PinsSchema = z
  .object({
    baseImageId: identifier,
    runtimeId: identifier,
    repositoryManifest: CloudComputerV2RepositoryManifestSchema,
  })
  .strict();
const CompletionSchema = PinsSchema.extend({
  template: z
    .object({
      providerResourceId: identifier.nullable(),
      accountScope: identifier.nullable(),
      billingOrg: identifier.nullable(),
      protectedContractDigest: z.string().regex(/^[a-f0-9]{64}$/),
      stoppedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
});
const LogInputSchema = z
  .object({
    stream: z.enum(["stdout", "stderr", "system"]),
    stage: CloudComputerV2BuildStageSchema,
    text: z
      .string()
      .max(CLOUD_COMPUTER_V2_MAX_REQUEST_BYTES)
      .refine(
        (value) =>
          !value.includes("\0") &&
          Buffer.byteLength(value) <= CLOUD_COMPUTER_V2_MAX_REQUEST_BYTES,
      ),
  })
  .strict();
type Head = {
  org_id: string;
  revision: string;
  next_version: string;
  draft_config_id: string | null;
  active_build_id: string | null;
  previous_build_id: string | null;
  latest_build_id: string | null;
};
type Build = {
  id: string;
  org_id: string;
  version: string;
  config_id: string;
  accepted_revision: string;
  state: CloudComputerV2BuildState;
  stage: CloudComputerV2BuildStage;
  error_code: CloudComputerV2BuildError | null;
  requested_by: string;
  operation_id: string;
  rebuilt_from_build_id: string | null;
  worker_fence: string;
  base_image_id: string | null;
  runtime_id: string | null;
  repository_manifest: CloudComputerV2RepositoryManifest | null;
  cancel_requested_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  template_state: CloudComputerV2TemplateState | null;
};
type EnvironmentRef = {
  name: string;
  binding_id: string;
  binding_version: string;
  available: boolean;
};
type Configuration = {
  id: string;
  install_script: string;
  timeout_seconds: number;
  metadata_digest: Buffer;
  repositories: CloudComputerV2Repository[];
  environment: EnvironmentRef[];
};
type Operation = {
  kind: "build" | "rebuild" | "activate";
  actor_id: string;
  request_sha256: Buffer;
  key_version: number | null;
  build_id: string;
  revision: string;
};
export type CloudComputerV2WorkerResult = {
  applied: boolean;
  state: CloudComputerV2BuildState;
  activated?: boolean;
};
export type CloudComputerV2Claim = {
  organizationId: string;
  workerFence: number;
  build: CloudComputerV2BuildSummary;
  config: {
    id: string;
    installScript: string;
    timeoutSeconds: number;
    repositories: CloudComputerV2Repository[];
  };
};

const iso = (value: Date | null) =>
  value === null ? null : value.toISOString();
function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown,
): T {
  try {
    if (
      Buffer.byteLength(JSON.stringify(value) ?? "") >
      CLOUD_COMPUTER_V2_MAX_REQUEST_BYTES
    )
      throw new Error();
    const result = schema.safeParse(value);
    if (result.success) return result.data;
  } catch {
    /* Inputs and validation errors can contain secrets; never echo them. */
  }
  throw new HttpError(422, "invalid_input", "Invalid Cloud Computer input.");
}
const uuid = (value: string) => parse(z.string().uuid(), value).toLowerCase();
const integer = (value: string | number) => positive.parse(Number(value));
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : item,
  );
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest();
const pending = (build: Build) =>
  build.state === "queued" || build.state === "running";
function conflict(head?: Head): never {
  throw new HttpError(
    409,
    "cloud_computer_changed",
    "Cloud Computer changed. Refresh before saving.",
    {
      currentRevision: Number(head?.revision ?? 0),
      latestBuildId: head?.latest_build_id ?? null,
    },
  );
}
function compareRevision(head: Head | undefined, expected: number) {
  if (Number(head?.revision ?? 0) !== expected) conflict(head);
}
function summary(build: Build): CloudComputerV2BuildSummary {
  return {
    id: build.id,
    version: integer(build.version),
    configId: build.config_id,
    acceptedRevision: integer(build.accepted_revision),
    state: build.state,
    stage: build.stage,
    errorCode: build.error_code,
    rebuiltFromBuildId: build.rebuilt_from_build_id,
    templateState: build.template_state,
    createdAt: iso(build.created_at)!,
    startedAt: iso(build.started_at),
    completedAt: iso(build.completed_at),
    cancelRequestedAt: iso(build.cancel_requested_at),
  };
}
async function authority(
  tx: Tx,
  org: string,
  user: string,
  admin = false,
  lockRows = true,
) {
  const account = (
    await tx.query<{ staff_role: StaffRole | null }>(
      `SELECT staff_role FROM users
    WHERE id=$1 AND deleted_at IS NULL AND auth_status='active'${lockRows ? " FOR SHARE" : ""}`,
      [user],
    )
  ).rows[0];
  requireOrganizationCreationCapability(account?.staff_role ?? null);
  return requireCloudComputerAuthority(tx, org, user, admin, lockRows);
}
async function headRow(tx: Tx, org: string, forUpdate = false) {
  return (
    await tx.query<Head>(
      `SELECT * FROM cloud_computer_v2_heads WHERE org_id=$1${forUpdate ? " FOR UPDATE" : ""}`,
      [org],
    )
  ).rows[0];
}
const selectBuild = `SELECT build.*,template.state AS template_state FROM cloud_computer_v2_builds build
  LEFT JOIN cloud_computer_templates template ON template.build_id=build.id AND template.org_id=build.org_id`;
async function buildRow(
  tx: Tx,
  org: string,
  id: string,
  forUpdate = false,
): Promise<Build> {
  const build = (
    await tx.query<Build>(
      `${selectBuild} WHERE build.org_id=$1 AND build.id=$2${forUpdate ? " FOR UPDATE OF build" : ""}`,
      [org, id],
    )
  ).rows[0];
  if (!build)
    throw new HttpError(404, "not_found", "Cloud Computer build not found.");
  return build;
}
async function configuration(
  tx: Tx,
  org: string,
  id: string,
): Promise<Configuration> {
  const config = (
    await tx.query<Omit<Configuration, "repositories" | "environment">>(
      "SELECT id,install_script,timeout_seconds,metadata_digest FROM cloud_computer_v2_configs WHERE id=$1 AND org_id=$2",
      [id, org],
    )
  ).rows[0];
  if (!config)
    throw new HttpError(
      404,
      "not_found",
      "Cloud Computer configuration not found.",
    );
  const repositories = (
    await tx.query<{
      repository_id: string;
      repository_owner: string;
      repository_name: string;
      installation_id: string;
      requested_ref: string | null;
    }>(
      `SELECT repository_id,repository_owner,repository_name,installation_id,requested_ref FROM cloud_computer_v2_config_repositories
      WHERE config_id=$1 AND org_id=$2 ORDER BY position`,
      [id, org],
    )
  ).rows.map((row) => ({
    id: row.repository_id,
    owner: row.repository_owner,
    name: row.repository_name,
    installationId: row.installation_id,
    requestedRef: row.requested_ref,
  }));
  const environment = (
    await tx.query<EnvironmentRef>(
      `SELECT ref.name,ref.binding_id,ref.binding_version,
    (binding.state='active' AND binding.owner_kind='organization' AND binding.name=ref.name AND binding.purpose='environment'
      AND binding.placement IN ('cloud','both') AND version.retired_at IS NULL) AS available
    FROM cloud_computer_environment_refs ref JOIN secret_bindings binding ON binding.id=ref.binding_id AND binding.org_id=ref.org_id
    JOIN secret_binding_versions version ON version.binding_id=ref.binding_id AND version.version=ref.binding_version AND version.org_id=ref.org_id
    WHERE ref.config_id=$1 AND ref.org_id=$2 ORDER BY ref.name`,
      [id, org],
    )
  ).rows;
  return { ...config, repositories, environment };
}
function requireEnvironment(config: Configuration) {
  if (config.environment.some((ref) => !ref.available))
    throw new HttpError(
      409,
      "cloud_computer_environment_unavailable",
      "An environment binding is unavailable. Edit the draft before building.",
    );
}
function repositoryIdentity(repository: CloudComputerV2Repository) {
  return canonical([
    repository.id,
    repository.owner.toLowerCase(),
    repository.name.toLowerCase(),
    repository.installationId.toLowerCase(),
  ]);
}
async function audit(
  tx: Tx,
  org: string,
  user: string,
  action: string,
  subject: Record<string, unknown>,
) {
  await tx.query(
    "INSERT INTO audit_log(org_id,actor_id,action,subject) VALUES($1,$2,$3,$4::jsonb)",
    [org, user, action, JSON.stringify(subject)],
  );
}

export class DatabaseCloudComputerV2Service {
  private readonly maxConcurrentBuilds: number;
  private readonly sanitizeLog: (value: string) => string;
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: CloudWorkspaceBackendConfig,
    options: {
      maxConcurrentBuilds?: number;
      sanitizeLog?: (value: string) => string;
    } = {},
  ) {
    this.maxConcurrentBuilds = parse(
      z.number().int().min(1).max(32),
      options.maxConcurrentBuilds ?? 2,
    );
    // C3 supplies a streaming literal/token filter before persisting output.
    // Until then, the default fails closed for arbitrary root-script output.
    this.sanitizeLog = options.sanitizeLog ?? sanitizeCloudWorkspaceSetupLog;
  }
  private secretKey(version?: number) {
    const keys =
      this.config.settingsSecretEncryptionKeys ??
      (this.config.settingsSecretKeyV1
        ? { 1: this.config.settingsSecretKeyV1 }
        : {});
    const selected =
      version ??
      this.config.currentSettingsSecretEncryptionKeyVersion ??
      (this.config.settingsSecretKeyV1 ? 1 : null);
    const key = selected === null ? undefined : keys[selected];
    if (!selected || !key)
      throw new HttpError(
        503,
        "cloud_secret_material_not_configured",
        "Cloud workspace secret material is not configured.",
      );
    return { version: selected, key };
  }
  private requestVerifier(
    org: string,
    operationId: string,
    value: unknown,
    keyVersion: number | null,
  ) {
    const hashed = digest(value);
    return keyVersion === null
      ? hashed
      : cloudWorkspaceSecretValueVerifier(
          hashed.toString("hex"),
          {
            bindingId: operationId,
            organizationId: org,
            version: 1,
            name: "CLOUD_COMPUTER_OPERATION",
          },
          this.secretKey(keyVersion).key,
        );
  }
  private async replay(
    tx: Tx,
    org: string,
    user: string,
    operationId: string,
    kind: Operation["kind"],
    request: unknown,
  ) {
    const previous = (
      await tx.query<Operation>(
        "SELECT * FROM cloud_computer_v2_operations WHERE org_id=$1 AND operation_id=$2",
        [org, operationId],
      )
    ).rows[0];
    if (!previous) return null;
    if (
      previous.kind !== kind ||
      previous.actor_id !== user ||
      !previous.request_sha256.equals(
        this.requestVerifier(org, operationId, request, previous.key_version),
      )
    )
      throw new HttpError(
        409,
        "cloud_computer_operation_conflict",
        "Operation identity is already in use.",
      );
    return previous;
  }
  private async receipt(
    tx: Tx,
    org: string,
    user: string,
    operationId: string,
    kind: Operation["kind"],
    request: unknown,
    buildId: string,
    revision: number,
    secretBearing = false,
  ) {
    const keyVersion = secretBearing ? this.secretKey().version : null;
    await tx.query(
      `INSERT INTO cloud_computer_v2_operations(org_id,operation_id,kind,actor_id,request_sha256,key_version,build_id,revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        org,
        operationId,
        kind,
        user,
        this.requestVerifier(org, operationId, request, keyVersion),
        keyVersion,
        buildId,
        revision,
      ],
    );
  }
  private async enable(tx: Tx, org: string, user: string): Promise<Head> {
    const current = await headRow(tx, org, true);
    if (current) return current;
    const legacy = (
      await tx.query<{ id: string }>(
        "SELECT id FROM cloud_computer_builds WHERE org_id=$1 AND state='building' LIMIT 1",
        [org],
      )
    ).rows[0];
    if (legacy)
      throw new HttpError(
        409,
        "cloud_computer_build_active",
        "Finish or cancel the legacy build before enabling v2.",
        { currentBuildId: legacy.id },
      );
    await ensureCloudComputerIdentity(tx, org, user);
    return (
      await tx.query<Head>(
        "INSERT INTO cloud_computer_v2_heads(org_id) VALUES($1) RETURNING *",
        [org],
      )
    ).rows[0]!;
  }
  private async setEnvironment(
    tx: Tx,
    org: string,
    user: string,
    name: string,
    value: string,
  ): Promise<EnvironmentRef> {
    const key = this.secretKey();
    const current = (
      await tx.query<{
        id: string;
        placement: string;
      }>(
        `SELECT id,placement FROM secret_bindings
      WHERE org_id=$1 AND owner_kind='organization' AND purpose='environment' AND name=$2 AND state='active' FOR UPDATE`,
        [org, name],
      )
    ).rows[0];
    if (current?.placement === "local")
      throw new HttpError(
        409,
        "cloud_computer_environment_unavailable",
        "Environment binding is not available in cloud workspaces.",
      );
    const bindingId = current?.id ?? randomUUID();
    // The binding row lock also serializes generic rotation. Draft versions
    // append independently of current_version, which only rotation publishes.
    const version = current
      ? integer(
          (
            await tx.query<{ version: string }>(
              "SELECT coalesce(max(version),0)+1 AS version FROM secret_binding_versions WHERE binding_id=$1 AND org_id=$2",
              [bindingId, org],
            )
          ).rows[0]!.version,
        )
      : 1;
    let sealed: ReturnType<typeof sealCloudWorkspaceSecretBinding>;
    try {
      sealed = sealCloudWorkspaceSecretBinding(
        value,
        { bindingId, organizationId: org, version, name },
        key.key,
      );
    } catch {
      throw new HttpError(
        422,
        "cloud_secret_invalid",
        "Secret binding input is invalid.",
      );
    }
    if (!current)
      await tx.query(
        `INSERT INTO secret_bindings(id,org_id,owner_kind,name,purpose,placement,current_version,state)
      VALUES($1,$2,'organization',$3,'environment','cloud',1,'active')`,
        [bindingId, org, name],
      );
    await tx.query(
      `INSERT INTO secret_binding_versions(binding_id,org_id,version,key_version,nonce,ciphertext,auth_tag,verifier_scheme,value_verifier,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9)`,
      [
        bindingId,
        org,
        version,
        key.version,
        sealed.nonce,
        sealed.ciphertext,
        sealed.authTag,
        sealed.valueVerifier,
        user,
      ],
    );
    // Older versions remain pinned by immutable recipes. Removing or
    // discarding a reference must never invoke security revocation.
    return {
      name,
      binding_id: bindingId,
      binding_version: String(version),
      available: true,
    };
  }
  private async createConfig(
    tx: Tx,
    org: string,
    user: string,
    input: CloudComputerV2DraftInput,
    prior: Configuration | null,
  ): Promise<Configuration> {
    const repositories = input.repositories.map((row) => ({
      ...row,
      owner: row.owner.toLowerCase(),
      name: row.name.toLowerCase(),
      installationId: row.installationId.toLowerCase(),
    }));
    const approved = new Set(prior?.repositories.map(repositoryIdentity));
    for (const repository of repositories)
      if (!approved.has(repositoryIdentity(repository)))
        await assertCloudGithubSource(tx, {
          organizationId: org,
          actorUserId: user,
          installationRecordId: repository.installationId,
          repositoryOwner: repository.owner,
          repositoryName: repository.name,
          forgeRepositoryId: repository.id,
        });
    const refs = new Map(prior?.environment.map((ref) => [ref.name, ref]));
    for (const operation of input.environment ?? []) {
      if (operation.op === "remove") refs.delete(operation.name);
      else if (operation.op === "set")
        refs.set(
          operation.name,
          await this.setEnvironment(
            tx,
            org,
            user,
            operation.name,
            operation.value,
          ),
        );
      else if (!refs.has(operation.name))
        throw new HttpError(
          409,
          "cloud_computer_environment_unavailable",
          "Environment binding cannot be preserved. Refresh the draft.",
        );
    }
    if (refs.size > 128)
      throw new HttpError(
        422,
        "invalid_input",
        "Too many environment bindings.",
      );
    const environment = [...refs.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    const id = randomUUID(),
      metadataDigest = digest({
        repositories,
        installScript: input.installScript,
        timeoutSeconds: input.timeoutSeconds,
        environment: environment.map((ref) => ({
          name: ref.name,
          bindingId: ref.binding_id,
          version: ref.binding_version,
        })),
      });
    await tx.query(
      `INSERT INTO cloud_computer_v2_configs(id,org_id,install_script,timeout_seconds,metadata_digest,created_by) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        id,
        org,
        input.installScript,
        input.timeoutSeconds,
        metadataDigest,
        user,
      ],
    );
    for (const [position, repository] of repositories.entries())
      await tx.query(
        `INSERT INTO cloud_computer_v2_config_repositories
      (config_id,org_id,position,repository_id,repository_owner,repository_name,installation_id,requested_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          org,
          position,
          repository.id,
          repository.owner,
          repository.name,
          repository.installationId,
          repository.requestedRef,
        ],
      );
    for (const ref of environment)
      await tx.query(
        `INSERT INTO cloud_computer_environment_refs(config_id,org_id,name,binding_id,binding_version) VALUES($1,$2,$3,$4,$5)`,
        [id, org, ref.name, ref.binding_id, ref.binding_version],
      );
    return {
      id,
      repositories,
      environment,
      install_script: input.installScript,
      timeout_seconds: input.timeoutSeconds,
      metadata_digest: metadataDigest,
    };
  }
  private async unbuilt(tx: Tx, head: Head, config: Configuration) {
    if (!head.active_build_id) return true;
    const active = (
      await tx.query<{ metadata_digest: Buffer }>(
        `SELECT config.metadata_digest FROM cloud_computer_v2_builds build
      JOIN cloud_computer_v2_configs config ON config.id=build.config_id AND config.org_id=build.org_id WHERE build.id=$1 AND build.org_id=$2`,
        [head.active_build_id, head.org_id],
      )
    ).rows[0];
    return !active?.metadata_digest.equals(config.metadata_digest);
  }
  async read(
    organizationId: string,
    userId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<CloudComputerV2State> {
    const org = uuid(organizationId),
      user = uuid(userId);
    const query = parse(
      z
        .object({
          cursor: z.string().min(1).max(512).optional(),
          limit: positive.max(100).default(30),
        })
        .strict(),
      options,
    );
    let before: number | null = null;
    if (query.cursor) {
      try {
        const decoded = Buffer.from(query.cursor, "base64url");
        if (decoded.toString("base64url") !== query.cursor) throw new Error();
        const cursor = z
          .object({
            organizationId: z.string().uuid(),
            beforeVersion: positive,
          })
          .strict()
          .parse(JSON.parse(decoded.toString("utf8")));
        if (cursor.organizationId !== org) throw new Error();
        before = cursor.beforeVersion;
      } catch {
        throw new HttpError(
          422,
          "invalid_cursor",
          "Invalid Cloud Computer history cursor.",
        );
      }
    }
    return withSystemTx(
      this.pool,
      async (tx) => {
        const member = await authority(tx, org, user, false, false),
          head = await headRow(tx, org);
        const config = head?.draft_config_id
          ? await configuration(tx, org, head.draft_config_id)
          : null;
        const pointers = [
          head?.active_build_id,
          head?.previous_build_id,
          head?.latest_build_id,
        ].filter((id): id is string => Boolean(id));
        const builds = pointers.length
          ? (
              await tx.query<Build>(
                `${selectBuild} WHERE build.org_id=$1 AND build.id=ANY($2::uuid[])`,
                [org, pointers],
              )
            ).rows
          : [];
        const active =
          builds.find((build) => build.id === head?.active_build_id) ?? null;
        const previous =
          builds.find((build) => build.id === head?.previous_build_id) ?? null;
        const latest =
          builds.find((build) => build.id === head?.latest_build_id) ?? null;
        const history = (
          await tx.query<Build>(
            `${selectBuild} WHERE build.org_id=$1 AND ($2::bigint IS NULL OR build.version<$2)
        ORDER BY build.version DESC LIMIT $3`,
            [org, before, query.limit + 1],
          )
        ).rows;
        const page = history.slice(0, query.limit),
          last = page.at(-1);
        return {
          state:
            latest && pending(latest)
              ? "building"
              : active
                ? "active"
                : latest
                  ? "failed"
                  : "not_built",
          revision: Number(head?.revision ?? 0),
          draft: {
            configId: config?.id ?? null,
            repositories: config?.repositories ?? [],
            installScript: config?.install_script ?? "",
            timeoutSeconds: config?.timeout_seconds ?? 900,
            environment:
              config?.environment.map((ref) => ({
                name: ref.name,
                set: ref.available,
              })) ?? [],
          },
          active: active ? summary(active) : null,
          previous: previous ? summary(previous) : null,
          latestBuild: latest ? summary(latest) : null,
          unbuiltChanges: Boolean(
            head && config && (await this.unbuilt(tx, head, config)),
          ),
          history: {
            builds: page.map(summary),
            nextCursor:
              history.length > query.limit && last
                ? Buffer.from(
                    JSON.stringify({
                      organizationId: org,
                      beforeVersion: integer(last.version),
                    }),
                  ).toString("base64url")
                : null,
          },
          canManage: member.role === "owner" || member.role === "admin",
        };
      },
      { consistentRead: true },
    );
  }
  async saveDraft(
    organizationId: string,
    userId: string,
    value: unknown,
  ): Promise<CloudComputerV2DraftResult> {
    const input = parse(CloudComputerV2SaveDraftSchema, value),
      org = uuid(organizationId),
      user = uuid(userId);
    return withSystemTx(this.pool, async (tx) => {
      await authority(tx, org, user, true);
      await lockCloudComputerOrganization(tx, org);
      compareRevision(await headRow(tx, org, true), input.expectedRevision);
      const head = await this.enable(tx, org, user);
      const prior = head.draft_config_id
        ? await configuration(tx, org, head.draft_config_id)
        : null;
      const config = await this.createConfig(tx, org, user, input, prior),
        revision = Number(head.revision) + 1;
      await tx.query(
        "UPDATE cloud_computer_v2_heads SET draft_config_id=$2,revision=$3 WHERE org_id=$1",
        [org, config.id, revision],
      );
      await audit(tx, org, user, "cloud_computer_v2.draft_saved", {
        configId: config.id,
        revision,
      });
      return {
        revision,
        configId: config.id,
        unbuiltChanges: await this.unbuilt(tx, head, config),
      };
    });
  }
  async discard(
    organizationId: string,
    userId: string,
    value: unknown,
  ): Promise<CloudComputerV2DraftResult> {
    const input = parse(CloudComputerV2RevisionSchema, value),
      org = uuid(organizationId),
      user = uuid(userId);
    return withSystemTx(this.pool, async (tx) => {
      await authority(tx, org, user, true);
      await lockCloudComputerOrganization(tx, org);
      compareRevision(await headRow(tx, org, true), input.expectedRevision);
      const head = await this.enable(tx, org, user);
      const active = head.active_build_id
        ? await buildRow(tx, org, head.active_build_id)
        : null;
      const config = active
        ? await configuration(tx, org, active.config_id)
        : await this.createConfig(tx, org, user, empty, null);
      const revision = Number(head.revision) + 1;
      await tx.query(
        "UPDATE cloud_computer_v2_heads SET draft_config_id=$2,revision=$3 WHERE org_id=$1",
        [org, config.id, revision],
      );
      await audit(tx, org, user, "cloud_computer_v2.draft_discarded", {
        configId: config.id,
        revision,
      });
      return {
        revision,
        configId: config.id,
        unbuiltChanges: await this.unbuilt(tx, head, config),
      };
    });
  }
  private async requireNoPendingBuild(tx: Tx, org: string) {
    const current = (
      await tx.query<{ id: string }>(
        "SELECT id FROM cloud_computer_v2_builds WHERE org_id=$1 AND state IN ('queued','running') LIMIT 1",
        [org],
      )
    ).rows[0];
    if (current)
      throw new HttpError(
        409,
        "cloud_computer_build_active",
        "A Cloud Computer build is already queued or running.",
        { currentBuildId: current.id },
      );
  }
  private async queue(
    tx: Tx,
    head: Head,
    user: string,
    operationId: string,
    config: Configuration,
    rebuiltFrom: string | null,
  ) {
    requireEnvironment(config);
    const id = randomUUID(),
      revision = Number(head.revision) + 1,
      version = integer(head.next_version);
    await tx.query(
      `INSERT INTO cloud_computer_v2_builds(id,org_id,version,config_id,accepted_revision,requested_by,operation_id,rebuilt_from_build_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        head.org_id,
        version,
        config.id,
        revision,
        user,
        operationId,
        rebuiltFrom,
      ],
    );
    await tx.query(
      `UPDATE cloud_computer_v2_heads SET draft_config_id=$2,revision=$3,next_version=$4,latest_build_id=$5 WHERE org_id=$1`,
      [head.org_id, config.id, revision, version + 1, id],
    );
    await audit(tx, head.org_id, user, "cloud_computer_v2.build_requested", {
      buildId: id,
      version,
      configId: config.id,
      revision,
      rebuiltFromBuildId: rebuiltFrom,
    });
    return {
      revision,
      build: summary(await buildRow(tx, head.org_id, id)),
      replayed: false,
    };
  }
  async build(
    organizationId: string,
    userId: string,
    value: unknown,
  ): Promise<CloudComputerV2BuildResult> {
    const input = parse(CloudComputerV2BuildRequestSchema, value),
      org = uuid(organizationId),
      user = uuid(userId),
      operationId = uuid(input.operationId);
    return withSystemTx(this.pool, async (tx) => {
      await authority(tx, org, user, true);
      await lockCloudComputerOrganization(tx, org);
      const replay = await this.replay(
        tx,
        org,
        user,
        operationId,
        "build",
        input,
      );
      if (replay)
        return {
          revision: Number(replay.revision),
          build: summary(await buildRow(tx, org, replay.build_id)),
          replayed: true,
        };
      compareRevision(await headRow(tx, org, true), input.expectedRevision);
      const head = await this.enable(tx, org, user);
      await this.requireNoPendingBuild(tx, org);
      const prior = head.draft_config_id
        ? await configuration(tx, org, head.draft_config_id)
        : null;
      const config =
        input.draft || !prior
          ? await this.createConfig(tx, org, user, input.draft ?? empty, prior)
          : prior;
      const result = await this.queue(
        tx,
        head,
        user,
        operationId,
        config,
        null,
      );
      await this.receipt(
        tx,
        org,
        user,
        operationId,
        "build",
        input,
        result.build.id,
        result.revision,
        input.draft?.environment?.some((op) => op.op === "set"),
      );
      return result;
    });
  }
  async rebuild(
    organizationId: string,
    userId: string,
    version: number,
    value: unknown,
  ): Promise<CloudComputerV2BuildResult> {
    const input = parse(CloudComputerV2VersionRequestSchema, value),
      sourceVersion = parse(positive, version);
    const org = uuid(organizationId),
      user = uuid(userId),
      operationId = uuid(input.operationId),
      request = { ...input, version: sourceVersion };
    return withSystemTx(this.pool, async (tx) => {
      await authority(tx, org, user, true);
      await lockCloudComputerOrganization(tx, org);
      const replay = await this.replay(
        tx,
        org,
        user,
        operationId,
        "rebuild",
        request,
      );
      if (replay)
        return {
          revision: Number(replay.revision),
          build: summary(await buildRow(tx, org, replay.build_id)),
          replayed: true,
        };
      const head = await headRow(tx, org, true);
      compareRevision(head, input.expectedRevision);
      const source = (
        await tx.query<Build>(
          `${selectBuild} WHERE build.org_id=$1 AND build.version=$2`,
          [org, sourceVersion],
        )
      ).rows[0];
      if (!head || !source)
        throw new HttpError(
          404,
          "not_found",
          "Cloud Computer version not found.",
        );
      await this.requireNoPendingBuild(tx, org);
      const prior = await configuration(tx, org, source.config_id);
      requireEnvironment(prior);
      const manifest =
        source.repository_manifest === null
          ? null
          : parse(
              CloudComputerV2RepositoryManifestSchema,
              source.repository_manifest,
            );
      const repositories = prior.repositories.map((repository) => {
        if (!manifest) return repository;
        const pin = manifest.find(
          (item) =>
            item.id === repository.id &&
            item.owner.toLowerCase() === repository.owner &&
            item.name.toLowerCase() === repository.name,
        );
        if (!pin)
          throw new HttpError(
            409,
            "cloud_computer_repository_manifest_invalid",
            "This version has incomplete repository pins.",
          );
        return { ...repository, requestedRef: pin.sha };
      });
      const config = await this.createConfig(
        tx,
        org,
        user,
        {
          repositories,
          installScript: prior.install_script,
          timeoutSeconds: prior.timeout_seconds,
        },
        prior,
      );
      const result = await this.queue(
        tx,
        head,
        user,
        operationId,
        config,
        source.id,
      );
      await this.receipt(
        tx,
        org,
        user,
        operationId,
        "rebuild",
        request,
        result.build.id,
        result.revision,
      );
      return result;
    });
  }
  async activate(
    organizationId: string,
    userId: string,
    version: number,
    value: unknown,
  ): Promise<CloudComputerV2ActivateResult> {
    const input = parse(CloudComputerV2VersionRequestSchema, value),
      targetVersion = parse(positive, version);
    const org = uuid(organizationId),
      user = uuid(userId),
      operationId = uuid(input.operationId),
      request = { ...input, version: targetVersion };
    return withSystemTx(this.pool, async (tx) => {
      await authority(tx, org, user, true);
      await lockCloudComputerOrganization(tx, org);
      const replay = await this.replay(
        tx,
        org,
        user,
        operationId,
        "activate",
        request,
      );
      if (replay)
        return {
          revision: Number(replay.revision),
          activeBuildId: replay.build_id,
          activated: true,
          replayed: true,
        };
      const head = await headRow(tx, org, true);
      compareRevision(head, input.expectedRevision);
      const build = (
        await tx.query<Build>(
          `${selectBuild} WHERE build.org_id=$1 AND build.version=$2 FOR UPDATE OF build`,
          [org, targetVersion],
        )
      ).rows[0];
      if (
        !head ||
        !build ||
        build.state !== "succeeded" ||
        build.template_state !== "ready"
      )
        throw new HttpError(
          409,
          "cloud_computer_not_built",
          "Activate requires a successful version with a ready template.",
        );
      // C3 supplies registry/qualification checks before publishing ready;
      // later retention/revocation workers withdraw that readiness.
      if (
        !(
          await tx.query(
            "SELECT build_id FROM cloud_computer_templates WHERE build_id=$1 AND org_id=$2 AND state='ready' FOR UPDATE",
            [build.id, org],
          )
        ).rowCount
      )
        throw new HttpError(
          409,
          "cloud_computer_not_built",
          "This template is no longer ready.",
        );
      requireEnvironment(await configuration(tx, org, build.config_id));
      const revision = Number(head.revision) + 1;
      await tx.query(
        `UPDATE cloud_computer_v2_heads SET previous_build_id=CASE WHEN active_build_id IS DISTINCT FROM $2::uuid
        THEN active_build_id ELSE previous_build_id END,active_build_id=$2,revision=$3 WHERE org_id=$1`,
        [org, build.id, revision],
      );
      await this.receipt(
        tx,
        org,
        user,
        operationId,
        "activate",
        request,
        build.id,
        revision,
      );
      await audit(tx, org, user, "cloud_computer_v2.activated", {
        buildId: build.id,
        version: targetVersion,
        revision,
      });
      return {
        revision,
        activeBuildId: build.id,
        activated: true,
        replayed: false,
      };
    });
  }
  async getBuild(
    organizationId: string,
    userId: string,
    buildId: string,
  ): Promise<CloudComputerV2BuildSummary> {
    const org = uuid(organizationId),
      user = uuid(userId),
      id = uuid(buildId);
    return withSystemTx(
      this.pool,
      async (tx) => {
        await authority(tx, org, user, false, false);
        return summary(await buildRow(tx, org, id));
      },
      { consistentRead: true },
    );
  }
  async cancel(
    organizationId: string,
    userId: string,
    buildId: string,
    value: unknown,
  ): Promise<CloudComputerV2CancelResult> {
    const input = parse(CloudComputerV2RevisionSchema, value),
      org = uuid(organizationId),
      user = uuid(userId),
      id = uuid(buildId);
    return withSystemTx(this.pool, async (tx) => {
      await authority(tx, org, user, true);
      await lockCloudComputerOrganization(tx, org);
      const head = (await headRow(tx, org, true))!,
        build = await buildRow(tx, org, id, true);
      // Terminal/repeated requests perform no write; report the winning result
      // even if completion advanced the caller's revision in the meantime.
      if (!pending(build) || build.cancel_requested_at)
        return {
          revision: Number(head.revision),
          build: summary(build),
          cancelled: build.state === "cancelled",
          cancelRequested:
            build.state === "running" && Boolean(build.cancel_requested_at),
          alreadyCompleted: !pending(build),
        };
      compareRevision(head, input.expectedRevision);
      const queued = build.state === "queued",
        revision = Number(head.revision) + 1;
      await tx.query(
        `UPDATE cloud_computer_v2_builds SET cancel_requested_at=now(),state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,
        completed_at=CASE WHEN state='queued' THEN now() ELSE completed_at END WHERE id=$1 AND org_id=$2`,
        [id, org],
      );
      await tx.query(
        "UPDATE cloud_computer_v2_heads SET revision=$2 WHERE org_id=$1",
        [org, revision],
      );
      await audit(tx, org, user, "cloud_computer_v2.cancel_requested", {
        buildId: id,
        revision,
      });
      return {
        revision,
        build: summary(await buildRow(tx, org, id)),
        cancelled: queued,
        cancelRequested: !queued,
        alreadyCompleted: false,
      };
    });
  }
  async logs(
    organizationId: string,
    userId: string,
    buildId: string,
    options: { after?: number; limit?: number } = {},
  ): Promise<CloudComputerV2BuildLogs> {
    const query = parse(
      z
        .object({
          after: z.number().int().nonnegative().safe().default(0),
          limit: positive.max(100).default(50),
        })
        .strict(),
      options,
    );
    const org = uuid(organizationId),
      user = uuid(userId),
      id = uuid(buildId);
    return withSystemTx(
      this.pool,
      async (tx) => {
        await authority(tx, org, user, false, false);
        const build = await buildRow(tx, org, id);
        const bounds = (
          await tx.query<{
            first_seq: string | null;
            last_seq: string | null;
            truncated: boolean | null;
          }>(
            `SELECT min(seq) AS first_seq,max(seq) AS last_seq,bool_or(stream='system' AND text=$3) AS truncated
          FROM cloud_computer_build_logs WHERE org_id=$1 AND build_id=$2`,
            [org, id, TRUNCATION_MARKER],
          )
        ).rows[0]!;
        const rows = (
          await tx.query<{
            seq: string;
            stream: "stdout" | "stderr" | "system";
            stage: CloudComputerV2BuildStage;
            text: string;
            created_at: Date;
          }>(
            `SELECT seq,stream,stage,text,created_at FROM cloud_computer_build_logs WHERE org_id=$1 AND build_id=$2 AND seq>$3 ORDER BY seq LIMIT $4`,
            [org, id, query.after, query.limit],
          )
        ).rows;
        return {
          entries: rows.map((row) => ({
            seq: integer(row.seq),
            stream: row.stream,
            stage: row.stage,
            text: row.text,
            createdAt: iso(row.created_at)!,
          })),
          firstSeq: bounds.first_seq ? integer(bounds.first_seq) : null,
          lastSeq: bounds.last_seq ? integer(bounds.last_seq) : null,
          nextAfter: rows.length ? integer(rows.at(-1)!.seq) : query.after,
          truncated: bounds.truncated === true,
          complete: !pending(build),
        };
      },
      { consistentRead: true },
    );
  }
  private async lockedBuild(tx: Tx, id: string) {
    const scope = (
      await tx.query<{ org_id: string }>(
        "SELECT org_id FROM cloud_computer_v2_builds WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!scope)
      throw new HttpError(404, "not_found", "Cloud Computer build not found.");
    await lockCloudComputerOrganization(tx, scope.org_id);
    const head = (await headRow(tx, scope.org_id, true))!,
      build = await buildRow(tx, scope.org_id, id, true);
    return { head, build };
  }
  /** No allocation: a global DB lock makes the running-count cap atomic across
   * API processes. Take the org lock before locking its build, as all writers do. */
  async claimNextBuild(fence: number): Promise<CloudComputerV2Claim | null> {
    const workerFence = parse(positive, fence);
    return withSystemTx(this.pool, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(62173)");
      const running = (
        await tx.query<{ count: string }>(
          "SELECT count(*) FROM cloud_computer_v2_builds WHERE state='running'",
        )
      ).rows[0]!;
      if (Number(running.count) >= this.maxConcurrentBuilds) return null;
      const candidate = (
        await tx.query<{ id: string }>(
          "SELECT id FROM cloud_computer_v2_builds WHERE state='queued' ORDER BY created_at,id LIMIT 1",
        )
      ).rows[0];
      if (!candidate) return null;
      const { build } = await this.lockedBuild(tx, candidate.id);
      if (build.state !== "queued") return null;
      const config = await configuration(tx, build.org_id, build.config_id);
      await tx.query(
        `UPDATE cloud_computer_v2_builds SET state='running',stage='allocating',worker_fence=$2,
        started_at=now(),deadline_at=now()+interval '30 minutes' WHERE id=$1`,
        [build.id, workerFence],
      );
      return {
        organizationId: build.org_id,
        workerFence,
        build: summary(await buildRow(tx, build.org_id, build.id)),
        config: {
          id: config.id,
          installScript: config.install_script,
          timeoutSeconds: config.timeout_seconds,
          repositories: config.repositories,
        },
      };
    });
  }
  private async verifyManifest(
    tx: Tx,
    build: Build,
    manifest: CloudComputerV2RepositoryManifest,
  ) {
    const config = await configuration(tx, build.org_id, build.config_id);
    if (
      manifest.length !== config.repositories.length ||
      config.repositories.some((repository, index) => {
        const pin = manifest[index];
        return (
          !pin ||
          pin.id !== repository.id ||
          pin.owner.toLowerCase() !== repository.owner ||
          pin.name.toLowerCase() !== repository.name ||
          (/^[a-f0-9]{40}$/.test(repository.requestedRef ?? "") &&
            repository.requestedRef !== pin.sha)
        );
      })
    )
      throw new HttpError(
        422,
        "invalid_input",
        "Repository manifest does not match this build's configuration.",
      );
    return config;
  }
  async markBuildStage(
    buildId: string,
    fence: number,
    value: CloudComputerV2BuildStage,
    pins?: z.infer<typeof PinsSchema>,
  ): Promise<CloudComputerV2WorkerResult> {
    const id = uuid(buildId),
      workerFence = parse(positive, fence),
      stage = parse(CloudComputerV2BuildStageSchema, value);
    const identity = pins === undefined ? undefined : parse(PinsSchema, pins);
    if (stage === "queued" || stage === "done")
      throw new HttpError(422, "invalid_input", "Invalid running build stage.");
    return withSystemTx(this.pool, async (tx) => {
      const { build } = await this.lockedBuild(tx, id);
      if (
        build.state !== "running" ||
        Number(build.worker_fence) !== workerFence
      )
        return { applied: false, state: build.state };
      if (identity) {
        await this.verifyManifest(tx, build, identity.repositoryManifest);
        if (
          (build.base_image_id !== null &&
            build.base_image_id !== identity.baseImageId) ||
          (build.runtime_id !== null &&
            build.runtime_id !== identity.runtimeId) ||
          (build.repository_manifest !== null &&
            canonical(build.repository_manifest) !==
              canonical(identity.repositoryManifest))
        )
          throw new HttpError(
            409,
            "cloud_computer_build_pin_conflict",
            "Build identity is already pinned.",
          );
      }
      if (
        CloudComputerV2BuildStageSchema.options.indexOf(stage) <
        CloudComputerV2BuildStageSchema.options.indexOf(build.stage)
      )
        return { applied: false, state: build.state };
      await tx.query(
        `UPDATE cloud_computer_v2_builds SET stage=$2,base_image_id=coalesce(base_image_id,$3),runtime_id=coalesce(runtime_id,$4),
        repository_manifest=coalesce(repository_manifest,$5::jsonb) WHERE id=$1`,
        [
          id,
          stage,
          identity?.baseImageId ?? null,
          identity?.runtimeId ?? null,
          identity ? JSON.stringify(identity.repositoryManifest) : null,
        ],
      );
      return { applied: true, state: build.state };
    });
  }
  /** C3 calls this only after protected-contract validation, qualification and
   * verified stop/capture. This transaction publishes the template and head
   * together; a lost CAS retains quarantined metadata for C3 cleanup. */
  async completeBuild(
    buildId: string,
    fence: number,
    value: z.infer<typeof CompletionSchema>,
  ): Promise<CloudComputerV2WorkerResult> {
    const id = uuid(buildId),
      workerFence = parse(positive, fence),
      input = parse(CompletionSchema, value);
    return withSystemTx(this.pool, async (tx) => {
      const { head, build } = await this.lockedBuild(tx, id);
      if (
        build.state !== "running" ||
        Number(build.worker_fence) !== workerFence
      )
        return { applied: false, state: build.state, activated: false };
      const config = await this.verifyManifest(
        tx,
        build,
        input.repositoryManifest,
      );
      const eligible =
        head.revision === build.accepted_revision &&
        head.draft_config_id === build.config_id &&
        head.latest_build_id === build.id &&
        build.cancel_requested_at === null &&
        build.base_image_id === input.baseImageId &&
        build.runtime_id === input.runtimeId &&
        build.repository_manifest !== null &&
        canonical(build.repository_manifest) ===
          canonical(input.repositoryManifest) &&
        config.environment.every((ref) => ref.available);
      if (eligible && build.stage !== "capture_confirmed")
        throw new HttpError(
          409,
          "cloud_computer_build_not_ready",
          "Build capture has not been confirmed.",
        );
      if (
        !build.base_image_id ||
        !build.runtime_id ||
        build.repository_manifest === null
      ) {
        if (
          build.cancel_requested_at === null &&
          head.revision === build.accepted_revision &&
          head.latest_build_id === build.id
        )
          throw new HttpError(
            409,
            "cloud_computer_build_not_ready",
            "Build identity has not been pinned.",
          );
      }
      const state = eligible ? "succeeded" : "superseded";
      await tx.query(
        "UPDATE cloud_computer_v2_builds SET state=$2,stage='done',completed_at=now() WHERE id=$1",
        [id, state],
      );
      const existing = (
        await tx.query<{
          provider_resource_id: string | null;
          account_scope: string | null;
          billing_org: string | null;
        }>(
          "SELECT provider_resource_id,account_scope,billing_org FROM cloud_computer_templates WHERE build_id=$1 AND org_id=$2 FOR UPDATE",
          [id, build.org_id],
        )
      ).rows[0];
      if (
        existing &&
        ((existing.provider_resource_id !== null &&
          existing.provider_resource_id !==
            input.template.providerResourceId) ||
          (existing.account_scope !== null &&
            existing.account_scope !== input.template.accountScope) ||
          (existing.billing_org !== null &&
            existing.billing_org !== input.template.billingOrg))
      )
        throw new HttpError(
          409,
          "cloud_computer_build_pin_conflict",
          "Template identity is already pinned.",
        );
      await tx.query(
        `INSERT INTO cloud_computer_templates(build_id,org_id,state,provider_resource_id,account_scope,billing_org,protected_contract_digest,stopped_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(build_id) DO UPDATE SET state=EXCLUDED.state,provider_resource_id=EXCLUDED.provider_resource_id,
        account_scope=EXCLUDED.account_scope,billing_org=EXCLUDED.billing_org,protected_contract_digest=EXCLUDED.protected_contract_digest,stopped_at=EXCLUDED.stopped_at`,
        [
          id,
          build.org_id,
          eligible ? "ready" : "quarantined",
          input.template.providerResourceId,
          input.template.accountScope,
          input.template.billingOrg,
          Buffer.from(input.template.protectedContractDigest, "hex"),
          input.template.stoppedAt,
        ],
      );
      if (eligible)
        await tx.query(
          `UPDATE cloud_computer_v2_heads SET previous_build_id=CASE WHEN active_build_id IS DISTINCT FROM $2::uuid
        THEN active_build_id ELSE previous_build_id END,active_build_id=$2,revision=revision+1 WHERE org_id=$1`,
          [build.org_id, id],
        );
      return { applied: true, state, activated: eligible };
    });
  }
  async failBuild(
    buildId: string,
    fence: number,
    value: CloudComputerV2BuildError,
  ): Promise<CloudComputerV2WorkerResult> {
    const id = uuid(buildId),
      workerFence = parse(positive, fence),
      error = parse(CloudComputerV2BuildErrorSchema, value);
    return withSystemTx(this.pool, async (tx) => {
      const { build } = await this.lockedBuild(tx, id);
      if (
        build.state !== "running" ||
        Number(build.worker_fence) !== workerFence
      )
        return { applied: false, state: build.state };
      const cancelled = Boolean(build.cancel_requested_at),
        state = cancelled ? "cancelled" : "failed";
      await tx.query(
        "UPDATE cloud_computer_v2_builds SET state=$2,error_code=$3,completed_at=now() WHERE id=$1",
        [id, state, cancelled ? null : error],
      );
      await tx.query(
        "UPDATE cloud_computer_templates SET state='quarantined' WHERE build_id=$1 AND org_id=$2 AND state='pending'",
        [id, build.org_id],
      );
      return { applied: true, state };
    });
  }
  async appendBuildLog(
    buildId: string,
    fence: number,
    value: z.infer<typeof LogInputSchema>,
  ): Promise<CloudComputerV2WorkerResult & { lastSeq?: number }> {
    const id = uuid(buildId),
      workerFence = parse(positive, fence),
      input = parse(LogInputSchema, value);
    const text = parse(LogInputSchema.shape.text, this.sanitizeLog(input.text));
    const chunks: string[] = [];
    let chunk = "",
      length = 0;
    // Never split a UTF-8 code point at the SQL row's byte boundary.
    for (const character of text) {
      const bytes = Buffer.byteLength(character);
      if (length + bytes > CLOUD_COMPUTER_V2_MAX_LOG_ROW_BYTES) {
        chunks.push(chunk);
        chunk = "";
        length = 0;
      }
      chunk += character;
      length += bytes;
    }
    if (chunk) chunks.push(chunk);
    return withSystemTx(this.pool, async (tx) => {
      const { build } = await this.lockedBuild(tx, id);
      if (
        build.state !== "running" ||
        Number(build.worker_fence) !== workerFence
      )
        return { applied: false, state: build.state };
      let seq = Number(
        (
          await tx.query<{ seq: string }>(
            "SELECT coalesce(max(seq),0) AS seq FROM cloud_computer_build_logs WHERE build_id=$1 AND org_id=$2",
            [id, build.org_id],
          )
        ).rows[0]!.seq,
      );
      for (const chunk of chunks)
        await tx.query(
          `INSERT INTO cloud_computer_build_logs(build_id,org_id,seq,stream,stage,text) VALUES($1,$2,$3,$4,$5,$6)`,
          [id, build.org_id, ++seq, input.stream, input.stage, chunk],
        );
      const total = Number(
        (
          await tx.query<{ bytes: string }>(
            "SELECT coalesce(sum(octet_length(text)),0) AS bytes FROM cloud_computer_build_logs WHERE build_id=$1 AND org_id=$2",
            [id, build.org_id],
          )
        ).rows[0]!.bytes,
      );
      if (total > CLOUD_COMPUTER_V2_MAX_LOG_BYTES) {
        await tx.query(
          "DELETE FROM cloud_computer_build_logs WHERE build_id=$1 AND org_id=$2 AND stream='system' AND text=$3",
          [id, build.org_id, TRUNCATION_MARKER],
        );
        const cutoff = Number(
          (
            await tx.query<{ seq: string }>(
              `SELECT min(seq) AS seq FROM (
          SELECT seq,sum(octet_length(text)) OVER(ORDER BY seq DESC) AS bytes FROM cloud_computer_build_logs WHERE build_id=$1 AND org_id=$2
        ) tail WHERE bytes<=$3`,
              [
                id,
                build.org_id,
                CLOUD_COMPUTER_V2_MAX_LOG_BYTES -
                  Buffer.byteLength(TRUNCATION_MARKER),
              ],
            )
          ).rows[0]!.seq,
        );
        await tx.query(
          "DELETE FROM cloud_computer_build_logs WHERE build_id=$1 AND org_id=$2 AND seq<$3",
          [id, build.org_id, cutoff],
        );
        await tx.query(
          `INSERT INTO cloud_computer_build_logs(build_id,org_id,seq,stream,stage,text) VALUES($1,$2,$3,'system',$4,$5)`,
          [id, build.org_id, cutoff - 1, input.stage, TRUNCATION_MARKER],
        );
      }
      return { applied: true, state: build.state, lastSeq: seq };
    });
  }
}
