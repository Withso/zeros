-- A stop or archive result that arrived after a generation's cleanup delete,
-- and found the allocation absent, cleared the deletion verification that the
-- delete had recorded. The workspace deletion job waits until every generation
-- is verified deleted, so an affected deleted workspace could never purge its
-- data. The reconciler now keeps the verification. Restore what a succeeded
-- delete verified where nothing contradicts it: the generation is still
-- observed absent, and any provider journal for it is terminal.
UPDATE cloud_workspace_provider_bindings binding
SET observed_state = 'deleted', deletion_verified_at = verified.completed_at, updated_at = now()
FROM (
  SELECT workspace_id, generation, max(completed_at) AS completed_at
  FROM cloud_workspace_lifecycle_intents
  WHERE operation = 'delete' AND state = 'succeeded' AND completed_at IS NOT NULL
  GROUP BY workspace_id, generation
) verified
WHERE binding.workspace_id = verified.workspace_id AND binding.generation = verified.generation
  AND binding.observed_state = 'absent' AND binding.deletion_verified_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM cloud_workspace_provider_operations operation
    WHERE operation.workspace_id = binding.workspace_id AND operation.generation = binding.generation
      AND operation.deleted_at IS NULL AND operation.create_closed_at IS NULL AND operation.lost_at IS NULL
  );
