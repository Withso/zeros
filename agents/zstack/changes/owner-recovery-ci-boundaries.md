# Exercise operator approval and authentication at the CI boundary

An approval-drift case passed locally but failed in CI because its hostname
replacement was a no-op when the starting URL already used localhost. Change
the parsed URL to a distinct value and assert that the approved identity really
changed before requiring rejection. Retain port, database and login drift
controls through the real PostgreSQL-backed operator.

The actual CLI fixture also depended on local trust authentication: its temporary
LOGIN role had no password. Give that non-superuser, non-inheriting role a fresh
fixture password, pass it only through the child environment, and run against
SCRAM authentication on CI's Node version. Inspect only the password's presence,
never its value. Preserve the stable NOLOGIN table-owner boundary and exact replay.

New operator pools must run the database-context inventory during focused checks.
Register only the reviewed function that sets app.system before table access;
ordinary context helpers cannot select the migration-owner role for this receipt.
Encoded in the owner recovery integration/input tests and db-context-usage.test.ts.
