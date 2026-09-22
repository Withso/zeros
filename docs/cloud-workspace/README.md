# Cloud workspaces

This folder is the current public engineering source for Zeros cloud workspaces.
It describes the product contract, target boundaries, security model, operating
requirements, and implementation sequence without depending on a particular
sandbox vendor.

Cloud workspaces are **pre-production** in this repository. The original non-UI
foundation roadmap through Phase 5 is implemented behind release gates. The
provider and multi-device expansion described in the client/runtime contract
has separate implementation and qualification work remaining:

- WorkOS proves account and Organization identity. Zeros remains authoritative
  for Personal's local-only boundary, individual Pro account authority,
  Business/Enterprise seats, Team and repository scope, workspace ownership,
  billing epochs, quotas, and every paid-runtime admission.
- The control plane owns immutable workspace/generation identity, idempotent
  lifecycle intents, provider-connection versions, encrypted settings and
  secret resolution, short-lived GitHub credentials, usage attribution,
  reconciliation, outbox delivery, retention, export, and deletion.
- The image-owned setup path uses one-use admission redemption, bounded
  commands, immutable readiness attestation, engine registration/heartbeats,
  credential rotation, and drain-first generation replacement/rollback.
- PostgreSQL stores the ordered durable record and content projections.
  Encrypted blobs and checkpoints use the object-store abstraction; the hosted
  filesystem adapter is hardened for a private mounted Railway volume.
- Local-to-cloud and cloud-to-local are immutable copy/fork workflows. The
  destination always receives a new workspace UUID and the source remains
  unchanged. Each authorized member/device receive-only replica may mirror a
  cloud workspace, but never becomes cloud authority or uploads local edits.
- Electron main owns exact-execution remote connection leases, short-lived SSH,
  authenticated previews, and `127.0.0.1` forwards. Raw provider capabilities
  do not enter renderer state.

Public cloud routes and `CLOUD_WORKSPACE_SETUP_WORKER_ENABLED` must
remain disabled until the exact images for each enabled provider, lifecycle/rollback/delete paths,
engine/worker isolation, and signed macOS SSH/preview/tunnel flow have passed
their protected qualification. Repository tests are not substitutes for that
evidence. A staff-only isolated API qualification backend may set
`CLOUD_WORKSPACES_ENABLED=true`, `CLOUD_WORKSPACE_BACKGROUND_WORKERS_ENABLED=false`
and `CLOUD_WORKSPACE_SETUP_WORKER_ENABLED=false`. This pauses background loops;
it does not block direct provider calls. Qualification must avoid provider
operations until their separate release gates pass.

End-user cloud creation/catalog/details UI is deliberately not wired yet.
Organization sharing and individually entitled external collaborators have
backend contracts, regression coverage and isolated deployed API evidence.
Provider runtime and native client qualification remain open. Presence UI,
ownership transfer execution, mobile apps, and a published customer-managed
Railway template are later work. Documents in
this folder distinguish implemented repository behavior from release
qualification and deferred product surfaces.

## Documents

- [Agent authentication and language tools](agent-authentication-and-language-tools.md) defines personal consent, native subscription renewal and bounded language services.

- [Qualification status](qualification-status.md) separates the current eight
  backend steps, native tool coverage, live evidence and remaining release gates.
- [Managed compute credits](compute-credits.md) defines explicit grants,
  reservations, finite provider leases, settlement and operator rollout.
- [Database qualification](database-qualification.md) defines the selected
  PlanetScale Postgres target, migration prerequisites and recovery acceptance.
- [Product contract](product-contract.md) defines what users may rely on.
- [Architecture](architecture.md) defines runtime and repository ownership.
- [Provider contract](provider-contract.md) defines generation-bound selection,
  operation evidence, asynchronous deletion and the current integration gates.
- [Client and runtime contract](client-runtime-contract.md) defines the backend
  expansion for independent provider connections, shared Code/Design sessions,
  live access from multiple devices, and complete recovery. Its acceptance
  requirements are not claims of completed implementation or qualification.
- [Data, copies, and local sync](data-and-sync.md)
  defines sources of truth, recovery, conflict rules, Personal/Organization
  placement, repository settings, immutable forks, per-device replicas, SSH,
  forwarded ports, and the target data model.
- [Native checkpoint recovery](checkpoint-native-format.md) defines chunked Git,
  harness, Design and attachment recovery, its bounds and format compatibility.
- [Security](security.md) defines trust boundaries and release blockers.
- [Root coordinator exception review](root-coordinator-threat-model.md)
  records the privileged coordinator boundary, unprivileged engine/worker
  separation and required provider evidence.
- [Infrastructure and operations](infrastructure-and-operations.md) defines
  image, lifecycle, observability, and provider requirements.
- [Enterprise and self-hosting](enterprise-and-self-hosting.md) defines the
  control-plane/data-plane seams to preserve.
- [Implementation roadmap](implementation-roadmap.md) is the temporary delivery
  checklist.
- [Engineering reference](engineering-reference.md) maps the plan to current
  code and validation commands.

## Retention policy

Do not delete the whole folder when cloud workspaces ship.

- Keep the product contract, architecture, data, security, operations,
  enterprise, and engineering-reference documents synchronized with the
  implementation.
- Retire a roadmap item only after its exit criteria and tests pass.
- When the roadmap is fully resolved, replace it with a short shipped-status
  page or move its lasting decisions into the durable documents.
- Keep dated vendor comparisons, pricing snapshots, reverse-engineering notes,
  credentials, and account-specific deployment investigations in the private
  planning system, not this public repository.

The former July 2026 research pack remains recoverable from Git history but is
not authoritative: it duplicated Markdown as generated HTML, referenced the old
repository layout, and mixed durable architecture with time-sensitive market
research.

## Authority

Code, tests, database migrations, and deployment manifests remain authoritative.
When a document and working behavior disagree, fix the document in the same
change and add a test for the intended contract where practical.
