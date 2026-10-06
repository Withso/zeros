import { createHash } from "node:crypto";
import type { Tx } from "../db.js";
import { readCloudRuntimeResumeProofEpoch } from "./runtime-transition.js";

export type CloudWorkspaceResumePlan = {
  version: 1;
  mode: "prepare_generation" | "resume_existing";
  keySha256: string;
  proofEpoch: string | null;
};

/** Called under the live workspace/setup locks, before enrolling the fresh
 * engine. This is a preparation hint, never a launch or admission capability.
 * PostgreSQL canonicalizes the exact preparation tuple before hashing it.
 */
export async function readCloudWorkspaceResumePlan(tx: Tx, input: {
  workspaceId: string; organizationId: string; generation: number; accountUserId: string;
}, preparation: unknown): Promise<CloudWorkspaceResumePlan | undefined> {
  const row = (await tx.query<{ identity: string }>(`SELECT jsonb_build_array(
      'zeros.resume-preparation/v1',w.org_id,w.id,g.generation,w.created_by,
      g.provider_connection_id,pb.provider,pb.provider_resource_id,
      g.runtime_id,g.runtime_manifest_sha256,g.runtime_base_image_id,g.runtime_base_compatibility_id,
      g.runtime_profile,g.runtime_engine_protocol_version,g.image_ref,g.source_commit,
      g.architecture,g.cpu_millicores,g.memory_mib,g.storage_mib,
      ss.spec_version,encode(ss.settings_snapshot_sha256,'hex'),ss.settings_snapshot,
      ss.repository_forge,ss.repository_owner,ss.repository_name,ss.repository_revision,
      ss.github_installation_id,w.repository_revision,$4::uuid,$5::jsonb)::text AS identity
    FROM cloud_workspaces w
    JOIN cloud_workspace_generations g ON g.workspace_id=w.id AND g.org_id=w.org_id AND g.generation=w.current_generation
    JOIN cloud_workspace_setup_specs ss ON ss.workspace_id=w.id AND ss.org_id=w.org_id AND ss.generation=g.generation
    JOIN cloud_workspace_provider_bindings pb ON pb.workspace_id=w.id AND pb.org_id=w.org_id AND pb.generation=g.generation
    JOIN users account ON account.id=$4
    WHERE w.id=$1 AND w.org_id=$2 AND w.current_generation=$3
      AND account.staff_role IN ('developer','platform_owner')
      AND account.auth_status='active' AND account.deleted_at IS NULL
      AND pb.provider='boat' AND pb.provider_resource_id IS NOT NULL
      AND g.runtime_profile='zeros-cloud-worker-v4'`,
  [input.workspaceId, input.organizationId, input.generation, input.accountUserId, JSON.stringify(preparation)])).rows[0];
  if (!row) return undefined;
  const proofEpoch = await readCloudRuntimeResumeProofEpoch(tx, input);
  return { version: 1, mode: proofEpoch ? "resume_existing" : "prepare_generation",
    keySha256: createHash("sha256").update(row.identity).digest("hex"), proofEpoch };
}
