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
| `pnpm dev:agents` | Check connected Dev agents and finish pending exact-image qualification |
| `pnpm dev:agents --retry` | Explicitly retry a failed native qualification, bounded to three attempts per connection/image |
| `pnpm electron:dev` | Reconcile hosted services, then build and watch the isolated macOS desktop |
| `pnpm electron:run` | Same provisioning, then run the desktop without source watchers |
| `pnpm dev:backend` | Reconcile/deploy the current source from macOS or Linux; monitor agent setup when a fixture is configured |
| `pnpm dev:backend --once` | Deploy and perform one qualification pass, then exit |
| `pnpm dev:doctor` | Read the encrypted environment receipt without provisioning |
| `pnpm dev:doctor --all --live` | Inventory current and archived owners; read live health, image, role and service evidence without mutations |
| `pnpm dev:adopt --owner OWNER --generation UUID` | Authenticate an existing receipt and explicitly bind this checkout without renaming live resource keys |
| `pnpm dev:reconcile` | Recover exact recorded provider creates and retain unresolved outcomes |
| `pnpm dev:seed` | Apply the explicitly configured test Organization fixture after normal sign-in |
| `pnpm dev:archive` | Immediately start owned resource cleanup and confirm the remote environment is gone |
| `pnpm dev:archive --owner OWNER --generation UUID` | Clean an explicitly selected authenticated generation, including from another checkout |
| `pnpm dev:gc --all --json` | Read-only cross-owner cleanup plan, including quarantined unknowns |
| `pnpm dev:gc --apply --owner OWNER --generation UUID` | Apply eligible cleanup under the same owner lease and resource guards |
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

The script installs Node 22 (the CI/backend major), pinned pnpm and Railway CLI, Bun, Python when
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
6. Private `ZEROS_DEV_PROFILE_B64` injection, only when none of those files exists
   and no explicit path was selected.

An invalid preferred file fails explicitly, without falling back to stale
credentials. Legacy filenames remain readable for migration/recovery; all new
installs use `zeros-dev-env.json`. The earlier local tunnel cleanup can select
its original version 1 profile with `ZEROS_DEV_PROFILE_PATH`.

The file must be user-owned, mode `0600`, and contain actual credentials rather
than placeholders. Do not commit it or paste it into chat. The cloud VM's home
is different from the Mac's home; creating a profile on one does not install it
on the other. In particular, `<checkout>/~/.zeros-dev/` is a literal directory,
not the user's home directory.

