-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_v2_execution_boots
  ADD COLUMN last_refusals text[] CHECK (last_refusals IS NULL OR (
    array_ndims(last_refusals)=1 AND array_lower(last_refusals,1)=1 AND cardinality(last_refusals) BETWEEN 1 AND 24
    AND array_position(last_refusals,NULL) IS NULL AND last_refusals <@ ARRAY[
    'proc_unreadable','cgroup_unavailable','cgroup_root','cgroup_unreadable','survivors',
    'contexts_erase_failed','state_dir_linked','state_dir_foreign','checkout_linked','checkout_foreign',
    'seed_journal_invalid','seed_journal_incomplete','seed_journal_outdated','seed_target_modified','seed_target_not_regular',
    'git_identity_linked','git_identity_foreign','git_identity_not_regular','git_identity_changed','terminal_dir_linked',
    'terminal_entry_foreign','shm_linked','restore_token_dir_invalid','io_error']::text[])),
  ADD COLUMN first_failed_refusals text[] CHECK (first_failed_refusals IS NULL OR (
    array_ndims(first_failed_refusals)=1 AND array_lower(first_failed_refusals,1)=1 AND cardinality(first_failed_refusals) BETWEEN 1 AND 24
    AND array_position(first_failed_refusals,NULL) IS NULL AND first_failed_refusals <@ ARRAY[
    'proc_unreadable','cgroup_unavailable','cgroup_root','cgroup_unreadable','survivors',
    'contexts_erase_failed','state_dir_linked','state_dir_foreign','checkout_linked','checkout_foreign',
    'seed_journal_invalid','seed_journal_incomplete','seed_journal_outdated','seed_target_modified','seed_target_not_regular',
    'git_identity_linked','git_identity_foreign','git_identity_not_regular','git_identity_changed','terminal_dir_linked',
    'terminal_entry_foreign','shm_linked','restore_token_dir_invalid','io_error']::text[]));

ALTER TABLE cloud_v2_execution_activations
  ADD COLUMN first_failed_refusals text[] CHECK (first_failed_refusals IS NULL OR (
    array_ndims(first_failed_refusals)=1 AND array_lower(first_failed_refusals,1)=1 AND cardinality(first_failed_refusals) BETWEEN 1 AND 24
    AND array_position(first_failed_refusals,NULL) IS NULL AND first_failed_refusals <@ ARRAY[
    'proc_unreadable','cgroup_unavailable','cgroup_root','cgroup_unreadable','survivors',
    'contexts_erase_failed','state_dir_linked','state_dir_foreign','checkout_linked','checkout_foreign',
    'seed_journal_invalid','seed_journal_incomplete','seed_journal_outdated','seed_target_modified','seed_target_not_regular',
    'git_identity_linked','git_identity_foreign','git_identity_not_regular','git_identity_changed','terminal_dir_linked',
    'terminal_entry_foreign','shm_linked','restore_token_dir_invalid','io_error']::text[]));

GRANT UPDATE(first_failed_refusals) ON cloud_v2_execution_activations TO zeros_app;
