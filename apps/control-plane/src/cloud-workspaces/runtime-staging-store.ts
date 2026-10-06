import { createHash } from "node:crypto";
import type pg from "pg";
import { withSystemTx } from "../db.js";
import { CloudActiveRuntimeSchema, RuntimeDescriptorSchema, type CloudActiveRuntime, type RuntimeDescriptor } from "./runtime-contract.js";
import type { CloudRuntimeQualificationMode } from "./runtime-config.js";
import { lockCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import { loadGenerationSource } from "./generation-pins.js";
import { cloudRuntimePin, loadPinnedCloudRuntime, type CloudRuntimePinRow } from "./runtime-selection.js";
import { readCloudWorkspaceCredentialKinds, selectCloudWorkspaceRuntimeUpgrade } from "./runtime-upgrade-availability.js";
import type { DatabaseCloudRuntimeTransitionService, CloudRuntimeTransitionClaim } from "./runtime-transfer.js";
import type { RuntimeUpdateInput } from "./runtime-update-runner.js";

export type RuntimeStagePlan = {
  resourceId: string; phase: "offered" | "staged"; objectKey: string; deadline: number;
  input: Omit<Extract<RuntimeUpdateInput, { operation: "stage" }>, "install">;
  target: RuntimeDescriptor;
};
export type RuntimeStagingStore = {
  discover(cursor: string | null, limit: number): Promise<{
    items: Array<Parameters<DatabaseCloudRuntimeTransitionService["offer"]>[0]>; cursor: string | null;
  }>;
  pending(cursor: string | null, limit: number): Promise<{
    items: Array<Pick<CloudRuntimeTransitionClaim, "workspaceId" | "organizationId" | "transitionId">>; cursor: string | null;
  }>;
  read(claim: CloudRuntimeTransitionClaim): Promise<RuntimeStagePlan | null>;
};

type Offer = Parameters<DatabaseCloudRuntimeTransitionService["offer"]>[0];
function operationId(source: Omit<Offer, "operationId" | "mode">, runtimeId: string, previous: string | null): string {
  const bytes = createHash("sha256").update(JSON.stringify(["zeros.runtime-stage/v1", source.organizationId,
    source.workspaceId, source.generation, source.sourceEngineInstanceId, runtimeId, previous])).digest();
  bytes[6] = (bytes[6]! & 15) | 0x50; bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function pageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) throw new Error("Invalid staging page size");
  return value;
}

/** Read-only discovery and final eligibility checks. Selection uses RU/HU's
 * qualification selector; mutations stay in HU's common-lock transition API.
 * Nothing here gates on client presence, PTYs, turns or idle time. */
export class DatabaseRuntimeStagingStore implements RuntimeStagingStore {
  constructor(private readonly options: { pool: pg.Pool; qualificationMode: CloudRuntimeQualificationMode; workosEnabled: boolean }) {}

