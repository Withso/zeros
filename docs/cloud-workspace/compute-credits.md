# Managed compute credit contract

Managed Boat allocations require prepaid, finite compute leases. Unsupported
persisted providers fail closed; their historical schema records and seed rows
do not authorize allocation or bypass Boat credit admission.

The [Pro backend](pro-backend.md) automatically issues one monthly allowance
per eligible user: 500 standard-machine hours, recorded as a server-defined
receipt under the existing funding lock. Staff receive independently audited
complimentary Pro with the same limits. Payment collection remains a separate
integration. Deployed staff-pilot receipts remain historical evidence; overlapping
pilot periods block automatic issuance until an explicit cutover is resolved.

Credits are integer micro-US dollars (`1 USD = 1000000 micro_usd`). A Pro
funding receipt belongs to one user and explicit period, independent of any
organization. Reservations in multiple organizations conserve that single user
allowance. Joining another organization never duplicates it. The workspace owner
sponsors compute; a collaborator's action does not change the payer. Business
organization grants remain a separate ledger and cannot replenish Pro-backed
periods. Eligibility does not bypass the allowance issuer or ledger. At a
qualified 100,000 standard seconds per dollar, the monthly receipt is
`18000000` micro-USD. There is no rollover, automatic invoice collection,
customer overage or model-token allowance here.

## Allocation and settlement

The control plane reserves the entire forecast before sending create, resume
or renewal to the provider. The reservation covers the finite TTL plus a
request margin. A database claim prevents a superseded worker from extending
credit. Retries retain the allocation identity and request TTL. Unknown provider
outcomes retain their holds until independently reconciled.

A temporary create/resume failure can retry while its original lifecycle
intent, generation, payer and paid authority remain valid. The initial claim is
created atomically with the lease. An unconfirmed start retains its reservation
for at most 45 minutes from the original request, also bounded by its funded
window; retries never reset that deadline. A currently absent or still-archived
VM does not finalize a pending start. Stop and credit settlement check the
worker's live claim under the mutation lock, so a late provider response cannot
cancel or refund an allocation recovered by another worker.

Boat's weighted allocated seconds are metered cumulatively within each exact
period. The provider's reported price must match the configured versioned
policy. Workload CPU counters are not billing evidence. A repeated or older
watermark cannot debit twice. Confirmed future periods can fund a lease across
a boundary; an assumed future subscription renewal cannot.

The provider deadline and funded window also gate engine and human-service
authority. A lost control plane therefore cannot leave an indefinitely funded
VM. The worker renews only after reserving the extension. A running
allocation's Boat usage is read and metered at most once an hour; its open
reservation holds the whole authorized window meanwhile, so the delay never
changes a funding decision. A stop or period end is metered at once. A
nonrecoverable provider error, policy mismatch or exhausted balance starts a bounded final
checkpoint and stop. Near the deadline it stops directly, retaining the last
durable checkpoint. Budget enforcement never permanently deletes the VM.

An exact-generation user stop or archive already in progress owns its final
checkpoint. A lease tick adopts that intent instead of superseding it or
cancelling its capture. An ordinary requested stop is not a lost compute scope.
The existing provider and funding limits still bound the drain: at expiry, the
worker escalates the same intent, records the checkpoint request as cancelled
with `stop_unsealed`, and retires authority before provider dispatch. It never
marks an incomplete checkpoint successful or extends the funded window.

Once a lease adopts a safety stop, cancelling final capture cannot cancel that
stop or reset its deadline. A wake, including an otherwise warm no-op, waits
on the same mandatory drain. The cancelled capture remains cancelled until
the original deadline or a tighter budget limit requires `stop_unsealed`.
Ordinary idle captures remain reversible when work resumes. Database guards
preserve mandatory drains across older lifecycle writers during rollout.

Final checkpoint completion also requires the active native command writer's
seal. Every lifecycle stop, archive and delete checks that gate before provider
dispatch; direct deletion settlement without an admitted stop first requests
one. A native writer whose authority has already closed cannot be reactivated
just to seal. That case, or an explicit seal-deadline fallback, records an
idempotent `cloud_workspace.stop_unsealed` audit receipt with the exact
workspace, generation, intent, checkpoint request and writer epoch. The receipt
records an unsealed stop decision, not positive provider retirement proof.
Credential retirement still requires the independently confirmed provider
outcome. A completed seal does not manufacture a missing durable checkpoint,
and an unsealed receipt does not authorize restore from an older checkpoint.

A cold wake also needs positive retirement of its previous boot source before
runtime replacement, allocation or provider start. Owner requests, queued
legacy wakes and drift use the same prerequisite. A terminal drain failure
stays visible; a fresh owner retry requeues it without treating revocation as
retirement or shortening an active provider backoff. Warm receipts with no
mandatory drain and already retired sources do not require another stop.

Retryable provider failures on an active allocation retain its credit hold and
retry with the existing 15-second to five-minute backoff while payer, generation,
engine and paid authority remain current. The retry window ends 315 seconds
before the earlier confirmed provider/funding deadline: the existing five-minute
checkpoint cap plus 15 seconds for stopping. Backoff cannot cross that boundary.
The first successful recovery pass attempts provider TTL renewal even before the
normal half-TTL renewal threshold. Funding alone never clears a failed renewal's
error clock. An exhausted outage runway requests a checkpoint stop, escalating
to the existing direct-stop fallback at 45 seconds; it never invents usage
or releases an unsettled reservation.

