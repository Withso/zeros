# Lifecycle evidence and idle liveness

Migration 0114 adds a private, RLS-protected incident store independent of
mutable workspace and compute-lease error fields. The organization/workspace,
generation and operation identity link compute leases to their lifecycle intent
and provider binding, or setup runs to their execution fence. Only current,
matching claims may append setup/compute evidence. Complete successful
reconciliation records recovery without erasing the original cause. Ready
publication records its timestamp/generation on the workspace row only; it never
locks incident rows. Its `BEFORE UPDATE` trigger is named to run after 0113's
quarantine guard, so rejected ready attempts cannot advance that boundary.
Future readiness guards must also run before the boundary writer. Each compute
worker pass retries up to 256 recoveries with
`SKIP LOCKED`, even when hourly cleanup is not due or no allocation needs work.
The committed boundary survives a subsequent stop and excludes failures first
observed after publication. A helper readiness response alone cannot mark
recovery before the worker commits it.

Diagnostic input uses closed phase and error-class enums, an explicit code
allowlist, validated SQLSTATE and HTTP status class, bounded timing/TTL values,
and fixed image checks/file-presence flags. It never retains messages, stack or
cause chains, command output, provider bodies, arbitrary paths, environment,
credentials, or repository contents. Storage attempts have a 500 ms lock timeout
and 2 s statement timeout; failure still takes the safety-stop path and attempts
a bounded operational failure counter. This is evidence, never an alternative
to image attestation, engine authorization, or a durable checkpoint.

Each event is limited to 4 KiB including its timing/count wrapper. Repeated
phase/code/SQLSTATE events coalesce into first/last/count. An incident retains
at most 16 events and preserves its first and terminal cause when compacting.
Once a cause initiates a checkpoint or direct stop, its classification and
terminal cause remain fixed through draining and settlement. Expected repeated
drain observations reuse that incident without incrementing its count; actual
later failures still append bounded events. A direct-stop escalation keeps the
initiating reason and reference.
At most eight incidents (128 events) remain per workspace. Organization caps
are 2,048 incidents / 8 MiB of serialized rows; global caps are 16,384 incidents /
64 MiB. Both byte caps reserve 64 bytes per row for later recovery timestamp and
generation growth, so recovery needs no aggregate retention lock. Capacity
pressure evicts oldest whole incidents. A durable hourly cleanup
job, serviced by the existing compute reconciliation loop even when no allocation
is due, removes event detail after seven days and terminal summaries after
30 days without further occurrences. Worker restart retains the cleanup deadline.
Account/workspace erasure still cascades this private evidence.

Workspace management returns bounded `incidents` with stable references,
first/last/count, recovery time, and distinct `budget_stop`, `safety_failure`,
`engine_expired`, and `image_integrity_rejected` reasons. General management
responses omit SQLSTATE, provider identities, balance, and detailed diagnostics.
Stopped/failed workspace responses prefer the cause that first initiated the
current generation's stop, otherwise the latest unrecovered incident, in the
existing two-key `error` shape. The public
budget code stays compatible; the message includes only the fixed reason and
incident UUID. Ready publication clears this active error while retaining history,
even when incident recovery bookkeeping is still waiting to run.

Setup success and exact-key v1 failure parsing remain compatible. New helpers
return **version 2 failures only**, using the existing result audience and a
strict version 1 `diagnostic` envelope. Older control planes fail closed on these
errors; they still accept unchanged v1 successes. New control planes accept both
failure versions. The helper reports separate source, engine-artifact and native
OS/package/Node comparisons on image rejection. Boat can probe a fixed four-file
list via its command channel when the Node bootstrap helper cannot start. No
probe can make failed attestation admissible.

The engine observes idleness every 15 seconds independently of record-sync
completion. Real work resets the ten-minute monotonic quiet clock; failed and
no-op stops use a separate 15–120 second retry backoff. Content-free
`idle_stop_blocked` observations include a fixed reason, elapsed quiet time and
retry interval. Final capture and engine-authority checks remain mandatory.
Paused durable queues are sleeping work. Dispatching commands, unpaused queues,
execution leases and other live work still prevent idle stop. Resume shares the
workspace lock with checkpoint admission and completion; pending idle capture
rejects Resume, and a completed old-engine capture never silently unpauses a
queue on a replacement engine. Resume stays explicit.

`GET /v1/organizations/:organization/cloud-workspace-management/pending-deletion`
is an organization-admin cleanup inventory, separate from workspace navigation.
It reports generation, receipt stage, request age, time since stage progress,
next retry and reserved CPU/memory/storage (up to 500 entries with truncation).
It never releases disk without the binding's deletion proof. Receipt progress
advances only at a new monotonic stage, not retries or blocked/processing
oscillation. Health reports `deletion_intent_stalled` for failed intents,
one-hour lack of progress, or 24-hour total age, including retirement while a
replacement workspace remains active. Old pending idle checkpoints report
`idle_stop_blocked`. These are aggregate health reasons without tenant IDs.

Legacy credential compatibility is reconciled at organization discovery/selection
and after legacy workspace delegation. Only credentials actually delegated into
the exact non-personal organization by a current member gain a private association.
An association neither selects a provider nor creates organization connection
consent. Connection classification derives from kind and the current material's
expiry (including expiring Cursor account tokens). This works for the released
write shape after 0106; no Alpha credential backfill is required by the measured
empty tables.
