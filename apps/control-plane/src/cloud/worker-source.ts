import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";
import { CloudV2RecipeSchema } from "./computer.js";
import { computerSourceReviewRequired, readComputerSourceTargets } from "./computer-provenance.js";
import { originalSetupBuild, setupSelectionUnavailable } from "./setup-selection.js";
import type { CloudV2Workspace } from "./store.js";
import { CLOUD_V2_LIVE_ACCESS } from "./workspace-access.js";

type Build = { recipe: unknown; source_policy_version: number; source_targets: unknown };
function sourceBuild(row: Build | null) {
  if (!row) throw new HttpError(404, "not_found", "Cloud Computer build not found");
  const recipe = CloudV2RecipeSchema.safeParse(row.recipe);
  if (!recipe.success || row.source_policy_version < 2) throw computerSourceReviewRequired();
  return { recipe: recipe.data, sources: readComputerSourceTargets(recipe.data.repositories, row.source_targets) };
}

export async function workerSourceConfiguration(tx: Tx, workspace: CloudV2Workspace) {
  const row = (await tx.query<{
    repository_id: string; creator_user_id: string | null; computer_build_id: string | null; restore_create: unknown;
    base_commit: string | null; local_commands_enabled: boolean;
    current_build: Build | null; original_build: Build | null;
  }>(`SELECT s.repository_id::text,w.creator_user_id,w.computer_build_id,w.restore_create,
      CASE WHEN w.state IN ('creating','starting','running') AND w.checkpoint_object IS NULL THEN w.base_commit END AS base_commit,
      (o.local_commands_allowed AND w.archived_at IS NULL AND w.state IN ('creating','starting','running') AND ${CLOUD_V2_LIVE_ACCESS}) AS local_commands_enabled,
      CASE WHEN current.id IS NOT NULL THEN jsonb_build_object('recipe',current.recipe,
        'source_policy_version',current.source_policy_version,'source_targets',current.source_targets) END AS current_build,
      CASE WHEN original.id IS NOT NULL THEN jsonb_build_object('recipe',original.recipe,
        'source_policy_version',original.source_policy_version,'source_targets',original.source_targets) END AS original_build
    FROM cloud_v2_workspaces w JOIN organizations o ON o.id=w.org_id
    JOIN cloud_v2_github_sources s ON s.workspace_id=w.id AND s.source_repository=lower($4)
    LEFT JOIN cloud_v2_computer_builds current ON current.org_id=w.org_id AND current.id=$5
    LEFT JOIN cloud_v2_computer_builds original ON original.org_id=w.org_id AND original.id=
      CASE WHEN w.restore_create ? 'setupBuildId' THEN CASE
        WHEN w.restore_create->>'setupBuildId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (w.restore_create->>'setupBuildId')::uuid END ELSE w.computer_build_id END
    WHERE w.id=$1 AND w.org_id=$2 AND (w.execution_mode='active' OR w.creator_user_id=$3)
      AND w.state NOT IN ('deleted','deleting')`,
  [workspace.id, workspace.organizationId, workspace.creatorUserId, workspace.repository, workspace.computerBuildId])).rows[0];
  if (!row) throw computerSourceReviewRequired();
  const target = { repository: workspace.repository, repositoryId: row.repository_id };
  let setup: { setup?: string; setupScript?: string } | null = null;
  if (workspace.computerBuildId) {
    const current = sourceBuild(row.current_build);
    if (current.sources.some(source => source.repositoryId === target.repositoryId) &&
        workspace.creatorUserId !== null && row.creator_user_id === workspace.creatorUserId) {
      // A replacement disk can use a newer Computer, but its source and setup
      // still belong to the original restore journal, including an absent setup.
      const pin = originalSetupBuild(row.computer_build_id, row.restore_create);
      if (pin.setupBuildId) {
        const original = sourceBuild(row.original_build);
        const index = original.sources.findIndex(source => source.repositoryId === target.repositoryId);
        if (index < 0) throw computerSourceReviewRequired();
        const recipe = original.recipe.repositories[index]!;
        if (recipe.setupScript && pin.setupLegacy) throw setupSelectionUnavailable();
        if (recipe.setup !== undefined || recipe.setupScript !== undefined) setup = {
          ...(recipe.setup !== undefined ? { setup: recipe.setup } : {}),
          ...(recipe.setupScript ? { setupScript: recipe.setupScript } : {}),
        };
      }
    }
  }
  return { target, setup, creatorUserId: row.creator_user_id, baseCommit: row.base_commit, localCommandsEnabled: row.local_commands_enabled };
}
