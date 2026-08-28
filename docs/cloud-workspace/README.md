# Cloud workspaces

This folder is the current public engineering source for Zeros cloud workspaces.
It describes the product contract, target boundaries, security model, operating
requirements, and implementation sequence without depending on a particular
sandbox vendor.

Cloud workspaces are **pre-production** in this repository. The implemented
foundation includes the opt-in remote transport, attested cloud-worker runtime,
account/capability gates, signed ingress and credential coordinators, the
operator/protected-CI provider qualification harness, and a disabled-by-default
production control-plane foundation: durable workspace generations, quotas,
idempotent lifecycle APIs, a provider adapter, reconciliation, and fenced setup
worker orchestration with immutable generation inputs. The guarded execution
path now includes bounded Daytona commands, one-use admission redemption,
repository-scoped GitHub App credentials, encrypted setup-secret resolution,
the image-owned clone/settings/setup helper, a root-only process supervisor,
durable engine registration/heartbeats, and structured readiness attestations.
GitHub working credentials rotate through the heartbeat without persisting a
raw token in PostgreSQL. Drain-first generation replacement/rollback and the
coordinator-side SSH, localhost tunnel, and isolated HTTP preview APIs are also
implemented with verifier-only grants and durable provider-wide revocation.
Membership loss and WorkOS account deletion retire live client/engine authority
at the database boundary. Organization, Team, or temporary workspace-owner
deletion also cancels setup/replacement work and queues provider-verified
deletion for every generation, preventing hidden or ownerless paid sandboxes.
Electron main now owns a bounded client broker for those APIs: it can copy an
SSH command directly to the native clipboard, open Terminal or a supported
remote IDE, manage an exact `127.0.0.1` SSH forward, and inject a preview
capability only into the authorized Browser frame ancestry. Raw access
capabilities do not cross the IPC response into renderer state. Remote IDEs use
a fixed SSH alias and isolated per-launch state, so the short-lived provider
username is absent from their process arguments and recent-workspace records.
A second operator gate keeps setup execution disabled, so provider creation
still stops honestly at `setting_up` until the exact image and production
adapter have passed the protected live Daytona qualification. The native access
boundary is not yet bound to an end-user cloud workspace catalog/details UI and
has not passed a signed macOS/live-provider E2E run. There is still no end-user
desktop cloud management/connection flow, durable chat record, placement
migration, per-device local replica, web management surface, or mobile client.
The current database rejects cloud placement for the Personal tenant; the
target Personal-cloud contract requires an explicit forward migration.
Documents in this folder must distinguish implemented behavior from target
behavior.

## Documents

- [Product contract](product-contract.md) defines what users may rely on.
- [Architecture](architecture.md) defines runtime and repository ownership.
- [Data, placement, migration, and local sync](data-and-sync.md)
  defines sources of truth, recovery, conflict rules, Personal/Organization
  placement, repository settings, authority handoff, per-device replicas, SSH,
  forwarded ports, and the target data model.
- [Security](security.md) defines trust boundaries and release blockers.
- [Root coordinator exception review](root-coordinator-threat-model.md)
  records the unresolved privileged-engine decision and required evidence.
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
