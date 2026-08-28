# Cloud workspace engineering reference

## Current implementation status

| Capability                                           | Status                                                                                             | Current anchor                                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Remote engine HTTP/WebSocket transport               | Implemented, opt-in and non-production                                                             | `apps/desktop/src/engine/transport/cloud.ts`                                                                          |
| Engine activation                                    | Implemented when `ZEROS_CLOUD_PORT` is a positive integer                                          | `apps/desktop/src/engine/zeros-engine.ts`                                                                             |
| Transport unit tests                                 | Implemented                                                                                        | `apps/desktop/src/engine/transport/__tests__/cloud-transport.test.ts`                                                 |
| Provider image/lifecycle validation                  | Implemented as an operator harness + protected manual CI                                           | `scripts/cloud-workspace-validation/`, `.github/workflows/zsr-cloud-qualification.yml`                                |
| Shared bridge protocol/version                       | Implemented                                                                                        | `packages/protocol/`                                                                                                  |
| Team identity and authorization foundation           | Implemented for existing product APIs                                                              | `apps/control-plane/`                                                                                                 |
| Production workspace registry and lifecycle API      | Implemented, gated, and pre-production                                                             | `apps/control-plane/migrations/0010_cloud_workspace_control_plane.sql`, `apps/control-plane/src/cloud-workspaces/`    |
| Provider reconciliation and orphan recovery          | Implemented; live provider qualification still required                                            | `apps/control-plane/src/cloud-workspaces/reconciler.ts`, `daytona-provider.ts`                                        |
| Production setup worker and workspace engine grant   | Implemented behind a second operator gate; live image/provider qualification remains required      | migrations `0013`–`0015`, setup worker/material service/internal routes, image helper/supervisor, engine registration |
| Drain-first generation replacement and rollback      | Implemented and database-tested; protected provider-adapter run has not yet supplied live evidence | migration `0016`, generation transitions, lifecycle routes, reconciler                                                |
| Coordinator SSH, preview, and localhost tunnel APIs  | Implemented and database-tested; live provider/edge qualification remains required                 | migration `0017`, `access.ts`, access routes and revocation worker                                                    |
| Account/scope authority retirement                   | Implemented and database-tested; live deletion/revocation qualification remains required           | migration `0018`, membership/account/scope triggers, engine heartbeat and durable delete intents                     |
| Production desktop remote client and management UI   | Native access client implemented; engine bridge, catalog, and management UI not implemented        | Electron access broker plus future desktop cloud-workspace feature ownership                                          |
| Durable cloud-workspace record/write-through         | Not implemented                                                                                    | Future control-plane/data-plane work                                                                                  |
| Renderer execution routing                           | One process-global active bridge; not multi-execution                                              | `apps/desktop/src/renderer/platform/bridge/active-bridge.ts`                                                          |
| Organization settings routing                        | One engine-global in-memory Team context                                                           | `apps/desktop/src/engine/settings/team-context.ts`                                                                    |
| Local settings layers                                | Implemented for current local engine                                                               | `apps/desktop/src/engine/settings/resolve.ts`, `files.ts`                                                             |
| Global local/cloud repository and workspace identity | Not implemented                                                                                    | Current desktop IDs remain local/path-derived compatibility identities                                                |
| Personal cloud eligibility                           | Not implemented; current schema fails closed                                                       | `0009_organization_team_hierarchy.sql`, cloud create authorization                                                    |
| Placement authority epochs and local/cloud moves     | Not implemented                                                                                    | Target `data-and-sync.md` contract                                                                                    |
| Per-user/per-device receive-only local replicas      | Not implemented                                                                                    | Target desktop replica broker + durable file stream                                                                   |
| Desktop SSH/preview/localhost-forward product flow   | Main/preload/native boundary implemented and unit-tested; product UI and macOS/live E2E remain     | `cloud-workspace-access-*`, frame authorizations, IPC/platform adapters                                               |
| Remote-authoritative Design workspace                | Not implemented                                                                                    | Current Design service/protocol remains local-engine routed                                                           |
| Web management                                       | Not implemented                                                                                    | Future `apps/web` management surface                                                                                  |
| Native mobile clients                                | Deferred                                                                                           | No `apps/ios` or `apps/android` boundary should be created yet                                                        |

