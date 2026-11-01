# Zeros Dev: `pnpm electron:dev`

Zeros Dev runs a branch's whole cloud v2 stack on one machine: this branch's
control plane, its worker runtime on real Boat VMs, and the desktop app. Use it
to test sign-in, organizations, backend, migration and cloud workspace changes
before they reach `main`. It is the cloud counterpart of
[Zeros Local](local-development.md) (`pnpm electron:local`), which stays
account-free and Local-only. Nothing is created in Railway or PlanetScale.
After merge, Alpha is the shared cloud environment.

`pnpm electron:cloud` is the same launcher; scripts, archive hooks and agent
checks keep using that name. In Conductor, the **Zeros Dev** entry starts it on
a Mac and **Zeros Dev backend** starts it with `--headless` in a cloud
workspace. The earlier per-checkout Railway/PlanetScale Dev environment has been
retired.

## What runs

- An isolated PostgreSQL 18 cluster on loopback. This branch's migrations run
  only there. It allows 40 connections, which keeps PostgreSQL's shared lock
  table close to a small hosted cluster's, so a migration that holds too many
  locks fails here first.
- This branch's control plane on loopback, as the `development` channel. It
  verifies Alpha's WorkOS tokens and runs cloud v2 with this checkout's own
  worker signing key, vault key and Codex keyring.
- The auth web facade for desktop sign-in pages.
- A named Cloudflare tunnel with stable hostnames per checkout:
  `api-dev-<owner>.<domain>` and `app-dev-<owner>.<domain>`. Boat VMs reach the
  control plane's worker API and Codex proxy through it; named tunnels stream
  server-sent events, which quick tunnels do not. The control plane reaches
  each VM outbound through Boat's protected route, so nothing listens on your
  machine's public interfaces.
- The desktop app built from this branch, pointed at the tunnel origin, unless
  you pass `--headless`.

Boat VMs are real and billed while they run. The worker runtime is a published
build pinned by its SHA-256.

