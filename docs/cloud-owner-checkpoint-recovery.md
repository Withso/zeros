# Owner-attested checkpoint recovery

This Alpha/development operator restores an explicitly selected durable
checkpoint after the owner acknowledges loss of all newer unsaved work. It is
for a failed final Stop with a retired capture and its dependent Restart.
Ordinary Stop, Restart and Delete still require final-save proof.
Complete workspace loss and deletion uses the separate operator described below.

The operator defaults to a plan. Before execution,
the incident owner separately authorizes provider deletion and runs the existing
`cloud-provider-loss:manage` operator. Its complete inventory omission and exact
not-found lookup must both be at most 15 minutes old, or the recovery request
must select the authenticated recheck described below. An expired lease, a missing
database row, or a loss acknowledgement alone cannot establish provider loss.
Keep the source VM preserved until that separate action is approved. A dry run
of this tool also requires the provider-loss receipt; do not destroy a VM just
to obtain a plan without the owner's loss acknowledgement.

Use an authorized database login with `DATABASE_MIGRATION_ROLE` set to the stable
table owner. The application role cannot create or change discard receipts.
The named operator must be an active platform owner; the named workspace owner
must still have normal organization, team and paid recovery admission. Apply
migrations `0172_cloud_owner_checkpoint_recovery.sql` and
`0173_cloud_owner_recovery_safety_stop.sql` first with the normal migration
runner. Existing 0171 proof and dispatch guards remain installed.

Create a private regular JSON file owned by the operator OS user, mode `0600`,
at most 16 KiB. The strict v1 fields are:

| Scope | Required fields |
| --- | --- |
| Request | `version: 1`, `operationId`, `channel: "alpha"` or `"development"` |
| Target | `organizationId`, `expectedOrganizationSlug`, `workspaceId`, `sourceGeneration`, `ownerUserId`, `operatorUserId` |
| Accepted restart | `stopIntentId`, `wakeIntentId`, `recoveryId` (the Stop ID) |
| Frozen capture | `requestId`, `retirementId`, `custodyId` |
| Provider loss | `providerResourceId`, `providerAccountScope`, `providerLossAttestationId` |
| Durable recovery point | `checkpointId`, `checkpointSha256`, `checkpointContentRevision`, `checkpointRecordRevision`, `checkpointAt` (ISO timestamp) |
| Current qualified Computer | `computerBuildId`, `computerConfigId`, `runtimeId` |
| Owner approval | `ownerAcknowledgedUnsavedLoss: true`, `ownerApprovalReference`, `reason` |

Two optional strict companions extend v1 without changing an existing request:

- `safetyStop: { intentId, requestId }` names the single system safety Stop that
  the compute worker can insert after a provider 404, before or after the loss
  attestation. Its producer audit, settled allocation lease, original engine
  incarnation and exact superseded Wake must agree. Both Stops must remain
  undispatched. The safety capture must never have been delivered and must have
  no custody, capture/commit/reconcile report or successor. Any additional active
  intent or unresolved source-generation recovery prevents execution. Do not add this companion
  for arbitrary cancelled, delivered or unrelated lifecycle work.
- `lossRecheck: { providerAccount }` reuses the immutable original loss identity
  while obtaining fresh authenticated inventory and an exact-resource 404 using
  `BOAT_API_KEY`. The account must equal the original attestation. This mode
  permits an expired original observation, but does not edit or renew it. Each
  plan and execute performs fresh reads outside database locks, then revalidates
  all pins under locks. The executed observation timestamps, inventory hash,
  account and count are recorded on the discard receipt. Both observations must
  still be within 15 minutes by the database clock when that receipt inserts.

There are no provider mutations. Without `lossRecheck`, there are no provider
calls and the original observations must still be fresh. A committed exact
replay needs no further provider read. Failed or changed evidence never grants
new authority and leaves the source disposition uncommitted.

The acknowledgement must identify the checkpoint and loss of newer unsaved work.
Both reference and reason must be 16–512 characters. Keep incident identifiers,
approval records, credentials and this request file outside the public checkout.
Use the same operation ID and exact request body on every replay.

With the normal private deployment environment loaded, set
`CONTROL_PLANE_OWNER_RECOVERY_REQUEST_FILE` to the file path and run:

```sh
pnpm --dir apps/control-plane cloud-owner-checkpoint-recovery:manage
```

Review the resulting `planned` receipt and candidate generation. The returned
`approval` binds the request, database target, source incarnation, current
authorization, original intent bodies, retirement, loss evidence and selected
Computer. Set `CONTROL_PLANE_OWNER_RECOVERY_APPROVAL` to that exact value and run
the same command with `--execute`. Never pass database credentials in command
arguments. A mismatch requires a fresh plan and review; do not weaken the pins.

