# Release candidates roadmap: retiring Beta

Status: **planned, in progress.** Until this lands, [deployment environments](deployment-environments.md)
describes the live Alpha → Beta → Production ladder, and code remains
authoritative.

## Why

Zeros has one maintainer. Three Mac apps and three hosted stacks are more than
one person can use, Beta costs a separate Railway environment, PlanetScale
database, Cloudflare project, WorkOS and GitHub apps, and it was not a soak
stage in practice: releases 0.1.24–0.1.29 each had one Beta push, and
Production followed 15 seconds to 82 minutes later.

## Target workflow

```text
main ─────────────────────────► Alpha app + Alpha backend (unchanged)
  └─ cut release/X.Y.Z ─► release.yml (one approval)
        CI → backend, database and cloud runtime to Production
        → build, sign, notarize X.Y.Z → rolling `rc` feed only
     use it in the Production app with Settings → Internal → Release candidates
  └─ release-promote.yml (one approval, no rebuild)
        → the same files become vX.Y.Z Latest and enter the Production ledger
```

- The candidate **is** the release: version `X.Y.Z`, notarized, and promotion
  publishes its exact files. A fix after a candidate is a new version cut from
  the release branch plus the cherry-pick, so versions are never reused.
- One release branch at a time. Fixes land on `main` first and are
  cherry-picked; nothing is merged back.
- Only the Mac app has a candidate stage. A candidate's backend, database
  migrations and cloud runtime serve every Production user immediately, exactly
  as old apps already talk to a new backend after every release. Alpha is the
  test stage for hosted changes; ship user-visible backend behaviour dark
  (server flag or `X-Zeros-Client` version gate) until the app that uses it is
  promoted.
- Production controlled cutovers require that Alpha's live identity already
  includes the migration, replacing "Beta ran this first".
- A release whose code Alpha has moved past keeps Production's current cloud
  runtime, with a warning, when CI replays that runtime's worker contract
  against the release's control plane. A control-plane or protocol cherry-pick
  therefore ships its backend and keeps the runtime; the new runtime follows in
  a later release cut where Alpha still serves matching code.

## Pull requests

| Step | Change | Status |
|---|---|---|
| 0 | Local migration check accepts a release branch whose ladder is a prefix of `main`'s | #1118 |
| 0 | Runtime resolver keeps the destination's own qualified pin when nothing it was qualified with changed | #1119 |
| 0 | The engine copies `zeros.db` before applying pending migrations, keeping two copies | #1120 |
| 0 | Old-app check: replay each supported desktop's requests and parsers against the new backend | #1121 (five cloud workspace reads; extend the list) |
| 0 | Old-runtime check: replay each kept runtime's boot sequence (hello, config, activity) against the new backend | #1122 |
| 0 | When Alpha has moved past a release's code, keep the destination's current runtime if CI replays its worker contract (warning, not failure) | #1124 |
| 0 | One approval per release, covering hosted, runtime and signing | #1125 |
| 1 | Production app follows the `rc` feed when a staff-only Internal toggle is on, falling back to Latest | #1128 |
| 2 | `release.yml` publishes candidates to `rc`; new `release-promote.yml`; candidate receipt replaces the Beta receipt in `scripts/release/` and `cutover-cli.ts` | planned |
| 3 | Remove Beta from code, after one candidate → promote cycle | planned |
| — | Tear down Beta services (order below), then delete old release branches | planned |

0.1.30 ships through the existing Beta flow. 0.1.31 is the first candidate,
and Beta stays until it has been promoted.

## Beta teardown order

1. Delete Beta cloud workspaces, Cloud Computers and snapshots in Boat while
   the keys still exist.
2. Take a final PlanetScale backup.
3. Delete the Railway `beta` environment.
4. Delete the `zeros-web-beta` Pages project and the `api-beta` / `app-beta`
   DNS records.
5. Delete the Beta WorkOS apps and redirect URIs, and the Beta GitHub App.
6. Delete the Beta R2 bucket and token, and the Beta Boat key.
7. Delete `zeros-control-plane-beta` after a grace period.
8. Delete the GitHub `beta` environment, then the rolling `beta` release and tag.
9. Uninstall Zeros Beta and its data directories on the maintainer's Mac.
