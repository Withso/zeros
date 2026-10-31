# Bind system context around a migration backfill

A backfill of `account_entitlements` in migration 0216 passed every test but
would have updated nothing in production. `FORCE ROW LEVEL SECURITY` hides every
row from the migration role unless `app.system` is on, and the migration runner
does not set it. Test databases migrate as a superuser, which bypasses row
security, so the gap never shows locally.

Rule: wrap every migration statement that reads or writes rows of a forced-RLS
table in `SELECT set_config('app.system', 'on', true);` … `SELECT
set_config('app.system', '', true);`, as 0157 and 0216 do. A local pass is no
evidence for these statements; reason from the policies instead.

Target: `gotchas.md` (PostgreSQL). Enforcer candidate: a migration lint that
flags `UPDATE`, `INSERT … SELECT` or `DELETE` on a forced-RLS table without a
preceding system-context `set_config` in the same file.
