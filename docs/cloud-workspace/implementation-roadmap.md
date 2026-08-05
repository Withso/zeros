# Cloud workspace implementation roadmap

This is a living delivery checklist. An unchecked box is not a shipped
capability. Update code anchors and exit evidence in the same change that marks
an item complete.

## Phase 0 — Validation foundation

- [x] Add an opt-in, token-gated engine `CloudTransport` without weakening the
      local loopback/origin boundary.
- [x] Cover health, token rejection, connection lifecycle, ping/pong, and bridge
      round trips with unit tests.
- [x] Build the operator-only `scripts/cloud-workspace-validation/` harness with
      private atomic state, fail-closed native dependency rebuilds, lifecycle
      checks, and cleanup.
- [ ] Run the full provider-account sequence, including soak and delete, and
      record sanitized measurements privately.
- [ ] Resolve runtime redistribution/authentication and dependency-security
      release blockers for the remote image.

Exit: representative provider runs prove image, ABI, bridge, PTY, reconnect,
egress, lifecycle, soak, and cleanup behavior without credentials in logs or
tracked files.

## Phase 1 — Control-plane contracts

- [ ] Define stable workspace, generation, provider-binding, lifecycle-intent,
      endpoint-grant, setup-run, and audit schemas.
- [ ] Add forward-only PostgreSQL migrations and tenant-isolation tests.
- [ ] Add authorized, idempotent create/get/list/stop/wake/archive/delete APIs.
- [ ] Add a provider interface and one production implementation behind it.
- [ ] Add reconciliation workers for timeouts, drift, and orphan cleanup.
- [ ] Add quotas and per-operation audit records before enabling creation.

Exit: API and reconciliation integration tests cover duplicate requests,
timeouts after dispatch, revoked membership, concurrent lifecycle intents, and
provider drift.

## Phase 2 — Production execution environment

- [ ] Produce a pinned, licensed, reproducible engine image.
- [ ] Run the engine and setup steps as a non-root user with bounded resources.
- [ ] Issue short-lived repository and engine grants; keep provisioning
      credentials outside the sandbox.
- [ ] Implement readiness, sanitized setup logs, stop/wake/delete, and image
      generation upgrades.
- [ ] Enforce inbound and outbound network policy and verify snapshot deletion.

Exit: a fresh authorized repository reaches readiness, survives stop/wake, and
is completely revoked/deleted through repeatable end-to-end tests.

## Phase 3 — Desktop remote workspace experience

- [ ] Add an authenticated remote bridge client with protocol negotiation,
      reconnect, bounded resume, and stale-state presentation.
- [ ] Add create/open/status/setup/retry/stop/wake/archive/delete surfaces.
- [ ] Keep local and cloud destination identity atomic and owner-keyed.
- [ ] Implement the approved file-access strategy without making every editor
      read depend on a high-latency network round trip.
- [ ] Preserve explicit Git publish/rebase/merge behavior across targets.

Exit: UI smoke and race tests cover exact-workspace isolation, A → B → A
restoration, stale responses, reconnect gaps, hidden-surface inertness, and
destructive-action confirmation.

## Phase 4 — Durable record and recovery

- [ ] Add versioned records for chats, messages, turns, agent sessions,
      workspace metadata, checkpoints, and stream revisions.
- [ ] Implement idempotent write-through and bounded catch-up.
- [ ] Rebuild a fresh execution environment from Git, checkpoint, and durable
      record without relying on a provider snapshot.
- [ ] Add export, retention, deletion propagation, backups, and restore drills.
- [ ] Measure durable-write lag and surface degraded durability honestly.

Exit: disaster-recovery tests restore representative workspaces and prove
tenant isolation, event deduplication, revision-gap recovery, and deletion.

## Phase 5 — Web control and operations

- [ ] Add authorized cloud-workspace management to `apps/web` using the same
      control-plane APIs.
- [ ] Add owner-visible setup logs, lifecycle history, quotas, and usage.
- [ ] Add operational dashboards and alerts for reconciliation drift, orphaned
      resources, durable-write lag, and restore failures.
- [ ] Document incident, rollback, provider outage, and credential-rotation
      procedures.

Exit: desktop and web show consistent authorized state, and operators can
detect and recover every supported lifecycle failure.

## Phase 6 — Collaboration and future clients

- [ ] Authorize multi-user connections by workspace membership and role.
- [ ] Add presence and shared live-session semantics without client-side turn
      merging.
- [ ] Define collaborative source/design editing separately from agent-chat
      sequencing.
- [ ] Create iOS and Android apps only when their real build boundaries and
      control use cases are ready.
- [ ] Validate revocation, device loss, offline resume, notification, and deep
      link behavior for each client.

Exit: multi-client authorization and ordering tests pass, and every platform has
signed release, security, and lifecycle verification.

## Roadmap retirement

Do not delete this roadmap merely because development started. When every item
is implemented, rejected with rationale, or moved to another owned roadmap,
move lasting contracts into the durable cloud-workspace documents and replace
this file with a concise shipped-status and verification record.
