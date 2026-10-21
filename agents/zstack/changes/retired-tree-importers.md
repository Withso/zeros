# Deleting a script tree breaks the tools that import it

Retiring v1 cloud removed `scripts/zeros-dev/`. `scripts/zstack/drivers.mjs`
still imported `../zeros-dev/hourly-actions.mjs`. `node scripts/zstack/verify.mjs
plan` then crashed at module load, and `scripts/__tests__/zstack-verify.test.ts`
failed before any test ran. Neither showed up in the desktop typecheck,
because `.mjs` tooling is outside it.

After deleting a directory, grep for its path across `scripts/`, `agents/`,
`.github/` and the docs. Then run the whole `scripts/__tests__` suite with the CI
umask (`umask 022`). The fix made zstack's drivers Local-only and documented
the gate0 probe in their place (`tools.md`, `zstack-verify`).
