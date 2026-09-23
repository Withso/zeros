# Cloud workspace engineering reference

Native recovery format, compatibility, ownership and capacity limits are defined
in [checkpoint-native-format.md](checkpoint-native-format.md). Exact-image
allocation-loss and native-session resume qualification remain release gates.

## Current implementation status

| Capability                                                | Repository status                                                                  | Current anchor                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Remote engine transport and exact runtime registry        | Implemented, gated; signed macOS/live E2E open                                     | `apps/desktop/src/engine/transport/cloud.ts`, `bridge/connection-registry.ts`, Electron access broker |
| Provider image/lifecycle qualification                    | Harness and protected workflow implemented; live evidence open                     | `scripts/cloud-workspace-validation/`, `.github/workflows/zsr-cloud-qualification.yml`                |
| WorkOS identity and membership projection                 | Implemented with Auth0 rollback compatibility                                      | control-plane auth migrations/services and web WorkOS session/event handlers                          |
| Individual Pro and deferred Business funding boundaries | Implemented and database-tested                                                    | migrations `0076`, `0079`, `authorization.ts`, `paid-authority.ts`, `compute-funding.ts`                    |
| Reviewed entitlement, compute, and storage provisioning   | Implemented and database-tested                                                    | migrations `0054`–`0055`, `0062`, owner management commands                                           |
| Repository/settings/environment/secret/provider model     | Implemented and database-tested                                                    | migrations `0026`–`0027`, `0041`–`0047`, `0056`                                                       |
| Lifecycle, setup worker, admission, and engine lease      | Implemented behind disabled setup-worker gate; live qualification open             | migrations `0020`–`0025`, setup and engine services                                                   |
| Generation replacement and provider reconciliation        | Implemented and database-tested; live rollback/delete evidence open                | `generation-transitions.ts`, `reconciler.ts`, `daytona-provider.ts`                                   |
| SSH, authenticated preview, and localhost forward         | Control plane and native desktop boundary implemented; UI/macOS qualification open | `access.ts`, `runtime-access.ts`, Electron access/SSH services                                        |
| Ordered durable record and content/checkpoints            | Implemented and database-tested                                                    | migrations `0028`–`0031`, durable/content/recovery services                                           |
| Encrypted object storage, admission, rotation, deletion   | Implemented; production restore/DR drills open                                     | `object-store.ts`, `object-maintenance.ts`, migrations `0037`, `0055`, `0057`, `0058`, `0060`         |
| Local→cloud and cloud→local immutable forks               | Implemented with fresh destination UUIDs                                           | `forks.ts`, desktop cloud-workspace-fork services, migrations `0032`, `0038`, `0048`, `0051`          |
| Per-user/per-device receive-only replicas                 | Implemented with exact actor/workspace/device authorization                                                 | `replicas.ts`, desktop cloud-replica services, migrations `0033`–`0035`, `0049`–`0052`                |
| Remote-authoritative Design routing                       | Implemented through the normal exact runtime bridge; product UI E2E open           | runtime connection registry and existing Design protocol/service                                      |
| Management, usage, outbox, health, and self-host seams    | Implemented as APIs/services; dashboards/drills/template publication open          | `management*.ts`, `usage.ts`, `outbox.ts`, `health.ts`                                                |
| Cloud creation/catalog/details/onboarding UI              | Deliberately deferred                                                              | final UI phase                                                                                        |
| Organization multiplayer and external workspace guests   | Implemented, staff gated; hosted guest qualification open                          | collaboration routes, actor sessions and individual Pro authority                                                                   |
| Native mobile clients                                     | Deferred                                                                           | no `apps/ios` or `apps/android` boundary                                                              |

## Existing environment contract

### New image storage layout

New qualification images use the version-2 physical layout in
`scripts/cloud-workspace-validation/sandbox/runtime-layout.json`:

| Purpose | Physical path |
| --- | --- |
| Immutable engine and bundled toolchain | `/opt/zeros` |
| Host broker helpers and fixed Node runtime | `/opt/zeros-runtime` |
| Repository checkout | `/srv/zeros/workspace` |
| Database and workspace state | `/srv/zeros/state` |
| Host-only setup journals and managed settings | `/srv/zeros/setup`, `/srv/zeros/managed-settings` |
| Agent home | `/srv/zeros/home/agent` |
| Separate capture home | `/srv/zeros/home/capture` |
| Engine log | `/srv/zeros/log/engine.log` |

