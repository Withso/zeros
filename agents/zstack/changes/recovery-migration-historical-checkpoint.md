# Keep migration fixtures within their historical schema

The stop-must-seal guard made three recovery-migration tests fail while creating
their pre-0113 data. Their current checkpoint completion service queried the
native-writer table added in 0139. The content service masked SQLSTATE 42P01 as
a stale checkpoint request, so the first apparent diagnosis was an unsealed
writer in a repair path. The repair migration had not run yet.

The fixture now records the historical completion receipt directly, retaining
the real durable content, checkpoint entries and blob references. A retained
regression proves that the legacy receipt exists while both the native-writer
table and the final-fence column are still absent. All three original FORCE RLS
repair cases remain. No production guard, migration or stop policy changes.

The bug-fix playbook adds this schema-cutoff check and requires the historical
recovery-migration suite beside current-schema checkpoint/stop adjacency.
