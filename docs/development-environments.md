# Workspace development environments

The standard Zeros Dev launcher now provisions an isolated hosted environment
for each development checkout. The implementation and automated tests are in
this repository. Live provider provisioning, authenticated desktop qualification,
and archive/relaunch qualification are still required before calling this setup
operational. Missing credentials fail explicitly; Dev never falls back to the
Alpha backend.

A development checkout is the Conductor workspace used to develop Zeros. Local
and cloud product workspaces created inside its app share that checkout's Dev
backend. Creating a product cloud workspace allocates its remote worker, not
another Railway environment or PlanetScale branch.

## Commands

| Command | Behavior |
| --- | --- |
| `bash scripts/setup-zeros-dev.sh --profile /path/to/zeros-dev-env.json` | Install tools/dependencies on a Mac and securely import the portable profile |
| `pnpm dev:setup --check` | Check installed tools and profile format without provisioning or changing files |
| `pnpm electron:dev` | Reconcile hosted services, then build and watch the isolated macOS desktop |
| `pnpm electron:run` | Same provisioning, then run the desktop without source watchers |
| `pnpm dev:backend` | Reconcile/deploy the current source from macOS or Linux; return after readiness |
| `pnpm dev:doctor` | Read the encrypted environment receipt without provisioning |
| `pnpm dev:seed` | Apply the explicitly configured test Organization fixture after normal sign-in |
| `pnpm dev:archive` | Immediately start owned resource cleanup and confirm the remote environment is gone |
| `pnpm electron:alpha` | Explicit desktop-against-Alpha workflow, separate from workspace Dev |

A normal restart preserves the branch, credentials and desktop session. Closing
the desktop leaves its hosted backend/database available and billable. Archive
is the destructive reset. Relaunch after a completed archive creates a new
generation, database, keys and desktop data directory.

Renderer changes retain the normal local watch loop. Restart Dev or run
`dev:backend` after backend, migration, web or cloud-engine changes to deploy a
new captured candidate. Local engine watchers do not replace a cloud image.

## One-time private configuration

On a new Apple silicon Mac, clone this repository and transfer **one** private
`zeros-dev-env.json` from your configured device using a trusted encrypted
transfer (for example AirDrop or a password manager). Then, from the clone:

```bash
bash scripts/setup-zeros-dev.sh --profile "$HOME/Downloads/zeros-dev-env.json"
```

The script installs Node 22 (the CI/backend major), pinned pnpm, Bun, Python when
missing, and all three locked dependency roots. Apple's Command Line Tools
installer must finish before setup can continue; rerun the same command after
the dialog completes. Homebrew installation may request administrator
authentication. Tools installed through npm use a private user prefix, without
sudo. Setup adds an idempotent PATH entry to `.zprofile` and `.bash_profile`;
open a new terminal afterward. Existing tools and credentials are reused.

Import validates the profile locally, restricts the transferred file to `0600`,
and writes private copies into the user's home, the main Git checkout and the
calling worktree. Destinations must already ignore `zeros-dev-env.json`. Different
existing profiles, linked files and tracked destinations fail without replacing
their credentials. Reconcile conflicts explicitly; do not discard a registry key
that still owns environments. `--profile-only` imports without tool/dependency
installation (also usable on Linux with Node 22.18+). `--check` reads tool and profile
status without writes or provider calls. Setup itself allocates no cloud resources.

Use [zeros-dev-env-example.json](../zeros-dev-env-example.json) for first-time
service configuration. A renamed version 1 profile still needs its hosted fields
completed; the filename migration does not silently upgrade its schema.
It is version 2 with `mode: "hosted"`. Configuration resolution is:

1. Explicit `ZEROS_DEV_PROFILE_PATH`.
2. Gitignored `<checkout>/zeros-dev-env.json`.
3. Legacy gitignored `<checkout>/.env.zeros-dev.json`.
4. `~/.zeros-dev/zeros-dev-env.json` on the machine executing the command.
5. Legacy `~/.zeros-dev/development.json`.

An invalid preferred file fails explicitly, without falling back to stale
credentials. Legacy filenames remain readable for migration/recovery; all new
installs use `zeros-dev-env.json`. The earlier local tunnel cleanup can select
its original version 1 profile with `ZEROS_DEV_PROFILE_PATH`.

