# Cloud workspace implementation roadmap

This roadmap separates repository implementation from external release
qualification. A capability is not a production claim merely because its code
and database tests exist.

## Scope and release boundary

Phases 0–5 cover the single-owner cloud-workspace foundation for Organization
tenants. Personal workspaces remain device-local. This execution deliberately
excludes cloud creation, catalog, details, onboarding, and management UI wiring.
It also excludes Organization multiplayer, presence, active ownership transfer,
mobile clients, and collaborative source or Design editing.

Local-to-cloud and cloud-to-local are immutable copy/fork operations:

- every destination receives a fresh workspace UUID;
- the source remains present and authoritative for itself;
- copy selection may include code, chats, and shared settings according to
  policy, but never device-local settings or secrets;
- archive or deletion of the source is a separate owner action; and
- continuous local sync is a receive-only per-user/per-device replica whose
  source of truth remains cloud.

The repository foundations through Phase 5 are implemented. Production release
remains blocked on the external qualifications listed below, and
CLOUD_WORKSPACE_SETUP_WORKER_ENABLED must remain false until they pass.

## Phase 0 — Contract and qualification foundation

Repository status: implemented.

- Organization cloud ownership, fixed workspace placement, immutable fork,
  receive-only replica, Design routing, SSH/preview/tunnel, retention, and
  customer-managed deployment seams are documented.
- The remote bridge is account- and capability-gated with bounded framing,
  backpressure, liveness, redaction, and protocol checks.
- Protected validation covers image provenance, agents, PTY, reconnect, egress,
  lifecycle, soak, SSH, previews, forwards, cleanup, and exact-commit
  qualification attestations under `scripts/cloud-workspace-validation/`.
- The root-coordinator exception has a dedicated threat model and cannot be
  mistaken for final approval.

External exit evidence:

- approve or remove the privileged coordinator exception;
- run the exact baked image and source commit in a representative Daytona
  account;
- store dated, sanitized image, lifecycle, soak, access, and delete evidence in
  the private operational system; and
- finish legal/licensing and agent-account delegation review for the release
  configuration.

## Phase 1 — Identity, authorization, settings, and paid authority

Repository status: implemented by forward migrations 0026–0027, 0041–0047,
and 0053–0056, plus their control-plane services and tests.

- WorkOS is the identity and Organization-membership source. Zeros maps WorkOS
  identities to canonical database UUIDs and remains authoritative for Team,
  repository, workspace, role, entitlement, seat, quota, and billing policy.
- Compute-quota and durable object-storage-limit creation and updates use
  separate database-target-bound, two-step operator commands with
  platform-owner attribution, current-usage protection, and owner-only
  append-only change records. Neither enables a cloud feature gate.
- Personal is permanently device-local and is rejected as a cloud-workspace
  owner by both authorization and database constraints.
- A Pro Organization supports at most five collaborators and requires every
  collaborator to have current Pro. Business and Enterprise require active
  seats within the purchased limit.
- Every paid operation binds current account, Organization, membership,
  entitlement, owner, provider-connection version, generation, and authority
  revisions. Revocation stops new work and queues runtime retirement.
- Repositories have stable tenant/forge identities. Legacy rows remain marked
  compatibility identities instead of being presented as verified forge IDs.
- Workspace owner, assignee, member roles, billing epochs, append-only usage,
  execution projections, ownership-transfer intent, and transactional outbox
  state are normalized.
- Shared/Local/Cloud repository settings and Personal/Organization environment
  profiles resolve to immutable redacted generation snapshots with per-leaf
  provenance.
- Secret values are encrypted separately from settings and bound by tenant,
  owner, purpose, placement, policy, and version. Provider connections are
  encrypted and generation-versioned.
- Tenant relations use forced RLS and composite tenant foreign keys. Runtime
  authorization does not trust WorkOS JWT role claims as billing authority.

Phase 6A owns active ownership transfer and member collaboration. Persisting
their safe data model now does not enable those workflows.

## Phase 2 — Secure cloud execution and access

Repository status: implementation complete; live qualification open.

- Creation records immutable generation inputs and a leased setup run before
  provider dispatch.
- The setup worker claims per-workspace work, renews leases, bounds attempts and
  deadlines, and fences stale or cancelled results.
- The Daytona executor invokes one fixed image-owned helper. One-use admission
  redemption returns only the exact settings snapshot, scoped encrypted
  secrets, repository read credential, and engine-registration grant.
