import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import {
  HttpError,
  requireOrganizationMembership,
  requireOrganizationRole,
} from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { assertCloudGithubSource } from "./github-user-access.js";
import { normalizeCloudWorkspaceSettingsDocument } from "./settings.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";
import { ensureWorkspaceDeletionJob } from "./workspace-deletion-job.js";
import { sanitizeCloudWorkspaceSetupLog } from "./setup-log.js";
import { assertComputerImageQualified, protectComputerImageBases, reserveComputerImageSlot, ComputerImageWorker, type ComputerImage, type ComputerImageDriver } from "./computer-image.js";
import { createComputerImageDriver } from "./computer-image-boat.js";
import { cloudWorkspaceProvisioningProfile } from "./provisioning-profile.js";
import { authorizeCloudWorkspaceOperation } from "./authorization.js";

const Name = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
export const CloudComputerRepositorySchema = z
  .object({
    id: z.string().regex(/^[1-9][0-9]{0,39}$/),
    owner: Name,
    name: Name,
    defaultBranch: z.string().min(1).max(512),
    private: z.boolean(),
  })
  .strict();
export const CloudComputerDocumentSchema = z
  .object({
    repositories: z
      .array(CloudComputerRepositorySchema)
      .max(20)
      .refine(
        (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
      ),
    installScript: z
      .string()
      .max(16_384)
      .refine(
        (value) => !value.includes("\0") && Buffer.byteLength(value) <= 16_384,
      ),
    timeoutSeconds: z.number().int().min(1).max(900),
  })
  .strict();
export type CloudComputerDocument = z.infer<typeof CloudComputerDocumentSchema>;
const empty: CloudComputerDocument = {
  repositories: [],
  installScript: "",
  timeoutSeconds: 900,
};
const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest();
function conflict(): never {
  throw new HttpError(
    409,
    "cloud_computer_changed",
    "Cloud Computer changed in another window. Refresh before saving.",
  );
}
async function authority(
  tx: Tx,
  organizationId: string,
  userId: string,
  admin = false,
) {
  if (admin) await requireOrganizationRole(tx, organizationId, userId, "admin");
  else await requireOrganizationMembership(tx, organizationId, userId);
  const row = (
    await tx.query<{ role: string }>(
      `SELECT member.role FROM organization_members member JOIN organizations org ON org.id=member.org_id
    WHERE member.org_id=$1 AND member.user_id=$2 AND NOT org.is_personal AND org.deleted_at IS NULL FOR SHARE OF org,member`,
      [organizationId, userId],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      404,
      "not_found",
      "Cloud Computer is available only in organizations.",
    );
  return row;
}
async function lock(tx: Tx, org: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,62171))", [
    org,
  ]);
}
export function cloudComputerRecipe(document: unknown): CloudComputerDocument {
  const input = document as { values?: { cloudComputer?: unknown } };
  return CloudComputerDocumentSchema.parse(input?.values?.cloudComputer);
}
function profileDocument(document: CloudComputerDocument) {
  return normalizeCloudWorkspaceSettingsDocument({
    values: { cloudComputer: document },
    // The recipe executes once in the image builder. Never replay installation
    // with a member's runtime/setup credentials on ordinary workspace creation.
    setupCommands: [],
  }).document;
}
async function activate(tx: Tx, org: string, version: number, imageId: string) {
  const computer = (
    await tx.query<{ profile_id: string }>(
      "SELECT profile_id FROM cloud_computers WHERE org_id=$1 FOR UPDATE",
      [org],
    )
  ).rows[0]!;
  await tx.query(
    "UPDATE environment_profiles SET is_default=false,updated_at=now() WHERE org_id=$1 AND owner_kind='organization' AND placement IN ('cloud','both') AND is_default AND deleted_at IS NULL",
    [org],
  );
  await tx.query(
    "UPDATE environment_profiles SET is_default=true,current_version=$2,updated_at=now() WHERE id=$1",
    [computer.profile_id, version],
  );
  await tx.query(
    "UPDATE cloud_computers SET active_version=$2,previous_image_id=CASE WHEN active_image_id IS DISTINCT FROM $3::uuid THEN active_image_id ELSE previous_image_id END,active_image_id=$3,revision=revision+1,updated_at=now() WHERE org_id=$1",
    [org, version, imageId],
  );
}

