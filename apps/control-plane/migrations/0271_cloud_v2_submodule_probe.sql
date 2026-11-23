-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
-- C4B: a stop probed before backups covered submodules judged a submodule holding only a stash, an unpushed branch
-- commit or an ignored file clean, so `restores` answered "all" and an open would rebuild from GitHub without it.
-- Such a stop's answer becomes unknown, for the same stop generation: maintenance backs it up with the new capture
-- while its machine is there, and once the machine is gone `restores` answers "pushed", which is true.
-- Only workspaces with a fetched submodule ('fetch' rows, from "Fetch submodules" on a project's repository) can match:
-- none while projects are off.
UPDATE cloud_v2_workspaces w SET backup_probe = 'unknown'
WHERE w.backup_probe = 'clean'
  AND EXISTS (SELECT 1 FROM cloud_v2_workspace_submodules s WHERE s.workspace_id = w.id AND s.status = 'fetch');

-- C4B: a backup of this stop made by the capture before this change holds none of a submodule's work (only its moved
-- gitlink), though the row says it is this stop's backup. For a stopped workspace with a fetched submodule it becomes
-- an earlier checkpoint: maintenance backs the stop up again with the new capture while its machine is there (the
-- shared budget, as any backup), `restores` no longer answers "all" from it, and an open after the machine is gone
-- restores it with the lost-work note. None can match while projects are off.
UPDATE cloud_v2_workspaces w SET checkpoint_stop_generation = NULL
WHERE w.state = 'stopped' AND w.checkpoint_object IS NOT NULL AND w.checkpoint_stop_generation = w.stop_generation
  AND EXISTS (SELECT 1 FROM cloud_v2_workspace_submodules s WHERE s.workspace_id = w.id AND s.status = 'fetch');

-- C4B: a backup that left out a planned submodule folder holding a person's own clone, which it cannot hold; `restores`
-- never answers "all" from it. Every backup before this change counts as complete, as before.
ALTER TABLE cloud_v2_workspaces ADD COLUMN IF NOT EXISTS checkpoint_partial boolean NOT NULL DEFAULT false;

-- C4B: the submodules a restore could not put back, each held on its machine (and in every later backup) until a later
-- open can: [{position, path, folder, reason, since}], written by the restore, emptied as each comes back; NULL when none.
-- While it is set every open, a plain start included, tries the held parts again before the worker starts.
ALTER TABLE cloud_v2_workspaces ADD COLUMN IF NOT EXISTS submodules_unrestored jsonb
  CHECK (submodules_unrestored IS NULL OR (jsonb_typeof(submodules_unrestored) = 'array' AND jsonb_array_length(submodules_unrestored) BETWEEN 1 AND 320));

-- C4B: a live recovery's capture left out a planned submodule folder holding a person's own clone; its publish carries
-- this onto the workspace's checkpoint_partial, as a stop's backup does.
ALTER TABLE cloud_v2_recovery_attempts ADD COLUMN IF NOT EXISTS checkpoint_partial boolean NOT NULL DEFAULT false;