Execution atomically appends the immutable owner receipt, marks the exact Stop
recovery and optional safety recovery `discarded` with no next attempt,
supersedes the original Stop and Wake plus the optional safety Stop, and starts
one existing recovery transition into a fresh generation. Failure and custody
records remain unchanged. A queued, never-delivered safety request is cancelled
with its normal retirement; an already terminal request remains unchanged.
The old Stops are never `succeeded`,
`proven` or `resolved`, and no seal ACK or final checkpoint is invented. The
selected durable checkpoint and current qualified Computer are pinned exactly.
The source binding receives deletion verification only from fresh authenticated
provider-loss evidence. Exact replay returns the same receipt and transition.

`restoring` means the transition committed, not that the new workspace is ready.
Observe the returned transition through provisioning/setup to `succeeded` and
verify its generation, checkpoint and Computer pins. A candidate failure keeps
the lost source quarantined and requires operator follow-up; it cannot wake the
discarded source. Replaying the command does not create another candidate.

After migration `0175_cloud_unstarted_candidate_cleanup.sql`, the existing
final-save worker can retire an exact failed candidate whose setup stopped at
`setup_checkpoint_restore_invalid` before any agent boot or writer reservation.
This requires the original owner receipt and transition, a retained valid source
checkpoint, the exact revoked engine and allocation, no candidate content writes
or checkpoints, and no delivered capture or capture custody. Candidate records
must be absent except for one initial primary metadata upsert, differing from
the checkpoint's source only in `createdAt`, written by that engine before setup
failed. Its exact batch ID is retained in the receipt; any other field change,
identity, tombstone or additional event refuses cleanup. A missing
ledger, revoked engine, or failed setup alone is insufficient.

The worker appends one immutable cleanup receipt per qualifying candidate Delete
or compute Stop and marks only its recovery `not_required`, with an infinite
retry timestamp. It preserves failure reports and original request identities;
an undelivered queued request is cancelled with its normal retirement receipt.
The existing reconciler then performs ordinary provider inspection, compute
settlement and Stop/Delete. No checkpoint is fabricated: `cloud_final_save_proven`
stays false. Dispatch retains its exact allocation hold until positive provider
retirement. Late setup, enrollment, boot, writer and capture work is refused.
There is no new operator execute command or new candidate start in this slice.

After deployment, observe the exact candidate's cleanup receipts, recovery
states, lifecycle results and provider binding. A receipt is not provider
deletion verification. `final_save_blocked` can clear at disposition, while
`lifecycle_stalled` clears only when the queued lifecycle work actually retires.
An ineligible candidate stays preserved and requires separate investigation.
The source checkpoint, original discard and failed transition remain intact.
Cleanup itself never starts another candidate.

## Explicit retry after a never-started candidate

Migration `0176_cloud_checkpoint_history_recovery.sql` adds one narrow retry
of the original failed candidate. Deploy its CP code first, then publish and
qualify the corrected runtime and build the selected Computer from it. A
restart of the old runtime does not acquire this fix. The retry must select a
different runtime from the failed candidate; the operator verifies that its
source contains the history correction before approving the plan.

Create a new private request with a new `operationId`, owner approval reference
and reason. Retain every original source, capture, discard, provider-loss and
checkpoint field, update the exact qualified Computer/build/runtime fields, and
add this strict companion:

```json
{
  "retry": {
    "ownerDiscardReceiptId": "<original-discard-receipt-uuid>",
    "failedTransitionId": "<original-failed-transition-uuid>",
    "failedCandidateGeneration": 2,
    "cleanupStopIntentId": "<candidate-system-stop-uuid>",
    "cleanupDeleteIntentId": "<candidate-delete-uuid>"
  }
}
```

The generation shown is illustrative; use the original receipt's exact failed
candidate. The source must still be stopped, positively lost and explicitly
discarded. Both exact never-started cleanup receipts must remain valid, both
intents must have succeeded, the allocation lease must be settled, and the
candidate binding must have verified deletion. The original transition must be
`rollback_failed` with `setup_checkpoint_restore_invalid`; the retained
checkpoint, owner/funding incarnation and absence of newer work are rechecked.
This does not cover an archived VM, a candidate that ran work, or another
failure reason.

Use the same CLI plan and execute commands. A plan rolls back all writes. Its
approval binds the new request, effective database target, current authority
and selected qualified Computer. Drift refuses before commit. Execute atomically
inserts an immutable operator retry receipt and one new provisioning candidate.
It does not spend another discard, reuse the original Stop as a drain, or
rewrite the original failed transition. The original immutable positive loss
fact suffices here because the discard already committed; this retry neither
refreshes that attestation nor makes provider calls. Original uncommitted
discard requests still require the fresh evidence described above.

Replay the same new request and approval after an uncertain CLI result. It
returns the same new transition, even after settlement. Replaying the original
request continues to return the original failed transition. A second new
operation for the same failed candidate refuses. Follow the new transition to
readiness and verify the pinned checkpoint, runtime and Computer before
declaring recovery successful.

