# Cloud workspace provider validation

This directory is an operator-run validation harness for the Zeros engine in a
remote Daytona sandbox. It proves that a sandbox image can boot the engine,
serve an account- and capability-gated bridge, run Claude/Codex/Cursor through
the same full ZSR boundary, complete `file.tree` and PTY round trips, reconnect
after stop/start, and pass lifecycle, socket, egress, and SSH gates.

This is not a deployable application or a product roadmap. Nothing in the
packaged desktop app imports these scripts, and repository builds exclude them.
The harness requires a paid provider account and live model credentials, so it
is never exercised by fork/PR CI. The protected, manual
`zsr-cloud-qualification.yml` workflow runs the complete sequence from `main`;
treat the backend as unverified until that workflow (or the equivalent operator
sequence) is green and its external operational record is retained.

## Engine boundary under test

[`CloudTransport`](../../apps/desktop/src/engine/transport/cloud.ts) starts only
when `ZEROS_CLOUD_PORT` is set. It binds a second HTTP/WebSocket server to
`0.0.0.0`, behind the sandbox provider's preview proxy, while the desktop-only
`LocalTransport` retains its loopback and origin defenses.

The qualified browser WebSocket upgrade requires two independent capabilities:

- Daytona's short-lived, revocable signed-preview capability is embedded in
  the hostname. Browser WebSocket cannot attach the header required by a
  standard preview URL, so the standard URL/token pair is used only by legacy
  Node-harness state. Signed and standard tokens are never interchanged.
- The independent Zeros bridge token is sent by both the Node qualification
  client and browser renderer as the validated
  `zeros-cloud-token.<base64url>` WebSocket subprotocol carrier, alongside the
  negotiated safe `zeros-v1` protocol. It is never placed in a URL or echoed
  as the negotiated credential-bearing protocol. A dedicated header remains a
  trusted non-browser compatibility path. The listener rejects repeated or
  mixed carriers instead of choosing one by precedence.

Every operator request uses the protocol's canonical `source: "browser"`
discriminator. The bridge client forces it at envelope construction; this is
covered by regression tests because a non-canonical value can complete the
WebSocket/`ENGINE_READY` exchange while the engine correctly discards every
client request that follows.

The signed provider capability necessarily appears in the hostname; it is
therefore treated as a bearer and never logged or copied to query/hash state.
The harness writes it, its provider revocation token, and the Zeros token
atomically to `~/.zeros/cloud-workspace-validation/state.json` with directory
mode `0700` and file mode `0600`. That engine-private root is absent from every
ZSR code view, including dev-channel sessions. Successful `--delete` cleanup
revokes every live/retiring generation and removes the state. Legacy
`.context/cloud-workspace-validation/` and `.context/cloud-spike/` files are
migrated once for compatibility and removed.

Qualified cloud admission always binds the immutable worker owner to an
asymmetrically verified account JWT. The browser/client JWT is sent only in the
`CONNECTED` frame; it is not part of sandbox create-time environment or saved
validation state. A bridge token alone is insufficient for a qualified worker.

Local transport sanity check, without a provider account:

```bash
pnpm build:engine
ZEROS_CLOUD_PORT=39393 ZEROS_CLOUD_TOKEN=test-only-cloud-token node dist-engine/cli.js serve --root .
curl localhost:39393/health
```

Unit coverage lives in the CloudTransport suite and the `cloud-*` validation
suites under `scripts/__tests__/`, including real shell-probe, bridge-client,
identity, cleanup, and fail-closed verdict regressions.

## Prerequisites

```bash
export DAYTONA_API_KEY=dtn_... # required
export DAYTONA_TARGET=eu       # optional: us | eu; default eu
export ZEROS_CLOUD_OWNER_SUB='auth0|owner-id'
export ZEROS_ACCOUNT_ACCESS_TOKEN='eyJ...' # client-only JWT; sub must equal owner
export ZEROS_ACCOUNT_JWT_JWKS_URL='https://tenant/.well-known/jwks.json'
# Or configure ZEROS_ACCOUNT_JWT_ISSUER / ZEROS_ACCOUNT_JWT_PUBLIC_KEY.
export ZEROS_CLOUD_REQUIRED_AGENTS='claude,codex,cursor' # paid live differential
```

`@daytona/sdk` is an exact root dev dependency. Run commands from the repository
root with `pnpm tsx scripts/cloud-workspace-validation/<name>.ts`.

