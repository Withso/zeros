# Give the control-plane suite a TCP database URL

A private PostgreSQL reached through `postgresql://…/postgres?host=/socket-dir`
failed 43 tests in 12 control-plane files. The configuration validators refuse
a URL whose query overrides connection parameters ("must not override or
duplicate connection parameters", "must be a PostgreSQL URL"). Listen on
`127.0.0.1` and use `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:<port>/postgres`,
as CI does. The same 12 files then pass 50/50. This belongs in `zstack-verify`
when fragments are folded.