  discover(cursor: string | null, limit: number): ReturnType<RuntimeStagingStore["discover"]> {
    return withSystemTx(this.options.pool, async tx => {
      const rows = (await tx.query<CloudRuntimePinRow & Omit<Offer, "operationId" | "mode">>(`SELECT
        workspace.id AS "workspaceId",workspace.org_id AS "organizationId",workspace.current_generation AS generation,
        engine.id AS "sourceEngineInstanceId",generation.runtime_id,generation.runtime_manifest_sha256,
        generation.runtime_base_image_id,generation.runtime_base_compatibility_id,generation.runtime_profile,generation.runtime_engine_protocol_version
        FROM cloud_workspaces workspace JOIN users account ON account.id=workspace.owner_user_id
        JOIN cloud_workspace_generations generation ON generation.workspace_id=workspace.id AND generation.org_id=workspace.org_id
          AND generation.generation=workspace.current_generation
        JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=workspace.id AND binding.org_id=workspace.org_id
          AND binding.generation=workspace.current_generation
        JOIN provider_connections connection ON connection.id=generation.provider_connection_id AND connection.org_id=workspace.org_id
        JOIN provider_connection_versions version ON version.connection_id=connection.id AND version.org_id=connection.org_id
          AND version.version=generation.provider_connection_version
        JOIN LATERAL (SELECT id FROM cloud_workspace_engine_instances instance
          WHERE instance.workspace_id=workspace.id AND instance.org_id=workspace.org_id AND instance.generation=workspace.current_generation
            AND instance.state='ready' AND instance.lease_expires_at>clock_timestamp()
          ORDER BY instance.registered_at DESC,instance.id LIMIT 1) engine ON true
        WHERE ($1::uuid IS NULL OR workspace.id>$1) AND workspace.deleted_at IS NULL
          AND workspace.desired_state='running' AND workspace.status IN ('ready','busy')
          AND account.staff_role IN ('platform_owner','developer') AND generation.provider='boat'
          AND generation.runtime_id IS NOT NULL AND binding.observed_state='running' AND binding.provider_resource_id IS NOT NULL
          AND connection.state='active' AND version.credential_source='hosted' AND version.retired_at IS NULL
          AND cloud_workspace_runtime_authority_live(workspace.id,workspace.current_generation,workspace.owner_user_id,$3)
        ORDER BY workspace.id LIMIT $2`, [cursor, pageLimit(limit), this.options.workosEnabled])).rows;
      const items: Offer[] = [];
      for (const row of rows) {
        const scope = { workspaceId: row.workspaceId, organizationId: row.organizationId, generation: row.generation,
          sourceEngineInstanceId: row.sourceEngineInstanceId };
        const selection = await selectCloudWorkspaceRuntimeUpgrade(tx, { ...scope, runtime: cloudRuntimePin(row),
          qualificationMode: this.options.qualificationMode });
        if (!selection.updateAvailable || !selection.selected) continue;
        // A long-running turn may outlive HU's offer deadline. Recover under
        // a fresh durable operation identity, but never create a tight loop of
        // cancelled generations after a staging failure or controller restart.
        const previous = (await tx.query<{ transition_id: string; waiting: boolean }>(`SELECT transition_id,
          stage_deadline_at>clock_timestamp() AS waiting FROM cloud_workspace_runtime_transitions
          WHERE workspace_id=$1 AND org_id=$2 AND source_engine_instance_id=$3 AND mode='engine'
            AND target_descriptor->>'runtimeId'=$4 AND phase='cancelled'
          ORDER BY created_at DESC,transition_id DESC LIMIT 1`,
        [scope.workspaceId, scope.organizationId, scope.sourceEngineInstanceId, selection.selected.pin.runtimeId])).rows[0];
        if (previous?.waiting) continue;
        items.push({ ...scope, mode: "engine",
          operationId: operationId(scope, selection.selected.pin.runtimeId, previous?.transition_id ?? null) });
      }
      return { items, cursor: rows.length === limit ? rows.at(-1)!.workspaceId : null };
    });
  }

  pending(cursor: string | null, limit: number): ReturnType<RuntimeStagingStore["pending"]> {
    return withSystemTx(this.options.pool, async tx => {
      const items = (await tx.query<{ workspaceId: string; organizationId: string; transitionId: string }>(`SELECT
        workspace_id AS "workspaceId",org_id AS "organizationId",transition_id AS "transitionId"
        FROM cloud_workspace_runtime_transitions WHERE phase IN ('offered','staged')
          AND ($1::uuid IS NULL OR transition_id>$1) AND (worker_id IS NULL OR worker_expires_at<=clock_timestamp())
        ORDER BY transition_id LIMIT $2`, [cursor, pageLimit(limit)])).rows;
      return { items, cursor: items.length === limit ? items.at(-1)!.transitionId : null };
    });
  }