The layout is included in image metadata, the image contract hash and admission
verification. It avoids relying on arbitrary `/workspace` and `/home` directories
that are not retained by every provider's stop/resume capture. Both image build
paths package the same capture identity and pinned browser installation.
Qualification must verify persistence on the exact provider/image; a provider
snapshot is not a substitute for durable checkpoint/export recovery.

Existing generations retain their accepted image and its original layout. This
change does not relocate a live checkout or create filesystem aliases. A layout
upgrade requires a new qualified image/generation and the normal validated restore
path. Headless clients discover the workspace through its runtime contract;
desktop SSH/IDE integration must remove its legacy fixed checkout assumption
before enabling this image for that client.

Version-2 broker entrypoints use `/opt/zeros-runtime/lib/zeros` and
`/opt/zeros-runtime/bin`. The version-1 `/usr/local` helper prefix is an image
compatibility contract, not a directory to rename on a running allocation.
Provider resume may restore files while resetting ownership of provider-managed
parent directories. New images therefore qualify both content and ancestry;
they never repair a user-writable helper prefix just before privileged execution.

Boat restores the disk without re-running the OCI image entrypoint. Before
bootstrap credentials are installed, the provider runner invokes the fixed
`ensure-cloud-worker-supervisor.mjs` helper. It verifies the version-2 image
profile and root-controlled paths, recreates private `/run/zeros` after a cold
boot, and probes or starts the broker. A lifetime kernel file lock prevents
concurrent startup from replacing a live endpoint. Readiness probes do not stop
an active engine or consume a setup session. Setup admission and engine readiness
remain separate checks; a live broker alone never makes a workspace ready.

Cgroup admission checks the process scope and every visible ancestor, taking the
tightest independent memory, CPU-rate and process bound. A child reporting `max`
can still be constrained by its parent. Malformed membership/limits fail admission;
an unrestricted VM is not treated as bounded. See the
[kernel cgroup v2 contract](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).

### Existing bootstrap variables

The validation foundation recognizes:

- `ZEROS_CLOUD_PORT`: enables the engine's additional remote listener;
- `ZEROS_CLOUD_TOKEN`: mandatory bounded capability gating the Zeros WebSocket
  upgrade in the validation boundary;
- `ZEROS_ACCOUNT_JWT_*`, `ZEROS_REQUIRE_ACCOUNT`, and
  `ZEROS_CLOUD_OWNER_SUB`: required asymmetric owner binding for an attested
  cloud worker; and
- validation-only provider variables documented in
  [`scripts/cloud-workspace-validation/README.md`](../../scripts/cloud-workspace-validation/README.md).

These names are externally observable bootstrap contracts. Do not rename them
without compatibility handling. The bridge capability remains defense in
depth; production desktop runtime admission additionally binds account, tenant,
workspace, generation, purpose, and expiry.
When the control plane uses WorkOS, setup material and the engine launch must
also carry `ZEROS_ACCOUNT_JWT_CONTRACT=zeros-access-v1`, the exact desktop
client ID, and one exact issuer. Auth0 compatibility leaves the contract and
client ID absent. Partial or mixed shapes are rejected at the control plane,
image helper, supervisor, and qualification boundary.

