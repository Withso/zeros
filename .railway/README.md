# Control-plane Railway IaC (authoring only)

`railway.ts` uses the official `railway/iac` TypeScript DSL and a named
`zeros-control-plane` partial. It targets the existing linked project's `zeros`
service only. It does not provision a database, define secrets, apply itself on
merge, or replace the release controller's exact-SHA deployment authority.
Beta/Production planning requires a reviewed `RELEASE_BRANCH=release/X.Y.Z`;
Alpha keeps `main`. Unknown environments and an unlinked project fail closed.

Phase 1 leaves `apps/control-plane/railway.json` intact. **Do not apply this file
while the service still uses Config as Code.** Phase 2's owner imports the live
configuration without plaintext variables, preserves its variable/domain and
resource ownership, clears the legacy Config File setting under an approved
deployment hold, reviews the diff, then applies and verifies each channel.
See `docs/deployment-environments.md` for the exact migration ceremony.

The authoring source is checked against Railway SDK `3.12.0` (MIT). The SDK and
Railway CLI are operator tools, not application dependencies; install them in an
isolated operator tool directory rather than changing the repository's lockfile.
SDK `3.12.0` requires Railway CLI `5.42.1` or newer for native IaC evaluation.