This local control plane enables
[durable prompt delivery](cloud-workspaces.md#durable-prompt-delivery) by default.
Use `CLOUD_V2_PROMPT_OUTBOX_ENABLED=false pnpm electron:cloud` to exercise the
legacy bridge send path. This override stays in the backend; the desktop follows
the workspace capability. Hosted deployments keep the default off until their
compatible runtime rollout. An older `--runtime` override cannot start against
an enabled outbox: publish/select this branch's worker or disable the flag for
that compatibility check. Refresh existing VMs after their turns settle so they
receive the new runtime and configuration.

[Checkpoint retries](cloud-workspaces.md#lifecycle) stay off here too. Use
`CLOUD_V2_CHECKPOINT_RETRY_ENABLED=true pnpm electron:cloud` to qualify forking a
stopped VM on this Boat account: stop a workspace whose checkpoint upload fails,
then confirm that a fork saves it and is deleted afterwards.

## Prerequisites

- macOS: `brew install postgresql@18 cloudflared`, plus Docker (Docker Desktop or
  OrbStack) to build a worker runtime. Linux x64: PostgreSQL 18, Node 24 and a
  checksum-verified `cloudflared` on `PATH`.
- The private profile described below.
- For seeding and agent checks, `.env.agent` entries: `ZEROS_DEV_REPOSITORY` and
  `ZEROS_DEV_GITHUB_INSTALLATION_ID` (the test repository and its Alpha GitHub App
  installation), `ZEROS_DEV_PASSWORD` (the fixture user's Alpha WorkOS password;
  required for headless seeding and gate0, optional when you sign in to the app),
  and test agent keys `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`,
  `OPENAI_API_KEY` and `CURSOR_API_KEY`.

## Private profile

Zeros Dev reads `zeros-dev-env.json` from the checkout, then `~/.zeros-dev`, or
the file named by `ZEROS_DEV_PROFILE_PATH`. Start from
[zeros-dev-env-example.json](../zeros-dev-env-example.json). The launcher reads
only its `cloudflare` (a Tunnel Edit and DNS Edit token), `workos` (Alpha),
`github` (the Alpha GitHub App), `boat`, `storage` and `fixture` sections.
Profiles written for the retired hosted Dev environment still work; their
Railway, PlanetScale and registry sections are ignored.

On a new Mac, transfer the private file from your own device through a trusted
encrypted channel, then from the clone run:

```bash
bash scripts/setup-zeros-dev.sh --profile "$HOME/Downloads/zeros-dev-env.json"
```

Setup installs Node 22, the pinned pnpm, Bun and the locked dependency roots,
then imports the profile with mode `0600` into `~/.zeros-dev`, the main checkout
and the calling worktree. Destinations must already ignore `zeros-dev-env.json`;
a different existing profile is preserved, never replaced.
`pnpm dev:setup --check` reads tool and profile status without changes.

Cloud workspaces cannot read a Mac-only file. Put the base64 encoding of the
same profile in the main checkout's private `.conductor/settings.local.toml`:

```toml
[environment_variables.cloud]
ZEROS_DEV_PROFILE_B64 = "<one-line standard base64 of the complete profile JSON>"
```

Conductor Setup validates it and writes the ignored checkout copy with mode
`0600`. An existing checkout, home or explicit profile keeps precedence.
Malformed, oversized or placeholder profiles fail without echoing their
contents. Never commit the profile or paste it into chat.

### Shared Alpha sign-in and GitHub

Zeros Dev reuses Alpha's WorkOS and GitHub registrations, so identities,
organization management, repository installations and permissions are shared;
the database, keys, object prefixes and desktop session are this checkout's own.
Authorize these WorkOS callback patterns for the configured domain:

- `https://app-dev-*.example.com/auth/callback` for the Web application.
- `https://app-dev-*.example.com/auth/desktop/callback` for the Desktop application.

The GitHub OAuth redirect is
`https://api-dev-<owner>.example.com/v1/github/oauth/callback`. Configure exact
callbacks, or enable GitHub's wildcard matching for a fully controlled domain.
GitHub's “redirect_uri is not associated with this application” page means that
registration is missing; retrying from the desktop cannot fix it.

Unpackaged Dev desktops share the `zeros-dev` URL scheme. Starting GitHub or
WorkOS sign-in reclaims that handler for the current instance, and a callback is
relayed to the process that began that exact attempt.

### Test fixture

A fresh database has no organization cloud entitlement. The optional `fixture`
section names the test user and Organization that seeding prepares:

```json
"fixture": {
  "workosUserId": "user_YOUR_TEST_USER",
  "workosOrganizationId": "org_YOUR_TEST_ORGANIZATION",
  "expectedEmail": "developer@example.com",
  "expectedOrganizationSlug": "test-organization",
  "bootstrapOrganization": true,
  "computeAllowance": "pro-monthly"
}
```

The WorkOS Organization must have `metadata.purpose = "zeros-development"` and a
UUID `external_id`, and the user must be its active owner. Seeding verifies that
membership with WorkOS and imports only that Organization, its owner membership
and default team into this checkout's database. It never creates users, invites
anyone or modifies WorkOS. `computeAllowance` is a compatibility marker.

## Worker runtime

Startup computes the packager's worker `sourceSha256` from the checkout's build
inputs, including uncommitted changes. It looks up
`cloud-v2/runtime/sources/<sourceSha256>.json` in the profile's runtime store.
A matching index names the immutable archive SHA and build commit. If absent,
startup builds and publishes the runtime automatically, natively on Linux x64
with Node 24 or through Docker on a Mac. Storage errors and malformed indices
stop startup; they do not trigger a new publication. The last selected runtime
is recorded in private state, and sources changing during selection require a
restart. Every VM still verifies the archive SHA at boot.

To prepublish from Linux for a Mac without Docker, run this on the same worker
sources and with the same runtime store:

```sh
pnpm --dir apps/control-plane cloud-v2:publish-runtime --local
```

Or package and publish an archive separately:

```sh
node apps/cloud-worker/scripts/package-runtime.mjs --out /tmp/worker-runtime.tar.gz
pnpm --dir apps/control-plane cloud-v2:publish-runtime --local --artifact /tmp/worker-runtime.tar.gz
```

Publishing with `--local` also removes the Dev store's older runtimes. It
keeps the two newest and anything from the last day; `--no-prune` skips this.
A stack whose runtime was removed publishes it again on its next start, which
on a Mac needs Docker. Startup's own automatic publish never removes anything.

The packager builds natively on Linux x64 with Node 24. Elsewhere it builds in
Docker (`node:24-bookworm`, `linux/amd64`) from a filtered copy of the source,
without the checkout, private profile or installed dependencies; `--docker`
forces that path. Publishing checks the archive and stores it under its
SHA-256, which it prints. `--local` reads the same private profile as the
launcher, including the `ZEROS_DEV_PROFILE_PATH` override, and uses its
`storage` section. Publication also writes the source-hash index. `--runtime`
can explicitly select the printed SHA when an override is needed. An archive
must include the packager's `BUILD.json` source hash to be indexed.

## Commands

```sh
pnpm electron:dev                                # start and open the app
pnpm electron:dev --headless                     # backend only, for agents
pnpm electron:dev --runtime <sha256>              # explicit runtime override
pnpm electron:dev --seed                         # seed a running stack's test organization
pnpm electron:dev --stop                         # stop a running stack
pnpm electron:dev --doctor                       # show state and profile issues
pnpm electron:dev --reset [--yes]                # delete this checkout's cloud resources and data
pnpm electron:run                                # start without file watching
```

Each also works as `pnpm electron:cloud …`.

`ZEROS_CLOUD_V2_RUNTIME_SHA256` remains an explicit override like `--runtime`;
leave both unset for source-based selection. `--run-only` disables file watching.

On its first healthy start, the stack seeds its database once: the verified
WorkOS test user and organization, the Alpha GitHub installation and test
repository, and the test agent keys through the vault. The exact fixture user
also receives the `developer` staff role through the audited staff-management
path, enabling Settings' Internal tab in this local database. Existing fixture
receipts are upgraded once on the next start; a stronger staff role is kept.
Alpha's database is never changed. Without
`ZEROS_DEV_PASSWORD`, sign in to the app first and then run `--seed`. A missing
input is reported without stopping the stack.

The desktop session persists in this instance's `environments/<owner>/desktop`
directory under `~/.zeros-dev`; the `dev-instances/local-<owner>` directory holds
the app bundle. With `ZEROS_DEV_PASSWORD`, the launcher signs the fixture user
into the desktop automatically if there is no saved session. It uses the Alpha
Desktop client and the fixture organization, verifies the token in Electron
main, and consumes a private 0600 handoff before opening the window. Passwords
and API keys stay in the launcher; tokens never enter argv or environment.
An existing session is reused, and an unavailable or different saved account
is preserved. This path is inert in packaged builds and `electron:local`.

Agents run `--headless`, then gate0 against this checkout's tunnel:

```sh
pnpm --dir apps/control-plane cloud-v2:gate0 --local --agents codex,claude,cursor --runtime <sha256>
```

gate0 derives its signer from this checkout's private state and checks the
running stack's owner and run before it creates one workspace. It signs in with
`ZEROS_DEV_PASSWORD` and needs the seeded organization's Cloud Computer to be
built.

gate0's provider turns use the bridge path. To qualify the outbox, separately
check HTTP receipt latency and the app's running-VM Send presentation, quit and
reopen with pending messages, Stop during wake, and a worker restart during a
turn. The last case must settle as interrupted without automatically repeating
provider work. Use the same cheap model/effort pins and count every explicit
test turn; a gate0 pass alone does not qualify the new HTTP send path.

## Data and cleanup

State persists between runs under `~/.zeros-dev/environments/<owner>/`: the
database, the derived keys and the desktop profile. Service output stays in
private logs there: `logs/control-plane.log`, `logs/auth-web.log` and
`logs/cloudflared.log`, with the previous run's copy as `*.previous.log`. Because the worker signing
key derives from that state, VMs keep trusting the control plane across
restarts. Boat sandbox, builder and snapshot names carry the checkout's owner,
so two checkouts never share a provider resource.

`--stop` waits for this checkout's desktop app, its Vite/watch processes and the
backend services to exit. Shutdown gives each owned process group time to exit
gracefully, then escalates within a bounded deadline and confirms it is gone.
Other checkouts and their apps stay running. A second start refuses an earlier
run whose shutdown is unconfirmed; its private receipt and data are kept.

The checkout's WorkOS webhook is paused while Dev is offline. Startup provisions
the endpoint and immediately pauses it, then enables delivery only after public
API and sign-in readiness. Shutdown and failed startup pause it before stopping
the services. Restart reuses the same endpoint and signing key. The control
plane's existing Events API repair loop resumes from its saved database cursor,
so events missed during downtime are reconciled within WorkOS's retention window.
Pausing delivery never clears account, membership or session security state.

If WorkOS cannot confirm the pause, local processes still stop and the private
receipt keeps cleanup pending. Retry `pnpm electron:cloud --stop` once WorkOS is
available; it also pauses endpoints retained by older launcher versions. A hard
crash or machine shutdown cannot run provider cleanup, so use `--stop` after
reboot recovery or `--reset` when retiring the checkout. Other Dev and hosted
Alpha endpoints are never paused by this launcher.

`--reset` asks for the owner ID (or `--yes`) and confirms the same app/backend
shutdown before cleanup. It then runs this checkout's migrator,
then drains: it fences the database, deletes only this checkout's VMs, builders
and snapshots, and confirms each is gone. Only then does it remove the
database, the WorkOS webhook, the DNS records and the tunnel. If anything is
uncertain, everything is kept; run `--reset` again.

Conductor's archive hook runs `pnpm electron:cloud --reset --yes` when this
checkout has active local cloud state. Archive proceeds only after the same
instance retains an `archived` receipt.
An older branch with local cloud state must switch to a branch that supports
the reset; branches without that state retain their existing archive behavior.
