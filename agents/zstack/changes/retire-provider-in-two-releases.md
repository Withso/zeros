# Retire a provider's code before its schema

Removing Auth0, the first plan put migration 0217 (drop the four `auth0_*`
tables) in the same branch as the code removal. In hosted channels that blocks
every deploy: `verifyMigrations` refuses to boot while any packaged migration is
pending, the hosted plan refuses contract files, and the strict migrator
refuses a contract before its `zeros-contract-after` date. A rollback binary
also fails closed on an unknown contract row.

A second surprise: the control plane's `pnpm typecheck` excludes `*.test.ts`,
so narrowing `AuthBackendConfig` and `IdentityProvider` to WorkOS left 19 test
files constructing Auth0 configs and identities that compiled cleanly and
failed only at run time.

A third: making `AUTH_PROVIDER` optional updated the boot config, build
guards and docs but missed the hosted-promotion Pages inspector, which still
required the exact value. A fresh-context review caught it.

Rule: retire a subsystem in two changes. First ship code that no longer reads
or writes its tables, leaving them in place. After every channel and rollback
target runs that code, ship the contract migration as its own owner-applied
change with a real not-before date. After narrowing a type, grep the tests for
the removed variant, because the package typecheck does not cover them. When
relaxing a variable, grep every validator that reads it: boot config, build
guards, and release and promotion inspectors.

Target: `gotchas.md` (control-plane migrations and typecheck scope) and the
deploy playbook. The procedure is in `docs/deployment-environments.md`
("Expand/contract migration rules").