If a fresh allocation lacks the original live FULL history ledger, the
corrected engine can explicitly request the CP's owner-discard history
projection. It validates the retained ACKed ancestor and imports only immutable
CP-mirrored history, accepted command IDs and current edit/delete fences.
Coverage stays unknown, gaps remain visible, and inherited pending commands
become uncertain without replay. Missing or corrupt surviving custody still
refuses. This path cannot invent a final-save proof or reconstruct unmirrored
work. See [history recovery](cloud-workspace/data-and-sync.md#recovery-after-an-unsealed-stop).

The migration supports deployed health and retry readers: the discarded row is
not blocked/retrying, and its next-attempt timestamp is infinity. Stale workers
cannot reopen any named intent or create a successor capture. The original failed
save remains false under `cloud_final_save_proven`. Later data erasure still
requires the new generation's final proof, settled dispatch, deletion-job
custody, legal-hold checks and physical object/record retirement. Only the exact
receipt-backed historical recovery is excluded from unresolved history.

Local Personal and organization-local workspaces are unaffected. The tool is an
exact organization/workspace operator; its optional history recovery uses the
private authenticated cloud boot wire. There is no renderer mutation surface.

## Complete workspace discard and Delete

Migration `0177_cloud_owner_discard_delete.sql` adds an Alpha/development
operator for an owner who explicitly accepts loss of **all** workspace data and
requests permanent deletion. It supports an undispatched system compute Stop
blocked on final save after a never-ready wake or a crashed previously-ready
engine, including delivered captures and an unsealed writer. It also supports
the engine-health producer's `system:engine-stop:` intent when its current
capture expired without delivery. Both require attempt zero, no dispatch and
the exact allocation's `stop_intent_id`; live authority and competing work
remain refused. Other system Stop families are not admitted. The existing
checkpoint-restore operator above has different authority and cannot substitute
for this complete-loss acknowledgement.

Use the stable migration table owner through `DATABASE_MIGRATION_ROLE` and an
active platform-owner operator. The current workspace owner must still pass
ordinary workspace cleanup authorization. There is no HTTP/engine admission
path and the application role cannot write the receipts. Local Personal and
organization-local workspaces do not use this control-plane operation.

Prepare an operator-owned regular JSON file, mode `0600`, at most 16 KiB:

| Scope | Required fields |
| --- | --- |
| Request | `version: 1`, `operationId`, `channel: "alpha"` or `"development"` |
| Owner | `organizationId`, `expectedOrganizationSlug`, `workspaceId`, `ownerUserId`, `operatorUserId` |
| Exact blocked source | `sourceGeneration`, `stopIntentId`, `requestId`, `engineInstanceId`, `allocationLeaseId` |
| Provider | `providerResourceId`, `providerAccountScope` |
| Explicit total loss | `ownerAcknowledgedCompleteDataLoss: true`, `ownerApprovalReference`, `reason` |

The approval reference and reason must each have 16–512 characters. Keep real
identities, approval records and credentials outside the public checkout.
Preserve the same operation ID and body for replay.

Set `CONTROL_PLANE_OWNER_DELETE_REQUEST_FILE` to that path and run:

```sh
pnpm --dir apps/control-plane cloud-owner-discard-delete:manage
```

Planning takes no provider action and rolls back all database work. It freezes
the target, current authority, original engine and allocation, content/record
heads, destructive lifecycle history, capture attempts/reports and generation
bindings. There must be no live engine lease, setup, transition, capture,
unsettled provider dispatch or legal hold. Every noncurrent generation must
already have positive provider deletion verification. The exact current capture
must be terminal. The inventory is bounded to 256 destructive intents,
512 captures, 128 engines, 64 generations and 1 MiB of retained source.

Review the exact plan, set `CONTROL_PLANE_OWNER_DELETE_APPROVAL` to its returned
`approval`, and run the same command with `--execute`. Request, target or source
changes require a fresh plan. Execution atomically records the owner loss
receipt, marks the named unproved recoveries `discarded`, preserves their
failure/custody facts, supersedes the blocked Stop and admits one normal Delete.
It revokes stale runtime/grant authority, but does not label that revocation as
native retirement. It creates no final-save proof, seal, checkpoint, provider
loss receipt or early erasure completion.

`deleting` reports committed intent, not provider or data deletion. The normal
workers retain compute settlement, provider deletion and independent absence
verification, all-generation checks, legal holds, object deletion and record
purge. An unsealed writer can retire only after the exact Delete's positive
provider result; its missing seal remains missing. Observe `providerDeletion`
and `dataErasure` separately. Immutable loss receipts survive normal data purge
and permit only their owning workspace's cascade during final organization
erasure. Direct receipt deletion remains refused while the workspace exists;
accounting retention and all other organization-purge gates remain in force.
The existing allocation-lease foreign key can still block organization erasure
after workspace deletion. Resolving that accounting-retention boundary is a
separate follow-up; this operator does not remove retained accounting rows.
A terminal provider failure or object-erasure failure requires operator
follow-up; replay never resets either operation. There is one approved Delete
per workspace, and a failed operation does not authorize a successor.