The production control plane additionally recognizes the explicitly gated
`CLOUD_WORKSPACES_ENABLED` block documented in
`apps/control-plane/.env.example`. Credentials alone never enable creation.
`CLOUD_WORKSPACE_SETUP_WORKER_ENABLED` is an independent second gate: when it
is false, reconciliation may create the provider resource but deliberately
leaves it at `setting_up`; internal setup/registration routes and the setup
worker are not mounted or started.
The desktop has a separate release/build capability,
`ZEROS_CLOUD_WORKSPACES_ENABLED`. It defaults to disabled and only the exact
literal `true` enables it. This is not a user-controlled preference and does
not replace either control-plane gate. `build:sidecar`, `build:engine`, and
`electron:compile` bake the decision into their artifacts; Electron main also
pins the value inherited by its engine child. A packaged artifact built with
the capability disabled therefore cannot be enabled by a launch-time or child-
process environment override. While disabled, desktop cloud access, device
enrollment and safeStorage key creation, replica session seeding/refresh, and
the local replica/fork runtimes remain unconstructed. Direct cloud worker
runtime registration remains governed by its qualified bootstrap contract. A
release cannot bake this capability on until the release-environment validator
accepts 1-8 exact lowercase preview DNS suffixes and canonical base64url
OpenSSH pins covering every allowed gateway.
The desktop main process accepts `ZEROS_CLOUD_SSH_HOSTS` as an exact comma-
separated SSH gateway allowlist; the default is `ssh.app.daytona.io`. Cloud
preview issuance additionally fails closed unless
`VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES` was baked into Electron main or the
development/self-host override `ZEROS_CLOUD_PREVIEW_HOST_SUFFIXES` is present.
The response must use one 32-hex label immediately below an allowed suffix.
These are main-process public deployment settings, never renderer values or
credentials.
The configured image, architecture, source commit, CPU, memory, and storage are
recorded per generation and passed through the provider boundary. Public API
documents use the stable Zeros workspace id and never expose provider resource
ids. Creation also requires the appropriate Organization entitlement/seat
policy plus available compute and durable object-storage limits. Personal
workspaces remain device-local.

Provider observations are accepted only when their immutable workspace and
generation labels match the requested identity. Lifecycle results and failures
recheck desired state and current generation while holding the workspace lock,
so a late provider response is retained as an observation but cannot overwrite
a newer workspace generation or command. Completion paths use the same
workspace-before-intent lock order as lifecycle routes, preventing a provider
response racing stop/delete from deadlocking the API transaction. Healthy drift
observations preserve application-owned `ready`, `busy`, `setting_up`, and
`failed` states, and repair a missing setup-verification run without duplicating
a queued/running attempt.
Delete remains `observing` after provider acceptance until a separate inspection
reports the generation absent or deleted; only then is deletion durably verified.
Daytona rate-limit delays are propagated into the durable retry schedule,
bounded to five minutes, and do not trigger an immediate recovery probe that
would consume another request while the provider is throttling the account.
Any stop, archive, or delete request now revokes every workspace endpoint grant
before changing lifecycle state and cancels queued/running setup attempts in the
same transaction, including when the requested state was already satisfied.
Provider drift, permanent provider failures, and late superseded results enforce
the same generation-scoped retirement. A later wake therefore allocates a fresh
setup-verification attempt instead of being blocked by an attempt from the old
runtime.

Migration `0020_cloud_workspace_setup_worker.sql` adds immutable per-generation
repository/settings inputs plus bounded claims, heartbeat/expiry, retry timing,
cancellation, and an incrementing execution fence. The orchestration in
`setup-worker.ts` locks workspace before setup rows, commits the claim before
calling an executor, and rechecks workspace, generation, provider resource,
lease owner, and fence before publishing readiness. A reclaimed execution can
therefore finish, but its late result cannot mutate durable state. Logs cross a
required sanitizer and a 256 KiB database ceiling; exception messages are not
persisted.

Migration `0021_cloud_workspace_setup_authority.sql` binds each new setup grant
to one setup-run ID and live execution fence. It retires pre-fence setup grants
during upgrade, and a database trigger rejects a new unbound or stale-fence
grant even from system code. Consumption rechecks the token digest, account,
Organization and Team membership, workspace/generation/lifecycle, audience,
expiry, one-use state, setup run, live lease, and fence. Successful setup now
requires an exact structured proof covering the pinned image/source commit,
requested and resolved repository commits, settings version/hash, engine
instance/protocol/health, and durable-record connectivity. That immutable proof
is inserted before the setup run and workspace become `succeeded`/`ready` in
the same transaction. A database trigger also rejects a proof after lease
expiry or when its pinned image, repository revision, or settings identity
differs from the immutable generation contract. A successful process exit alone
cannot publish readiness.