While a draining lease still lacks positive stopped proof, both ordinary
polling and failure backoff stop at its earlier pending checkpoint deadline or
the 45-second force boundary. The worker requests due escalation before
provider inspection, using the current claim and generation. After that
attempt, retries keep the normal 15-second cadence within the remaining
provider/funding TTL and cannot cross its expiry. Once the finite window is
past, failures keep normal backoff instead of repeatedly scheduling an expired
deadline. A positively stopped allocation awaiting final metering keeps its
coverage delay and normal settlement backoff throughout; `draining` alone does
not mean a stop is still needed. None of these deadlines prove provider
retirement, extend funding or release an unsettled hold.

A ready/busy workspace must also have a live current-generation engine before
its compute lease can renew. Expired engine authority stops compute even when
credit remains. Bootstrap uses the existing setup deadline; a failed workspace
cannot keep renewing under its initial provisioning allowance. Engine loss
does not authorize a replacement allocation or automatic prompt replay.

Final settlement requires an independently stopped/archived allocation and a
provider meter covering the stopped observation. A paused billing flag on a
running VM is insufficient. Permanent deletion waits for settlement while the
provider usage API is still available. Unused future reservations are released
without querying a future usage interval. A missing resource or an accepted
DELETE is not proof of absence or a zero bill. Unrecoverable final usage stays
visible as an operator reconciliation failure; it is never invented.

A provider can later report less usage for a window that was already metered.
For a running allocation, or any reading with the wrong allocation, price or
window, that rejection remains a reconciliation failure. After an independent
stopped observation, a lower final reading is rejected and retried. Once the
stop was first observed at least 15 minutes earlier, a retried lower reading
settles the allocation at its confirmed meter. The bill is never lowered, time
after that meter is not billed, and the remaining hold is released.

Actual usage beyond an authorization is recorded as platform exposure, not
customer debt. Later grants cannot retroactively charge that exposure. This
initial policy meters allocated compute. Provider snapshot/storage/network
charges and Zeros durable-object costs require separate operational budgets;
they are not silently debited as compute seconds.

### Lease check cadence

