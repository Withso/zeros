# Control-plane Railway IaC (authoring only)

`railway.ts` uses the official `railway/iac` TypeScript DSL and a named
`zeros-control-plane` partial. It targets the existing linked project's `zeros`
service only. It does not provision a database, define secrets, apply itself on
merge, or replace the release controller's exact-SHA deployment authority.
Beta/Production planning requires a reviewed `RELEASE_BRANCH=release/X.Y.Z`;
Alpha keeps `main`. Unknown environments and an unlinked project fail closed.

The legacy `apps/control-plane/railway.json` is retired: each environment's
service settings now hold its Dockerfile, health-check and restart values.
Applying this file is optional and owner-operated. Import the live configuration
first so its variables, domains, limits, region and Production's promotion-hold
watch pattern survive, then review each environment's diff. See
`docs/deployment-environments.md`.

The authoring source is checked against Railway SDK `3.12.0` (MIT). The SDK and
Railway CLI are operator tools, not application dependencies; install them in an
isolated operator tool directory rather than changing the repository's lockfile.
SDK `3.12.0` requires Railway CLI `5.42.1` or newer for native IaC evaluation.