`daytona-command-runner.ts` resolves the exact opaque resource id, rejects
malformed commands, relative working directories, invalid environment maps,
and zero/unbounded timeouts before a provider call, supplies an explicit Daytona
execution timeout, and bounds returned UTF-8 output without splitting a
character. A local abort stops the generated toolbox request and stops waiting
immediately; aborting the HTTP request is not accepted as proof that an
already-dispatched remote process terminated, so the mandatory provider timeout
and stale setup fence remain the authoritative bounds. The control plane depends
on Daytona's narrow generated toolbox client rather than adding the full
image/AWS/telemetry SDK tree to the Railway runtime.

The provider and toolbox clients are intentionally pinned together at
`0.214.0`. Daytona's current SDK documentation describes newer event-streamed
lifecycle behavior; upgrading either client is therefore an adapter change,
not routine dependency maintenance. It requires contract tests plus the full
live stop/wake/delete/preview/SSH qualification before promotion.

`daytona-setup-executor.ts` accepts only a pinned Daytona generation and invokes
the fixed image-owned command
`/opt/zeros-runtime/bin/node /opt/zeros-runtime/lib/zeros/setup-cloud-workspace.mjs`. Repository
text is never concatenated into the command. Its single compact environment
envelope contains an expiring admission plus expected hashes/versions, not the
settings document, installation ID, or provider credential. The database
admission broker stores only the token digest, binds it to the claimed setup
run/fence, and requires retirement before executor success can be returned.
Helper error codes are allowlisted, provider details are collapsed, output is
bounded, and an echoed admission makes the run fail closed.

Migration `0022_cloud_workspace_setup_materials.sql` adds encrypted per-
generation setup secrets and durable engine instances whose bridge and
heartbeat capabilities are stored only as SHA-256 verifiers. The capability-
authenticated internal routes are mounted only with the setup gate. Redemption
rechecks the live setup fence, tenant/member/repository authority, consumes the
admission once, resolves the exact immutable settings snapshot, decrypts only
its referenced secrets, and mints a one-hour GitHub App token restricted to the
single repository with `contents:read`. Authority is checked again after the
external mint; a raced token is revoked.

The image-owned `setup-cloud-workspace.mjs` accepts only the canonical bounded
envelope, exchanges it over HTTPS, clones through askpass without placing the
token in a URL or argv, rejects redirects and non-GitHub askpass prompts,
writes managed settings atomically, and runs declared setup commands as
UID/GID 10001 with individual deadlines and bounded output.
It then rechecks the physical in-repository Git directory, origin, top level,
and HEAD before it can attest readiness; setup-generated files are allowed, but
setup cannot silently change repository authority.
Its root-only journal resumes after commands whose completion was durably
recorded. Setup commands must still tolerate replay across the unavoidable
command-success/journal-write crash window. A root-only Unix-socket supervisor
turns one prepare session into one fixed engine launch and stops a prior process
group before replacement. Live image/ZSR attestation runs immediately before
launch. A sandbox-wide file lock serializes helper invocations, an interrupted
clone is recovered only through exact temporary-directory shapes, and the
worker's shutdown path stops waiting even when a provider executor ignores its
abort signal; the durable run fence prevents that late process from publishing.

The engine consumes and erases its registration envelope, registers the exact
instance/protocol/setup fence, and exposes private readiness only after durable
registration. A heartbeat (10 seconds by default,
`CLOUD_WORKSPACE_ENGINE_HEARTBEAT_INTERVAL_MS` 5–30 seconds) renews a
90-second lease; rejection or lease exhaustion stops the engine. Checkpoint
directives ride the heartbeat, so its cadence bounds how long a stop, archive
or rebuild waits before the final checkpoint begins. The root-owned GitHub projection requests a
replacement ten minutes before expiry (or after a credential rejection), and
the heartbeat returns only an owner-bound replacement document. PostgreSQL and
audit rows never contain the raw GitHub token.

Migration `0023_cloud_workspace_generation_transitions.sql` binds lifecycle
intents to an immutable generation and records a drain-first transition. The
source is stopped and its client/runtime authority retired before candidate
creation; only structured candidate readiness can promote it. A permanent
drain failure restores the source without creating the candidate, while a
rejected candidate is deleted before a source wake is queued. Provider results
remain fenced by transition, generation, desired state, lease owner, and intent.