## Validation sequence

| Order | Command                                                                      | Validates                                                     |
| ----- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1     | `pnpm tsx scripts/cloud-workspace-validation/bake-snapshot.ts`               | Reproducible image build and native Node ABI                  |
| 2     | `pnpm tsx scripts/cloud-workspace-validation/provision.ts`                   | Sandbox create, engine start, health, and private local state |
| 3     | `pnpm tsx scripts/cloud-workspace-validation/preview-coordinator.ts`         | Keep running separately; rotate authenticated preview ingress |
| 4     | `pnpm tsx scripts/cloud-workspace-validation/test-client.ts`                 | Handshake, file tree, PTY, and stop/start reconnect           |
| 5     | `pnpm tsx scripts/cloud-workspace-validation/agent-smoke.ts`                 | Live providers enter the full Design-enforced boundary        |
| 6     | `pnpm tsx scripts/cloud-workspace-validation/egress.ts`                      | Required outbound provider and package endpoints              |
| 7     | `pnpm tsx scripts/cloud-workspace-validation/lifecycle.ts`                   | Stop/start and archive/restore latency                        |
| 8     | `ZEROS_SOAK_HOURS=4 pnpm tsx scripts/cloud-workspace-validation/soak-wss.ts` | Long-lived socket stability and reconnect behavior            |
| 9     | `pnpm tsx scripts/cloud-workspace-validation/ssh-forward.ts`                 | SSH local-forward fallback                                    |
| 10    | `pnpm tsx scripts/cloud-workspace-validation/lifecycle.ts --delete`          | Provider resource and local credential cleanup                |

Set `ZEROS_CLOUD_VALIDATION_SKIP_RECONNECT=1` only for a deliberately shortened
local iteration. The legacy `ZEROS_SPIKE_SKIP_RECONNECT` name remains accepted
temporarily so existing operator scripts do not break.

All qualification commands fail non-zero: a blocked egress endpoint, missing
SSH round trip, premature soak interruption, dead final socket, or a drop count
above `ZEROS_SOAK_MAX_DROPS` cannot print a warning and still graduate. The
default drop budget is zero. `agent-smoke.ts` is deliberately opt-in and refuses
to run unless `ZEROS_CLOUD_REQUIRED_AGENTS` names at least one provider. CPU,
memory, and disk inputs are parsed and capped before any paid provider request;
provider calls and inventory checks have deadlines.

The protected workflow mints an ephemeral RS256 validation identity. Its
private key never leaves the runner process; the public key enters the worker
and the expiring JWT remains client-side. This validates the engine's
asymmetric gate but is not a substitute for the production tenant/workspace
grant. The workflow also uses a commit-pinned, unique
`zeros-zsr-ci-<run>-<attempt>` snapshot, independently attempts sandbox and
snapshot cleanup, and waits for fresh provider inventories to prove both are
absent. A failure deleting one resource never suppresses deletion of the other.
It also sets a 12-hour provider auto-delete backstop and reaps exact-prefix
snapshots left by killed runners after 24 hours. Configure required reviewers
on the `zsr-cloud-qualification` GitHub Environment before storing its Daytona
and dedicated low-quota model keys.

Keep `preview-coordinator.ts` running for the lifetime of an active validation
workspace. The Daytona API key, account JWT, GitHub App mint authority, and any
refresh credential remain in this external process. The worker receives only
root-owned bounded documents containing signed preview origins and a short-lived
GitHub working copy. Engine and development-preview rotation starts six hours
before expiry. GitHub App rotation starts ten minutes before expiry and also
reacts within seconds to the engine's secret-free, generation-scoped rejection
request; explicit PAT/gh-cli credentials are cleared after rejection instead of
reinstalling the same value. All replacements are serialized with
stop/wake/archive/delete. A browser host installs the current engine descriptor
only into the live `RuntimeClient`; exact expiry closes the socket and emits one
secret-free renewal event. Neither the signed hostname nor the Zeros capability
is persisted by renderer state.

The harness automates bridge/account binding, PTY, reconnect, credential
projection/rotation, egress, lifecycle, soak, and SSH checks. Long-term billing
behavior, production file mirroring, and vendor redistribution approval remain
outside this provider qualification.

## Files

