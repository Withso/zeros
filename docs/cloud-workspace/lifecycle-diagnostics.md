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

Active allocation retries retain their closed error code and first-error time
on the lease, without appending an incident on each transient provider failure.
A complete successful recovery, including any required renewal, clears those
fields and recovers existing incidents. If the provider outage consumes the
checkpoint runway, its incident carries additive `stopReason: "provider_outage"`
JSON evidence. The stored legacy reason remains `safety_failure`; management
projects `provider_outage`, and the workspace error uses
`cloud_workspace_provider_outage` with fixed outage copy and the same incident
UUID. Stop escalation preserves that classification. No database migration is
required, and genuine safety failures retain their existing reason and message.

The setup executor passes closed transient provider diagnostics to the setup
worker instead of recording `reject_setup` immediately. The worker keeps its
existing retry backoff (five-second base in production) and records the diagnostic
only when retries are exhausted. Successful retries leave no rejection incident.
Nonrecoverable provider errors, helper failures and integrity rejections still
retain evidence immediately. The existing setup fence and admission revocation
apply to each retry.

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

## Explicit open and message wake (Cloud v2 Alpha)

With the staff-only `cloudComputerV2` toggle active, an explicit workspace open
or message submission prepares the exact workspace before session admission.
Selection restoration, history/catalog reads, hover/focus prefetch, app resume
and retained hidden views do not request wake. Existing history and drafts stay
available while the workspace starts. Concurrent open/send preparation shares
one connection flight and one lifecycle idempotency key. The renderer does not
retry a submitted prompt to repair a missing response.

A `ready` workspace may still have a queued or delivered idle final checkpoint.
Explicit preparation always crosses the server wake transaction, including on
an already connected runtime: it cancels uncommitted capture or waits for a
committed drain. Afterwards, a healthy connection revalidates its admission with
an authenticated engine workspace read; a retired connection obtains fresh
native admission. A list read does not prove the engine has finished unwinding
capture: Resume/enqueue retry only `CLOUD_WORKSPACE_CHECKPOINTING`, with backoff
from 250 ms to 2 seconds and one shared 60-second deadline. Every attempt keeps
the same operation/command identity, payload and expected revision. Cancellation,
connection retirement or conversation replacement ends the wait; other errors
retain their existing handling. A lost transport acknowledgement is not retried.

`POST /v1/organizations/:organization/cloud-workspaces/:workspace/wake` accepts
current run authority for stopped compute, including an exact-workspace guest
prompter or developer with a writer slot. Run authority is `canWrite`; it is not
edit authority (`canEdit`) or independent creation authority (`canStart`). The
owner remains the billing sponsor. Sponsor eligibility, funding/quota, managed
policy, recovery barriers and organization/workspace locks still apply. An
archived/failed workspace still requires management authority to restart.
Stop, archive, delete and sharing keep their existing independent authorization.
The request reauthorizes the actor before replaying an idempotency key.

Navigation away, hiding the window, account replacement or owner removal
cancels an open that is still pending. A concurrent explicit message retains its
own interest in that same flight. The composer shows **Cancel send** while its
cloud preparation is pending; Stop or closing the chat cancels that interest
without clearing the rich draft. A lifecycle mutation already accepted by the
server can finish after cancellation; cancellation does not send a compensating
Stop. Readiness polling stops after two minutes; an in-flight request retains
its existing request timeout. A later Stop, access loss,
generation change or failed wake ends the intent, without an automatic restart.
Retry is a new explicit user action. Wake retains the existing generation;
fresh runtime admission is minted only after readiness, with account, workspace
and generation checked again before connecting and dispatching.
The rich draft remains until the session provider owns a pending submission,
including its final preparation after attachment encoding. Preparation failures
surface in the composer; they do not clear the draft. A confirmed superseding
Stop, terminal failure or server rejection retires the wake idempotency key.
Only an unresolved transport outcome retains that key for a retry.

### Alpha live acceptance runbook

This procedure requires a signed Alpha desktop on macOS and the completed C5,
B8 and B10 integration. Local Vitest results do not qualify Boat restore, the
signed client or disk persistence. Run it from the orchestrator's credentialed
workspace; credentials must not be copied to an implementation workspace.