Migration `0024_cloud_workspace_client_access.sql` stores only capability
verifiers and operational provider IDs for SSH, localhost tunnels, and isolated
preview origins. Access issuance rechecks Organization/Team/current-generation
authority on both sides of the provider call. Unknown SSH issue outcomes enter
a durable provider-wide revocation queue; stop/archive/delete and membership
loss do the same. Preview requests recheck the live database row on every
request, keep Daytona's standard token coordinator-side, reject WebSocket
upgrade in favor of the SSH tunnel path, bound bodies and headers, and run
through a pre-auth IP abuse limit before database work. Exact-key endpoint
lookups are coalesced and both the completed and in-flight provider caches are
bounded, preventing concurrent preview requests from multiplying provider API
calls. Valid streaming responses retain a bounded slot through completion or
cancellation (4 per grant, 32 per process). External provider-edge limits are
still required for production.

Migration `0025_cloud_workspace_engine_authority.sql` closes authority that is
not represented by an ordinary lifecycle request. Organization/Team membership
loss retires issuing and active client grants, endpoint grants, and live engine
instances even when the removal runs under user-context RLS. WorkOS account
deletion applies the same immediate retirement; while `created_by` remains the
temporary billing-owner compatibility field, it also queues provider-verified
deletion for every workspace owned by that account. Organization and Team soft
deletion cancels active setup and generation replacement, supersedes non-delete
intents, and queues one durable delete per provider generation. Existing delete
work remains valid, and no workspace reaches `deleted` before independent
provider inspection proves absence.
The migration itself requires a controlled deployment: it first drains
workspace row lockers with a `cloud_workspaces` table boundary, then changes the
engine schema and installs/backfills authority retirement. Old and new control
plane processes must not overlap that transaction; the exact one-time approval
and rollout procedure are in
[`infrastructure-and-operations.md`](./infrastructure-and-operations.md).

Runtime retirement follows one cross-controller child lock order: client access
rows, endpoint grants, setup work when applicable, then engine instances.
Engine registration and final readiness lock the exact one-use registration
grant before its engine. This matches membership retirement and prevents stop,
membership-loss, registration, and readiness publication from constructing
inverse waits. A provider-wide SSH revoke first commits a workspace-locked
pending fence over every matching `issuing`, `active`, or already-pending row,
then drains the provider, then terminally fences the same set. A sibling issuance
already in its provider call is captured before the drain, and a later issuance
cannot cross the pending marker.

`cloud-workspace-access-client.ts` and `cloud-workspace-access-broker.ts` are
the desktop consumption boundary for those routes. The bounded main-process
client rejects redirects, unapproved SSH hosts, inconsistent grant identity,
kind, port, generation, or expiry, and untrusted free-form error text. If a
response published a valid-looking grant but fails the rest of the contract,
the client attempts exact revocation before failing; an unproven cleanup has a
distinct fail-closed error. The broker limits live device leases, coalesces
provider-wide SSH revocation by workspace generation, attempts to stop tunnels
before revocation without letting a local cleanup failure preserve remote
authority, clears all local authority on auth/app lifetime changes, and returns
no raw capability through IPC.

`cloud-workspace-ssh-runtime.ts` owns macOS Terminal, Cursor/VS Code, and
OpenSSH tunnel processes. Terminal and tunnel credentials are projected into
private one-use SSH configs. Packaged builds require a baked, verified
`known_hosts` entry for every allowed gateway and use strict checking;
trust-on-first-use is available only through an explicit development flag.
Forwards bind exact `127.0.0.1` endpoints and require control-socket readiness. Preview
capabilities stay in `PreviewFrameAuthorizations` and are injected only for an
exact HTTPS origin whose request ancestry contains the authorized Browser
iframe. Capacity exhaustion refuses the new authorization so the broker can
revoke it instead of silently orphaning an older grant. IDE launch uses a fixed
`zeros-cloud` authority plus an isolated user-data directory that points
Remote-SSH at the per-launch private config; the provider username is absent
from child argv and recent-workspace state. Auth replacement, sign-out, and app
disposal remove every tracked projection immediately; expiry and the next
broker lifetime clean up their bounded fallback paths. A new broker lifetime
removes only exact mkdtemp-shaped one-shot SSH directories left by a prior crash
before projecting another credential. The disposed broker/runtime cannot be
reused, and a late provider issuance is revoked before native launch.

