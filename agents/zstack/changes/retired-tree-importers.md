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

The same applies to a shared wire. Removing the cloud Design mapping from
`cloud-runtime-wire.ts` broke 23 tests in `design-catalog-read-adapter.test.ts`,
a suite outside the edited directories. Its fixture defaulted to the cloud
placement, so generic adapter checks were running through the cloud mapping. The
targeted run missed it; the full `pnpm test:git` caught it. After changing a
wire consumed across features, run the whole root suite. A test whose subject
is not placement-specific should default to a Local placement.

Bundle entries break in the same way. `tsup.config.ts` still listed the
deleted resident terminal host, so CI's `build` job failed at
`pnpm build:engine`. Neither typecheck nor any test loads tsup entries. After
removing an engine entry point, run `pnpm build:engine` and
`pnpm electron:compile` locally.