1. Run `pnpm agent:check` there. This existing read-only preflight script reads
   `.env.agent` and reports closed diagnostics. Use only Alpha/test resources.
   Enable Cloud v2 in Internal settings on each staff test account/device.
   Record the app revision, C5/B8/B10 revisions and their successful persistence
   and lifecycle qualification receipts in the private acceptance record.
2. Through the Alpha desktop, fork a sanitized Cloud Computer template into a
   workspace named `zeros-v2-test-e4-open` and a second named
   `zeros-v2-test-e4-message`. Record their organization/workspace/generation
   IDs, provider sandbox/snapshot IDs, accepted runtime/base/template/environment
   pins, and initial boot/session/engine identities privately. Confirm that
   B10's backing/machine-identity receipts and C5's primary/secondary projections
   match these exact forks before testing E4.
3. Establish distinct owner, developer, prompter and viewer accounts/devices.
   Include a current guest writer with only exact-workspace access. Confirm
   that its writer slot is assigned. Keep manager lifecycle and sharing controls
   separate from the guest's run permission. Use E5's approved sharing flow;
   do not modify membership or billing tables to manufacture access.
4. In the open fixture, save a small primary-repository edit and leave a rich
   unsent draft with an attachment. Record the chat ID and history tail IDs.
   Exercise B8's busy cases: an open terminal, background job, active agent,
   run action and unexpired native-service grant must each prevent idle stop.
   Close/retire the workloads and grants, then record the quiet-start time.
   Leave the workspace unselected for a genuine **at least 600 seconds** plus
   observation/checkpoint latency. Do not shorten the clock or click Start/Stop.
5. From the orchestrator's authorized read-only lifecycle evidence, require the
   final checkpoint to be durably committed before the provider Stop completes.
   Record checkpoint/request/lifecycle IDs and their timestamps, the stopped
   status and retired engine authority. Consume B8's failed-final-capture and
   activity-race qualification evidence for this build: failed capture must
   leave compute running or report the reconciled failure, and new live work
   must prevent an unproven stop. If either prerequisite lacks live evidence,
   mark that acceptance row unverified rather than inducing a global fault.
6. While it is stopped, browse catalog/history from another view, hover/focus
   its sidebar row, resume the app and retain its hidden tab. Observe for two
   normal catalog intervals (at least 60 seconds). No new wake intent, provider
   start or runtime admission may appear. The saved draft/history must remain
   attached to the original account/workspace/chat.
7. Explicitly select `zeros-v2-test-e4-open`. Do not press Start. Require one
   wake intent followed by fresh admission and a usable runtime. Compare the
   private before/after record: new boot/session/engine authority, unchanged
   accepted runtime/base/template/environment pins, preserved primary edit,
   draft and history. Old engine/device grants must fail to reconnect. Repeat
   with the workspace asleep across B8's separately authorized channel-head
   advance; an existing fork must still retain all its accepted pins.
8. In the message fixture, let the selected workspace idle through the same
   genuine quiet/checkpoint/stop sequence. Submit a uniquely identifiable test
   message directly from the retained composer. Press Enter again while wake
   is pending. Require one original user-message/command identity and exactly
   one execution after readiness; record the IDs and resulting checkpointed
   file edit. There must be no ordinary command admission before wake completes.
   Repeat with explicit open and send overlapping and with a temporary response
   loss after dispatch: reconnection must not replay a possibly accepted prompt.
   Also submit to a paused conversation while its real idle checkpoint is
   queued/delivered and its workspace still reports `ready`. Require capture
   cancellation before Resume, admission revalidation and one execution. Hold
   capture across server cancellation: Resume must remain pending until the
   engine observes cancellation and releases its fence, then enqueue once.
   Verify the 60-second timeout and cancellation leave no delayed enqueue. For a
   committed capture, require completion of the drain and fresh admission first.
   Retire the connection or request Stop during attachment encoding: a failed
   final preparation must leave the rich draft intact and show an error.