This remains pre-production. Setup admission requires qualification of the
exact provider, image, worker identity and helper contract. The current image
places the engine in a user namespace mapped to host UID/GID 10003; the fixed
host broker remains privileged. Workspace/agent and capture identities use
10001 and 10002. The legacy host-root engine is not a production exception; see
[the runtime threat model](root-coordinator-threat-model.md). Sandbox commands
run outside database transactions. The engine compute sponsor is bound to the
workspace billing epoch; each human/agent action separately records its actor.
Deleting or deauthorizing that account fails closed by retiring its paid
runtime and queuing provider-verified cleanup. Organization or Team soft deletion
similarly cancels setup/replacement work, revokes runtime/client grants, and
queues every provider generation for deletion. Membership triggers cross FORCE
RLS only through a narrowly privileged fixed-search-path function, so a normal
user-context self-leave cannot retain a provider bearer.
WorkOS identity, account lifecycle, and notification migrations own `0011`
through `0019`; cloud workspace additions resume at `0020`. The append-only
ladder in `apps/control-plane/migrations/` is authoritative; do not infer the
current schema from an old phase's final migration number. The migration runner explicitly recognizes the
`a80ac25` `0013`–`0018` and `c2b7418` `0018`–`0050` histories as aliases for
their canonical `0020`–`0052` equivalents. `0053` repairs the Personal
local-only constraint for those databases.
Never rename a migration after deployment and never edit
`0010_cloud_workspace_control_plane.sql` in place.

The cloud API models Organization-owned cloud rows and rejects Personal
ownership. Desktop local workspaces remain in SQLite; fork jobs allocate fresh
UUID destinations and preserve released local identifiers as compatibility
data. The placement-aware resolver preserves `.zeros/settings.toml` as optional
shared input and always excludes `.zeros/settings.local.toml` and secret
material from copies.

## Checkpoint throughput and bounded storage admission

Cold recovery captures the complete safe worktree. Small files use engine-only
batches of at most 64 items and 4MiB decoded bytes; large files retain the binary
object endpoint. The engine runs at most two requests concurrently, validates
each returned index, digest and size, and keeps at most 10,000 acknowledged blob
IDs for 15 minutes under the exact origin/workspace/generation/engine identity.
This cache only avoids repeated uploads after interruption. A successful content
append still requires current engine authority and a live, exact workspace blob
reservation. Append success or failure clears these hints.

Each batch uses one reservation transaction and one finalization transaction.
Encrypted conditional PUT and strong read-back occur outside database locks;
finalization rechecks engine authority, immutable object key, nonce and key
version. Admission counts pending, quarantined and deleting objects, rotation
reservations and detached deletion receipts. Reclaiming an interrupted old-key
upload first charges and queues the old key and chooses a fresh physical key;
it never reuses a fenced key or downgrades the key version.

Migration `0092` adds set-based quota admission and avoids rescanning an unchanged
workspace reservation ledger for every file reference. Content append publishes
ordered immutable events, current entries and exact reference-count deltas in a
bounded number of SQL statements. Tombstones precede replacement entries, so a
case-only rename does not depend on input order. Both hashed and legacy mutable
entry references are removed; immutable event references are retained. UUIDs
use the same canonical identity for storage locks, encryption and references.

Per API process, uploads share 32 object-I/O permits (at most 16 per small-file
batch), at most 64MiB of active
I/O payload and 64MiB queued payload, and at most 32 queued operations. Parsed
upload ingress reserves at most 128MiB, with at most eight batch bodies and four
active batch operations. Binary uploads use the same ingress and I/O budgets.
Body readers reject malformed headers before buffering, enforce a cancellable
15-second deadline, coalesce fragments into 64KiB slabs and periodically yield
the event loop. Storage I/O has a 25-second deadline, propagated to S3 operations.
Cancellation drains admitted work before buffers or capacity are released.
Metadata-backed reads enforce the exact expected ciphertext length before
allocating or consuming the response. These payload admission budgets are not
a process RSS ceiling. The shared production S3 connection pool permits 16
sockets; logical I/O permits include work waiting for a socket. Multiple batches
share bounded FIFO admission and can fill it; overload is retriable, without a
reserved per-workspace or interactive lane.
Content append chunks are bounded by both 10,000 mutations and 7MiB of serialized
mutations, leaving room under the 8MiB route body limit.

