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
idempotent lifecycle APIs, a provider adapter, and reconciliation. Provider
creation currently stops honestly at `setting_up`; there is still no production
setup worker, workspace-bound engine grant, desktop management UI, durable chat
record, web management surface, or mobile client. Documents in this folder must
distinguish implemented behavior from target behavior.

## Documents

- [Product contract](product-contract.md) defines what users may rely on.
- [Architecture](architecture.md) defines runtime and repository ownership.
- [Data and synchronization](data-and-sync.md) defines sources of truth,
  recovery, and conflict rules.
- [Security](security.md) defines trust boundaries and release blockers.
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
