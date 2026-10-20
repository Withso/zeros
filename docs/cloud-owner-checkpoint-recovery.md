# Owner-attested checkpoint recovery

This Alpha/development operator restores an explicitly selected durable
checkpoint after the owner acknowledges loss of all newer unsaved work. It is
for a failed final Stop with a retired capture and its dependent Restart.
Ordinary Stop, Restart and Delete still require final-save proof.

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
History restoration and any explicit retry of recovery remain separate work.

The migration supports deployed health and retry readers: the discarded row is
not blocked/retrying, and its next-attempt timestamp is infinity. Stale workers
cannot reopen any named intent or create a successor capture. The original failed
save remains false under `cloud_final_save_proven`. Later data erasure still
requires the new generation's final proof, settled dispatch, deletion-job
custody, legal-hold checks and physical object/record retirement. Only the exact
receipt-backed historical recovery is excluded from unresolved history.

Local Personal and organization-local workspaces are unaffected. The tool is a
control-plane-only, exact organization/workspace operation, with no renderer or
engine wire change.
