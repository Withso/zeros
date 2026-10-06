import type { Tx } from "../db.js";
import { cloudWorkspaceHasActiveWork } from "./idle-workloads.js";
import { publicCloudError } from "./public-contract.js";
import type { CloudRuntimeQualificationMode } from "./runtime-config.js";
import { selectCloudRuntime, type CloudRuntimePin } from "./runtime-selection.js";
import { CloudRuntimeUpgradeAvailabilitySchema, type CloudRuntimeUpgradeAvailability } from "./runtime-upgrade-contract.js";

/** No provider calls, lifecycle writes, or qualification changes. POST remains
 * authoritative for funding, quota, checkpoint freshness and admission races. */
export async function readCloudRuntimeUpgradeAvailability(tx: Tx, input: {
  workspaceId: string;
  organizationId: string;
  generation: number;
  status: string;
  desiredState: string;
  deleted: boolean;
  runtime: CloudRuntimePin | null;
  qualificationMode: CloudRuntimeQualificationMode;
}): Promise<CloudRuntimeUpgradeAvailability> {
  const kinds = (await tx.query<{ kind: string }>(`SELECT DISTINCT credential.kind
    FROM cloud_agent_credential_delegations delegation
    JOIN cloud_agent_credentials credential ON credential.id=delegation.credential_id
      AND credential.revision=delegation.credential_revision
    WHERE delegation.workspace_id=$1 AND delegation.org_id=$2
      AND delegation.revoked_at IS NULL AND delegation.expires_at>clock_timestamp()
      AND credential.revoked_at IS NULL`, [input.workspaceId, input.organizationId])).rows.map(row => row.kind);
  const selected = input.runtime
    ? await selectCloudRuntime(tx, input.qualificationMode, input.runtime.baseImageId) : null;
  const qualified = kinds.length && input.runtime
    ? await selectCloudRuntime(tx, input.qualificationMode, input.runtime.baseImageId, kinds) : selected;
  const sourceOrder = input.runtime ? (await tx.query<{ release_order: string | null }>(
    `SELECT max(release_order)::text AS release_order FROM cloud_runtime_channel_releases
     WHERE channel='alpha' AND runtime_id=$1 AND confirmed_at IS NOT NULL`, [input.runtime.runtimeId])).rows[0]!.release_order : null;
  const compatible = !!qualified && !!input.runtime && qualified.pin.baseCompatibilityId === input.runtime.baseCompatibilityId;
  const newer = compatible && sourceOrder !== null && qualified!.releaseOrder > BigInt(sourceOrder);
  // Never offer a target different from the unchanged POST selector. A release
  // missing an API-key qualification cannot silently strand that delegation.
  const updateAvailable = !!(newer && qualified!.pin.runtimeId === selected?.pin.runtimeId);
  const activity = (await tx.query<{ transition_active: boolean; lifecycle_active: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM cloud_workspace_generation_transitions WHERE workspace_id=$1 AND org_id=$2
      AND state IN ('draining','provisioning','setting_up','rolling_back')) AS transition_active,
    EXISTS(SELECT 1 FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND org_id=$2
      AND affects_workspace AND state IN ('queued','dispatching','observing')) AS lifecycle_active`,
  [input.workspaceId, input.organizationId])).rows[0]!;
  const latest = (await tx.query<{ id: string; generation: number; runtime_id: string;
    state: string; error_code: string | null }>(`SELECT transition.id,transition.candidate_generation AS generation,
      candidate.runtime_id,transition.state,transition.error_code
    FROM cloud_workspace_generation_transitions transition
    JOIN cloud_workspace_lifecycle_intents intent ON intent.id=transition.drain_intent_id
      AND intent.idempotency_key LIKE 'runtime-upgrade:%'
    JOIN cloud_workspace_generations candidate ON candidate.workspace_id=transition.workspace_id
      AND candidate.org_id=transition.org_id AND candidate.generation=transition.candidate_generation
    WHERE transition.workspace_id=$1 AND transition.org_id=$2
    ORDER BY transition.candidate_generation DESC LIMIT 1`, [input.workspaceId, input.organizationId])).rows[0];
  const stable = input.status === "ready" && input.desiredState === "running" ||
    ["stopped", "archived", "failed"].includes(input.status) && input.desiredState !== "deleted";
  const unavailableReason = !input.runtime ? "cloud_runtime_upgrade_not_supported"
    : activity.transition_active ? "cloud_generation_transition_active"
    : activity.lifecycle_active ? "cloud_workspace_lifecycle_active"
    : input.deleted || !stable && input.status !== "busy" ? "cloud_workspace_not_stable"
    : input.status === "busy" || await cloudWorkspaceHasActiveWork(tx, input) ? "cloud_workspace_busy"
    : !compatible || !selected || qualified?.pin.runtimeId !== selected.pin.runtimeId ||
      sourceOrder === null || qualified!.releaseOrder < BigInt(sourceOrder) ? "cloud_runtime_unavailable" : null;
  return CloudRuntimeUpgradeAvailabilitySchema.parse({
    organizationId: input.organizationId, workspaceId: input.workspaceId, generation: input.generation,
    currentRuntimeId: input.runtime?.runtimeId ?? null, latestRuntimeId: compatible ? qualified!.pin.runtimeId : null,
    updateAvailable, unavailableReason,
    transition: latest ? { id: latest.id, generation: latest.generation, runtimeId: latest.runtime_id,
      state: latest.state, error: latest.error_code ? publicCloudError(latest.error_code) : null } : null,
  });
}