Local regressions exercise a 4,000-file baseline with repeated and distinct
contents, interrupted uploads, exact replay, quota rollback, revocation, key
reclaim, UUID casing, fragmented bodies and shared scalar/batch capacity. These
are algorithm and correctness checks; hosted cold capture/restore remains a
separate qualification gate, measured through the deployed API and object store.

## Protocol contract

Remote clients use `PROTOCOL_VERSION` from `packages/protocol/src/version.ts`.
Wire-shape changes require the protocol guard and mixed-version behavior. The
validation client imports the shared version rather than duplicating a numeric
constant.

## Security boundary already preserved

`LocalTransport` remains loopback-only with local host/origin defenses.
`CloudTransport` is a separate listener behind a remote network boundary; cloud
work must never relax local transport checks. The current bridge token is kept
out of the validation URL, and harness state is written atomically with
owner-only permissions and removed after successful cleanup. The browser and
operator clients use the same safe `zeros-v1` + credential-carrier protocol and
the shared canonical `source: "browser"` discriminator; the client forces that
value so a call site cannot produce a connected-but-discarded false green.

The listener enforces aggregate—not merely per-socket—handler and retained-byte
limits, preserves a separately bounded control lane, and bounds total outbound
buffering and HTTP/WS connection/shutdown state. Qualified account verification
coalesces JWKS lookups, has fetch and streamed-body deadlines/caps, validates
key-use/algorithm metadata, and cannot fall back to symmetric signing.

## Useful commands

```bash
pnpm exec vitest run apps/desktop/src/engine/transport/__tests__/cloud-transport.test.ts
pnpm exec vitest run apps/desktop/electron/__tests__/cloud-workspace-access-client.test.ts
pnpm exec vitest run apps/desktop/electron/__tests__/cloud-workspace-access-broker.test.ts
pnpm exec vitest run apps/desktop/electron/__tests__/cloud-workspace-ssh-runtime.test.ts
pnpm exec vitest run apps/desktop/electron/__tests__/preview-frame-authorizations.test.ts
pnpm exec vitest run scripts/__tests__/cloud-bridge-client.test.ts
pnpm exec vitest run scripts/__tests__/cloud-workspace-validation-config.test.ts
pnpm exec vitest run scripts/__tests__/cloud-workspace-setup-helper.test.ts
pnpm --dir apps/control-plane exec vitest run src/cloud-workspaces/daytona-provider.test.ts
pnpm --dir apps/control-plane exec vitest run src/cloud-workspaces/access.integration.test.ts
pnpm exec vitest run scripts/__tests__/repository-layout.test.ts
pnpm build:engine
pnpm check:protocol
pnpm check:secrets
pnpm --dir apps/control-plane audit:prod
```

The provider-account sequence is documented beside the harness. It is never a
fork/PR-CI claim. The protected manual workflow uses exact-commit image builds,
an ephemeral asymmetric validation identity, required live
Claude/Codex/Cursor turns with a per-turn challenge, the same browser-safe WSS
credential carrier as the renderer, outbound-reachability/soak/SSH verdicts, and
production-adapter private-preview, stop/wake, drain/candidate-delete/source-
wake rollback primitives, plus fresh-inventory-verified cleanup. A workflow
existing in source is not evidence that it ran: record platform, region, image
ID, runtime versions, measured latencies, soak duration, cleanup result, and
sanitized failures in the private operational record.

## Ownership rules

- Keep lifecycle schemas and routes in `apps/control-plane`, not in desktop UI.
- Put remote desktop connection orchestration in a semantic cloud-workspace
  feature/engine boundary, not in `renderer/shared`.
- Keep provider SDK types behind the control-plane/provider boundary.
- Add a shared package only after a stable contract has multiple deployable
  consumers.
- Keep device absolute paths, replica application state, local-only settings,
  SSH client configuration, and localhost tunnel processes in desktop-owned
  storage/process boundaries.
- Add a new app only when it owns an independent build and deployment.
- Update this reference and `REPOSITORY-ARCHITECTURE.md` whenever those
  boundaries become real.