9. Repeat the authorization and cancellation cases below. A rejected or
   cancelled preparation must preserve the draft, attachments and history and
   must never dispatch its message to another workspace/account.

   | Case | Required result |
   | --- | --- |
   | Member/guest developer or prompter opens/sends | Wake succeeds with the existing sponsor; guest cannot list the organization or stop/delete/share the workspace |
   | Viewer, expired/revoked grant, missing writer slot, different workspace | No wake or admission; replay after revocation is also rejected |
   | Ineligible sponsor or exhausted quota | Wake denied; no sponsor substitution; draft remains |
   | Cancel send while waking; then explicitly retry | Cancelled message never executes; retry executes once |
   | Open A, switch to B, then reopen A while the old reply is delayed | Old reply cannot replace B or erase A's replacement intent |
   | Open plus send; cancel only the open by navigation | Original message continues for A once; B stays independent |
   | Change account, remove owner access or advance generation during wake/admission | Late response is rejected and any late native connection is closed |
   | Manager Stop wins after wake began; then explicitly retry once stopped | Original intent ends with no delayed message; retry gets a new wake identity and starts compute |
   | Restore a saved selection or disable Cloud v2 | Existing read-only behavior; no implicit wake |

10. Cleanup as the owner using normal Alpha lifecycle controls. Delete both
    test workspaces and every additional `zeros-v2-test-` fixture created for
    the run, revoke temporary sharing/grants, and verify provider sandbox and
    snapshot deletion receipts. Remove only the test template/build if this run
    created it. Record every resource ID and its confirmed cleanup outcome;
    unresolved provider cleanup keeps acceptance incomplete. Do not print
    credentials, signed URLs, raw provider bodies or unsanitized runtime logs.

The acceptance record must distinguish local tests, signed-Mac observations and
provider evidence. No live resources are created by the E4 implementation tests.

## Worker scheduling

Lifecycle and setup workers accept payload-free PostgreSQL hints on
`zeros_cloud_lifecycle_work` and `zeros_cloud_setup_work`. Migration 0134 emits
these after committed eligible queue writes, prerequisite completion, and
provider/workspace setup availability. The hints identify neither an owner nor
an operation; each worker uses its existing authorized, fenced claim query.
No start/stop/upgrade decision, setup verification, or retry deadline changes.

One dedicated runtime-privilege connection per control-plane replica listens
on both channels, using `DATABASE_LISTEN_URL` when configured and otherwise
`DATABASE_URL`. It never consumes request-pool capacity. Reconnect repairs the
notification gap by scheduling both workers; reconnect backoff is 1–30 seconds
and sessions retire at the database connection lifetime. Notification failure
leaves normal polling enabled. No new environment variable is required.

Workers coalesce hints and retain one hint received during an active tick.
They never overlap ticks. Notifications do not postpone the existing polling
clock or accelerate lifecycle drift, lease/authority maintenance or orphan
sweeps. Future retries and expired claims still progress through polling, using
the existing `next_attempt_at`/lease checks. Stop discards pending hints, drains
active lifecycle work, and retains setup cancellation behavior.

The configured defaults are a 5,000 ms lifecycle interval and a 1,000 ms setup
interval. Without contention, polling alone can add up to one interval at each
handoff; notification delivery removes that intentional wait when available.
This is a code-derived latency opportunity, not a live end-to-end measurement
or a guarantee of 1–2 second wake. Provider restore, runtime verification,
engine registration, client admission and the CONNECTED probe remain on the
critical path. Validate live on disposable Alpha workspaces before claiming
the target is met.

Local workspaces (Personal or organization-owned) never enter these workers.
Cloud authorization remains keyed by organization, workspace and generation;
owner/placement switching introduces no new client state or wake behavior.

### Boat restore readiness polling

The v4 setup transport can observe provider `running` before the guest accepts
commands. Its fixed, secret-free base-status probe now retries classified Boat
409 `boat_starting` / `boat_restoring` responses and retryable 5xx responses every
two seconds within one fenced setup claim. The phase is bounded to 120 seconds
(or the configured command timeout when shorter) and honors cancellation.
A longer provider Retry-After, other conflicts, rate limits, access failures,
invalid base identity, and failed guest status go directly to normal setup
failure handling. Once the status command responds, neither SSH nor installer,
attestation or setup execution is retried by this phase.

This avoids spending 5/10/20/40-second claim backoffs on an allocation whose
restored guest is almost command-ready. It does not change the worker's retry,
upgrade/rollback or readiness publication decisions. Exhaustion returns the
closed provider error to those existing policies. A persistent provider outage
can occupy a setup slot for the bounded phase; it cannot publish readiness.
Local and organization-owned local workspaces, legacy cloud setup and owner
switching use their existing paths. No new environment flag or migration is
required. Measure a real stopped wake after deployment before claiming a saved
latency; a 5xx response alone is not proof of the guest's boot state.