- GitHub credentials are installation/repository scoped and short lived. The
  working credential refreshes through the engine heartbeat and raw tokens are
  not stored in PostgreSQL.
- Setup attestation binds the pinned image/build, helper, boot identity,
  generation, setup run, execution fence, repository revision, settings
  generation, resource limits, and engine readiness.
- The engine registers and heartbeats with a verifier-only lease. Runtime
  admission is account/workspace/generation bound and stale generations fail
  closed.
- Stop, wake, archive, delete, drain-first generation replacement, candidate
  rollback, provider inspection, unknown-result reconciliation, and durable
  cleanup queues are implemented.
- SSH, authenticated preview, and TCP-over-SSH forwarding use short-lived
  verifier-only grants. Electron main owns credentials, private SSH files,
  external IDE launch, exact Browser-frame header injection, and loopback-only
  tunnels.

External exit evidence:

- qualify the exact snapshot on live Daytona;
- provider-test stop/start, archive where supported, replacement rollback,
  fire-and-forget delete verification, orphan cleanup, credential revocation,
  SSH expiry, preview restart behavior, and tunnel teardown;
- complete a signed/notarized macOS run with supported Cursor/VS Code and
  Terminal versions; and
- close the root-coordinator exception.

The setup worker remains disabled until every item above is reviewed.

## Phase 3 — Durable record, checkpoints, recovery, and deletion

Repository status: implemented by migrations 0028–0031, 0036–0038, 0055, and
0057, plus the durable-record, content, object-store, maintenance, recovery, and
fork services.

- Chats, messages, turns, agent sessions, runs, terminals, Design transactions,
  and metadata use ordered idempotent batches, current projections, tombstones,
  bounded catch-up, and revision-gap handling.
- File content uses monotonic revisions, current manifest projection, immutable
  events, encrypted tenant-scoped blobs, and explicit reference accounting.
- Checkpoints bind Git base/ref, canonical manifest order, file entries,
  integrity hashes, record revision, retention, and recovery provenance.
- Provider filesystems and snapshots are caches. A fresh generation restores
  from Git, the durable record, encrypted objects, settings, and checkpoints.
- Object publication is content-addressed, authenticated-encrypted, read-back
  verified, key-versioned, and bounded. The Railway-volume filesystem adapter
  rejects symlink traversal, non-regular objects, hard-link substitution,
  oversize reads, and root replacement.
- Organization physical bytes, per-workspace logical bytes, pending uploads,
  and copy-on-write rotation headroom are transactionally admitted before
  publication. Tenant deduplication and retry reuse do not double-charge the
  durable ledger; missing limits fail closed independently of sandbox disk
  quota and provider volume size.
- Retention, legal hold metadata, export, key rotation, quarantine,
  reference-count reconciliation, garbage collection, deletion propagation,
  and health/backlog reporting are implemented.
- Secret-like paths, device settings, engine-private files, .git, unsupported
  types, path aliases, unsafe symlinks, and over-limit files are excluded or
  rejected.

Operational exit evidence:

- restore a representative clean and dirty workspace into a fresh provider
  resource without the old sandbox or a Mac replica;
- run database PITR/logical restore and object-store loss drills;
- verify key rotation and deletion propagation against production-like backups;
  and
- approve RPO/RTO, retention, legal-hold, privacy, and operator-access policy.

## Phase 4 — Desktop runtime parity, forks, replicas, and Design routing

Repository status: non-UI services implemented. Product UI is explicitly
deferred.

- The runtime connection registry is keyed by exact workspace/execution target,
  retains bounded inactive state, refreshes generation-bound admissions, and
  prevents process-global bridge leakage.
- The normal remote bridge carries file, Git, PTY, chat, agent, browser, and
  Design protocol traffic. The Design canvas remains on the Mac; its authored
  writes execute through the cloud engine against sandbox files.
- Local-to-cloud scans a stable Git base and selected working-tree overlay,
  stages bounded bytes and portable chats, creates a fresh cloud UUID, verifies
  the canonical source snapshot, and leaves the local source intact.
- Cloud-to-local pins a durable checkpoint, uses a short-lived device-bound
  export grant, stages and verifies the manifest/blobs/records, creates a fresh
  local UUID, and leaves the cloud source intact.
