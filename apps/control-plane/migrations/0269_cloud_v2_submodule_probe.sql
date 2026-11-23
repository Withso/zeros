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
