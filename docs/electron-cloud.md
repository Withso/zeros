# Cloud workspaces on one machine: `pnpm electron:cloud`

`pnpm electron:cloud` runs a branch's whole cloud v2 stack: this branch's
control plane, its worker runtime on real Boat VMs, and the desktop app. Use it
to test cloud workspace changes before they reach `main`. It is the cloud
counterpart of [`pnpm electron:local`](local-development.md), which stays
account-free and Local-only. Nothing is created in Railway or PlanetScale.
After merge, Alpha is the shared cloud environment.

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

## Prerequisites

- macOS: `brew install postgresql@18 cloudflared`, plus Docker (Docker Desktop or
  OrbStack) to build a worker runtime. Linux x64: PostgreSQL 18, Node 24 and a
  checksum-verified `cloudflared` on `PATH`.
- The private profile `zeros-dev-env.json` in the checkout or `~/.zeros-dev`,
  or `ZEROS_DEV_PROFILE_PATH`. `electron:cloud` reads only its `cloudflare`
  (a Tunnel Edit and DNS Edit token), `workos` (Alpha), `github` (the Alpha
  GitHub App), `boat`, `storage` and `fixture` sections. Railway, PlanetScale
  and registry sections are ignored.
- A published worker runtime for this branch (see below), or the SHA-256 of one
  an agent already published.
- For seeding and agent checks, `.env.agent` entries: `ZEROS_DEV_REPOSITORY` and
  `ZEROS_DEV_GITHUB_INSTALLATION_ID` (the test repository and its Alpha GitHub App
  installation), `ZEROS_DEV_PASSWORD` (the fixture user's Alpha WorkOS password;
  required for headless seeding and gate0, optional when you sign in to the app),
  and test agent keys `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`,
  `OPENAI_API_KEY` and `CURSOR_API_KEY`.

## Worker runtime

Build the Linux x64 worker runtime and publish it to the profile's runtime store:

```sh
node apps/cloud-worker/scripts/package-runtime.mjs --out /tmp/worker-runtime.tar.gz
pnpm --dir apps/control-plane cloud-v2:publish-runtime --local --artifact /tmp/worker-runtime.tar.gz
```

The packager builds natively on Linux x64 with Node 24. Elsewhere it builds in
Docker (`node:24-bookworm`, `linux/amd64`) from a filtered copy of the source,
without the checkout, private profile or installed dependencies; `--docker`
forces that path. Publishing checks the archive and stores it under its
SHA-256, which it prints. `--local` reads the same private profile as the
launcher, including the `ZEROS_DEV_PROFILE_PATH` override, and uses its
`storage` section. Pass the printed SHA to `--runtime`.

## Commands

```sh
pnpm electron:cloud --runtime <sha256>             # start and open the app
pnpm electron:cloud --headless --runtime <sha256>  # backend only, for agents
pnpm electron:cloud --seed                         # seed a running stack's test organization
pnpm electron:cloud --stop                         # stop a running stack
pnpm electron:cloud --doctor                       # show state and profile issues
pnpm electron:cloud --reset [--yes]                # delete this checkout's cloud resources and data
```

`ZEROS_CLOUD_V2_RUNTIME_SHA256` may replace `--runtime`. `--run-only` disables
file watching.

On its first healthy start, the stack seeds its database once: the verified
WorkOS test user and organization, the Alpha GitHub installation and test
repository, and the test agent keys through the vault. Without
`ZEROS_DEV_PASSWORD`, sign in to the app first and then run `--seed`. A missing
input is reported without stopping the stack.

Agents run `--headless`, then gate0 against this checkout's tunnel:

```sh
pnpm --dir apps/control-plane cloud-v2:gate0 --local --agents codex,claude,cursor --runtime <sha256>
```

gate0 derives its signer from this checkout's private state and checks the
running stack's owner and run before it creates one workspace. It signs in with
`ZEROS_DEV_PASSWORD` and needs the seeded organization's Cloud Computer to be
built.

## Data and cleanup

State persists between runs under `~/.zeros-dev/environments/<owner>/`: the
database, the derived keys and the desktop profile. Service output stays in
private logs there: `logs/control-plane.log`, `logs/auth-web.log` and
`logs/cloudflared.log`, with the previous run's copy as `*.previous.log`. Because the worker signing
key derives from that state, VMs keep trusting the control plane across
restarts. Boat sandbox, builder and snapshot names carry the checkout's owner,
so two checkouts never share a provider resource.

`--reset` asks for the owner ID (or `--yes`). It runs this checkout's migrator,
then drains: it fences the database, deletes only this checkout's VMs, builders
and snapshots, and confirms each is gone. Only then does it remove the
database, the WorkOS webhook, the DNS records and the tunnel. If anything is
uncertain, everything is kept; run `--reset` again.