export class DatabaseCloudComputerService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: CloudWorkspaceBackendConfig,
    private readonly imageDriver?: ComputerImageDriver,
    private readonly workosEnabled = false,
  ) {}
  async read(organizationId: string, userId: string) {
    return withSystemTx(this.pool, async (tx) => {
      const member = await authority(tx, organizationId, userId);
      const row = (
        await tx.query<{
          revision: string;
          draft_version: string;
          active_version: string | null;
          document: unknown;
          active_image_id: string | null;
          previous_image_id: string | null;
          active_image_ref: string | null;
          active_image_created_at: Date | null;
        }>(
          `SELECT computer.revision,computer.draft_version,computer.active_image_id,computer.previous_image_id,
        image.image_ref AS active_image_ref,image.created_at AS active_image_created_at,
        CASE WHEN profile.is_default AND profile.current_version=computer.active_version THEN computer.active_version ELSE NULL END AS active_version,version.document
        FROM cloud_computers computer JOIN environment_profiles profile ON profile.id=computer.profile_id
        LEFT JOIN cloud_computer_images image ON image.id=computer.active_image_id
        JOIN environment_profile_versions version ON version.profile_id=computer.profile_id AND version.version=computer.draft_version WHERE computer.org_id=$1`,
          [organizationId],
        )
      ).rows[0];
      const history = (
        await tx.query<{
          id: string;
          version: string;
          state: string;
          cleanup_state: string;
          repository_owner: string;
          repository_name: string;
          created_at: Date;
          completed_at: Date | null;
          error_code: string | null;
          artifact: ComputerImage | null;
        }>(
          `SELECT build.*,to_jsonb(image) AS artifact FROM cloud_computer_builds build
           LEFT JOIN cloud_computer_images image ON image.id=build.id
           WHERE build.org_id=$1 ORDER BY build.created_at DESC,build.id DESC LIMIT 30`,
          [organizationId],
        )
      ).rows;
      return {
        revision: Number(row?.revision ?? 0),
        draftVersion: Number(row?.draft_version ?? 0),
        activeVersion: row?.active_version ? Number(row.active_version) : null,
        imageBuilds: true,
        activeArtifactId: row?.active_version ? row.active_image_id : null,
        previousArtifactId: row?.previous_image_id ?? null,
        activeArtifact: row?.active_version && row.active_image_ref ? { imageRef: row.active_image_ref, createdAt: iso(row.active_image_created_at) } : null,
        document: row ? cloudComputerRecipe(row.document) : empty,
        canManage: ["owner", "admin"].includes(member.role),
        configured:
          this.config.provider === "boat" &&
          Boolean(this.config.setupExecution) &&
          this.config.backgroundWorkersEnabled !== false,
        resources: {
          cpuMillicores: this.config.cpuMillicores,
          memoryMiB: this.config.memoryMiB,
          storageMiB: this.config.storageMiB,
        },
        history: history.map((build) => ({
          id: build.id,
          version: Number(build.version),
          state: build.state,
          cleanupState: build.cleanup_state,
          repository: `${build.repository_owner}/${build.repository_name}`,
          createdAt: iso(build.created_at),
          completedAt: iso(build.completed_at),
          errorCode: build.error_code,
          artifact: build.artifact ? {
            id: build.artifact.id, state: build.artifact.state, snapshotId: build.artifact.snapshot_id,
            imageRef: build.artifact.image_ref, buildSha256: build.artifact.build_sha256,
            baseImageRef: build.artifact.base_image_ref, sourceContract: build.artifact.source_contract,
            createdAt: iso(build.artifact.created_at), attestedAt: iso(build.artifact.attested_at),
          } : null,
        })),
      };
    });
  }
  async save(organizationId: string, userId: string, value: unknown) {
    const parsed = z
      .object({
        expectedRevision: z.number().int().nonnegative(),
        operationId: z.string().uuid(),
        document: CloudComputerDocumentSchema,
        sources: z
          .array(
            z
              .object({
                repositoryId: z.string(),
                installationId: z.string().uuid(),
              })
              .strict(),
          )
          .max(20),
      })
      .strict()
      .safeParse(value);
    if (!parsed.success)
      throw new HttpError(
        422,
        "invalid_input",
        "Invalid Cloud Computer configuration.",
      );
    const input = parsed.data,
      hash = digest({ document: input.document });
    return withSystemTx(this.pool, async (tx) => {
      await authority(tx, organizationId, userId, true);
      await lock(tx, organizationId);
      const current = (
        await tx.query<{
          profile_id: string;
          revision: string;
          draft_version: string;
          operation_id: string;
          request_sha256: Buffer;
        }>("SELECT * FROM cloud_computers WHERE org_id=$1 FOR UPDATE", [
          organizationId,
        ])
      ).rows[0];
      if (current?.operation_id === input.operationId) {
        if (!current.request_sha256.equals(hash)) conflict();
        return {
          revision: Number(current.revision),
          version: Number(current.draft_version),
        };
      }
      if (Number(current?.revision ?? 0) !== input.expectedRevision) conflict();
      // Revalidate every selected repository using the saving person's private,
      // short-lived GitHub proof. Another administrator's App is not authority.
      for (const repository of input.document.repositories) {
        const source = input.sources.find(
          (source) => source.repositoryId === repository.id,
        );
        if (!source)
          throw new HttpError(
            409,
            "github_cloud_source_authorization_required",
            "Refresh access to the selected repositories before saving.",
          );
        await assertCloudGithubSource(tx, {
          organizationId,
          actorUserId: userId,
          installationRecordId: source.installationId,
          repositoryOwner: repository.owner,
          repositoryName: repository.name,
          forgeRepositoryId: repository.id,
        });
      }
      const profileId = current?.profile_id ?? randomUUID(),
        version = Number(current?.draft_version ?? 0) + 1;
      if (!current)
        await tx.query(
          `INSERT INTO environment_profiles(id,org_id,owner_kind,name,placement,is_default,current_version)
        VALUES($1,$2,'organization',$3,'cloud',false,1)`,
          [
            profileId,
            organizationId,
            `Cloud Computer ${profileId.slice(0, 8)}`,
          ],
        );
      await tx.query(
        "INSERT INTO environment_profile_versions(profile_id,org_id,version,document,created_by) VALUES($1,$2,$3,$4::jsonb,$5)",
        [
          profileId,
          organizationId,
          version,
          JSON.stringify(profileDocument(input.document)),
          userId,
        ],
      );
      await tx.query(
        `INSERT INTO cloud_computers(org_id,profile_id,draft_version,operation_id,request_sha256) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(org_id) DO UPDATE SET draft_version=EXCLUDED.draft_version,operation_id=EXCLUDED.operation_id,request_sha256=EXCLUDED.request_sha256,revision=cloud_computers.revision+1,updated_at=now()`,
        [organizationId, profileId, version, input.operationId, hash],
      );
      await tx.query(
        "INSERT INTO audit_log(org_id,actor_id,action,subject) VALUES($1,$2,'cloud_computer.saved',$3::jsonb)",
        [organizationId, userId, JSON.stringify({ profileId, version })],
      );
      return { revision: input.expectedRevision + 1, version };
    });
  }
  async activate(
    organizationId: string,
    userId: string,
    expectedRevision: number,
    version: number,
    artifactId?: string,
    rollback = false,
  ) {
    return withSystemTx(this.pool, async (tx) => {
      await authority(tx, organizationId, userId, true);
      await lock(tx, organizationId);
      const current = (
        await tx.query<{ revision: string; active_version: string | null; active_image_id: string | null; previous_image_id: string | null }>(
          "SELECT revision,active_version,active_image_id,previous_image_id FROM cloud_computers WHERE org_id=$1 FOR UPDATE",
          [organizationId],
        )
      ).rows[0];
      if (!current)
        throw new HttpError(
          404,
          "not_found",
          "Cloud Computer is not configured.",
        );
      if (
        Number(current.revision) === expectedRevision + 1 &&
        Number(current.active_version) === version && artifactId && current.active_image_id === artifactId
      )
        return { activated: true };
      if (Number(current.revision) !== expectedRevision) conflict();
      const image = (await tx.query<ComputerImage>(`SELECT image.* FROM cloud_computer_images image
        JOIN cloud_computer_builds build ON build.id=image.id WHERE image.org_id=$1 AND build.version=$2
        AND build.state='succeeded' AND image.state='attested' AND image.id=$3 FOR UPDATE OF image`,
        [organizationId, version, artifactId ?? null])).rows[0];
      if (!image)
        throw new HttpError(
          409,
          "cloud_computer_not_built",
          "Build this version successfully before activating it.",
        );
      if (rollback && current.previous_image_id !== artifactId) conflict();
      if (image.base_image_ref !== cloudWorkspaceProvisioningProfile(this.config, "boat").imageRef)
        throw new HttpError(409, "cloud_computer_base_changed", "Rebuild this recipe for the current base image.");
      await assertComputerImageQualified(tx, image);
      await activate(tx, organizationId, version, image.id);
      await tx.query(
        "INSERT INTO audit_log(org_id,actor_id,action,subject) VALUES($1,$2,'cloud_computer.activated',$3::jsonb)",
        [organizationId, userId, JSON.stringify({ version, artifactId: image.id, rollback })],
      );
      return { activated: true };
    });
  }
  async rollback(organizationId: string, userId: string, expectedRevision: number, artifactId: string) {
    const version = await withSystemTx(this.pool, async tx => {
      await authority(tx, organizationId, userId, true);
      return (await tx.query<{ version: string }>("SELECT version FROM cloud_computer_builds WHERE id=$1 AND org_id=$2", [artifactId, organizationId])).rows[0]?.version;
    });
    if (!version) conflict();
    return this.activate(organizationId, userId, expectedRevision, Number(version), artifactId, true);
  }
  async build(organizationId: string, userId: string, value: unknown) {
    const parsed = z.object({ id: z.string().uuid(), expectedRevision: z.number().int().positive(), version: z.number().int().positive() }).strict().safeParse(value);
    if (!parsed.success) throw new HttpError(422, "invalid_input", "Invalid Cloud Computer build.");
    if (this.config.provider !== "boat" || !this.config.boat || !this.config.setupExecution || this.config.backgroundWorkersEnabled === false)
      throw new HttpError(409, "cloud_computer_build_unavailable", "Image building is unavailable in this environment.");
    const input = parsed.data, driver = this.imageDriver ?? createComputerImageDriver(this.config);
    return withSystemTx(this.pool, async tx => {
      // Match paid-work admission's organization-first lock order.
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [organizationId]);
      await authority(tx, organizationId, userId, true);
      const team = (await tx.query<{ id: string }>(`SELECT team.id FROM teams team JOIN team_members member
        ON member.team_id=team.id AND member.org_id=team.org_id AND member.user_id=$2
        WHERE team.org_id=$1 AND team.deleted_at IS NULL ORDER BY team.is_default DESC,team.id LIMIT 1`, [organizationId, userId])).rows[0];
      if (!team) throw new HttpError(404, "team_not_found", "Authorized cloud workspace team not found.");
      await authorizeCloudWorkspaceOperation(tx, { organizationId, teamId: team.id, actorUserId: userId,
        billingOwnerUserId: userId, workosEnabled: this.workosEnabled, requireWorkspaceOwner: true });
      await lock(tx, organizationId);
      const current = (await tx.query<{ profile_id: string; revision: string; draft_version: string; document: unknown }>(
        `SELECT computer.*,version.document FROM cloud_computers computer JOIN environment_profile_versions version
         ON version.profile_id=computer.profile_id AND version.version=computer.draft_version WHERE computer.org_id=$1 FOR UPDATE OF computer`, [organizationId])).rows[0];
      const previous = (await tx.query<{ org_id: string; version: string }>("SELECT org_id,version FROM cloud_computer_builds WHERE id=$1", [input.id])).rows[0];
      if (previous) {
        if (previous.org_id !== organizationId || Number(previous.version) !== input.version) conflict();
        return { id: input.id };
      }
      if (!current || Number(current.revision) !== input.expectedRevision || Number(current.draft_version) !== input.version) conflict();
      if ((await tx.query("SELECT 1 FROM cloud_computer_builds WHERE org_id=$1 AND state='building'", [organizationId])).rowCount)
        throw new HttpError(409, "cloud_computer_build_active", "A Cloud Computer build is already running.");
      const profile = cloudWorkspaceProvisioningProfile(this.config, "boat");
      if (!profile.sourceCommit) throw new HttpError(409, "cloud_computer_build_unavailable", "The base image has no pinned source contract.");
      if (!(await tx.query("SELECT 1 FROM cloud_agent_runtime_qualifications WHERE provider='boat' AND image_ref=$1 AND enabled LIMIT 1", [profile.imageRef])).rowCount)
        throw new HttpError(409, "cloud_computer_qualification_required", "Qualify the base image before building a Cloud Computer.");
      await protectComputerImageBases(tx, this.config.boat!.accountScope, [profile.imageRef]);
      await reserveComputerImageSlot(tx, this.config.boat!.accountScope, driver);
      await tx.query(`INSERT INTO cloud_computer_builds(id,org_id,profile_id,version,requested_by,repository_owner,repository_name)
        VALUES($1,$2,$3,$4,$5,'','')`, [input.id, organizationId, current.profile_id, input.version, userId]);
      await tx.query(`INSERT INTO cloud_computer_images(id,org_id,account_scope,snapshot_name,base_image_ref,base_source_commit,recipe_sha256,profile)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [input.id, organizationId, this.config.boat!.accountScope,
        `zeros-org-${input.id.replaceAll("-", "")}`, profile.imageRef, profile.sourceCommit, digest(cloudComputerRecipe(current.document)).toString("hex"), profile]);
      return { id: input.id };
    });
  }
  async logs(organizationId: string, userId: string, buildId: string) {
    return withSystemTx(this.pool, async (tx) => {
      await authority(tx, organizationId, userId, true);
      const row = (
        await tx.query<{ log: string }>(
          `SELECT coalesce(run.log_excerpt,build.log_excerpt) AS log FROM cloud_computer_builds build
        LEFT JOIN LATERAL (SELECT log_excerpt FROM cloud_workspace_setup_runs WHERE workspace_id=build.workspace_id ORDER BY attempt DESC LIMIT 1) run ON true
        WHERE build.org_id=$1 AND build.id=$2`,
          [organizationId, buildId],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "not_found", "Build not found.");
      return { log: sanitizeCloudWorkspaceSetupLog(row.log) };
    });
  }
  async cancel(organizationId: string, userId: string, buildId: string) {
    return withSystemTx(this.pool, async (tx) => {
      await authority(tx, organizationId, userId, true);
      await lock(tx, organizationId);
      const row = await tx.query(
        "UPDATE cloud_computer_builds SET state='cancelled',completed_at=now() WHERE org_id=$1 AND id=$2 AND state='building' RETURNING id",
        [organizationId, buildId],
      );
      return { cancelled: Boolean(row.rowCount) };
    });
  }
}

/** Called within ordinary workspace create admission, after its organization
 * lock. Builds use exactly the same compute sponsorship and setup isolation. */
export async function authorizeCloudComputerBuild(
  tx: Tx,
  input: {
    organizationId: string;
    actorUserId: string;
    version: number;
    repositoryOwner: string;
    repositoryName: string;
  },
) {
  await authority(tx, input.organizationId, input.actorUserId, true);
  const row = (
    await tx.query<{
      profile_id: string;
      draft_version: string;
      document: unknown;
    }>(
      `SELECT computer.profile_id,computer.draft_version,version.document FROM cloud_computers computer
    JOIN environment_profile_versions version ON version.profile_id=computer.profile_id AND version.version=$2
    WHERE computer.org_id=$1 FOR UPDATE OF computer`,
      [input.organizationId, input.version],
    )
  ).rows[0];
  if (!row || Number(row.draft_version) !== input.version) conflict();
  if (
    !cloudComputerRecipe(row.document).repositories.some(
      (repo) =>
        repo.owner.toLowerCase() === input.repositoryOwner.toLowerCase() &&
        repo.name.toLowerCase() === input.repositoryName.toLowerCase(),
    )
  )
    throw new HttpError(
      409,
      "cloud_computer_repository_required",
      "Choose a repository from this Cloud Computer configuration.",
    );
  if (
    (
      await tx.query(
        "SELECT 1 FROM cloud_computer_builds WHERE org_id=$1 AND state='building'",
        [input.organizationId],
      )
    ).rowCount
  )
    throw new HttpError(
      409,
      "cloud_computer_build_active",
      "A Cloud Computer build is already running.",
    );
  return { id: row.profile_id, version: input.version };
}

/** This worker only retires explicitly-created disposable build workspaces.
 * All provider deletion stays in the existing receipt-verified reconciler. */
export class CloudComputerBuildWorker {
  constructor(
    private readonly pool: pg.Pool,
    private readonly batchSize = 32,
    private readonly imageWorker?: ComputerImageWorker,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32)
      throw new Error("Invalid Cloud Computer reconciliation batch size");
  }
  async tick(): Promise<void> {
    await this.imageWorker?.tick();
    const candidates = await withSystemTx(this.pool, (tx) =>
      tx.query<{ id: string; org_id: string; workspace_id: string | null }>(
        // Claim fairly before provider/lifecycle reconciliation. Slow or failed
        // builds must not keep newer organizations outside the bounded batch.
        `WITH candidates AS (SELECT id FROM cloud_computer_builds
          WHERE (state='building' OR cleanup_state<>'complete')
            AND NOT EXISTS(SELECT 1 FROM cloud_computer_images image WHERE image.id=cloud_computer_builds.id)
          ORDER BY last_checked_at,id LIMIT $1 FOR UPDATE SKIP LOCKED)
          UPDATE cloud_computer_builds build SET last_checked_at=clock_timestamp()
          FROM candidates WHERE build.id=candidates.id RETURNING build.id,build.org_id,build.workspace_id`,
        [this.batchSize],
      ),
    );
    for (const candidate of candidates.rows) {
      try {
        await withSystemTx(this.pool, async (tx) => {
          // Match the normal lifecycle lock order: organization, workspace, then recipe/build.
          await tx.query(
            "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
            [candidate.org_id],
          );
          const workspace = candidate.workspace_id
            ? (
                await tx.query<{
                  status: string;
                  desired_state: string;
                  current_generation: number;
                  owner_user_id: string;
                }>(
                  "SELECT status,desired_state,current_generation,owner_user_id FROM cloud_workspaces WHERE id=$1 FOR UPDATE",
                  [candidate.workspace_id],
                )
              ).rows[0]
            : null;
          await lock(tx, candidate.org_id);
          const build = (
            await tx.query<{
              state: string;
              cleanup_state: string;
              version: string;
              requested_by: string | null;
              expired: boolean;
            }>(
              "SELECT *,deadline_at<=clock_timestamp() AS expired FROM cloud_computer_builds WHERE id=$1 FOR UPDATE",
              [candidate.id],
            )
          ).rows[0];
          if (!build) return;
          if (build.state === "building") {
            const ready = workspace?.status === "ready",
              failed =
                !workspace ||
                [
                  "failed",
                  "deleted",
                  "deleting",
                  "archived",
                  "stopped",
                ].includes(workspace.status) ||
                workspace.desired_state !== "running" ||
                build.expired;
            if (!ready && !failed) return;
            const run = (
              await tx.query<{
                log_excerpt: string;
                error_code: string | null;
              }>(
                "SELECT log_excerpt,error_code FROM cloud_workspace_setup_runs WHERE workspace_id=$1 ORDER BY attempt DESC LIMIT 1",
                [candidate.workspace_id],
              )
            ).rows[0];
            // Legacy workspace-based builds cannot certify a reusable image.
            const succeeded = false;
            await tx.query(
              "UPDATE cloud_computer_builds SET state=$2,completed_at=now(),log_excerpt=$3,error_code=$4 WHERE id=$1",
              [
                candidate.id,
                succeeded ? "succeeded" : "failed",
                sanitizeCloudWorkspaceSetupLog(run?.log_excerpt ?? ""),
                succeeded
                  ? null
                  : build.expired
                    ? "build_timed_out"
                    : (run?.error_code ?? "image_build_required"),
              ],
            );
            // Completion is evidence, not a new activation authorization. The user
            // explicitly activates a successful version with fresh admin authority.
          }
          if (!workspace || workspace.status === "deleted") {
            await tx.query(
              "UPDATE cloud_computer_builds SET cleanup_state='complete' WHERE id=$1",
              [candidate.id],
            );
            return;
          }
          if (workspace.desired_state === "deleted") {
            await tx.query(
              "UPDATE cloud_computer_builds SET cleanup_state='requested' WHERE id=$1",
              [candidate.id],
            );
            return;
          }
          await tx.query(
            "UPDATE cloud_workspace_lifecycle_intents SET state='superseded',completed_at=now(),updated_at=now() WHERE workspace_id=$1 AND affects_workspace AND state IN ('queued','observing')",
            [candidate.workspace_id],
          );
          const intentId = randomUUID();
          await tx.query(
            `INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256)
        VALUES($1,$2,$3,$4,$5,'delete',$6,$7)`,
            [
              intentId,
              candidate.workspace_id,
              workspace.current_generation,
              candidate.org_id,
              workspace.owner_user_id,
              `computer-build.${candidate.id}.delete`,
              digest({ build: candidate.id, operation: "delete" }),
            ],
          );
          await retireCloudWorkspaceRuntimeAccess(tx, {
            workspaceId: candidate.workspace_id!,
            organizationId: candidate.org_id,
            reason: "workspace_delete_requested",
          });
          await ensureWorkspaceDeletionJob(tx, {
            workspaceId: candidate.workspace_id!,
            organizationId: candidate.org_id,
            requestedBy: workspace.owner_user_id,
            lifecycleIntentId: intentId,
          });
          await tx.query(
            "UPDATE cloud_workspaces SET status='deleting',desired_state='deleted',version=version+1,authority_epoch=authority_epoch+1,updated_at=now() WHERE id=$1",
            [candidate.workspace_id],
          );
          await tx.query(
            "UPDATE cloud_computer_builds SET cleanup_state='requested' WHERE id=$1",
            [candidate.id],
          );
        });
      } catch {
        // The claim timestamp is already committed. Retry this build later,
        // but continue retiring the other organizations in this batch.
        console.warn("[cloud-computer] build reconciliation failed");
      }
    }
  }
  start(): () => Promise<void> {
    let stopping = false,
      pending: Promise<void> | null = null;
    const tick = () => {
      if (stopping || pending) return;
      pending = this.tick()
        .catch(() => {
          console.warn("[cloud-computer] build reconciliation failed");
        })
        .finally(() => {
          pending = null;
        });
    };
    const timer = setInterval(tick, 5000);
    timer.unref();
    tick();
    return async () => {
      stopping = true;
      clearInterval(timer);
      await pending;
    };
  }
}

export function createCloudComputerBuildWorker(pool: pg.Pool, config: CloudWorkspaceBackendConfig) {
  return new CloudComputerBuildWorker(pool, 32, config.provider === "boat" && config.boat
    ? new ComputerImageWorker(pool, config.boat.accountScope, createComputerImageDriver(config), [cloudWorkspaceProvisioningProfile(config, "boat").imageRef]) : undefined);
}