A healthy running lease is next checked at its renewal point: half the
maximum TTL before the provider deadline, or 315 seconds (the checkpoint and
stop margin) before it when that is earlier. The next check is at least 15
seconds and at most 10 minutes away. A failing check keeps its backoff.
Migration `0160_cloud_compute_lease_recheck.sql` re-checks every unsettled
lease of a workspace at once when its desired state, generation, owner,
billing epoch or deletion changes, or when its status moves into or out of
`failed` or the serving statuses `ready` and `busy`. A start refused with
`compute_previous_lease_pending` re-checks the previous lease at once. A check
requested while a lease is being checked is kept: the running check never
replaces it with its own later schedule. The trigger skips a lease whose row
another transaction holds, so a workspace write never waits for one; that
lease is still checked at its scheduled time. Each metered increment is
compared with the allocation's weighted wall-clock time; a difference above
max(60 s, 5 %) is recorded in `managed_compute_usage_disagreements`, audited as
`cloud_compute.usage_disagreement` and raises `compute_usage_disagreement` for
24 hours (an under-report only after a running allocation's first window).

A failed check that carries a provider wait (an HTTP `Retry-After` or
Boat's body wait, capped at five minutes) is not retried sooner, but an
active allocation is still re-checked before its checkpoint and stop margin.

### Exact previous-allocation waits

The internal `lifecycle_allocation_waits` organization flag enables a scheduling
edge only after the ordinary allocator refuses an exact previous allocation.
A funded running allocation can still satisfy a warm wake before that refusal.
Incomplete blocker identity keeps the ordinary retry. Both the current provider
binding and the refused lease must already name a resource in the original
attempt. Independent settlement may fill a missing identity before publication;
that attempt still retries and never adopts the later binding into an edge.
The flag does not grant compute authority or change a client/engine contract.

Migration `0172_cloud_lifecycle_scheduling.sql` stores one immutable edge per
lifecycle intent. It freezes the organization/workspace/generation, original
owner, billing and authority epochs, source and predecessor, provider
connection/version/resource, and exact allocation/owner revision. The writer
holds the normal parent/intent locks but never waits on a monetary lease or
allocation-owner lock; those tables have no foreign key from the edge.

An unchanged pending edge releases the worker claim and has no recurring timer,
retry audit, or repeated provider/funding attempt. Both edge publication and
independent settlement enqueue the workspace's existing lifecycle job in their
transactions. Each settlement transition enqueues even when no edge is yet
visible, so crossing transactions cannot drain the edge's job before settlement
commits and then lose the wakeup. This is one coalesced hint per settlement,
including a harmless job when there is no waiter. Scope changes enqueue
re-evaluation, and the existing lost-job audit repairs a missing hint. Settlement
enqueues without updating or locking a waiter. The legacy error-based settlement
nudge excludes pending edges.

Resolution requires the original lease to be positively settled with no open
reservation, its original identity and owner revision intact, any saved
predecessor successful, and any old source and final-save dispatch retired.
A destructive predecessor's exact successful request and checkpoint are frozen
with the edge. Initial resolution uses the final-save dispatch proof; afterward
the original historical receipt is checked without mistaking this continuation's
own new allocation for an unrelated replacement. Checkpoint invalidation, a new
engine/token incarnation, or different allocation still refuses continuation.
A different allocation reusing the resource is not that proof. Changed scope
retires only the old continuation; it cannot update the replacement workspace,
adopt new authority, or synthesize a new wake. The normal runtime/provider,
funding, deadline and source checks run again. The original lifecycle claim and
frozen edge are checked after funding and before accepting a late result. All
independent meter floors, retry deadlines and reservation custody remain.

Deploy all readers and the SQL dispatch guard before enabling new edge writes;
drain old dispatchers before rollout. Disabling the flag, including loss of its
change feed, stops new writes only. Keep the readers, guard and durable enqueue
path until pending and resolved edges finish; deleting edges or rolling back
past their reader is not a safe rollback. Local workspaces do not use this path.

## Configuration and rollout

Managed Boat requires `BOAT_COMPUTE_POLICY_ID` and
`BOAT_SECONDS_PER_DOLLAR`, pinned to an observed provider billing contract.
`BOAT_TTL_SECONDS` is the maximum renewable lease, from 60 through 3600 seconds.
The default minimum funded lease is the smaller of 600 seconds and that maximum.
The request margin is the configured operation timeout plus five seconds.
`none` is not a managed-compute deployment option.

Migration `0073_cloud_workspace_compute_leases.sql` is a controlled rollout:
stop old lifecycle workers, back up the database, and stop existing hosted Boat
allocations before applying it. Provision explicit credit receipts and deploy
the new reconciler before resuming. Do not run an older allocator alongside the
new spending boundary. A rollback must leave Boat allocations stopped and
cloud execution disabled; do not disable the credit gate to revive them.
Existing provider credentials and immutable image references stay unchanged.
The managed Boat deployment variables are listed in
the control plane's [environment example](../../apps/control-plane/.env.example).

## Grant operations

The operator command defaults to a read-only plan and requires an active
`platform_owner` on execution. Explicit `fundingScope` selects the user or
organization ledger. Receipt identities are global across users for individual
funding; changing their user, amount or period conflicts. No public HTTP route
can grant funds, set prices or submit provider billing evidence.

Prepare a private JSON document containing `channel`, `fundingScope`, `userId`,
`actorUserId`, `startsAt`, `endsAt`, `amountMicroUsd`, `policyId`, `idempotencyKey`
and `reason`. For Pro and the staff pilot, use `"fundingScope": "user"` and omit
organization fields. The root allowance follows that account across organizations.
For historical Organization funding, use `"fundingScope": "organization"` and include `organizationId`
and `expectedOrganizationSlug`; current membership and the exact slug are checked.
Manual receipts cannot top up an automatic monthly period. The following is a
historical pilot grant shape, not the Pro monthly issuer (replace all fixtures):

```json
{
  "channel": "alpha",
  "fundingScope": "user",
  "userId": "11111111-1111-4111-8111-111111111111",
  "actorUserId": "22222222-2222-4222-8222-222222222222",
  "startsAt": "2026-09-01T00:00:00Z",
  "endsAt": "2026-10-01T00:00:00Z",
  "amountMicroUsd": 20000000,
  "policyId": "pilot-budget-v1",
  "idempotencyKey": "approved-pilot-receipt-1",
  "reason": "Approved finite staff qualification allowance"
}
```

Older Business documents must add `"fundingScope": "organization"` and obtain
a fresh plan digest before replay. Their existing ledger receipt identity and
amount do not change; this never grants the same receipt a second time.

Use ISO timestamps with explicit offsets, the approved receipt amount, and an
audit reason of 16–512 characters. The channel must match Railway when present.
Configure `DATABASE_URL` securely and run:

```sh
CLOUD_COMPUTE_GRANT_FILE=/secure/grant.json pnpm --dir apps/control-plane cloud-compute:grant
```

Review the exact target and amount. Set `CLOUD_COMPUTE_GRANT_PLAN_SHA256` to the
returned digest, keep the same file and database, and run the command with
`--execute`. Repeating the same receipt reports `replayed` without granting twice.
A signed billing adapter may call the same ledger after independently validating
its receipt; subscription events alone are insufficient.

`GET /v1/organizations/:organization/cloud-compute-credits` returns at most the
100 most recent periods for the authenticated member only, with `Cache-Control:
no-store`. Paid cancellation does not hide the owner's balance; account or
membership revocation removes access. The public response excludes platform
exposure. It does not grant execution authority.

Health reports aggregate `compute_settlement_stalled`, `compute_lease_expired`,
and `compute_platform_exposure` signals without tenant identifiers. Operators
must investigate retained reservations using provider receipts. Never release
a hold because a worker timed out, or mark deletion complete from a 404 alone.