The file must be user-owned, mode `0600`, and contain actual credentials rather
than placeholders. Do not commit it or paste it into chat. The cloud VM's home
is different from the Mac's home; creating a profile on one does not install it
on the other. In particular, `<checkout>/~/.zeros-dev/` is a literal directory,
not the user's home directory.

For future Conductor workspaces, place the private profile in the main checkout
as `zeros-dev-env.json` (setup does this automatically, even from a linked
worktree). The anchored `/zeros-dev-env.json` rule in `.worktreeinclude` covers
it for both Conductor and Zeros. Both the cloud archive hook and the synced Mac launch need the same registry
bucket and encryption key. A home-only Mac profile is insufficient for a cloud
archive hook. Verify file copying in an actual new cloud workspace before relying
on it. See [Conductor Files to copy](https://conductor.build/docs/reference/files-to-copy).
The shared Conductor setup also imports the copied file before dependency
installation, restoring private permissions if the transfer did not retain them.
Repository-local Conductor settings override the shared script and must include
this step when they replace setup.

Provision these shared Dev prerequisites once:

| Profile section | Required authority/configuration |
| --- | --- |
| `railway` | Workspace/account API token, existing project/backend service IDs, explicit protected Alpha environment IDs; permission to create/delete Dev environments, configure that service in Dev, upload deployments and manage custom domains |
| `planetscale` | Existing PostgreSQL logical database and protected default branch, region, `clusterSize: "development"`, service token allowed to read/create/delete development branches and their role credentials |
| `cloudflare` | Account, DNS zone/domain, Pages Edit and DNS Edit token with zone read access |
| `registry` | Dedicated Dev R2 bucket, scoped S3 credentials and one shared random 32-byte encryption key encoded as 64 hex characters |
| `storage` | A different dedicated Dev R2 bucket and scoped S3 credentials for per-generation objects and recovery artifacts |
| `workos` | Explicit `alpha` or `dev`, Web/Desktop client IDs and API key permitted to manage the owned Dev webhook |
| `github` | Selected GitHub App ID/slug, OAuth client credentials and base64-encoded RSA private key |
| `boat` | API/billing account, qualified base snapshot, actual compute conversion rate and an explicit builder meter budget |

The launcher creates per-workspace resources; it does not create provider
accounts, change account plans, mint master tokens or create the two shared R2
buckets. An environment-scoped Railway project token cannot substitute for the
workspace API token. See [Railway environment API](https://docs.railway.com/integrations/api/manage-environments),
[PlanetScale role API](https://planetscale.com/docs/api/reference/create_role), and
[Cloudflare Pages direct upload](https://developers.cloudflare.com/pages/get-started/direct-upload/).

Use an Alpha/Dev-only Railway workspace or an automation identity restricted to
the intended project. Keep Beta/Production-capable credentials out of the Dev
profile and `.env.agent`; the launcher's protected-resource checks do not replace
provider-side credential scoping.

The hosted choice uses Railway for the API and Cloudflare Pages for the existing
web/auth facade. It needs no Cloudflare Tunnel connector, local PostgreSQL server,
or separately deployed Workers service. Retire an earlier local tunnel through
its original ownership receipt before reusing the same Dev DNS names. The
launcher refuses to overwrite existing tunnel DNS before allocating billable
resources. The earlier local/tunnel helpers are retained for compatibility and
recovery; they are not the standard launch path or a qualified alternative.

## Shared Alpha integrations

Alpha WorkOS and GitHub registrations may be explicitly reused. Their identities,
organization management, repository installations and permissions remain shared.
The backend/database, encryption keys, object prefixes and desktop sessions are
isolated. Do not interpret a private database as isolated identity-provider
side effects.

For the configured domain, authorize these WorkOS callback patterns:

- `https://app-dev-*.example.com/auth/callback` for the Web application.
- `https://app-dev-*.example.com/auth/desktop/callback` for the Desktop application.

Also allow the matching app logout origin and invite resume URL as required by
the existing WorkOS registration. Preserve Alpha defaults and use Alpha's
audience when `workos.environment` is `alpha`. The launcher creates a separate
webhook at `https://api-dev-<owner>.example.com/auth/workos-webhook?zeros_dev=<generation>`
and removes only its owned endpoint on archive.

The GitHub OAuth redirect is
`https://api-dev-<owner>.example.com/v1/github/oauth/callback`. Configure exact
callbacks for a bounded pilot, or deliberately enable GitHub's wildcard matching
for the controlled domain and callback path to support future checkout hosts.
Do not assume that a newly created App permits subdomain redirects by default.
GitHub currently allows ten exact callbacks; its wildcard setting is separate
from the URL string. For example, a controlled-domain callback entry
`https://example.com/v1/github/oauth/callback` with wildcard matching enabled
covers the generated Dev hosts. Keep Alpha's existing first/default callback.
This grants redirect authority to the matching subdomains and paths, so use
exact per-checkout callbacks for a bounded pilot unless that broader domain is
fully controlled. Verify the actual GitHub authorization flow in the shared
App's dashboard. The launcher does not change this setting. See
[GitHub callback rules](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url).

Isolated Dev desktops start with explicit OAuth authorization, including for a
fresh database. GitHub's App installation URL uses the shared App's fixed
callback and cannot choose the workspace callback. The OAuth flow supplies that
workspace URL and discovers installations the signed-in user has already
authorized. Keep the App installed on the repositories used for Dev tests.
GitHub's “redirect_uri is not associated with this application” page means the
callback registration above is missing or wildcard matching is disabled; the
desktop cannot fix that provider registration by retrying. After saving it,
start a new connection from Settings rather than reusing an expired browser URL.

## Launch and isolation

The Conductor workspace UUID owns the remote environment, including its synced
Mac checkout. A standalone checkout uses its canonical path. A branch rename does
not change ownership. One encrypted R2 receipt coordinates launches and archive
from either machine using conditional writes, a renewable lease and ownership
checks before provider mutations. Keep the registry key and bucket available
until cleanup completes; replacing the registry is not a reset operation.

Launch performs the following:

1. Validate the private profile, provider parent identities, existing DNS and
   protected environments. Capture tracked and untracked nonignored source into
   a private clean commit, leaving the user's index and branch unchanged. Run the
   normal secret scanner over the complete captured source.
2. Build/qualify a worker through the release Boat image kit, including native
   attestation and sanitation. Canonical engine/build/dependency inputs determine
   reuse; a renderer-only change does not build another VM in that generation.
3. Create an empty disposable PostgreSQL 18 branch inside the configured logical
   database. It copies no Alpha schema or data. Create a short-lived migration
   role and a separate runtime role; run the release migrations as stable owner
   `postgres`, grant runtime access, and delete the migration credential.
4. Create an empty Railway environment with a compact generation-specific name.
   The encrypted receipt retains the complete owner and generation; existing
   receipts keep their original names for recovery and cleanup. Do not duplicate Alpha variables or
   service configuration. Deploy the captured control plane through the normal
   Dockerfile and configure only its environment-scoped variables.
5. Deploy the captured web/auth facade to its owned Pages project/domain, then
   check API generation/source identity, web commit and WorkOS redirect routing.
6. Build and start Electron with public configuration, cloud enabled, private
   app data and the existing independent port selection. Provider credentials
   never enter the renderer or desktop environment.

The API verifies its compiled source digest and the database's owner/generation
marker before serving requests or starting background work. Its role may not
have admin, DDL, superuser or RLS bypass authority. Migrations run separately;
normal API startup is verify-only. Object encryption keys and storage prefixes
are generated per environment. The prefix covers objects and tombstones.

See [PlanetScale PostgreSQL branching](https://planetscale.com/docs/postgres/branching)
and the repository's [database qualification](cloud-workspace/database-qualification.md).
An unchanged healthy launch reuses its generation. A stopped deployment is
reconciled without replacing the database. Failed readiness never launches the
new desktop against a stale backend.

## Explicit cloud test fixture

A fresh database has no paid cloud entitlement or compute funding. Sign in through
the real WorkOS flow and join/select a collaborative test Organization. Personal
remains ineligible. Optionally add this object to the private profile:

```json
"fixture": {
  "workosUserId": "user_YOUR_TEST_USER",
  "workosOrganizationId": "org_YOUR_TEST_ORGANIZATION",
  "expectedEmail": "developer@example.com",
  "expectedOrganizationSlug": "test-organization",
  "computeAllowance": "pro-monthly"
}
```

Then run `pnpm dev:seed`. It resolves only that active authenticated member and
Organization in this generation, verifies email/slug, and uses the existing
operator utilities to grant Dev platform-owner authority and one
workspace/running-workspace quota. That role supplies the ordinary audited
complimentary Pro entitlement. The release allowance issuer supplies its
standard **500 compute hours per monthly period**, priced with the configured
worker rate. For example, `secondsPerDollar: 100000` gives $18 of ledger credit;
this is spending authority, not a purchase or free provider usage. The normal
lease, metering and exhaustion rules apply. Retrying reuses the existing
monthly receipt; it never adds another grant. Staff benefits retain their normal
monthly renewal behavior until the disposable environment is archived.

The selected fixture is bound to its generation and must be refreshed after
seven days through Archive/Run. Changing its identity or funding model also
requires a fresh generation. Archive starts provider cleanup immediately.

The retired `computeCreditMicroUsd` fixture created organization-scoped pilot
credit. New workspaces use individual Pro funding, so that credit conflicts with
the current monthly issuer. Old profiles remain readable for Doctor/Archive,
but Run/Seed fail before granting or allocating anything new. After reviewing
the standard allowance, archive with the original profile, replace that field
with `"computeAllowance": "pro-monthly"`, and launch a fresh generation. The
launcher never silently raises the old budget or rewrites its funding history.

With the optional fixture configured, deployment reapplies it idempotently when
its identity has already arrived through normal authentication. On a fresh DB,
launch explains that sign-in and `dev:seed` are still needed. It does not create
fake users or grant cloud access to every Alpha Organization.

For a dedicated test Organization created directly in WorkOS, set
`"bootstrapOrganization": true` in the fixture. The WorkOS Organization must have
`metadata.purpose = "zeros-development"` and a UUID `external_id`, and the selected
verified user must be its active owner. After the user signs into Dev normally,
`dev:seed` verifies this membership directly with WorkOS and imports only that
Organization, owner membership and default team into the disposable database.
It refuses conflicting identities, slugs, ownership or provider links. It does
not invite users, modify WorkOS or fabricate an authenticated user. Refresh the
Organization selector after seeding, then select the test Organization.

## Archive and failure recovery

`dev:archive` starts cleanup immediately, with no 24-hour grace period:

1. Persist the archive state, block new launches, stop the exact Railway
   deployment and remove its environment. This prevents late uploads from
   restarting an API while cleanup is underway.
2. Drain the database's allocation journal using the normal cloud provider
   deletion/absence rules. Confirm physical worker deletion; a missing resource
   response alone cannot close an uncertain creation.
3. Retire owned worker snapshot names, request deletion of image builders and
   verify the exact provider receipts, then remove the owned Pages project,
   DNS and WorkOS webhook.
4. Remove only this generation's R2 object prefix, then delete the PlanetScale
   branch and poll for its absence. Never delete the shared database, protected
   branch, Railway project or backend service.
5. Mark the generation archived, erase its credentials and remove inactive local
   app/source data. If a local desktop is still running, preserve its open data
   and report that it needs closing before local cleanup can finish.

A copy of the last deployment's database cleanup operator is preserved in Dev
object storage. Archive therefore does not depend on compiling the current
checkout. Interrupted operations keep receipts, confirmed steps are skipped on
retry, and an unfinished archive blocks a new generation. An unavailable API,
missing authority or uncertain create returns an error with the receipt retained;
it cannot guarantee immediate provider deletion under those conditions. Run the
archive command again after resolving the cause. Do not delete the checkout or
registry to force success.

An upload that Railway accepted without returning a deployment ID remains
uncertain. The launcher refuses another upload instead of guessing from the
latest deployment. Archive can remove the entire owned environment, including
late deployments, and a subsequent launch starts fresh; preserving that
generation requires provider-side reconciliation of the recorded upload.

Named image retirement is different from physical storage erasure: Boat's backing
data cleanup begins no earlier than six hours after removing a named snapshot,
and shared data persists while still referenced. Archive records this distinction
and does not retain the PlanetScale branch waiting for provider storage GC. See
[Boat data retention](https://docs.boat.dev/data-retention). Immediate archive is
not a promise that all provider charges cease at the same instant.

For image builders, an irreversible deletion operation may report
`waiting_for_uploads`, `kept_for_newer_snapshots` or `waiting_for_restore` after
the sandbox has disappeared. These recognized storage-retention stages can
complete the builder retirement step without claiming physical deletion.
The exact deletion receipts survive archive and fresh launches, and later Run
or Archive operations recheck them. Unknown stages, a still-accessible builder
or an unbound deletion receipt stop cleanup. Cloud workspace workers retain the
stricter physical-deletion requirement because their database allocation journal
must remain available until their outcomes are settled.

Conductor's shared configuration wires the archive command and installs all three
dependency graphs. Local Conductor reads shared settings from the remote default
branch, so merge is required for automatic adoption by future local workspaces.
Repository-local or managed settings may override the archive/run commands.
If the main checkout's `.conductor/settings.local.toml` defines those commands,
update them there too: `.worktreeinclude` copies that local layer into future
workspaces, and merging the shared file does not override it. Its archive command
must run `pnpm dev:archive`; local and cloud run commands must select the desktop
and backend respectively.
Verify the actual local and cloud archive hooks, including nonzero failure
reporting. No hosted background sweeper is deployed by this change: if an archive
hook is never invoked, there is no automatic database deletion. The durable
receipt permits a later manual or externally scheduled retry.

The Mac bootstrap also installs native Zeros repository defaults using its
Settings operations. Existing Setup and Run commands are preserved; a conflicting
Archive command is reported for explicit reconciliation. New defaults provide
the macOS desktop Run action and Linux backend action. Required cleanup is set
with `scripts.archive_required = true` and a 1,800-second deadline through
`scripts.archive_timeout_seconds`. Older app builds must be updated to understand
these settings before relying on native archive automation.

Required archive commands must be idempotent. Zeros journals the exact command,
deadline and required policy before execution. Failure or interruption keeps the
worktree and retries the recorded cleanup on the next Archive, even if settings
have since changed. Confirmed success is recorded before the final Git snapshot.
Ordinary optional archive hooks retain their previous best-effort behavior.

Native Setup, Run, Terminal and Archive processes receive the workspace's canonical
UUID and actual root as `ZEROS_WORKSPACE_CANONICAL_ID` and `ZEROS_WORKSPACE_ROOT`.
The Dev launcher accepts the pair only when the root matches its own checkout.
Conductor and synced Mac copies retain their existing Conductor UUID identity.
This keeps environment ownership stable without letting a parent app identify
an unrelated nested checkout.

## Cost and qualification limits

Provisioning is lazy on first Dev launch. `clusterSize: "development"` explicitly
selects PlanetScale's empty development-branch flow (PS-DEV) without a cluster SKU
override. Ordinary SKUs, including PS-5, create production-class branches and are
rejected before allocation. The returned branch must still be nonproduction and
match its exact ownership receipt. See [PlanetScale branch types](https://planetscale.com/docs/postgres/branching).
A generation
reuses its qualified worker across renderer/backend changes. New generations
currently qualify their own image; there is no cross-checkout shared-image cache.
The builder checks the configured organization meter before each build step and
stops/deletes at the threshold, with a provider TTL as fallback. Other concurrent
builds share that meter, and API outages can delay enforcement; it is not a hard
invoice cap. Archive removes all owned resources that the APIs permit immediately.

This setup tests the same application, hosting providers, migrations, privilege
boundaries and native worker qualification path as releases. It does not prove
production scaling, replica behavior, failover or upgrades from existing customer
data. Query correctness, indexes and migrations can be exercised against real
PlanetScale PostgreSQL, but performance conclusions require representative data,
load, instance size and topology. Release permissions, domains, signing,
notarization and updates also need checks in their destination environment.
Promoting the same tested source minimizes drift; Dev success is evidence, not
a guarantee of release success. Those checks require the intended topology and
an upgrade fixture. See
[PlanetScale development environments](https://planetscale.com/docs/postgres/development-environments).

Before rollout, qualify first launch, sign-in, GitHub authorization, test fixture,
cloud creation, streaming/stop/resume, file browsing/editing, terminal routing,
Changes, Review/PR, reconnect and local/cloud switching. Then archive, verify the
provider inventories and relaunch to confirm fresh data. Repeat concurrent
launch/archive and interrupted-create recovery across Mac/cloud copies. Promote
the same tested source and migrations through Alpha, Beta and Production with
each environment's own configuration and release gates.