  read(claim: CloudRuntimeTransitionClaim): Promise<RuntimeStagePlan | null> {
    return withSystemTx(this.options.pool, async tx => {
      await lockCloudWorkspaceGenerationTransition(tx, claim);
      const row = (await tx.query<{ source_generation: number; candidate_generation: number; source_engine_instance_id: string;
        source_active: CloudActiveRuntime; target_descriptor: RuntimeDescriptor; provider_resource_id: string;
        phase: "offered" | "staged"; mode: "engine" | "bootstrap"; stage_deadline_at: Date }>(`SELECT runtime.*,
          transition.source_generation,transition.candidate_generation
        FROM cloud_workspace_runtime_transitions runtime
        JOIN cloud_workspace_generation_transitions transition ON transition.id=runtime.transition_id
        JOIN cloud_workspaces workspace ON workspace.id=runtime.workspace_id AND workspace.org_id=runtime.org_id
        JOIN users account ON account.id=workspace.owner_user_id
        JOIN cloud_workspace_engine_instances engine ON engine.id=runtime.source_engine_instance_id
          AND engine.workspace_id=workspace.id AND engine.org_id=workspace.org_id AND engine.generation=transition.source_generation
        JOIN cloud_workspace_provider_bindings binding ON binding.workspace_id=workspace.id AND binding.org_id=workspace.org_id
          AND binding.generation=transition.source_generation
        JOIN cloud_workspace_generations generation ON generation.workspace_id=workspace.id AND generation.org_id=workspace.org_id
          AND generation.generation=transition.source_generation
        JOIN provider_connections connection ON connection.id=generation.provider_connection_id AND connection.org_id=workspace.org_id
        JOIN provider_connection_versions version ON version.connection_id=connection.id AND version.org_id=connection.org_id
          AND version.version=generation.provider_connection_version
        WHERE runtime.transition_id=$1 AND runtime.workspace_id=$2 AND runtime.org_id=$3
          AND runtime.worker_id=$4 AND runtime.worker_fence=$5 AND runtime.execution_fence=$6
          AND runtime.worker_expires_at>clock_timestamp() AND runtime.stage_deadline_at>clock_timestamp()
          AND runtime.phase IN ('offered','staged') AND transition.execution_mode='retain_allocation' AND transition.state='draining'
          AND workspace.current_generation=transition.source_generation AND workspace.status IN ('ready','busy')
          AND workspace.desired_state='running' AND workspace.deleted_at IS NULL AND account.staff_role IN ('platform_owner','developer')
          AND engine.state='ready' AND engine.lease_expires_at>clock_timestamp()
          AND binding.provider_resource_id=runtime.provider_resource_id AND binding.observed_state='running'
          AND generation.provider='boat' AND connection.state='active' AND version.credential_source='hosted' AND version.retired_at IS NULL
          AND cloud_workspace_runtime_authority_live(workspace.id,workspace.current_generation,workspace.owner_user_id,$7)
          AND NOT EXISTS(SELECT 1 FROM cloud_workspace_lifecycle_intents intent WHERE intent.workspace_id=workspace.id
            AND intent.state IN ('queued','dispatching','observing'))`,
      [claim.transitionId, claim.workspaceId, claim.organizationId, claim.workerId, claim.workerFence, claim.executionFence, this.options.workosEnabled])).rows[0];
      if (!row) return null;
      const source = await loadGenerationSource(tx, { ...claim, generation: row.source_generation });
      const target = await loadGenerationSource(tx, { ...claim, generation: row.candidate_generation });
      const kinds = await readCloudWorkspaceCredentialKinds(tx, claim);
      if (!source.runtime || !target.runtime || !await loadPinnedCloudRuntime(tx, source.runtime, this.options.qualificationMode, kinds)) return null;
      const selection = await selectCloudWorkspaceRuntimeUpgrade(tx, { ...claim, runtime: source.runtime, qualificationMode: this.options.qualificationMode });
      if (!selection.updateAvailable || !selection.selected || selection.selected.pin.runtimeId !== target.runtime.runtimeId) return null;
      const descriptor = RuntimeDescriptorSchema.parse(row.target_descriptor);
      const active = CloudActiveRuntimeSchema.parse(row.source_active);
      if (Object.entries(descriptor).some(([key, value]) => selection.selected!.descriptor[key as keyof RuntimeDescriptor] !== value) ||
        active.runtimeId !== source.runtime.runtimeId || active.manifestSha256 !== source.runtime.manifestSha256 ||
        active.baseCompatibilityId !== source.runtime.baseCompatibilityId) return null;
      return { resourceId: row.provider_resource_id, phase: row.phase, objectKey: selection.selected.objectKey,
        deadline: row.stage_deadline_at.getTime(), target: descriptor,
        input: { schema: "zeros.runtime-update/v1", operation: "stage", transitionId: claim.transitionId, fence: claim.executionFence,
          scope: { workspaceId: claim.workspaceId, organizationId: claim.organizationId, sourceGeneration: row.source_generation,
            candidateGeneration: row.candidate_generation, sourceEngineInstanceId: row.source_engine_instance_id },
          mode: row.mode, expiresAt: row.stage_deadline_at.toISOString(), source: active } };
    });
  }
}