## Existing environment contract

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
depth; a production desktop bridge connection grant must add workspace/tenant/
purpose binding, and that transition must be explicit and tested.
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
ids. A system operator must provision an Organization quota before any create
request can succeed.

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

Migration `0013_cloud_workspace_setup_worker.sql` adds immutable per-generation
repository/settings inputs plus bounded claims, heartbeat/expiry, retry timing,
cancellation, and an incrementing execution fence. The orchestration in
`setup-worker.ts` locks workspace before setup rows, commits the claim before
calling an executor, and rechecks workspace, generation, provider resource,
lease owner, and fence before publishing readiness. A reclaimed execution can
therefore finish, but its late result cannot mutate durable state. Logs cross a
required sanitizer and a 256 KiB database ceiling; exception messages are not
persisted.

Migration `0014_cloud_workspace_setup_authority.sql` binds each new setup grant
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
`0.190.1`. Daytona's current SDK documentation describes newer event-streamed
lifecycle behavior; upgrading either client is therefore an adapter change,
not routine dependency maintenance. It requires contract tests plus the full
live stop/wake/delete/preview/SSH qualification before promotion.

`daytona-setup-executor.ts` accepts only a pinned Daytona generation and invokes
the fixed image-owned command
`/usr/local/bin/node /usr/local/lib/zeros/setup-cloud-workspace.mjs`. Repository
text is never concatenated into the command. Its single compact environment
envelope contains an expiring admission plus expected hashes/versions, not the
settings document, installation ID, or provider credential. The database
admission broker stores only the token digest, binds it to the claimed setup
run/fence, and requires retirement before executor success can be returned.
Helper error codes are allowlisted, provider details are collapsed, output is
bounded, and an echoed admission makes the run fail closed.

Migration `0015_cloud_workspace_setup_materials.sql` adds encrypted per-
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
registration. A 30-second heartbeat renews a 90-second lease; rejection or
lease exhaustion stops the engine. The root-owned GitHub projection requests a
replacement ten minutes before expiry (or after a credential rejection), and
the heartbeat returns only an owner-bound replacement document. PostgreSQL and
audit rows never contain the raw GitHub token.

Migration `0016_cloud_workspace_generation_transitions.sql` binds lifecycle
intents to an immutable generation and records a drain-first transition. The
source is stopped and its client/runtime authority retired before candidate
creation; only structured candidate readiness can promote it. A permanent
drain failure restores the source without creating the candidate, while a
rejected candidate is deleted before a source wake is queued. Provider results
remain fenced by transition, generation, desired state, lease owner, and intent.

Migration `0017_cloud_workspace_client_access.sql` stores only capability
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

Migration `0018_cloud_workspace_engine_authority.sql` closes authority that is
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

This remains pre-production. The second setup gate must stay off until the exact
snapshot/entrypoint/helpers are qualified in a real Daytona account. The image
currently keeps the supervisor and engine coordinator root-owned while Git,
setup commands, and agents run as UID/GID 10001; that exception requires threat-
model approval or removal before the non-root Phase-2 item can close. Sandbox
commands continue to run outside database transactions. The execution account
is temporarily the immutable workspace creator; Phase 1 ownership and billing
authority must replace that compatibility binding before reassignment ships.
Until then, deleting that account fails closed by queuing provider-verified
deletion of every workspace it created. Organization or Team soft deletion
similarly cancels setup/replacement work, revokes runtime/client grants, and
queues every provider generation for deletion. Membership triggers cross FORCE
RLS only through a narrowly privileged fixed-search-path function, so a normal
user-context self-leave cannot retain a provider bearer.
WorkOS identity lifecycle and browser-session migrations own `0011` and
`0012`; the still-unreleased cloud workspace additions are the contiguous
`0013` through `0018` sequence.
Never rename a migration after deployment and never edit
`0010_cloud_workspace_control_plane.sql` in place.

The current cloud API models only Organization-owned cloud rows and the desktop
stores local workspaces in SQLite with human-readable IDs. The target product
does not reinterpret either silently: a forward migration adds stable global
UUIDs and preserves released IDs as aliases, then maps the existing cloud UUID
onto the same canonical identity. Current `.zeros/settings.toml` and
`.zeros/settings.local.toml` precedence remains authoritative until the
placement-aware resolver and compatibility tests ship.

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