- Fork jobs are durable and resumable. Cross-tenant references, duplicate IDs,
  idempotency conflicts, expired staging, quota amplification, secret paths,
  case/Unicode aliases, file-directory conflicts, symlink traversal, and
  snapshot mismatch fail closed.
- Device registration and key rotation use Ed25519 possession proofs with a
  bounded replay window.
- Each receive-only replica is scoped to one workspace, user, and device. The
  absolute local path stays in device SQLite. Bootstrap uses an exact
  checkpoint and catch-up uses ordered file revisions.
- Replica application uses bounded staging, hash verification, atomic rename,
  parent/leaf no-follow checks, case/Unicode collision checks, safe symlinks,
  crash journals, convergence scans, and divergence preservation. Pause,
  resume, replace-diverged, and remove affect only that binding.
- Cloud and local terminal product labels, creation/details actions, progress,
  destructive confirmations, and onboarding are not wired in this phase.

External exit evidence:

- signed macOS tests for remote bridge reconnect, generation replacement,
  Design writes, fork interruption/resume, replica sleep/resume/divergence,
  native credential storage, SSH/IDE launch, previews, and port collisions; and
- UI work in its own final phase, including exact-key/race, smoke,
  accessibility, and performance verification.

## Phase 5 — Single-member operations and self-hosting seams

Repository status: non-UI services implemented; production operations and
release approval open.

- Organization cloud creation, lifecycle, settings, repository,
  provider connection, quota, usage, checkpoint, export, replica, access,
  retention, and deletion APIs share the same authorization spine.
- Phase 5 runtime is owner-only even when an Organization has other members.
  Team members may see policy-authorized metadata, but cannot connect, prompt,
  sync, mint access, or spend the owner's cloud/agent budget.
- Current entitlement or provider authority loss freezes new paid work and
  retires runtime access. Existing durable data remains owner-exportable after
  paid compute cancellation.
- Usage events retain both actor and immutable billing-owner/epoch snapshots;
  historical charges do not move when current entitlement metadata changes.
- Health and reconciliation cover provider drift, stale setup/lifecycle work,
  access revocation, paid-authority checks, checkpoints, object maintenance,
  outbox delivery, forks, replicas, retention, and deletion.
- PostgreSQL, identity/JWKS, provider, object store, encryption keys, and
  public/private endpoints are configuration boundaries. The hosted object
  adapter can use a private Railway volume; alternate/customer stores implement
  the same interface.
- A future Railway template can package these services, but no customer-managed
  deployment is advertised until install, upgrade, backup, restore, key
  management, observability, and security procedures are exercised.

Production exit evidence:

- enable dashboards and alerts with reviewed SLOs;
- execute provider outage, rollback, orphan, restore, object loss, key rotation,
  database PITR, regional recovery, and deletion drills;
- finish abuse, privacy, security, support, capacity, cost, licensing, and
  signed desktop reviews;
- finish the deferred cloud UI and its E2E tests; and
- only then enable the setup-worker and customer-facing feature flags.

## Phase 6A — deferred Organization multiplayer

Phase 6A is not part of this execution. It owns:

- workspace-role permissions for viewers, prompters, developers, managers, and
  owners;
- presence, shared live transcripts, followers, direct links, and concurrent
  chats;
- per-member runtime, SSH, Design, preview, forward, replica, export, and
  lifecycle authorization;
- independent member/device replica behavior;
- accepted ownership transfer, provider/agent/secret rebinding, generation and
  billing-epoch cutover; and
- multi-client ordering, revocation, owner-departure, billing, and isolation
  qualification.

The cloud engine remains the source/Git/chat sequencer. Phase 6A does not imply
CRDT source editing, collaborative Design canvas editing, or bidirectional
replica writes.

## Explicitly deferred

- cloud creation/catalog/details/onboarding and management UI in this branch;
- native iOS and Android applications;
- automatic bidirectional cloud/local file synchronization;
- in-place local/cloud authority movement;
- CRDT/OT source or Design editing;
- provider-to-provider live migration;
- UDP, public ports, custom preview domains, and Organization-wide port shares;
- offline authority election or peer-to-peer replicas; and
- publication of a Railway template before customer-owned operations are
  proven.

## Verification rule

Every code change requires adjacent regression tests first and the repository
verification matrix in AGENTS.md. Database suites run serially because they
reset the shared test schema. Live Daytona and signed macOS checks must be
reported as external qualification, never as passed from a Linux sandbox.