For future local Conductor workspaces, place the private profile in the main checkout
as `zeros-dev-env.json` (setup does this automatically, even from a linked
worktree). The anchored `/zeros-dev-env.json` rule in `.worktreeinclude` covers
it for local Conductor and Zeros copying. Both the cloud archive hook and the synced Mac launch need the same registry
bucket and encryption key. A home-only Mac profile is insufficient for a cloud
archive hook. Conductor Files to copy runs only for local Mac workspaces;
cloud workspaces require the separate injection below.
See [Conductor Files to copy](https://conductor.build/docs/reference/files-to-copy).
The shared Conductor setup also imports the copied file before dependency
installation, restoring private permissions if the transfer did not retain them.
Repository-local Conductor settings override the shared script and must include
this step when they replace setup.

Configure cloud transport once in the main checkout's **private**
`.conductor/settings.local.toml`, preserving its other settings:

```toml
[environment_variables.cloud]
ZEROS_DEV_PROFILE_B64 = "<one-line standard base64 of the complete portable profile JSON>"
```

Replace the placeholder privately with the base64 encoding of the same version 2
hosted profile used on the Mac. Conductor injects this value into cloud workspace
scripts. Setup validates it and atomically creates the ignored checkout
`zeros-dev-env.json` with mode `0600` before dependencies or provisioning.
Direct `dev:backend` and `dev:archive` use the same fallback. Existing checkout,
home and explicit profiles keep precedence, including when invalid; injection
never silently replaces their registry key. Malformed, oversized or placeholder
profiles fail without echoing their contents. The archive guard can authenticate
receipt discovery from the injected value with system Python before selecting
Node, including on old branches.

A mounted user-owned `0600` profile selected by `ZEROS_DEV_PROFILE_PATH` remains
supported. Keep the setting out of shared/tracked TOML, command arguments and
logs. VM-to-Mac sync cannot upload a Mac-only profile. Fresh cloud creation with
the Mac offline still requires live qualification; regression tests use private
temporary checkouts and synthetic credentials, with no provider mutations.

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

On macOS, several unpackaged Dev instances register the same URL scheme. The
launcher declares only `zeros-dev` in each bundle's `CFBundleURLTypes` before
refreshing LaunchServices; Electron cannot register the bundle without it.
Starting GitHub or WorkOS sign-in reclaims that Dev handler before opening the
browser, so an older checkout cannot remain the preferred recipient. This does
not change Alpha, Beta or stable protocol ownership. The receiving process
relays a GitHub callback to the process that began that exact
nonce, using the encrypted Dev callback store shared with WorkOS routing. That
store contains routing data only; each instance keeps its WorkOS session and
GitHub credentials in its own app data. The initiating account must still match
when the handoff is redeemed and saved. Cancel, disconnect and a newer attempt
invalidate an older attempt. A restart requires a fresh Dev connection attempt;
packaged channels retain their existing persisted handoff behavior. Both running
Dev instances must include the relay implementation. An older process cannot
forward a callback it does not recognize.

Cloud Codex account import also needs its refresh-family fingerprint keyring.
Both hosted and local cloud-enabled Dev backends project this from the separate
`agent` key already persisted in the generation receipt. It remains stable across
restarts and deployments, changes with a fresh database generation, and is never
included in the desktop or web environment. Credential encryption retains its
independent key. A successful browser sign-in is only the provider ceremony;
Zeros reports a connection after the native cache is imported into its backend.

## Launch and isolation

First use pins the logical checkout owner in the private `0600` file
`.context/zeros-dev/owner.json`. Managed checkouts retain their root-validated
Conductor/native UUID identity; a new standalone checkout gets a random identity.
Existing UUID/path-derived receipts are adopted without renaming their registry
or provider keys. A branch rename or manager variable disappearing cannot change
a binding. A manager switch or unrelated copy requires explicit adoption; a
root-validated synced Mac copy of the same Conductor UUID keeps the shared owner.
Use `dev:doctor --all` to recover an older owner, then `dev:adopt` with its exact
generation. An active bound owner must be archived before replacing its binding.

One encrypted R2 receipt coordinates launches and archive
from either machine using conditional writes, a renewable lease and ownership
checks before provider mutations. Keep the registry key and bucket available
until cleanup completes; replacing the registry is not a reset operation.
All local mutation commands share one owner lock. Desktop ownership lasts until
the owned process tree exits, with graceful shutdown followed by escalation.
Local cleanup removes only the archived generation's paths; old-layout caches
and another generation's files are preserved. Port collisions retry at most
three coherent port sets after the losing process tree exits.

Worker source and cleanup archives use a three-minute R2 transfer deadline;
small storage metadata calls retain their twenty-second deadline. Uploads also
honor cancellation of the owning provisioning lease. A failed transfer retains
the same builder and generation receipts for retry, and does not record an
archive as saved before the upload succeeds.

Launch performs the following:

1. Validate the private profile, provider parent identities, existing DNS and
   protected environments. Capture tracked and untracked nonignored source into
   a private clean commit, leaving the user's index and branch unchanged. Run the
   normal secret scanner over the complete captured source.
2. Reserve account/owner generation capacity, then a builder and snapshot slot
   through the shared account CAS ledger before allocating a builder. Build/qualify
   a worker through the release Boat image kit, including native
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

Use `pnpm electron:dev` for the hosted desktop build as well as its launch.
`ZEROS_CLOUD_WORKSPACES_ENABLED` is baked into Electron during compilation;
setting it only when starting an already compiled desktop cannot enable Cloud.
Standalone compile/validation tools must use `hostedDesktopEnvironment(...)`
for both steps. A VM can remain running while an incorrectly compiled desktop
reports that Cloud is disabled: VM lifecycle and desktop build admission are
separate checks.

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

Desktop renderer and Electron-only edits also reuse a healthy deployment. The
launcher fingerprints hosted build inputs separately, checks the source and web
commit that are actually deployed, and keeps that deployment's receipt. Backend,
migration, web, engine and shared build input changes still reconcile and deploy
within the same generation. Older receipts without the hosted fingerprint need
one deployment to establish it. Readiness failures repair the recorded resources;
they do not create a new database generation.

A versioned HMAC digest also covers deployment configuration, credential values
and the optional `secretVersions` map. Rotation redeploys unchanged source within
the same generation; diagnostics never expose those values or an unkeyed secret
hash. Keep `registry.encryptionKey` stable: it is the authority needed to decrypt
all receipts, not an ordinary deployment secret. Expired, disabled or missing
runtime DB roles rotate automatically; increment `planetscale.runtimeRoleVersion`
to request rotation explicitly. The old login is retired after replacement
deployment verification. Archive can repair an expired runtime role's grants
after shutdown without applying new migrations.

During a running session, renderer edits use Vite hot reload once they reach the
Mac checkout; no Git commit is needed. Electron and engine edits rebuild and may
restart their processes. Backend and worker edits require another launcher run
to deploy or qualify them. An existing cloud workspace keeps its immutable
worker image; publishing a new image does not hot-patch its running agent engine.
First provisioning or a changed worker image can take
several minutes; this is not a fixed five-minute delay on every launch. Startup
messages distinguish verifying/reusing resources from creating them.

Organization memberships, workspace metadata and cloud chat data belong to this
Dev generation's disposable database branch. The logical PlanetScale database
may also contain Alpha's protected branch, but Dev never stores this data in
that branch. Files and running processes belong to their Boat workspace. Local
workspaces continue to use the local engine and database. Reloading the desktop
restores an existing selection; it neither provisions resources nor creates a
workspace. Archive performs the documented immediate cleanup; a later Run starts
a fresh generation with empty Dev data.

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

The running Dev launcher prepares this fixture after normal sign-in;
`pnpm dev:seed` also remains available for an explicit preparation or repair.
It resolves only that active authenticated member and Organization in this
generation, verifies email/slug, and uses the existing
operator utilities to grant Dev platform-owner authority and one
workspace/running-workspace quota. That role supplies the ordinary audited
complimentary Pro entitlement. The release allowance issuer supplies its
standard **500 compute hours per monthly period**, priced with the configured
worker rate. For example, `secondsPerDollar: 100000` gives $18 of ledger credit;
this is spending authority, not a purchase or free provider usage. The normal
lease, metering and exhaustion rules apply. Retrying reuses the existing
monthly receipt; it never adds another grant. Staff benefits retain their normal
monthly renewal behavior until the disposable environment is archived.

The base example provisions infrastructure only. Add and verify the optional
member/Organization fixture above to enable automatic native qualification.
Native Linux Run is long-running when it monitors a fixture; `--once` provides an
explicit one-pass command. No fixture means no automatic agent tests.

The selected fixture is bound to its generation and must be refreshed after
seven days through Archive/Run. Changing its identity or funding model also
requires a fresh generation. Archive starts provider cleanup immediately.
Backend admission rejects worker creation, wake and TTL renewal at expiry, even
if the launcher is offline; the requested TTL must fit before that deadline.

The retired `computeCreditMicroUsd` fixture created organization-scoped pilot
credit. New workspaces use individual Pro funding, so that credit conflicts with
the current monthly issuer. Old profiles remain readable for Doctor/Archive,
but Run/Seed fail before granting or allocating anything new. After reviewing
the standard allowance, archive with the original profile, replace that field
with `"computeAllowance": "pro-monthly"`, and launch a fresh generation. The
launcher never silently raises the old budget or rewrites its funding history.

With the optional fixture configured, deployment reapplies it idempotently when
its identity has already arrived through normal authentication. On a fresh DB,
the launcher waits for sign-in and prepares it automatically. It does not create
fake users or grant cloud access to every Alpha Organization.

For a dedicated test Organization created directly in WorkOS, set
`"bootstrapOrganization": true` in the fixture. The WorkOS Organization must have
`metadata.purpose = "zeros-development"` and a UUID `external_id`, and the selected
verified user must be its active owner. After the user signs into Dev normally,
the fixture preparation verifies this membership directly with WorkOS and imports only that
Organization, owner membership and default team into the disposable database.
It refuses conflicting identities, slugs, ownership or provider links. It does
not invite users, modify WorkOS or fabricate an authenticated user. Refresh the
Organization selector after seeding, then select the test Organization. Opening
the selector revalidates memberships while retaining the current Local selection
and cached workspaces.

## Archive and failure recovery

Railway shutdown cancels queued/building deployments and removes running,
sleeping or crashed deployments. It waits for terminal deployment states before
database cleanup; `deploymentStop` acknowledgement or `deploymentStopped` alone
is not shutdown evidence. Crashed deployments can restart, so they also require
removal. Every shutdown observation rechecks that the environment contains only
the recorded Dev service. See [Railway deployment removal](https://docs.railway.com/deployments/deployment-actions#remove).

Local image-kit recovery files are keyed by Dev generation as well as source
inputs. A remote Archive can leave another device's cache behind; fresh Run
must allocate a new builder instead of adopting that retired generation's
files. Pending builds from older cache layouts restore their relative recovery
files from the authenticated encrypted registry receipt. Older local directories
remain untouched until their normal local cleanup can run safely.

`dev:archive` starts cleanup immediately, with no 24-hour grace period:

1. Persist signed archive intent and the archive state, block new launches, stop the exact Railway
   deployment and remove its environment. This prevents late uploads from
   restarting an API while cleanup is underway. This happens before old retention
   reconciliation; a pending old deletion or an allocation cap cannot prevent
   shutdown. Independent Pages, DNS and webhook cleanup still runs when another
   cleanup step fails.
2. Drain the database's allocation journal using the normal cloud provider
   deletion/absence rules. Confirm physical worker deletion or durably transfer
   an exact, irreversibly retired storage receipt to the encrypted Dev registry.
   A missing resource response alone cannot close an uncertain creation.
3. Retire owned worker snapshot names, request deletion of image builders and
   verify the exact provider receipts, then remove the owned Pages project,
   DNS and WorkOS webhook.
4. Remove only this generation's R2 object prefix, then delete the PlanetScale
   branch and poll for its absence. Never delete the shared database, protected
   branch, Railway project or backend service.
5. Mark the generation archived, erase its credentials and remove inactive local
   app/source data. If a local desktop is still running, preserve its open data
   and report that it needs closing before local cleanup can finish.

A version 2 copy of the last deployment's database cleanup operator, including
its locked runtime dependency bundle, is preserved in Dev object storage.
It can run outside the original checkout on qualified Node 22. Legacy version 1
artifacts still need their original dependency graph; they are not silently
treated as portable. Interrupted operations keep receipts, confirmed steps are skipped on
retry, and an unfinished archive blocks a new generation. An unavailable API,
missing authority or uncertain create returns an error with the receipt retained;
it cannot guarantee immediate provider deletion under those conditions. Run the
archive command again after resolving the cause. Do not delete the checkout or
registry to force success.

Provider creates persist `planned`, `dispatching`, `acknowledged`, `rejected` or
`uncertain` phases. Only documented authenticated 401/403 rejections are known
not-created; timeouts, malformed replies, 409/422/quota errors and elapsed time
do not prove absence. `dev:reconcile` identifies exact recorded resources, can
replay an original Boat builder request only inside its idempotency window, and
retires an exactly identified DB role whose one-time password was lost. Doctor
shows sanitized phases/request IDs. Unknowns keep their receipts and capacity.

For an externally pruned historical image, first run Archive to stop the backend
and drain workers, then `dev:reconcile`, then Archive again. Reconciliation closes
only the missing name of a previously qualified image whose exact builder is
confirmed physically deleted. An uncertain save, running builder or missing
ownership evidence remains blocked; name absence never claims backing storage
erasure. `dev:doctor --live` reports these differences without changing receipts.

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
or an unbound deletion receipt stop cleanup. Dev workspace workers can transfer
these receipts only after their entire Railway environment is confirmed removed,
dispatchable lifecycle intents are superseded, and the provider's receipt matches
the database allocation journal. The transfer is saved before deleting the
PlanetScale branch. Unallocated or uncertain creates still block archive.
`pendingWorkerDeletions` survives archive and fresh generations and is reconciled
on subsequent Run/Archive operations. Normal product workspace deletion continues
to require physical deletion; this exception applies only to disposable Dev
environment teardown. Provider storage charges can persist while cleanup runs.

Conductor's shared configuration wires the archive command and installs all three
dependency graphs. Local Conductor reads shared settings from the remote default
branch, so a merge affects existing local workspaces too, even on old branches.
Repository-local or managed settings may override the archive/run commands.
If the main checkout's `.conductor/settings.local.toml` defines those commands,
update them there too: `.worktreeinclude` copies that local layer into future
workspaces, and merging the shared file does not override it. Its archive command
should use the shared archive guard; local and cloud run commands select the desktop
and backend respectively when the checkout has hosted tooling. Every current
Conductor/native hook uses `scripts/dev-environment/toolchain.sh` to select
Node 22.18+ in the 22.x line before pnpm. It rejects unqualified higher majors and
skips broken candidates. This avoids
inheriting an older Node or a broken, separately upgraded Homebrew Node in
Conductor's non-interactive shell.

The Dev launcher also passes its working Node executable through
`ZEROS_DEV_NODE_EXECUTABLE`. Electron retains that toolchain after loading the
login-shell PATH, so shell initialization cannot switch engine helpers back to a
broken Node installation. Other user CLI directories stay available. Packaged
apps ignore this hint, and terminals remove it so a nested Dev launch selects
its own runtime.

Setup installs dependencies and imports a copied profile when this checkout has
the profile importer; it does not provision hosted resources. A checkout from
before the hosted Dev foundation can still run its existing Local desktop.
The shared archive guard runs before selecting Node. With no private binding and
no provisioning profile it exits successfully with a nothing-to-clean message.
For an unbound legacy profile it uses system Python's standard library to
authenticate the registry and check the derived owner keys. Confirmed absence
also exits successfully, including on branches without `dev:archive`. A binding
or receipt requires real cleanup; missing tooling, missing cleanup scripts or an
unconfirmed lookup fails with recovery instructions. Old-branch Setup/Run retain
their existing Local desktop commands. Shared settings do not backport hosted
code into those branches. The embedded guard in `.conductor/settings.toml` must
stay identical to `scripts/dev-environment/archive-hook.sh` (covered by tests).

No hosted background sweeper is deployed by this change. Without an archive hook
or separately installed scheduled job, orphaned resources still require a
manual GC/Archive retry.

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

### Account admission and cross-owner cleanup

All Dev launchers for an account must share the same registry bucket/key and
admission policy. `admission/v1/account.json` is an encrypted CAS ledger. It
reserves active generations and per-owner capacity before provisioning, then a
builder and named-snapshot slot before builder allocation. Defaults are four
active generations, one generation per owner, one builder account-wide and per
owner, ten named snapshots including protected names, and one spare snapshot
slot. Configure the `admission` fields in the example together across launchers.
The ten-name ceiling cannot be raised without qualifying another capacity model.
Unknown creates retain reservations; elapsed time alone never releases them.
Caps stop new allocation and do not prevent shutdown or cleanup.

Before a changed worker build, the launcher retires its older rollback image
and retains the currently deployed image as the fallback. The replacement then
fits within the two Dev snapshot slots reserved alongside channel release and
rollback images. Failed or unconfirmed deletion keeps its slot reserved and
prevents the new allocation; a failed build leaves the deployed image available.

Qualification canaries share the builder compute cap but do not reserve a named
snapshot. Compute reservations have a stable `computeId`; only snapshot builders
also carry `snapshotName`. Admission enrolls legacy resources for every owner,
including the requesting generation, and retains uncertain snapshot saves after
their builder exits. Earlier nameless canary reservations are repaired from
authenticated generation receipts under CAS; a reservation without matching
evidence remains blocked for reconciliation. A denied replay never establishes
that the original create failed and never releases its capacity.

Receipts remain at `environments/v1/<owner>.json` for serialized compatibility.
Version 2 receipt contents include `expiresAt`, `lastUserActivityAt` and signed
archive intent. Before a fresh generation starts, its archived predecessor is
preserved at `environments/v2/<owner>/<generation>.json`, including retirement
history. `dev:gc` reads complete paginated registry/provider inventories and is
read-only unless `--apply` is supplied. `--all`, `--owner`, `--generation` and
`--json` select its scope/output. GC never adopts a Dev-looking resource name;
unknown keys, unreadable receipts and unowned provider resources are quarantined.
An unavailable provider is reported without preventing authenticated independent
cleanup. Each apply rereads the exact generation under the owner lease.

GC eligibility requires signed archive intent or an explicitly enrolled maximum
lifetime. Legacy receipts, inactivity and maintenance heartbeats do not establish
eligibility. A private profile may opt new version 2 generations into:

```json
"lifecycle": {
  "maxLifetimeHours": 168,
  "activityGraceHours": 24,
  "warningHours": 24
}
```

This is an explicit deletion policy, not enabled by default. Run updates user
activity and warns near expiry; lease renewal and Doctor do not. GC requires
both maximum lifetime and the user-activity grace to have elapsed. Backend
admission stops new work at expiry. Archive/relaunch starts a fresh lifetime;
changing profile policy does not silently extend existing generations. An
authenticated `investigationPin` with a future expiry suppresses GC eligibility.

Manual Archive, reconciliation and GC protect Alpha/Beta/Production, the configured default
DB branch, base/release snapshots, the registry bucket and configured persistent
service IDs. `protectedResources` can list `railwayEnvironments`,
`railwayServices`, `databaseBranches`, `snapshots` and `buckets`; register the
connections service and GC service there before installing either. These guards
supplement the existing exact owner/generation/account/actor checks. They do not
give a connection hook authority over a shared service. The lifecycle exposes
`lifecycleHooks` (`beforeDeploy` and `archive`) for separate integrations.

### Hosted scheduled job (implementation supplied; not deployed)

`scripts/dev-environment/hosted-gc.mjs` is the same plan/apply library used by the
CLI and `scripts/dev-environment/gc-cron.mjs`. Install a separate protected Railway
operations service with `scripts/dev-environment/gc-railway.toml`: every fifteen
minutes it starts one pass and exits, with no restart loop. Railway cron skips a
new scheduled run if the previous process is still running; registry CAS leases
also fence overlapping manual/scheduled attempts. See
[Railway cron jobs](https://docs.railway.com/cron-jobs).

Build the job from a reviewed operational-code artifact, independent of any
disposable workspace. Include `scripts/dev-environment/`, the referenced
`scripts/dev-auth-profile.mjs`, root locked dependencies (including esbuild), and
the locked `apps/control-plane` dependency graph/package metadata used by the R2
adapters. Preserve that relative layout. It needs Node 22.18+ in the 22.x line,
outbound provider API access and private temporary disk. Archive uses each
generation's retained operator bundle; it does not compile its checkout or
require the original desktop/node_modules. Legacy version 1 operators require
separate restoration of their original dependencies.

Mount a user-owned `0600` Dev operations profile and set the absolute
`ZEROS_DEV_GC_PROFILE_PATH`. Use the original provider containers/registry key
with provider credentials scoped to Dev operations, and explicitly protect the
job and connections service. Do not embed a profile in the runtime artifact.
Run first with `ZEROS_DEV_GC_APPLY` unset to collect sanitized JSON plans. After
reviewing ownership and protected IDs, `ZEROS_DEV_GC_APPLY=1` enables apply.
Nothing in repository setup creates or deploys this scheduler.

A pass handles at most 32 owners, ten minutes total and one minute per owner;
oldest attempted owners go first so a stuck owner cannot starve the rest. Archive
records intent/stops compute before the bounded retention pass. Retention checks
at most 16 receipts in 15 seconds, with capped backoff and retained attempts,
provider stages and deadlines. Alert on nonzero exit, unconfirmed/deferred
owners, quarantined inventory and breached retention deadlines. Resume the same
library after an outage; never erase receipts to get a green schedule. Named
snapshot retirement still does not promise immediate physical storage erasure.

### Runtime qualification

Provisioning is lazy on first Dev launch. `clusterSize: "development"` explicitly
selects PlanetScale's empty development-branch flow (PS-DEV) without a cluster SKU
override. Ordinary SKUs, including PS-5, create production-class branches and are
rejected before allocation. The returned branch must still be nonproduction and
match its exact ownership receipt. See [PlanetScale branch types](https://planetscale.com/docs/postgres/branching).
A generation reuses its attested worker across renderer/backend changes. New
generations attest their own image; there is no cross-checkout shared-image cache.
The builder checks the configured organization meter before each build step and
stops/deletes at the threshold, with a provider TTL as fallback. Other concurrent
builds share that meter, and API outages can delay enforcement; it is not a hard
invoice cap. Archive removes all owned resources that the APIs permit immediately.

Worker image attestation establishes the machine boundary and build provenance.
It does not enable provider credentials. Agent execution also requires an audited
runtime qualification for the exact immutable image, recipe and authentication
kind in that Dev database. After normal sign-in, the Dev launcher seeds the
explicitly configured fixture and monitors its selected organization connections.
Each new image/credential kind runs the baked native turn/resume, permission,
file/shell, isolation and stop/revocation tests on a disposable clone. Codex account
connections also prove native backend renewal and adoption of refreshed access
material. Expired or near-expiry Codex access is renewed durably before the first
canary turn, followed by a separate forced-renewal proof; refresh tokens stay in
the backend. Only successful exact-image evidence is applied through the existing
migration-owner audited operator. Runtime application credentials cannot write
approvals. Release channels continue to use the
[runtime qualification procedure](cloud-workspace/agent-authentication-and-language-tools.md#runtime-qualification-and-activation).

No agent credentials are copied from another database or stored in the portable
profile. Normal WorkOS sign-in and GitHub/agent account consent are required after
a fresh launch. The configured member's selected, consented model is used for
small paid tests (preferring a smaller model when included in that consent).
Tests run serially with a finite VM TTL, bounded output and a compute-meter
budget. These checks are not a hard invoice cap. Failure is retained without
automatically running another paid attempt; `pnpm dev:agents --retry` allows at
most three attempts for the same connection/image. Reconnecting an account or
changing the image creates a new qualification identity.

Connection reuse across disposable databases is not implemented. A future
Dev-only connection service should retain each member's consent, encrypted
credentials and refresh journal independently of checkout lifetimes. Checkouts
would receive scoped connection references after normal sign-in; archive would
remove those bindings while preserving the shared Dev connections. Do not solve
this by copying refresh-token caches into each database: their independent locks
cannot coordinate rotating tokens or propagate revocation. Keep this service
separate from Alpha/Beta/Production, and require current GitHub repository access
and exact-image agent qualification even when a connection is reused.

The launcher uses a pinned Railway CLI (5.47.1), installed by Dev setup or lazily
when first needed, to invoke the SSH-only backend operator. Temporary SSH keys
are recorded in the encrypted ownership receipt before registration and removed
after dispatch; Run/Archive can reconcile an interrupted removal from another
machine. Registration uses Railway's structured key API with complete paginated
inventory; it does not add keys to the developer's SSH agent or `~/.ssh`. A
confirmed failure before dispatch retires its unused canary immediately, while
an uncertain dispatch remains subject to polling and the overall deadline.
Provider credentials move directly from the backend to a private file
on the disposable worker. Native refresh caches never leave the backend.
`pnpm dev:doctor` reports recorded test phases and pending storage receipts.
Native tests run between short registry leases, so Archive can stop the backend
and retire their recorded VMs without waiting for a paid turn to finish.

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