| Path                         | Responsibility                                               |
| ---------------------------- | ------------------------------------------------------------ |
| `config.ts`                  | Provider client, resources, private state, and URL helpers   |
| `image.ts`                   | Canonical Daytona image specification                        |
| `Dockerfile`                 | Portable equivalent for local Docker/provider validation     |
| `sandbox/start-engine.sh`    | In-sandbox engine launcher                                   |
| `sandbox/egress-probe.sh`    | In-sandbox outbound endpoint probe                           |
| `lib/bridge-client.ts`       | Minimal bridge handshake, request, and PTY client            |
| `lib/provider-cleanup.ts`    | Bounded operations and inventory-proven resource deletion    |
| `lib/validation-identity.ts` | Ephemeral asymmetric qualification identity                  |
| `preview-coordinator.ts`     | External signed-ingress renewal and crash recovery           |
| `github-coordinator.ts`      | Owner-bound GitHub App working-credential minting            |
| Remaining `.ts` files        | Ordered operator commands from the validation sequence above |

## Configuration

| Variable                                                 | Default                               | Purpose                                           |
| -------------------------------------------------------- | ------------------------------------- | ------------------------------------------------- |
| `DAYTONA_API_KEY`                                        | required                              | Provisioning API credential; never enters sandbox |
| `DAYTONA_TARGET`                                         | `eu`                                  | Provider region (`us` or `eu`)                    |
| `ZEROS_SNAPSHOT_NAME`                                    | `zeros-engine-v1`                     | Registered image/snapshot name                    |
| `ZEROS_REPO_URL` / `ZEROS_REPO_REF`                      | public repo / `main`                  | Reachable source ref baked into the image         |
| `ZEROS_REPO_COMMIT`                                      | unset                                 | Optional exact commit; ref must resolve to it     |
| `ZEROS_NODE_BASE_IMAGE`                                  | `node:22-bookworm`                    | Sandbox base image                                |
| `ZEROS_CLOUD_PORT`                                       | `39393`                               | CloudTransport bind port                          |
| `ZEROS_CLOUD_ENGINE_INGRESS_TTL_SECONDS`                 | `86400`                               | Signed engine-ingress lifetime (provider maximum) |
| `ZEROS_SANDBOX_CPU` / `_MEMORY` / `_DISK`                | `2` / `4` / `10`                      | Positive vCPU/GiB values, capped at 64/256/1024   |
| `ZEROS_SOAK_HOURS` / `ZEROS_SOAK_PING_MS`                | `4` / `25000`                         | Soak duration and operation cadence               |
| `ZEROS_SOAK_MAX_DROPS`                                   | `0`                                   | Maximum drops before the soak fails               |
| `ZEROS_CLOUD_REQUIRED_AGENTS`                            | required by agent smoke               | Comma-separated paid live provider gate           |
| `ZEROS_CLOUD_VALIDATION_SKIP_RECONNECT`                  | unset                                 | Skip only the reconnect portion of `test-client`  |
| `ZEROS_CLOUD_VALIDATION_STATE_DIR`                       | `~/.zeros/cloud-workspace-validation` | Absolute engine-private operator-state override   |
| `ZEROS_CLOUD_VALIDATION_AUTO_DELETE_MINUTES`             | disabled                              | 60–10080 minute killed-run provider backstop      |
| `ZEROS_CLOUD_OWNER_SUB`                                  | required                              | Immutable account subject that owns the worker    |
| `ZEROS_ACCOUNT_ACCESS_TOKEN`                             | required                              | Client-only JWT used in `CONNECTED`               |
| `ZEROS_ACCOUNT_JWT_JWKS_URL` / `_ISSUER` / `_PUBLIC_KEY` | one required                          | Asymmetric verifier projected into the worker     |
| `ZEROS_CONTROL_PLANE_URL`                                | optional                              | HTTPS control plane used for App token minting    |
| `ZEROS_CLOUD_GITHUB_INSTALLATION_ID`                     | optional                              | Owner-authorized GitHub App installation          |
| `ZEROS_CLOUD_GITHUB_REPOSITORIES`                        | optional                              | Comma-separated repository-name scope             |
| `ZEROS_CLOUD_GITHUB_TOKEN`                               | optional                              | Direct short-lived operator working copy          |

The trusted root engine necessarily receives create-time provider credentials;
ZSR keeps its environment outside code views and projects only the active
provider's bounded values into that provider session. Still use short-lived,
narrowly scoped values, never bake credentials into the image, and run the
delete step when validation finishes.
